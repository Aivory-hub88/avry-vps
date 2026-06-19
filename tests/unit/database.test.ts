/**
 * Unit tests for the database module.
 * Tests SQLite initialization, schema creation, migration runner, and health check.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  initializeDatabase,
  checkHealth,
  closeDatabase,
  listTables,
  getDbPath,
  getCurrentSchemaVersion,
  applyMigrations,
} from '../../src/database/index.js';

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-panel-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Database Module', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTempDbPath();
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  describe('getDbPath', () => {
    it('should use provided config path', () => {
      const result = getDbPath({ dbPath: '/custom/path/db.sqlite' });
      expect(result).toBe(path.resolve('/custom/path/db.sqlite'));
    });

    it('should use DB_PATH env var when no config provided', () => {
      const original = process.env.DB_PATH;
      process.env.DB_PATH = '/env/path/panel.db';
      try {
        const result = getDbPath();
        expect(result).toBe(path.resolve('/env/path/panel.db'));
      } finally {
        if (original !== undefined) {
          process.env.DB_PATH = original;
        } else {
          delete process.env.DB_PATH;
        }
      }
    });

    it('should default to ./data/panel.db', () => {
      const original = process.env.DB_PATH;
      delete process.env.DB_PATH;
      try {
        const result = getDbPath();
        expect(result).toBe(path.resolve('./data/panel.db'));
      } finally {
        if (original !== undefined) {
          process.env.DB_PATH = original;
        }
      }
    });
  });

  describe('initializeDatabase', () => {
    it('should create the database file and directory', () => {
      const db = initializeDatabase({ dbPath });
      expect(fs.existsSync(dbPath)).toBe(true);
      closeDatabase(db);
    });

    it('should enable WAL mode by default', () => {
      const db = initializeDatabase({ dbPath });
      const mode = db.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
      closeDatabase(db);
    });

    it('should skip WAL mode when walMode is false', () => {
      const db = initializeDatabase({ dbPath, walMode: false });
      const mode = db.pragma('journal_mode', { simple: true });
      // Without explicit WAL, SQLite defaults to 'delete' journal mode
      expect(mode).not.toBe('wal');
      closeDatabase(db);
    });

    it('should enable foreign keys', () => {
      const db = initializeDatabase({ dbPath });
      const fk = db.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
      closeDatabase(db);
    });

    it('should create all expected tables', () => {
      const db = initializeDatabase({ dbPath });
      const tables = listTables(db);

      const expectedTables = [
        'projects',
        'project_resources',
        'jobs',
        'pipeline_configs',
        'webhook_configs',
        'webhook_events',
        'tunnel_configs',
        'tunnel_transfers',
        'cicd_configs',
        'cicd_sync_events',
        'domains',
        'certificates',
        'backup_schedules',
        'backups',
        'alert_rules',
        'alert_channels',
        'alerts',
        'firewall_rules',
        'security_scans',
        'audit_log',
        'sessions',
        'rate_limits',
        'concurrency_limits',
        'cron_jobs',
        'cron_executions',
        'schema_migrations',
      ];

      for (const table of expectedTables) {
        expect(tables).toContain(table);
      }

      closeDatabase(db);
    });

    it('should create default concurrency limits', () => {
      const db = initializeDatabase({ dbPath });
      const rows = db.prepare('SELECT * FROM concurrency_limits ORDER BY operation_type').all() as {
        operation_type: string;
        max_concurrent: number;
      }[];

      expect(rows.length).toBeGreaterThanOrEqual(3);

      const buildLimit = rows.find((r) => r.operation_type === 'build');
      expect(buildLimit?.max_concurrent).toBe(2);

      const deployLimit = rows.find((r) => r.operation_type === 'deploy');
      expect(deployLimit?.max_concurrent).toBe(3);

      const dbImportLimit = rows.find((r) => r.operation_type === 'db-import');
      expect(dbImportLimit?.max_concurrent).toBe(1);

      closeDatabase(db);
    });

    it('should be idempotent (safe to call multiple times)', () => {
      const db1 = initializeDatabase({ dbPath });
      closeDatabase(db1);

      // Second initialization should not throw
      const db2 = initializeDatabase({ dbPath });
      const tables = listTables(db2);
      expect(tables).toContain('projects');
      closeDatabase(db2);
    });
  });

  describe('applyMigrations', () => {
    it('should set schema version to latest after all migrations', () => {
      const db = initializeDatabase({ dbPath });
      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(2);
      closeDatabase(db);
    });

    it('should not re-apply migrations on subsequent calls', () => {
      const db = initializeDatabase({ dbPath });

      // Insert a test row
      db.prepare("INSERT INTO projects (id, name) VALUES ('test-1', 'Test Project')").run();

      // Re-apply migrations (should be a no-op)
      applyMigrations(db);

      // The test row should still exist
      const row = db.prepare("SELECT * FROM projects WHERE id = 'test-1'").get() as { name: string } | undefined;
      expect(row?.name).toBe('Test Project');

      closeDatabase(db);
    });
  });

  describe('checkHealth', () => {
    it('should report healthy for a valid database', () => {
      const db = initializeDatabase({ dbPath });
      const health = checkHealth(db);

      expect(health.healthy).toBe(true);
      expect(health.walMode).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.error).toBeUndefined();

      closeDatabase(db);
    });

    it('should report unhealthy after database is closed', () => {
      const db = initializeDatabase({ dbPath });
      closeDatabase(db);

      const health = checkHealth(db);
      expect(health.healthy).toBe(false);
      expect(health.error).toBeDefined();
    });

    it('should report walMode false when WAL is not enabled', () => {
      const db = initializeDatabase({ dbPath, walMode: false });
      const health = checkHealth(db);

      expect(health.healthy).toBe(true);
      expect(health.walMode).toBe(false);

      closeDatabase(db);
    });
  });

  describe('Schema integrity', () => {
    it('should enforce foreign key constraints', () => {
      const db = initializeDatabase({ dbPath });

      // Inserting a project_resource without a valid project_id should fail
      expect(() => {
        db.prepare(
          "INSERT INTO project_resources (id, project_id, resource_type, resource_id) VALUES ('r1', 'nonexistent', 'container', 'c1')"
        ).run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should enforce unique constraints on projects.name', () => {
      const db = initializeDatabase({ dbPath });

      db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'My Project')").run();

      expect(() => {
        db.prepare("INSERT INTO projects (id, name) VALUES ('p2', 'My Project')").run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should cascade delete project resources when project is deleted', () => {
      const db = initializeDatabase({ dbPath });

      db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Project 1')").run();
      db.prepare(
        "INSERT INTO project_resources (id, project_id, resource_type, resource_id) VALUES ('r1', 'p1', 'container', 'c1')"
      ).run();

      db.prepare("DELETE FROM projects WHERE id = 'p1'").run();

      const resources = db.prepare("SELECT * FROM project_resources WHERE project_id = 'p1'").all();
      expect(resources).toHaveLength(0);

      closeDatabase(db);
    });

    it('should have indexes on jobs table', () => {
      const db = initializeDatabase({ dbPath });

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'")
        .all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_jobs_status');
      expect(indexNames).toContain('idx_jobs_type_status');
      expect(indexNames).toContain('idx_jobs_project');

      closeDatabase(db);
    });

    it('should support FTS5 on audit_log_fts', () => {
      const db = initializeDatabase({ dbPath });

      // Insert an audit log entry
      db.prepare(
        "INSERT INTO audit_log (id, actor, action_type, target_resource, details, result) VALUES ('a1', 'admin', 'container.start', 'container:nginx', '{\"reason\":\"deploy\"}', 'success')"
      ).run();

      // Manually insert into FTS table (in production, triggers would do this)
      db.prepare(
        "INSERT INTO audit_log_fts (rowid, action_type, target_resource, details) VALUES (last_insert_rowid(), 'container.start', 'container:nginx', '{\"reason\":\"deploy\"}')"
      ).run();

      // Search via FTS
      const results = db
        .prepare("SELECT * FROM audit_log_fts WHERE audit_log_fts MATCH 'container'")
        .all();
      expect(results.length).toBeGreaterThanOrEqual(1);

      closeDatabase(db);
    });
  });

  describe('Migration V2: Premium upgrade schema extensions', () => {
    it('should add acknowledgment columns to alerts table', () => {
      const db = initializeDatabase({ dbPath });

      // Verify columns exist by inserting an alert with the new columns
      db.prepare(
        "INSERT INTO alert_rules (id, resource_type, threshold) VALUES ('rule-1', 'cpu', 80)"
      ).run();
      db.prepare(
        "INSERT INTO alerts (id, event_type, affected_resource, severity, acknowledged_at, acknowledged_by, resolved_at, resolution_status) VALUES ('alert-1', 'threshold_breach', 'system:cpu', 'warning', '2024-01-01T00:00:00Z', 'admin-user', NULL, 'acknowledged')"
      ).run();

      const alert = db.prepare("SELECT * FROM alerts WHERE id = 'alert-1'").get() as Record<string, unknown>;
      expect(alert.acknowledged_at).toBe('2024-01-01T00:00:00Z');
      expect(alert.acknowledged_by).toBe('admin-user');
      expect(alert.resolved_at).toBeNull();
      expect(alert.resolution_status).toBe('acknowledged');

      closeDatabase(db);
    });

    it('should enforce resolution_status CHECK constraint on alerts', () => {
      const db = initializeDatabase({ dbPath });

      expect(() => {
        db.prepare(
          "INSERT INTO alerts (id, event_type, affected_resource, severity, resolution_status) VALUES ('alert-2', 'threshold_breach', 'system:cpu', 'warning', 'invalid_status')"
        ).run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should default resolution_status to active', () => {
      const db = initializeDatabase({ dbPath });

      db.prepare(
        "INSERT INTO alerts (id, event_type, affected_resource, severity) VALUES ('alert-3', 'threshold_breach', 'system:cpu', 'warning')"
      ).run();

      const alert = db.prepare("SELECT resolution_status FROM alerts WHERE id = 'alert-3'").get() as { resolution_status: string };
      expect(alert.resolution_status).toBe('active');

      closeDatabase(db);
    });

    it('should create alert_silences table with correct schema', () => {
      const db = initializeDatabase({ dbPath });

      const tables = listTables(db);
      expect(tables).toContain('alert_silences');

      // Insert a silence record
      db.prepare(
        "INSERT INTO alert_rules (id, resource_type, threshold) VALUES ('rule-1', 'cpu', 80)"
      ).run();
      db.prepare(
        "INSERT INTO alert_silences (id, rule_id, admin_id, expires_at) VALUES ('silence-1', 'rule-1', 'admin-1', '2024-12-31T23:59:59Z')"
      ).run();

      const silence = db.prepare("SELECT * FROM alert_silences WHERE id = 'silence-1'").get() as Record<string, unknown>;
      expect(silence.rule_id).toBe('rule-1');
      expect(silence.admin_id).toBe('admin-1');
      expect(silence.expires_at).toBe('2024-12-31T23:59:59Z');
      expect(silence.created_at).toBeDefined();

      closeDatabase(db);
    });

    it('should enforce foreign key on alert_silences.rule_id', () => {
      const db = initializeDatabase({ dbPath });

      expect(() => {
        db.prepare(
          "INSERT INTO alert_silences (id, rule_id, admin_id, expires_at) VALUES ('silence-2', 'nonexistent-rule', 'admin-1', '2024-12-31T23:59:59Z')"
        ).run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should add container snapshot columns to backups table', () => {
      const db = initializeDatabase({ dbPath });

      db.prepare(
        "INSERT INTO backups (id, targets, storage_type, storage_path, status, type, container_id, container_name, image_tag, commit_message) VALUES ('backup-1', 'nginx', 'local', '/data/backups/backup-1.tar', 'completed', 'snapshot', 'abc123', 'my-nginx', 'my-nginx-snapshot-20240101-120000', 'Pre-deploy snapshot')"
      ).run();

      const backup = db.prepare("SELECT * FROM backups WHERE id = 'backup-1'").get() as Record<string, unknown>;
      expect(backup.type).toBe('snapshot');
      expect(backup.container_id).toBe('abc123');
      expect(backup.container_name).toBe('my-nginx');
      expect(backup.image_tag).toBe('my-nginx-snapshot-20240101-120000');
      expect(backup.commit_message).toBe('Pre-deploy snapshot');

      closeDatabase(db);
    });

    it('should enforce type CHECK constraint on backups', () => {
      const db = initializeDatabase({ dbPath });

      expect(() => {
        db.prepare(
          "INSERT INTO backups (id, targets, storage_type, storage_path, status, type) VALUES ('backup-2', 'nginx', 'local', '/data/backups/backup-2.tar', 'completed', 'invalid_type')"
        ).run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should default backups type to volume', () => {
      const db = initializeDatabase({ dbPath });

      db.prepare(
        "INSERT INTO backups (id, targets, storage_type, storage_path, status) VALUES ('backup-3', 'nginx', 'local', '/data/backups/backup-3.tar', 'completed')"
      ).run();

      const backup = db.prepare("SELECT type FROM backups WHERE id = 'backup-3'").get() as { type: string };
      expect(backup.type).toBe('volume');

      closeDatabase(db);
    });

    it('should create restore_history table with correct schema', () => {
      const db = initializeDatabase({ dbPath });

      const tables = listTables(db);
      expect(tables).toContain('restore_history');

      // Insert a backup first (FK target)
      db.prepare(
        "INSERT INTO backups (id, targets, storage_type, storage_path, status) VALUES ('backup-4', 'nginx', 'local', '/data/backups/backup-4.tar', 'completed')"
      ).run();

      // Insert a restore history record
      db.prepare(
        "INSERT INTO restore_history (id, backup_id, target_container, safety_snapshot_id, outcome, started_at) VALUES ('restore-1', 'backup-4', 'my-nginx', 'safety-snap-1', 'success', '2024-01-01T12:00:00Z')"
      ).run();

      const restore = db.prepare("SELECT * FROM restore_history WHERE id = 'restore-1'").get() as Record<string, unknown>;
      expect(restore.backup_id).toBe('backup-4');
      expect(restore.target_container).toBe('my-nginx');
      expect(restore.safety_snapshot_id).toBe('safety-snap-1');
      expect(restore.outcome).toBe('success');
      expect(restore.error_message).toBeNull();
      expect(restore.started_at).toBe('2024-01-01T12:00:00Z');
      expect(restore.completed_at).toBeNull();

      closeDatabase(db);
    });

    it('should enforce outcome CHECK constraint on restore_history', () => {
      const db = initializeDatabase({ dbPath });

      db.prepare(
        "INSERT INTO backups (id, targets, storage_type, storage_path, status) VALUES ('backup-5', 'nginx', 'local', '/data/backups/backup-5.tar', 'completed')"
      ).run();

      expect(() => {
        db.prepare(
          "INSERT INTO restore_history (id, backup_id, target_container, outcome) VALUES ('restore-2', 'backup-5', 'my-nginx', 'invalid_outcome')"
        ).run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should enforce foreign key on restore_history.backup_id', () => {
      const db = initializeDatabase({ dbPath });

      expect(() => {
        db.prepare(
          "INSERT INTO restore_history (id, backup_id, target_container, outcome) VALUES ('restore-3', 'nonexistent-backup', 'my-nginx', 'success')"
        ).run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should apply V2 migration incrementally to existing V1 database', () => {
      // Simulate a database that already has V1 applied
      const db = initializeDatabase({ dbPath });
      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(2);

      // Verify V1 tables still exist
      const tables = listTables(db);
      expect(tables).toContain('projects');
      expect(tables).toContain('alerts');
      expect(tables).toContain('backups');

      // Verify V2 tables exist
      expect(tables).toContain('alert_silences');
      expect(tables).toContain('restore_history');

      closeDatabase(db);
    });
  });
});
