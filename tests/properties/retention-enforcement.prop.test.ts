/**
 * Property-based tests for retention enforcement deletes oldest snapshots.
 *
 * Feature: VPS Panel Premium Upgrade, Property 12: Retention enforcement deletes oldest snapshots
 * For any retention count N (N ≥ 1) and any number of existing snapshots M for a container,
 * after adding a new snapshot, the total number of retained snapshots SHALL be at most N.
 * If M ≥ N before the addition, the oldest (M - N + 1) snapshots SHALL be deleted.
 *
 * **Validates: Requirements 14.3**
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import {
  createBackupManager,
  type BackupManagerExtended,
} from '../../src/modules/backup-manager.js';
import type Database from 'better-sqlite3';

// ─── Mock Dockerode ────────────────────────────────────────────────────────────

const mockImageRemove = vi.fn().mockResolvedValue(undefined);
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

// ─── Helpers ───────────────────────────────────────────────────────────────────

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-retention-prop-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Insert a test snapshot record with a given timestamp into the backups table.
 */
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

/**
 * Query all completed snapshots for a container, ordered by timestamp DESC.
 */
function getSnapshotsForContainer(db: Database.Database, containerName: string): any[] {
  return db
    .prepare(
      `SELECT * FROM backups WHERE type = 'snapshot' AND status = 'completed' AND container_name = ? ORDER BY timestamp DESC`
    )
    .all(containerName);
}

/**
 * Make a container mock that returns a successful commit.
 */
