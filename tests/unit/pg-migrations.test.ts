/**
 * Unit tests for PostgreSQL Schema Migrations (migrations.ts)
 *
 * Tests cover: aggregated metrics tables SQL structure, settings table SQL,
 * CHECK constraints, incremental migration logic, and partition creation
 * for new tables.
 *
 * @validates Requirements 1.2, 1.3, 2.1, 6.1
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPgMigrations, ensureFuturePartitions, _internals, _sql } from '../../src/database/migrations.js';
import type { PgClient } from '../../src/database/pg-client.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createMockPgClient(overrides?: Partial<PgClient>): PgClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

// ─── SQL Structure Tests ───────────────────────────────────────────────────────

describe('PostgreSQL Migration SQL Definitions', () => {
  describe('vps_panel.settings table', () => {
    it('should define the settings table with all required columns', () => {
      const sql = _sql.VPS_PANEL_SETTINGS_SQL;
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS vps_panel.settings');
      expect(sql).toContain('key VARCHAR(255) PRIMARY KEY');
      expect(sql).toContain('value TEXT NOT NULL');
      expect(sql).toContain('category VARCHAR(50) NOT NULL');
      expect(sql).toContain('data_type VARCHAR(20) NOT NULL');
      expect(sql).toContain('description TEXT');
      expect(sql).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    });

    it('should include category CHECK constraint with all valid categories', () => {
      const sql = _sql.VPS_PANEL_SETTINGS_SQL;
      expect(sql).toContain("CHECK (category IN ('General', 'Monitoring', 'Alerts', 'Backups', 'Security', 'Network'))");
    });

    it('should include data_type CHECK constraint with all valid types', () => {
      const sql = _sql.VPS_PANEL_SETTINGS_SQL;
      expect(sql).toContain("CHECK (data_type IN ('string', 'number', 'boolean', 'json', 'email', 'url', 'cron'))");
    });

    it('should create an index on category', () => {
      const sql = _sql.VPS_PANEL_SETTINGS_SQL;
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_settings_category ON vps_panel.settings (category)');
    });
  });

  describe('monitoring.system_metrics_5m table', () => {
    it('should define the 5m aggregated system metrics table', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS monitoring.system_metrics_5m');
    });

    it('should include all required columns for 5m aggregation', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      expect(sql).toContain('bucket_start TIMESTAMPTZ NOT NULL');
      expect(sql).toContain('cpu_usage_percent_avg REAL NOT NULL');
      expect(sql).toContain('cpu_usage_percent_max REAL NOT NULL');
      expect(sql).toContain('memory_used_bytes_avg BIGINT NOT NULL');
      expect(sql).toContain('memory_used_bytes_max BIGINT NOT NULL');
      expect(sql).toContain('memory_total_bytes BIGINT NOT NULL');
      expect(sql).toContain('disk_used_bytes_avg BIGINT NOT NULL');
      expect(sql).toContain('disk_used_bytes_max BIGINT NOT NULL');
      expect(sql).toContain('disk_total_bytes BIGINT NOT NULL');
      expect(sql).toContain('network_rx_bytes_per_sec_avg BIGINT NOT NULL');
      expect(sql).toContain('network_tx_bytes_per_sec_avg BIGINT NOT NULL');
      expect(sql).toContain('sample_count INTEGER NOT NULL');
    });

    it('should be partitioned by range on bucket_start', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      // Match the PARTITION BY RANGE clause that follows the system_metrics_5m table definition
      const tableSection = sql.split('monitoring.system_metrics_5m')[1];
      expect(tableSection).toContain('PARTITION BY RANGE (bucket_start)');
    });

    it('should use composite primary key (id, bucket_start)', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      // The PRIMARY KEY appears multiple times, check it exists for 5m table context
      expect(sql).toContain('PRIMARY KEY (id, bucket_start)');
    });
  });

  describe('monitoring.system_metrics_1h table', () => {
    it('should define the 1h aggregated system metrics table', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS monitoring.system_metrics_1h');
    });

    it('should be partitioned by range on bucket_start', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      const tableSection = sql.split('monitoring.system_metrics_1h')[1];
      expect(tableSection).toContain('PARTITION BY RANGE (bucket_start)');
    });

    it('should have the same structure as the 5m table', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      const section1h = sql.split('monitoring.system_metrics_1h')[1].split('CREATE TABLE')[0];
      expect(section1h).toContain('cpu_usage_percent_avg REAL NOT NULL');
      expect(section1h).toContain('cpu_usage_percent_max REAL NOT NULL');
      expect(section1h).toContain('memory_used_bytes_avg BIGINT NOT NULL');
      expect(section1h).toContain('memory_used_bytes_max BIGINT NOT NULL');
      expect(section1h).toContain('sample_count INTEGER NOT NULL');
    });
  });

  describe('monitoring.container_metrics_5m table', () => {
    it('should define the per-container 5m aggregated table', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS monitoring.container_metrics_5m');
    });

    it('should include container_id and container_name columns', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      const section = sql.split('monitoring.container_metrics_5m')[1];
      expect(section).toContain('container_id VARCHAR(12) NOT NULL');
      expect(section).toContain('container_name VARCHAR(255) NOT NULL');
    });

    it('should include container-specific metrics', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      const section = sql.split('monitoring.container_metrics_5m')[1];
      expect(section).toContain('cpu_usage_percent_avg REAL NOT NULL');
      expect(section).toContain('cpu_usage_percent_max REAL NOT NULL');
      expect(section).toContain('memory_used_bytes_avg BIGINT NOT NULL');
      expect(section).toContain('memory_used_bytes_max BIGINT NOT NULL');
      expect(section).toContain('memory_limit_bytes BIGINT NOT NULL');
      expect(section).toContain('sample_count INTEGER NOT NULL');
    });

    it('should be partitioned by range on bucket_start', () => {
      const sql = _sql.MONITORING_AGGREGATED_TABLES_SQL;
      const section = sql.split('monitoring.container_metrics_5m')[1];
      expect(section).toContain('PARTITION BY RANGE (bucket_start)');
    });

    it('should have a container_id index', () => {
      const sql = _sql.MONITORING_AGGREGATED_INDEXES_SQL;
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_container_metrics_5m_container');
      expect(sql).toContain('ON monitoring.container_metrics_5m (container_id, bucket_start DESC)');
    });
  });
});

// ─── Migration Logic Tests ─────────────────────────────────────────────────────

describe('runPgMigrations', () => {
  it('should run incremental migrations when schemas already exist', async () => {
    const queryCalls: string[] = [];
    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        queryCalls.push(sql);
        // Return true for schema existence checks
        if (sql.includes('information_schema.schemata')) {
          return [{ exists: true }];
        }
        // Return false for table existence checks (tables don't exist yet)
        if (sql.includes('information_schema.tables')) {
          return [{ exists: false }];
        }
        return [];
      }),
    });

    const result = await runPgMigrations(mockClient);
    expect(result).toBe(false); // returns false when schemas already existed

    // Should have checked for settings table and aggregated tables
    const tableChecks = queryCalls.filter(q => q.includes('information_schema.tables'));
    expect(tableChecks.length).toBeGreaterThanOrEqual(1);

    // Should have created the settings table
    const settingsCreation = queryCalls.find(q => q.includes('vps_panel.settings'));
    expect(settingsCreation).toBeDefined();

    // Should have created the aggregated tables
    const aggregatedCreation = queryCalls.find(q => q.includes('system_metrics_5m'));
    expect(aggregatedCreation).toBeDefined();
  });

  it('should create all tables on fresh install (no schemas exist)', async () => {
    const queryCalls: string[] = [];
    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        queryCalls.push(sql);
        // Both schemas don't exist
        if (sql.includes('information_schema.schemata')) {
          return [{ exists: false }];
        }
        return [];
      }),
    });

    const result = await runPgMigrations(mockClient);
    expect(result).toBe(true); // returns true when schemas were created

    // Should create vps_panel schema
    expect(queryCalls.some(q => q.includes('CREATE SCHEMA IF NOT EXISTS vps_panel'))).toBe(true);
    // Should create monitoring schema
    expect(queryCalls.some(q => q.includes('CREATE SCHEMA IF NOT EXISTS monitoring'))).toBe(true);
    // Should create settings table
    expect(queryCalls.some(q => q.includes('vps_panel.settings'))).toBe(true);
    // Should create aggregated tables
    expect(queryCalls.some(q => q.includes('monitoring.system_metrics_5m'))).toBe(true);
    expect(queryCalls.some(q => q.includes('monitoring.system_metrics_1h'))).toBe(true);
    expect(queryCalls.some(q => q.includes('monitoring.container_metrics_5m'))).toBe(true);
  });

  it('should skip creating settings table if it already exists during incremental migration', async () => {
    const queryCalls: string[] = [];
    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        queryCalls.push(sql);
        // Schemas exist
        if (sql.includes('information_schema.schemata')) {
          return [{ exists: true }];
        }
        // Settings table already exists
        if (sql.includes('information_schema.tables') && params?.[1] === 'settings') {
          return [{ exists: true }];
        }
        // Aggregated tables already exist
        if (sql.includes('information_schema.tables') && params?.[1] === 'system_metrics_5m') {
          return [{ exists: true }];
        }
        return [];
      }),
    });

    await runPgMigrations(mockClient);

    // Should NOT have run the settings creation SQL
    const settingsCreation = queryCalls.filter(q => q.includes('CREATE TABLE IF NOT EXISTS vps_panel.settings'));
    expect(settingsCreation.length).toBe(0);

    // Should NOT have run the aggregated tables SQL
    const aggCreation = queryCalls.filter(q => q.includes('CREATE TABLE IF NOT EXISTS monitoring.system_metrics_5m'));
    expect(aggCreation.length).toBe(0);
  });
});

// ─── ensureFuturePartitions Tests ──────────────────────────────────────────────

describe('ensureFuturePartitions', () => {
  it('should create partitions for all 5 partitioned tables', async () => {
    const queryCalls: string[] = [];
    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        queryCalls.push(sql);
        return [];
      }),
    });

    await ensureFuturePartitions(mockClient);

    // Should include partition creation for all tables
    // Use exact match with word boundary to avoid substring matching
    const tables = [
      'monitoring.system_metrics',
      'monitoring.container_snapshots',
      'monitoring.system_metrics_5m',
      'monitoring.system_metrics_1h',
      'monitoring.container_metrics_5m',
    ];

    for (const table of tables) {
      const partitionsForTable = queryCalls.filter(q => {
        // Match exact table name in "PARTITION OF <table>\n"
        const regex = new RegExp(`PARTITION OF ${table.replace('.', '\\.')}\\s`);
        return regex.test(q);
      });
      // Should create 4 weeks of future partitions per table
      expect(partitionsForTable.length).toBe(4);
    }
  });

  it('should create 4 weeks of future partitions (Requirement 2.2)', async () => {
    const queryCalls: string[] = [];
    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        queryCalls.push(sql);
        return [];
      }),
    });

    await ensureFuturePartitions(mockClient);

    // 5 tables × 4 weeks = 20 partition creation queries
    const partitionCreations = queryCalls.filter(q => q.includes('PARTITION OF'));
    expect(partitionCreations.length).toBe(20);
  });
});

// ─── Internal Helper Tests ─────────────────────────────────────────────────────

describe('tableExists helper', () => {
  it('should return true when table exists', async () => {
    const mockClient = createMockPgClient({
      query: vi.fn().mockResolvedValue([{ exists: true }]),
    });

    const result = await _internals.tableExists(mockClient, 'vps_panel', 'settings');
    expect(result).toBe(true);
  });

  it('should return false when table does not exist', async () => {
    const mockClient = createMockPgClient({
      query: vi.fn().mockResolvedValue([{ exists: false }]),
    });

    const result = await _internals.tableExists(mockClient, 'monitoring', 'system_metrics_5m');
    expect(result).toBe(false);
  });

  it('should query the correct schema and table name', async () => {
    const queryMock = vi.fn().mockResolvedValue([{ exists: true }]);
    const mockClient = createMockPgClient({ query: queryMock });

    await _internals.tableExists(mockClient, 'monitoring', 'container_metrics_5m');

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.tables'),
      ['monitoring', 'container_metrics_5m']
    );
  });
});
