/**
 * Unit tests for the Backup Manager Container Restore functionality.
 *
 * Tests container rollback from snapshot including safety snapshot creation,
 * container stop/create/start flow, failure handling with original container restart,
 * restore_history table recording, and input validation.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Readable } from 'node:stream';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import {
  createBackupManager,
  type BackupManagerExtended,
} from '../../src/modules/backup-manager.js';
import type Database from 'better-sqlite3';

// ─── Mock Dockerode ────────────────────────────────────────────────────────────

const mockContainerCommit = vi.fn();
const mockContainerInspect = vi.fn();
const mockContainerStop = vi.fn();
const mockContainerRemove = vi.fn();
const mockContainerStart = vi.fn();
const mockContainerRename = vi.fn();

const mockContainer = {
  commit: mockContainerCommit,
  inspect: mockContainerInspect,
  stop: mockContainerStop,
  remove: mockContainerRemove,
  start: mockContainerStart,
  rename: mockContainerRename,
};

const mockNewContainerStart = vi.fn();
const mockNewContainerInspect = vi.fn();
const mockNewContainerRename = vi.fn();
const mockNewContainer = {
  start: mockNewContainerStart,
  inspect: mockNewContainerInspect,
  rename: mockNewContainerRename,
};

const mockDocker = {
  getContainer: vi.fn(() => mockContainer),
  getImage: vi.fn(() => ({ get: vi.fn(), remove: vi.fn() })),
  listContainers: vi.fn(),
  createContainer: vi.fn(() => mockNewContainer),
};

vi.mock('dockerode', () => {
  return {
    default: vi.fn(() => mockDocker),
  };
});

// ─── Mock Settings Service ─────────────────────────────────────────────────────

const mockSettingsService = {
  get: vi.fn(),
  getAll: vi.fn(),
  getTyped: vi.fn(),
  update: vi.fn(),
  validate: vi.fn(),
  getDefinitions: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
} as any;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-backup-restore-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Inserts a completed snapshot backup row directly into the database
 * to set up the restore test precondition.
 */