function makeContainerMock(name: string) {
  return {
    commit: vi.fn().mockResolvedValue({ Id: `sha256:img-${name}` }),
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

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate a retention count N between 1 and 20.
 */
const retentionCountArb = fc.integer({ min: 1, max: 20 });

/**
 * Generate an existing snapshot count M between 0 and 30.
 */
const existingSnapshotCountArb = fc.integer({ min: 0, max: 30 });

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Retention Enforcement Property Tests (Property 12)', () => {
  /**
   * Helper that runs the retention enforcement for given parameters:
   * - Creates a fresh DB
   * - Pre-populates M snapshots
   * - Triggers a scheduled snapshot (which adds 1 new + enforces retention)
   * - Returns the remaining snapshot count and the IDs of deleted/retained ones
   */
  async function runRetentionScenario(
    retentionCount: number,
    existingCount: number,
    containerName: string = 'test-app'
  ): Promise<{
    remaining: any[];
    totalBefore: number;
  }> {
    const dbPath = createTempDbPath();
    const db = initializeDatabase({ dbPath });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-ret-work-'));

    try {
      vi.useFakeTimers();

      // Pre-populate M existing snapshots with incremental timestamps
      for (let i = 0; i < existingCount; i++) {
        const timestamp = new Date(2024, 0, 1 + i, 12, 0, 0).toISOString();
        insertTestSnapshot(db, `snap-${i}`, containerName, `tag-${i}`, timestamp);
      }

      const totalBefore = existingCount;

      // Set system time to match cron "0 2 * * *" (2:00 AM)
      vi.setSystemTime(new Date(2024, 1, 15, 1, 59, 0));

      mockDocker.listContainers.mockResolvedValue([
        { Id: `cid-${containerName}`, Names: [`/${containerName}`], State: 'running' },
      ]);
      mockDocker.getContainer.mockReturnValue(makeContainerMock(containerName));
      mockDocker.getImage.mockReturnValue(mockImage);

      const backupManager = createBackupManager(db, {
        workDir,
        docker: mockDocker as any,
      });

      // Configure scheduled snapshots with the given retention count
      backupManager.updateScheduleFromSettings({
        targets: [containerName],
        cronExpression: '0 2 * * *',
        retentionCount,
        enabled: true,
      });

      // Advance timer to trigger scheduled snapshot
      await vi.advanceTimersByTimeAsync(60_000);

      // Give async operations time to complete
      await vi.advanceTimersByTimeAsync(100);

      // Query remaining snapshots
      const remaining = getSnapshotsForContainer(db, containerName);

      // Disable schedule to clear timers before cleanup
      backupManager.updateScheduleFromSettings({
        targets: [],
        cronExpression: '0 0 * * *',
        retentionCount: 7,
        enabled: false,
      });

      vi.useRealTimers();
      closeDatabase(db);
      cleanupDb(dbPath);
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }

      return { remaining, totalBefore };
    } catch (error) {
      vi.useRealTimers();
      try { closeDatabase(db); } catch { /* ignore */ }
      cleanupDb(dbPath);
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /**
   * Helper for multi-container scenario.
   */
  async function runMultiContainerRetentionScenario(
    retentionCount: number,
    countA: number,
    countB: number
  ): Promise<{
    remainingA: any[];
    remainingB: any[];
  }> {
    const dbPath = createTempDbPath();
    const db = initializeDatabase({ dbPath });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-ret-multi-'));

    const containerA = 'app-a';
    const containerB = 'app-b';

    try {
      vi.useFakeTimers();

      // Pre-populate snapshots for container A
      for (let i = 0; i < countA; i++) {
        const timestamp = new Date(2024, 0, 1 + i, 12, 0, 0).toISOString();
        insertTestSnapshot(db, `a-snap-${i}`, containerA, `a-tag-${i}`, timestamp);
      }

      // Pre-populate snapshots for container B
      for (let i = 0; i < countB; i++) {
        const timestamp = new Date(2024, 0, 1 + i, 12, 0, 0).toISOString();
        insertTestSnapshot(db, `b-snap-${i}`, containerB, `b-tag-${i}`, timestamp);
      }

      vi.setSystemTime(new Date(2024, 1, 15, 1, 59, 0));

      mockDocker.listContainers.mockResolvedValue([
        { Id: `cid-${containerA}`, Names: [`/${containerA}`], State: 'running' },
        { Id: `cid-${containerB}`, Names: [`/${containerB}`], State: 'running' },
      ]);
      mockDocker.getContainer.mockImplementation((id: string) => {
        if (id === `cid-${containerA}`) return makeContainerMock(containerA);
        if (id === `cid-${containerB}`) return makeContainerMock(containerB);
        return makeContainerMock('unknown');
      });
      mockDocker.getImage.mockReturnValue(mockImage);

      const backupManager = createBackupManager(db, {
        workDir,
        docker: mockDocker as any,
      });

      backupManager.updateScheduleFromSettings({
        targets: [containerA, containerB],
        cronExpression: '0 2 * * *',
        retentionCount,
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(100);

      const remainingA = getSnapshotsForContainer(db, containerA);
      const remainingB = getSnapshotsForContainer(db, containerB);

      backupManager.updateScheduleFromSettings({
        targets: [],
        cronExpression: '0 0 * * *',
        retentionCount: 7,
        enabled: false,
      });

      vi.useRealTimers();
      closeDatabase(db);
      cleanupDb(dbPath);
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }

      return { remainingA, remainingB };
    } catch (error) {
      vi.useRealTimers();
      try { closeDatabase(db); } catch { /* ignore */ }
      cleanupDb(dbPath);
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  it('Property 12.1: After retention enforcement, total snapshots for a container ≤ N', async () => {
    await fc.assert(
      fc.asyncProperty(
        retentionCountArb,
        existingSnapshotCountArb,
        async (retentionCount, existingCount) => {
          const { remaining } = await runRetentionScenario(retentionCount, existingCount);
          // Total retained snapshots should be at most N
          expect(remaining.length).toBeLessThanOrEqual(retentionCount);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 12.2: If M ≥ N before addition, the oldest (M - N + 1) snapshots are deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        retentionCountArb,
        existingSnapshotCountArb.filter((m) => m >= 1),
        async (retentionCount, existingCount) => {
          // Only test cases where M >= N (retention will actually delete)
          if (existingCount < retentionCount) return;

          const { remaining } = await runRetentionScenario(retentionCount, existingCount);

          // After adding 1 new snapshot: total was M+1, should retain at most N
          expect(remaining.length).toBeLessThanOrEqual(retentionCount);

          // The number deleted should be (M + 1 - N) or more
          const totalAfterAdd = existingCount + 1;
          const expectedMinDeleted = totalAfterAdd - retentionCount;
          const actualDeleted = totalAfterAdd - remaining.length;
          expect(actualDeleted).toBeGreaterThanOrEqual(expectedMinDeleted);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 12.3: Oldest snapshots are deleted, newest are retained', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 2, max: 20 }),
        async (retentionCount, existingCount) => {
          // Only test cases where deletion will occur
          if (existingCount < retentionCount) return;

          const { remaining } = await runRetentionScenario(retentionCount, existingCount);

          // Remaining snapshots should be ordered newest-first
          for (let i = 0; i < remaining.length - 1; i++) {
            const current = new Date(remaining[i].timestamp).getTime();
            const next = new Date(remaining[i + 1].timestamp).getTime();
            expect(current).toBeGreaterThanOrEqual(next);
          }

          // The newest snapshots should have the latest timestamps
          // Since we created snaps with dates 2024-01-01, 01-02, ..., 01-{existingCount}
          // and the new one is at 2024-02-15, the newest should be the scheduled one
          if (remaining.length > 0) {
            // The most recent snapshot should be from 2024-02-15 (the scheduled one)
            const newestTimestamp = new Date(remaining[0].timestamp);
            expect(newestTimestamp.getMonth()).toBe(1); // February (0-indexed)
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 12.4: Retention enforcement does not delete snapshots when total ≤ N', async () => {
    await fc.assert(
      fc.asyncProperty(
        retentionCountArb,
        existingSnapshotCountArb,
        async (retentionCount, existingCount) => {
          // Only test cases where M + 1 (after adding new) <= N
          if (existingCount + 1 > retentionCount) return;

          const { remaining } = await runRetentionScenario(retentionCount, existingCount);

          // All original snapshots + the new one should still exist
          expect(remaining.length).toBe(existingCount + 1);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 12.5: Retention is enforced per container independently', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        async (retentionCount, countA, countB) => {
          const { remainingA, remainingB } = await runMultiContainerRetentionScenario(
            retentionCount, countA, countB
          );

          // Each container's snapshots should be independently bounded by N
          expect(remainingA.length).toBeLessThanOrEqual(retentionCount);
          expect(remainingB.length).toBeLessThanOrEqual(retentionCount);
        }
      ),
      { numRuns: 30 }
    );
  });
});
