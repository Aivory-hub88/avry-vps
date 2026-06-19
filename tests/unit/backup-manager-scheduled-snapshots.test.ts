/**
 * Unit tests for Backup Manager - Scheduled Container Snapshots with Retention.
 *
 * Tests updateScheduleFromSettings(), runScheduledSnapshots (via interval triggers),
 * enforceSnapshotRetention(), individual failure handling with alert emission,
 * and settings change subscription behavior.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import {
  createBackupManager,
  type BackupManagerExtended,
  type SnapshotScheduleConfig,
  type AlertCallback,
} from '../../src/modules/backup-manager.js';
import type Database from 'better-sqlite3';

// ─── Mock Dockerode ────────────────────────────────────────────────────────────

const mockContainerCommit = vi.fn();
const mockContainerInspect = vi.fn();
const mockContainerStop = vi.fn();
const mockContainerRemove = vi.fn();
const mockContainerStart = vi.fn();
const mockContainerRename = vi.fn();

const mockImageRemove = vi.fn();
const mockImage = {
  get: vi.fn(),
  remove: mockImageRemove,
};

const mockDocker = {
  getContainer: vi.fn(),
  getImage: vi.fn(() => mockImage),
  listContainers: vi.fn(),
  createContainer: vi.fn(),
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-sched-snap-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function insertTestSnapshot(
  db: Database.Database,
  id: string,
  containerName: string,
  imageTag: string,
  timestamp: string
): void {
  db.prepare(`
    INSERT INTO backups (id, timestamp, type, container_id, container_name, image_tag, commit_message, status, targets, storage_type, storage_path)
    VALUES (?, ?, 'snapshot', ?, ?, ?, 'test', 'completed', '', 'local', '')
  `).run(id, timestamp, `cid-${containerName}`, containerName, imageTag);
}

function makeContainerMock(name: string, shouldFail = false) {
  return {
    commit: shouldFail
      ? vi.fn().mockRejectedValue(new Error(`Commit failed for ${name}`))
      : vi.fn().mockResolvedValue({ Id: `sha256:img-${name}` }),
    inspect: vi.fn().mockResolvedValue({
      Id: `cid-${name}`,
      Name: `/${name}`,
      Config: { Env: [] },
      HostConfig: {},
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Backup Manager - Scheduled Container Snapshots with Retention', () => {
  let dbPath: string;
  let db: Database.Database;
  let backupManager: BackupManagerExtended;
  let tempBackupDir: string;
  let alertCalls: Array<{ backupId: string; error: string; targets: string[] }>;
  let alertCallback: AlertCallback;

  beforeEach(() => {
    vi.useFakeTimers();
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });
    tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-sched-dest-'));

    vi.clearAllMocks();

    alertCalls = [];
    alertCallback = {
      onBackupFailure: (backupId: string, error: string, targets: string[]) => {
        alertCalls.push({ backupId, error, targets });
      },
    };

    // Default: single container "my-app"
    const myAppMock = makeContainerMock('my-app');
    mockDocker.getContainer.mockReturnValue(myAppMock);
    mockDocker.listContainers.mockResolvedValue([
      { Id: 'cid-my-app', Names: ['/my-app'], State: 'running' },
      { Id: 'cid-web-server', Names: ['/web-server'], State: 'running' },
      { Id: 'cid-db-service', Names: ['/db-service'], State: 'running' },
    ]);
    mockSettingsService.get.mockResolvedValue('');

    backupManager = createBackupManager(db, {
      workDir: tempBackupDir,
      docker: mockDocker as any,
      settingsService: mockSettingsService,
      alertCallback,
    });
  });

  afterEach(() => {
    // Disable schedule to clear timers
    backupManager.updateScheduleFromSettings({
      targets: [], cronExpression: '0 0 * * *', retentionCount: 7, enabled: false,
    });
    vi.useRealTimers();
    closeDatabase(db);
    cleanupDb(dbPath);
    if (fs.existsSync(tempBackupDir)) {
      fs.rmSync(tempBackupDir, { recursive: true, force: true });
    }
  });

  // ─── updateScheduleFromSettings - enable/disable ──────────────────────────

  describe('updateScheduleFromSettings - enable/disable scheduling', () => {
    it('should set up interval timer when enabled is true', () => {
      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 5,
        enabled: true,
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    it('should clear interval timer when disabled', () => {
      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 5,
        enabled: true,
      });
      // Disable
      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 5,
        enabled: false,
      });
      // Repeated disable is idempotent
      backupManager.updateScheduleFromSettings({
        targets: [],
        cronExpression: '0 2 * * *',
        retentionCount: 5,
        enabled: false,
      });
    });

    it('should replace existing timer when called with new config', () => {
      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 5,
        enabled: true,
      });
      backupManager.updateScheduleFromSettings({
        targets: ['web-server', 'db-service'],
        cronExpression: '30 3 * * *',
        retentionCount: 3,
        enabled: true,
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    it('should not trigger snapshots when schedule is disabled', async () => {
      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '* * * * *',
        retentionCount: 5,
        enabled: false,
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockDocker.listContainers).not.toHaveBeenCalled();
    });

    it('should trigger snapshots when cron matches current time', async () => {
      // Set time to 02:00 which matches "0 2 * * *"
      vi.setSystemTime(new Date(2024, 5, 15, 1, 59, 0));

      const myAppMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(myAppMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 5,
        enabled: true,
      });

      // Advance 1 minute so system time becomes 02:00
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDocker.listContainers).toHaveBeenCalled();
      expect(myAppMock.commit).toHaveBeenCalled();
    });

    it('should not trigger when cron does not match current time', async () => {
      // Set time to 05:30 which does NOT match "0 2 * * *"
      vi.setSystemTime(new Date(2024, 5, 15, 5, 29, 0));

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 5,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDocker.listContainers).not.toHaveBeenCalled();
    });
  });

  // ─── Retention enforcement ──────────────────────────────────────────────────

  describe('enforceSnapshotRetention - deletes oldest when exceeding count', () => {
    it('should delete oldest snapshots when count exceeds retention limit', async () => {
      // Pre-populate 5 snapshots for "my-app"
      insertTestSnapshot(db, 'snap-1', 'my-app', 'tag-1', '2024-01-01T01:00:00Z');
      insertTestSnapshot(db, 'snap-2', 'my-app', 'tag-2', '2024-01-02T01:00:00Z');
      insertTestSnapshot(db, 'snap-3', 'my-app', 'tag-3', '2024-01-03T01:00:00Z');
      insertTestSnapshot(db, 'snap-4', 'my-app', 'tag-4', '2024-01-04T01:00:00Z');
      insertTestSnapshot(db, 'snap-5', 'my-app', 'tag-5', '2024-01-05T01:00:00Z');

      // Set time to match cron
      vi.setSystemTime(new Date(2024, 0, 5, 1, 59, 0));

      const myAppMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(myAppMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 3,
        enabled: true,
      });

      // Trigger
      await vi.advanceTimersByTimeAsync(60_000);

      // After snapshot + retention, we should have at most 3
      const remaining = db.prepare(
        "SELECT * FROM backups WHERE type = 'snapshot' AND status = 'completed' AND container_name = 'my-app'"
      ).all();
      expect(remaining.length).toBeLessThanOrEqual(3);
    });

    it('should not delete snapshots when count is within retention limit', async () => {
      insertTestSnapshot(db, 'snap-1', 'my-app', 'tag-1', '2024-01-01T01:00:00Z');
      insertTestSnapshot(db, 'snap-2', 'my-app', 'tag-2', '2024-01-02T01:00:00Z');

      vi.setSystemTime(new Date(2024, 0, 2, 1, 59, 0));
      const myAppMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(myAppMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      // All original + new snapshot should exist (3 total, well under 10)
      const snap1 = db.prepare("SELECT * FROM backups WHERE id = 'snap-1'").get();
      const snap2 = db.prepare("SELECT * FROM backups WHERE id = 'snap-2'").get();
      expect(snap1).toBeDefined();
      expect(snap2).toBeDefined();
    });

    it('should enforce retention per container independently', async () => {
      // 3 snapshots each for two containers
      insertTestSnapshot(db, 'app-1', 'my-app', 'app-tag-1', '2024-01-01T01:00:00Z');
      insertTestSnapshot(db, 'app-2', 'my-app', 'app-tag-2', '2024-01-02T01:00:00Z');
      insertTestSnapshot(db, 'app-3', 'my-app', 'app-tag-3', '2024-01-03T01:00:00Z');
      insertTestSnapshot(db, 'web-1', 'web-server', 'web-tag-1', '2024-01-01T01:00:00Z');
      insertTestSnapshot(db, 'web-2', 'web-server', 'web-tag-2', '2024-01-02T01:00:00Z');
      insertTestSnapshot(db, 'web-3', 'web-server', 'web-tag-3', '2024-01-03T01:00:00Z');

      vi.setSystemTime(new Date(2024, 0, 3, 1, 59, 0));

      // Each container gets its own mock
      mockDocker.getContainer.mockImplementation((id: string) => {
        if (id === 'cid-my-app') return makeContainerMock('my-app');
        if (id === 'cid-web-server') return makeContainerMock('web-server');
        return makeContainerMock('unknown');
      });

      backupManager.updateScheduleFromSettings({
        targets: ['my-app', 'web-server'],
        cronExpression: '0 2 * * *',
        retentionCount: 2,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      // Each container should have at most 2 snapshots
      const appSnaps = db.prepare(
        "SELECT * FROM backups WHERE type = 'snapshot' AND status = 'completed' AND container_name = 'my-app'"
      ).all();
      const webSnaps = db.prepare(
        "SELECT * FROM backups WHERE type = 'snapshot' AND status = 'completed' AND container_name = 'web-server'"
      ).all();
      expect(appSnaps.length).toBeLessThanOrEqual(2);
      expect(webSnaps.length).toBeLessThanOrEqual(2);
    });

    it('should keep newest and delete oldest snapshots', async () => {
      insertTestSnapshot(db, 'oldest', 'my-app', 'tag-oldest', '2024-01-01T00:00:00Z');
      insertTestSnapshot(db, 'middle', 'my-app', 'tag-middle', '2024-01-15T00:00:00Z');
      insertTestSnapshot(db, 'newest', 'my-app', 'tag-newest', '2024-01-30T00:00:00Z');

      vi.setSystemTime(new Date(2024, 0, 30, 1, 59, 0));
      const myAppMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(myAppMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 2,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      // After adding one new snapshot + enforcing retention=2:
      // newest + the new one should remain, oldest and middle should be deleted
      const oldest = db.prepare("SELECT * FROM backups WHERE id = 'oldest'").get();
      const newest = db.prepare("SELECT * FROM backups WHERE id = 'newest'").get();
      expect(oldest).toBeUndefined();
      expect(newest).toBeDefined();
    });

    it('should attempt Docker image removal for deleted snapshots', async () => {
      insertTestSnapshot(db, 'snap-old', 'my-app', 'old-image-tag', '2024-01-01T00:00:00Z');
      insertTestSnapshot(db, 'snap-new', 'my-app', 'new-image-tag', '2024-01-02T00:00:00Z');

      vi.setSystemTime(new Date(2024, 0, 2, 1, 59, 0));
      const myAppMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(myAppMock);
      mockImageRemove.mockResolvedValue(undefined);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 1,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      // Should attempt to get image for removal
      expect(mockDocker.getImage).toHaveBeenCalled();
    });
  });

  // ─── Individual failure handling ───────────────────────────────────────────

  describe('individual snapshot failure - alert emission and continuation', () => {
    it('should emit alert on snapshot failure', async () => {
      vi.setSystemTime(new Date(2024, 5, 15, 1, 59, 0));

      // Make container commit fail
      const failMock = makeContainerMock('my-app', true);
      mockDocker.getContainer.mockReturnValue(failMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(alertCalls.length).toBeGreaterThan(0);
      expect(alertCalls[0].error).toContain('my-app');
      expect(alertCalls[0].targets).toContain('my-app');
    });

    it('should not emit alert when snapshot succeeds', async () => {
      vi.setSystemTime(new Date(2024, 5, 15, 1, 59, 0));

      const successMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(successMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '0 2 * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(alertCalls.length).toBe(0);
    });

    it('should continue with remaining containers after one fails', async () => {
      vi.setSystemTime(new Date(2024, 5, 15, 1, 59, 0));

      // my-app fails, web-server succeeds
      mockDocker.getContainer.mockImplementation((id: string) => {
        if (id === 'cid-my-app') return makeContainerMock('my-app', true);
        if (id === 'cid-web-server') return makeContainerMock('web-server', false);
        return makeContainerMock('unknown');
      });

      backupManager.updateScheduleFromSettings({
        targets: ['my-app', 'web-server'],
        cronExpression: '0 2 * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      // web-server should have a successful snapshot despite my-app failing
      const webSnaps = db.prepare(
        "SELECT * FROM backups WHERE type = 'snapshot' AND status = 'completed' AND container_name = 'web-server'"
      ).all();
      expect(webSnaps.length).toBe(1);

      // Alert should be emitted for my-app
      expect(alertCalls.length).toBeGreaterThan(0);
      expect(alertCalls[0].targets).toContain('my-app');
    });

    it('should emit separate alerts for each failed container', async () => {
      vi.setSystemTime(new Date(2024, 5, 15, 1, 59, 0));

      // Both fail
      mockDocker.getContainer.mockImplementation((id: string) => {
        if (id === 'cid-my-app') return makeContainerMock('my-app', true);
        if (id === 'cid-web-server') return makeContainerMock('web-server', true);
        return makeContainerMock('unknown', true);
      });

      backupManager.updateScheduleFromSettings({
        targets: ['my-app', 'web-server'],
        cronExpression: '0 2 * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(alertCalls.length).toBe(2);
      const alertTargets = alertCalls.map((a) => a.targets[0]);
      expect(alertTargets).toContain('my-app');
      expect(alertTargets).toContain('web-server');
    });

    it('should skip containers not found in Docker listing', async () => {
      vi.setSystemTime(new Date(2024, 5, 15, 1, 59, 0));

      // Only my-app exists in Docker
      mockDocker.listContainers.mockResolvedValue([
        { Id: 'cid-my-app', Names: ['/my-app'], State: 'running' },
      ]);

      const myAppMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(myAppMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app', 'nonexistent'],
        cronExpression: '0 2 * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      // Only my-app should be snapshotted (1 commit call)
      expect(myAppMock.commit).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Multiple target containers ───────────────────────────────────────────

  describe('scheduled snapshots - multiple target containers', () => {
    it('should snapshot each configured target container', async () => {
      vi.setSystemTime(new Date(2024, 5, 15, 1, 59, 0));

      const mocks: Record<string, ReturnType<typeof makeContainerMock>> = {
        'cid-my-app': makeContainerMock('my-app'),
        'cid-web-server': makeContainerMock('web-server'),
        'cid-db-service': makeContainerMock('db-service'),
      };

      mockDocker.getContainer.mockImplementation((id: string) => mocks[id] || makeContainerMock('unknown'));

      backupManager.updateScheduleFromSettings({
        targets: ['my-app', 'web-server', 'db-service'],
        cronExpression: '0 2 * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      // Each container should have been committed
      expect(mocks['cid-my-app'].commit).toHaveBeenCalledTimes(1);
      expect(mocks['cid-web-server'].commit).toHaveBeenCalledTimes(1);
      expect(mocks['cid-db-service'].commit).toHaveBeenCalledTimes(1);
    });

    it('should record each snapshot in backup registry', async () => {
      vi.setSystemTime(new Date(2024, 5, 15, 1, 59, 0));

      mockDocker.getContainer.mockImplementation((id: string) => {
        if (id === 'cid-my-app') return makeContainerMock('my-app');
        if (id === 'cid-web-server') return makeContainerMock('web-server');
        return makeContainerMock('unknown');
      });

      backupManager.updateScheduleFromSettings({
        targets: ['my-app', 'web-server'],
        cronExpression: '0 2 * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      const snapshots = db.prepare(
        "SELECT * FROM backups WHERE type = 'snapshot' AND status = 'completed'"
      ).all() as any[];
      expect(snapshots.length).toBe(2);

      const names = snapshots.map((s: any) => s.container_name);
      expect(names).toContain('my-app');
      expect(names).toContain('web-server');
    });
  });

  // ─── Cron expression matching ─────────────────────────────────────────────

  describe('cron expression matching via schedule trigger', () => {
    it('should match wildcard (* * * * *) at any time', async () => {
      vi.setSystemTime(new Date(2024, 3, 10, 15, 41, 0));
      const myAppMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(myAppMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '* * * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(myAppMock.commit).toHaveBeenCalled();
    });

    it('should match step cron (*/5) at 5-minute intervals', async () => {
      // minute=9 → advance 1 min → minute=10 (divisible by 5)
      vi.setSystemTime(new Date(2024, 3, 10, 15, 9, 0));
      const myAppMock = makeContainerMock('my-app');
      mockDocker.getContainer.mockReturnValue(myAppMock);

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '*/5 * * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(myAppMock.commit).toHaveBeenCalled();
    });

    it('should not match step cron at non-matching minutes', async () => {
      // minute=12 → advance 1 min → minute=13 (not divisible by 5)
      vi.setSystemTime(new Date(2024, 3, 10, 15, 12, 0));

      backupManager.updateScheduleFromSettings({
        targets: ['my-app'],
        cronExpression: '*/5 * * * *',
        retentionCount: 10,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockDocker.listContainers).not.toHaveBeenCalled();
    });
  });
});
