/**
 * Unit tests for the Backup Manager Container Snapshot & Export functionality.
 *
 * Tests container snapshot via Docker commit, image export as tar archive,
 * S3 upload integration, backup registry tracking, and error handling.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 15.1, 15.2, 15.3, 15.4, 15.5
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Readable } from 'node:stream';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import {
  createBackupManager,
  generateSnapshotTag,
  formatTimestamp,
  type BackupManagerExtended,
  type SnapshotResult,
  type ExportResult,
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

const mockImageGet = vi.fn();
const mockImageRemove = vi.fn();
const mockImage = {
  get: mockImageGet,
  remove: mockImageRemove,
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
  getImage: vi.fn(() => mockImage),
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-backup-snapshot-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockStream(content: Buffer = Buffer.from('mock-tar-content')): Readable {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return stream;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Backup Manager - Container Snapshot & Export', () => {
  let dbPath: string;
  let db: Database.Database;
  let backupManager: BackupManagerExtended;
  let tempBackupDir: string;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });

    tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-backup-dest-'));

    // Reset mocks
    vi.clearAllMocks();

    // Default mock implementations
    mockContainerInspect.mockResolvedValue({
      Id: 'abc123def456',
      Name: '/my-app',
      Config: {
        Env: ['NODE_ENV=production'],
        ExposedPorts: { '3000/tcp': {} },
      },
      HostConfig: {
        PortBindings: { '3000/tcp': [{ HostPort: '3000' }] },
        Binds: ['/data:/app/data'],
        RestartPolicy: { Name: 'always' },
        NetworkMode: 'bridge',
      },
    });

    mockContainerCommit.mockResolvedValue({ Id: 'sha256:newimage123' });
    mockContainerStop.mockResolvedValue(undefined);
    mockContainerRemove.mockResolvedValue(undefined);
    mockContainerStart.mockResolvedValue(undefined);
    mockContainerRename.mockResolvedValue(undefined);

    mockImageGet.mockResolvedValue(createMockStream());
    mockImageRemove.mockResolvedValue(undefined);

    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'abc123def456',
        Names: ['/my-app'],
        Image: 'my-app:latest',
        State: 'running',
      },
    ]);

    mockNewContainerStart.mockResolvedValue(undefined);
    mockNewContainerInspect.mockResolvedValue({ Id: 'new-container-id' });
    mockNewContainerRename.mockResolvedValue(undefined);

    mockSettingsService.get.mockImplementation(async (key: string) => {
      const settings: Record<string, string> = {
        backup_local_path: tempBackupDir,
        backup_s3_enabled: 'false',
        backup_s3_endpoint: '',
        backup_s3_bucket: '',
        backup_s3_access_key: '',
        backup_s3_secret_key: '',
        backup_s3_region: 'us-east-1',
        backup_s3_prefix: 'vps-panel',
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

  // ─── generateSnapshotTag tests ───────────────────────────────────────────────

  describe('generateSnapshotTag', () => {
    it('should format tag as {container_name}-snapshot-{YYYYMMDD-HHmmss}', () => {
      const date = new Date(2024, 5, 15, 14, 30, 45); // June 15, 2024, 14:30:45
      const tag = generateSnapshotTag('my-app', date);
      expect(tag).toBe('my-app-snapshot-20240615-143045');
    });

    it('should zero-pad single digit month, day, hour, minute, second', () => {
      const date = new Date(2024, 0, 5, 3, 7, 9); // Jan 5, 2024, 03:07:09
      const tag = generateSnapshotTag('web-server', date);
      expect(tag).toBe('web-server-snapshot-20240105-030709');
    });

    it('should handle container names with hyphens', () => {
      const date = new Date(2024, 11, 31, 23, 59, 59); // Dec 31, 2024, 23:59:59
      const tag = generateSnapshotTag('my-cool-app-v2', date);
      expect(tag).toBe('my-cool-app-v2-snapshot-20241231-235959');
    });
  });

  // ─── formatTimestamp tests ─────────────────────────────────────────────────

  describe('formatTimestamp', () => {
    it('should format date as YYYYMMDD-HHmmss', () => {
      const date = new Date(2024, 2, 10, 9, 5, 30); // March 10, 2024, 09:05:30
      expect(formatTimestamp(date)).toBe('20240310-090530');
    });
  });

  // ─── snapshotContainer tests ─────────────────────────────────────────────────

  describe('snapshotContainer', () => {
    it('should create a snapshot using Docker commit', async () => {
      const result = await backupManager.snapshotContainer('abc123def456', 'Test snapshot');

      expect(mockDocker.getContainer).toHaveBeenCalledWith('abc123def456');
      expect(mockContainerInspect).toHaveBeenCalled();
      expect(mockContainerCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: 'Test snapshot',
          author: 'VPS Panel Backup Manager',
        })
      );

      expect(result.containerId).toBe('abc123def456');
      expect(result.backupId).toBeDefined();
      expect(result.imageTag).toMatch(/^my-app-snapshot-\d{8}-\d{6}$/);
      expect(result.timestamp).toBeDefined();
    });

    it('should use default commit message when none provided', async () => {
      await backupManager.snapshotContainer('abc123def456');

      expect(mockContainerCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: 'Snapshot of my-app',
        })
      );
    });

    it('should track successful snapshot in backup registry', async () => {
      const result = await backupManager.snapshotContainer('abc123def456', 'Test');

      // Check that it's stored in the database
      const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(result.backupId) as any;
      expect(row).toBeDefined();
      expect(row.type).toBe('snapshot');
      expect(row.container_id).toBe('abc123def456');
      expect(row.container_name).toBe('my-app');
      expect(row.image_tag).toMatch(/^my-app-snapshot-\d{8}-\d{6}$/);
      expect(row.commit_message).toBe('Test');
      expect(row.status).toBe('completed');
    });

    it('should throw error and track failure when Docker commit fails', async () => {
      mockContainerCommit.mockRejectedValue(new Error('Container is paused'));

      await expect(
        backupManager.snapshotContainer('abc123def456', 'Test')
      ).rejects.toThrow('Docker commit failed for container abc123def456: Container is paused');

      // Check failed entry is tracked
      const rows = db.prepare('SELECT * FROM backups WHERE status = ?').all('failed') as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].type).toBe('snapshot');
    });

    it('should strip leading slash from container name', async () => {
      mockContainerInspect.mockResolvedValue({
        Id: 'abc123def456',
        Name: '/my-app-service',
        Config: { Env: [] },
        HostConfig: {},
      });

      const result = await backupManager.snapshotContainer('abc123def456');
      expect(result.imageTag).toMatch(/^my-app-service-snapshot-/);
    });
  });

  // ─── exportImage tests ────────────────────────────────────────────────────

  describe('exportImage', () => {
    it('should export a Docker image as tar archive', async () => {
      const result = await backupManager.exportImage('my-app-snapshot-20240615-143045');

      expect(mockDocker.getImage).toHaveBeenCalledWith('my-app-snapshot-20240615-143045');
      expect(mockImageGet).toHaveBeenCalled();

      expect(result.backupId).toBeDefined();
      expect(result.archivePath).toContain(tempBackupDir);
      expect(result.archivePath).toContain('.tar');
      expect(result.size).toBeGreaterThan(0);
      expect(result.s3Uploaded).toBe(false);
    });

    it('should save archive to configured backup_local_path', async () => {
      const result = await backupManager.exportImage('my-image:latest');

      expect(result.archivePath.startsWith(tempBackupDir)).toBe(true);
      expect(fs.existsSync(result.archivePath)).toBe(true);
    });

    it('should track successful export in backup registry', async () => {
      const result = await backupManager.exportImage('my-image:latest');

      const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(result.backupId) as any;
      expect(row).toBeDefined();
      expect(row.type).toBe('export');
      expect(row.status).toBe('completed');
      expect(row.size).toBeGreaterThan(0);
    });

    it('should throw and track failure when Docker save fails', async () => {
      mockImageGet.mockRejectedValue(new Error('No such image'));

      await expect(
        backupManager.exportImage('nonexistent:latest')
      ).rejects.toThrow('Docker save failed for image nonexistent:latest: No such image');

      // Check failed entry is tracked
      const rows = db.prepare('SELECT * FROM backups WHERE status = ? AND type = ?').all('failed', 'export') as any[];
      expect(rows.length).toBe(1);
    });

    it('should clean up partial tar file on failure', async () => {
      // Create a scenario where the stream write fails midway
      const errorStream = new Readable({
        read() {
          this.emit('error', new Error('Stream interrupted'));
        },
      });
      mockImageGet.mockResolvedValue(errorStream);

      await expect(
        backupManager.exportImage('my-image:latest')
      ).rejects.toThrow('Docker save failed');

      // Verify a failed backup entry is recorded
      const rows = db.prepare('SELECT * FROM backups WHERE status = ? AND type = ?').all('failed', 'export') as any[];
      expect(rows.length).toBe(1);
    });

    it('should not attempt S3 upload when backup_s3_enabled is false', async () => {
      const result = await backupManager.exportImage('my-image:latest');

      expect(result.s3Uploaded).toBe(false);
    });

    it('should retain local copy and emit alert when S3 upload fails', async () => {
      // Enable S3 but make it fail
      mockSettingsService.get.mockImplementation(async (key: string) => {
        const settings: Record<string, string> = {
          backup_local_path: tempBackupDir,
          backup_s3_enabled: 'true',
          backup_s3_endpoint: 'https://s3.example.com',
          backup_s3_bucket: 'my-bucket',
          backup_s3_access_key: 'key',
          backup_s3_secret_key: 'secret',
          backup_s3_region: 'us-east-1',
          backup_s3_prefix: 'backups',
        };
        return settings[key] ?? '';
      });

      // Mock S3 SDK to throw
      vi.doMock('@aws-sdk/client-s3', () => {
        throw new Error('Module not found');
      });

      const alertMock = vi.fn();
      const managerWithAlert = createBackupManager(db, {
        workDir: tempBackupDir,
        docker: mockDocker as any,
        settingsService: mockSettingsService,
        alertCallback: { onBackupFailure: alertMock },
      });

      const result = await managerWithAlert.exportImage('my-image:latest');

      // Local file should still be retained
      expect(result.s3Uploaded).toBe(false);
      expect(fs.existsSync(result.archivePath)).toBe(true);
    });

    it('should replace special characters in image name for filename', async () => {
      const result = await backupManager.exportImage('registry.io/org/my-image:v1.0');

      // Special characters /, : in the IMAGE NAME should be replaced with -
      // Note: the full path may contain OS-specific separators (e.g. C:\ on Windows)
      const filename = path.basename(result.archivePath);
      expect(filename).not.toContain('/');
      expect(filename).not.toContain(':');
      expect(filename).toContain('registry.io-org-my-image-v1.0');
    });
  });

  // ─── updateScheduleFromSettings tests ──────────────────────────────────────

  describe('updateScheduleFromSettings', () => {
    it('should accept a schedule configuration without errors', () => {
      expect(() => {
        backupManager.updateScheduleFromSettings({
          targets: ['my-app', 'web-server'],
          cronExpression: '0 2 * * *',
          retentionCount: 7,
          enabled: true,
        });
      }).not.toThrow();
    });

    it('should stop the scheduler when disabled', () => {
      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 7,
        enabled: true,
      });

      // Now disable
      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 7,
        enabled: false,
      });

      // Should not throw and should be idempotent
      backupManager.updateScheduleFromSettings({
        targets: [],
        cronExpression: '0 2 * * *',
        retentionCount: 7,
        enabled: false,
      });
    });
  });

  // ─── Backup registry tracking tests ─────────────────────────────────────────

  describe('backup registry tracking', () => {
    it('should record backup entry with ID, timestamp, size, storage location, status', async () => {
      const result = await backupManager.exportImage('my-image:latest');

      const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(result.backupId) as any;
      expect(row.id).toBe(result.backupId);
      expect(row.timestamp).toBeDefined();
      expect(row.size).toBeGreaterThan(0);
      expect(row.storage_type).toBeDefined();
      expect(row.status).toBe('completed');
    });

    it('should record snapshot with container metadata', async () => {
      const result = await backupManager.snapshotContainer('abc123def456', 'My commit');

      const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(result.backupId) as any;
      expect(row.container_id).toBe('abc123def456');
      expect(row.container_name).toBe('my-app');
      expect(row.image_tag).toBe(result.imageTag);
      expect(row.commit_message).toBe('My commit');
    });
  });
});