function insertSnapshotBackup(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    timestamp: string;
    type: string;
    container_id: string;
    container_name: string;
    image_tag: string;
    commit_message: string;
    status: string;
  }> = {}
): string {
  const id = overrides.id ?? 'backup-' + Math.random().toString(36).slice(2, 10);
  const timestamp = overrides.timestamp ?? new Date().toISOString();
  const type = overrides.type ?? 'snapshot';
  const container_id = overrides.container_id ?? 'abc123def456';
  const container_name = overrides.container_name ?? 'my-app';
  const image_tag = overrides.image_tag ?? 'my-app-snapshot-20240615-143045';
  const commit_message = overrides.commit_message ?? 'Test snapshot';
  const status = overrides.status ?? 'completed';

  db.prepare(`
    INSERT INTO backups (id, timestamp, type, container_id, container_name, image_tag, commit_message, status, targets, storage_type, storage_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'local', '')
  `).run(id, timestamp, type, container_id, container_name, image_tag, commit_message, status);

  return id;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Backup Manager - Container Restore from Snapshot', () => {
  let dbPath: string;
  let db: Database.Database;
  let backupManager: BackupManagerExtended;
  let tempBackupDir: string;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });

    tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-backup-restore-dest-'));

    // Reset mocks
    vi.clearAllMocks();

    // Default mock implementations
    mockContainerInspect.mockResolvedValue({
      Id: 'abc123def456',
      Name: '/my-app',
      Config: {
        Env: ['NODE_ENV=production', 'PORT=3000'],
        ExposedPorts: { '3000/tcp': {} },
      },
      HostConfig: {
        PortBindings: { '3000/tcp': [{ HostPort: '3000' }] },
        Binds: ['/data:/app/data'],
        RestartPolicy: { Name: 'always' },
        NetworkMode: 'bridge',
      },
    });

    mockContainerCommit.mockResolvedValue({ Id: 'sha256:safetyimage123' });
    mockContainerStop.mockResolvedValue(undefined);
    mockContainerRemove.mockResolvedValue(undefined);
    mockContainerStart.mockResolvedValue(undefined);
    mockContainerRename.mockResolvedValue(undefined);

    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'abc123def456',
        Names: ['/my-app'],
        Image: 'my-app:latest',
        State: 'running',
      },
    ]);

    mockNewContainerStart.mockResolvedValue(undefined);
    mockNewContainerInspect.mockResolvedValue({ Id: 'new-container-id-789' });
    mockNewContainerRename.mockResolvedValue(undefined);

    mockDocker.createContainer.mockResolvedValue(mockNewContainer);

    mockSettingsService.get.mockImplementation(async (key: string) => {
      const settings: Record<string, string> = {
        backup_local_path: tempBackupDir,
        backup_s3_enabled: 'false',
      };
      return settings[key] ?? '';
    });

    backupManager = createBackupManager(db, {
      workDir: tempBackupDir,
      docker: mockDocker as any,
      settingsService: mockSettingsService,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
    if (fs.existsSync(tempBackupDir)) {
      fs.rmSync(tempBackupDir, { recursive: true, force: true });
    }
  });

  // ─── Successful Restore Flow ─────────────────────────────────────────────────

  describe('successful restore flow', () => {
    it('should restore a container from a completed snapshot backup', async () => {
      const backupId = insertSnapshotBackup(db);

      const result = await backupManager.restoreContainer(backupId, 'my-app');

      expect(result.success).toBe(true);
      expect(result.previousContainerId).toBe('abc123def456');
      expect(result.newContainerId).toBe('new-container-id-789');
      expect(result.safetySnapshotId).toBeDefined();
      expect(result.safetySnapshotId).not.toBe('');
    });

    it('should create a safety snapshot before performing restore', async () => {
      const backupId = insertSnapshotBackup(db);

      await backupManager.restoreContainer(backupId, 'my-app');

      // The commit call is for the safety snapshot
      expect(mockContainerCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: expect.stringContaining('Safety snapshot before restore'),
        })
      );
    });

    it('should stop the target container during restore', async () => {
      const backupId = insertSnapshotBackup(db);

      await backupManager.restoreContainer(backupId, 'my-app');

      expect(mockContainerStop).toHaveBeenCalled();
    });

    it('should create a new container from the snapshot image with same configuration', async () => {
      const backupId = insertSnapshotBackup(db, {
        image_tag: 'my-app-snapshot-20240615-143045',
      });

      await backupManager.restoreContainer(backupId, 'my-app');

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: 'my-app-snapshot-20240615-143045:latest',
          Env: ['NODE_ENV=production', 'PORT=3000'],
          HostConfig: expect.objectContaining({
            PortBindings: { '3000/tcp': [{ HostPort: '3000' }] },
            Binds: ['/data:/app/data'],
            RestartPolicy: { Name: 'always' },
            NetworkMode: 'bridge',
          }),
        })
      );
    });

    it('should start the new container after creation', async () => {
      const backupId = insertSnapshotBackup(db);

      await backupManager.restoreContainer(backupId, 'my-app');

      expect(mockNewContainerStart).toHaveBeenCalled();
    });

    it('should remove old container and rename new one after successful restore', async () => {
      const backupId = insertSnapshotBackup(db);

      await backupManager.restoreContainer(backupId, 'my-app');

      expect(mockContainerRemove).toHaveBeenCalled();
      expect(mockNewContainerRename).toHaveBeenCalledWith({ name: 'my-app' });
    });

    it('should record successful restore in restore_history table', async () => {
      const backupId = insertSnapshotBackup(db);

      const result = await backupManager.restoreContainer(backupId, 'my-app');

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow).toBeDefined();
      expect(historyRow.backup_id).toBe(backupId);
      expect(historyRow.target_container).toBe('my-app');
      expect(historyRow.safety_snapshot_id).toBe(result.safetySnapshotId);
      expect(historyRow.outcome).toBe('success');
      expect(historyRow.error_message).toBeNull();
      expect(historyRow.started_at).toBeDefined();
      expect(historyRow.completed_at).toBeDefined();
    });
  });

  // ─── Failure Handling ─────────────────────────────────────────────────────────

  describe('failure handling', () => {
    it('should attempt to restart original container when restore fails', async () => {
      const backupId = insertSnapshotBackup(db);

      // Make container creation fail
      mockDocker.createContainer.mockRejectedValue(new Error('Image not found'));

      // Track getContainer calls to verify restart attempt
      const originalContainerMock = {
        commit: mockContainerCommit,
        inspect: mockContainerInspect,
        stop: mockContainerStop,
        remove: mockContainerRemove,
        start: mockContainerStart,
        rename: mockContainerRename,
      };
      mockDocker.getContainer.mockReturnValue(originalContainerMock);

      await expect(
        backupManager.restoreContainer(backupId, 'my-app')
      ).rejects.toThrow();

      // Verify restart was attempted on the original container
      expect(mockContainerStart).toHaveBeenCalled();
    });

    it('should record failed restore in restore_history table', async () => {
      const backupId = insertSnapshotBackup(db);

      // Make new container start fail
      mockNewContainerStart.mockRejectedValue(new Error('Port already in use'));

      await expect(
        backupManager.restoreContainer(backupId, 'my-app')
      ).rejects.toThrow('Restore failed');

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow).toBeDefined();
      expect(historyRow.outcome).toBe('failed');
      expect(historyRow.error_message).toContain('Port already in use');
    });

    it('should throw an error with details when restore fails', async () => {
      const backupId = insertSnapshotBackup(db);

      mockDocker.createContainer.mockRejectedValue(new Error('Insufficient memory'));

      await expect(
        backupManager.restoreContainer(backupId, 'my-app')
      ).rejects.toThrow(/Restore failed.*my-app.*Insufficient memory/);
    });

    it('should handle original container restart failure gracefully', async () => {
      const backupId = insertSnapshotBackup(db);

      // Make container creation fail AND restart fail
      mockDocker.createContainer.mockRejectedValue(new Error('Image not found'));
      mockContainerStart.mockRejectedValue(new Error('Container is removed'));

      // Should still throw the original restore error, not crash
      await expect(
        backupManager.restoreContainer(backupId, 'my-app')
      ).rejects.toThrow('Restore failed');

      // Restore history should still be recorded
      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow).toBeDefined();
      expect(historyRow.outcome).toBe('failed');
    });
  });

  // ─── Validation ───────────────────────────────────────────────────────────────

  describe('validation', () => {
    it('should throw error when backup ID is not found', async () => {
      await expect(
        backupManager.restoreContainer('nonexistent-id', 'my-app')
      ).rejects.toThrow('Backup not found: nonexistent-id');
    });

    it('should throw error when backup type is not snapshot', async () => {
      const backupId = insertSnapshotBackup(db, { type: 'export' });

      await expect(
        backupManager.restoreContainer(backupId, 'my-app')
      ).rejects.toThrow(/Cannot restore from backup type.*export.*Only snapshot/);
    });

    it('should throw error when backup status is not completed', async () => {
      const backupId = insertSnapshotBackup(db, { status: 'failed' });

      await expect(
        backupManager.restoreContainer(backupId, 'my-app')
      ).rejects.toThrow(/Cannot restore from backup with status.*failed/);
    });

    it('should throw error when backup status is in-progress', async () => {
      const backupId = insertSnapshotBackup(db, { status: 'in-progress' });

      await expect(
        backupManager.restoreContainer(backupId, 'my-app')
      ).rejects.toThrow(/Cannot restore from backup with status.*in-progress/);
    });

    it('should throw error when target container is not found', async () => {
      const backupId = insertSnapshotBackup(db);

      // Return empty container list
      mockDocker.listContainers.mockResolvedValue([]);

      await expect(
        backupManager.restoreContainer(backupId, 'nonexistent-container')
      ).rejects.toThrow('Target container not found: nonexistent-container');
    });
  });

  // ─── Safety Snapshot ──────────────────────────────────────────────────────────

  describe('safety snapshot creation', () => {
    it('should create safety snapshot with descriptive commit message', async () => {
      const backupId = insertSnapshotBackup(db, { id: 'test-backup-123' });

      await backupManager.restoreContainer(backupId, 'my-app');

      expect(mockContainerCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: expect.stringContaining('test-backup-123'),
        })
      );
    });

    it('should store safety snapshot in backup registry', async () => {
      const backupId = insertSnapshotBackup(db);

      const result = await backupManager.restoreContainer(backupId, 'my-app');

      // The safety snapshot should be stored as a backup entry
      const safetyRow = db.prepare('SELECT * FROM backups WHERE id = ?').get(result.safetySnapshotId) as any;
      expect(safetyRow).toBeDefined();
      expect(safetyRow.type).toBe('snapshot');
      expect(safetyRow.status).toBe('completed');
      expect(safetyRow.commit_message).toContain('Safety snapshot');
    });

    it('should link safety snapshot ID in restore_history', async () => {
      const backupId = insertSnapshotBackup(db);

      const result = await backupManager.restoreContainer(backupId, 'my-app');

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow.safety_snapshot_id).toBe(result.safetySnapshotId);
    });
  });

  // ─── restore_history table recording ──────────────────────────────────────────

  describe('restore_history table recording', () => {
    it('should record restore with source backup ID', async () => {
      const backupId = insertSnapshotBackup(db, { id: 'source-backup-001' });

      await backupManager.restoreContainer(backupId, 'my-app');

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get('source-backup-001') as any;
      expect(historyRow).toBeDefined();
      expect(historyRow.backup_id).toBe('source-backup-001');
    });

    it('should record restore with target container name', async () => {
      const backupId = insertSnapshotBackup(db);

      await backupManager.restoreContainer(backupId, 'my-app');

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow.target_container).toBe('my-app');
    });

    it('should record restore with timestamps', async () => {
      const backupId = insertSnapshotBackup(db);

      await backupManager.restoreContainer(backupId, 'my-app');

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow.started_at).toBeDefined();
      expect(historyRow.completed_at).toBeDefined();

      // Timestamps should be valid ISO strings
      expect(() => new Date(historyRow.started_at)).not.toThrow();
      expect(() => new Date(historyRow.completed_at)).not.toThrow();
    });

    it('should record restore with unique ID', async () => {
      const backupId = insertSnapshotBackup(db);

      await backupManager.restoreContainer(backupId, 'my-app');

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow.id).toBeDefined();
      expect(historyRow.id).not.toBe('');
      // UUID format check
      expect(historyRow.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should record outcome as success for successful restore', async () => {
      const backupId = insertSnapshotBackup(db);

      await backupManager.restoreContainer(backupId, 'my-app');

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow.outcome).toBe('success');
    });

    it('should record outcome as failed with error message for failed restore', async () => {
      const backupId = insertSnapshotBackup(db);
      mockDocker.createContainer.mockRejectedValue(new Error('Disk full'));

      try {
        await backupManager.restoreContainer(backupId, 'my-app');
      } catch {
        // Expected to throw
      }

      const historyRow = db.prepare('SELECT * FROM restore_history WHERE backup_id = ?').get(backupId) as any;
      expect(historyRow.outcome).toBe('failed');
      expect(historyRow.error_message).toContain('Disk full');
    });
  });
});
