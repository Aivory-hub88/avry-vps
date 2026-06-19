/**
 * Unit tests for Enhanced Partition Manager
 *
 * Tests cover: ensureFuturePartitions, pruneExpiredPartitions,
 * verifyAndRepair, listPartitions, error handling with alert emission.
 *
 * @validates Requirements 2.1, 2.2, 2.3, 2.4, 2.5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPartitionManager,
  _internals,
  type AlertCallback,
  type PartitionManagerInstance,
} from '../../src/database/partition-manager.js';
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

// ─── Utility Function Tests ────────────────────────────────────────────────────

describe('Partition Manager Internals', () => {
  describe('getWeekStart', () => {
    it('should return Monday 00:00 UTC for a Wednesday', () => {
      // 2024-01-10 is a Wednesday
      const date = new Date('2024-01-10T14:30:00Z');
      const weekStart = _internals.getWeekStart(date);
      expect(weekStart.toISOString()).toBe('2024-01-08T00:00:00.000Z');
    });

    it('should return the same date for a Monday', () => {
      // 2024-01-08 is a Monday
      const date = new Date('2024-01-08T10:00:00Z');
      const weekStart = _internals.getWeekStart(date);
      expect(weekStart.toISOString()).toBe('2024-01-08T00:00:00.000Z');
    });

    it('should go back 6 days for a Sunday', () => {
      // 2024-01-14 is a Sunday
      const date = new Date('2024-01-14T23:59:59Z');
      const weekStart = _internals.getWeekStart(date);
      expect(weekStart.toISOString()).toBe('2024-01-08T00:00:00.000Z');
    });
  });

  describe('formatPartitionSuffix', () => {
    it('should format date as YYYY_MM_DD', () => {
      const date = new Date('2024-03-15T00:00:00Z');
      expect(_internals.formatPartitionSuffix(date)).toBe('2024_03_15');
    });

    it('should zero-pad month and day', () => {
      const date = new Date('2024-01-05T00:00:00Z');
      expect(_internals.formatPartitionSuffix(date)).toBe('2024_01_05');
    });
  });

  describe('getPartitionName', () => {
    it('should replace dot with underscore and append date suffix', () => {
      const date = new Date('2024-01-08T00:00:00Z');
      const name = _internals.getPartitionName('monitoring.system_metrics', date);
      expect(name).toBe('monitoring_system_metrics_2024_01_08');
    });
  });

  describe('PARTITIONED_TABLES', () => {
    it('should contain all 5 partitioned tables', () => {
      expect(_internals.PARTITIONED_TABLES).toHaveLength(5);
      expect(_internals.PARTITIONED_TABLES).toContain('monitoring.system_metrics');
      expect(_internals.PARTITIONED_TABLES).toContain('monitoring.container_snapshots');
      expect(_internals.PARTITIONED_TABLES).toContain('monitoring.system_metrics_5m');
      expect(_internals.PARTITIONED_TABLES).toContain('monitoring.system_metrics_1h');
      expect(_internals.PARTITIONED_TABLES).toContain('monitoring.container_metrics_5m');
    });
  });
});

// ─── ensureFuturePartitions Tests ──────────────────────────────────────────────

describe('PartitionManager.ensureFuturePartitions', () => {
  let mockClient: PgClient;
  let queryCalls: string[];
  let manager: PartitionManagerInstance;

  beforeEach(() => {
    queryCalls = [];
    mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        queryCalls.push(sql);
        return [];
      }),
    });
    manager = createPartitionManager(mockClient);
  });

  it('should create partitions for the current week and 4 future weeks', async () => {
    await manager.ensureFuturePartitions();

    // 5 tables × (1 current + 4 future) = 25 partition creation queries
    const partitionCreations = queryCalls.filter((q) => q.includes('PARTITION OF'));
    expect(partitionCreations.length).toBe(25);
  });

  it('should create partitions for all 5 partitioned tables', async () => {
    await manager.ensureFuturePartitions();

    for (const table of _internals.PARTITIONED_TABLES) {
      const regex = new RegExp(`PARTITION OF ${table.replace(/\./g, '\\.')}\\s`);
      const partitionsForTable = queryCalls.filter((q) => regex.test(q));
      expect(partitionsForTable.length).toBe(5); // current + 4 future
    }
  });

  it('should use CREATE TABLE IF NOT EXISTS for idempotency', async () => {
    await manager.ensureFuturePartitions();

    const partitionCreations = queryCalls.filter((q) => q.includes('PARTITION OF'));
    for (const sql of partitionCreations) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
    }
  });

  it('should respect custom futureWeeks config', async () => {
    const customManager = createPartitionManager(mockClient, { futureWeeks: 2 });
    await customManager.ensureFuturePartitions();

    // 5 tables × (1 current + 2 future) = 15 partition creation queries
    const partitionCreations = queryCalls.filter((q) => q.includes('PARTITION OF'));
    expect(partitionCreations.length).toBe(15);
  });
});

// ─── pruneExpiredPartitions Tests ──────────────────────────────────────────────

describe('PartitionManager.pruneExpiredPartitions', () => {
  it('should drop partitions whose rangeEnd is before the cutoff date', async () => {
    const queryCalls: string[] = [];
    const oldDate = new Date('2023-01-01T00:00:00Z');
    const oldDateEnd = new Date('2023-01-08T00:00:00Z');

    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        queryCalls.push(sql);
        // Return expired partition for listPartitions query
        if (sql.includes('pg_inherits')) {
          return [
            {
              partition_name: 'monitoring_system_metrics_2023_01_01',
              partition_bounds: `FOR VALUES FROM ('${oldDate.toISOString()}') TO ('${oldDateEnd.toISOString()}')`,
              estimated_rows: '100',
            },
          ];
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient);
    const dropped = await manager.pruneExpiredPartitions(365);

    expect(dropped).toContain('monitoring_system_metrics_2023_01_01');
    expect(queryCalls.some((q) => q.includes('DROP TABLE IF EXISTS'))).toBe(true);
  });

  it('should NOT drop partitions that are within the retention period', async () => {
    const queryCalls: string[] = [];
    const recentDate = new Date();
    recentDate.setUTCDate(recentDate.getUTCDate() - 7); // Last week
    const recentDateEnd = new Date(recentDate);
    recentDateEnd.setUTCDate(recentDateEnd.getUTCDate() + 7);

    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        queryCalls.push(sql);
        if (sql.includes('pg_inherits')) {
          return [
            {
              partition_name: 'monitoring_system_metrics_recent',
              partition_bounds: `FOR VALUES FROM ('${recentDate.toISOString()}') TO ('${recentDateEnd.toISOString()}')`,
              estimated_rows: '500',
            },
          ];
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient);
    const dropped = await manager.pruneExpiredPartitions(365);

    expect(dropped).toHaveLength(0);
    expect(queryCalls.some((q) => q.includes('DROP TABLE IF EXISTS'))).toBe(false);
  });

  it('should return the names of all dropped partitions', async () => {
    const oldDate1 = new Date('2022-06-01T00:00:00Z');
    const oldDate1End = new Date('2022-06-08T00:00:00Z');
    const oldDate2 = new Date('2022-06-08T00:00:00Z');
    const oldDate2End = new Date('2022-06-15T00:00:00Z');

    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_inherits')) {
          return [
            {
              partition_name: 'monitoring_system_metrics_2022_06_01',
              partition_bounds: `FOR VALUES FROM ('${oldDate1.toISOString()}') TO ('${oldDate1End.toISOString()}')`,
              estimated_rows: '50',
            },
            {
              partition_name: 'monitoring_system_metrics_2022_06_08',
              partition_bounds: `FOR VALUES FROM ('${oldDate2.toISOString()}') TO ('${oldDate2End.toISOString()}')`,
              estimated_rows: '60',
            },
          ];
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient);
    const dropped = await manager.pruneExpiredPartitions(365);

    expect(dropped.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── verifyAndRepair Tests ─────────────────────────────────────────────────────

describe('PartitionManager.verifyAndRepair', () => {
  it('should report healthy=true when all expected partitions exist', async () => {
    const now = new Date();
    const currentWeekStart = _internals.getWeekStart(now);

    // Generate expected partition names for all tables
    const weekStarts: Date[] = [];
    const pastWeek = new Date(currentWeekStart);
    pastWeek.setUTCDate(pastWeek.getUTCDate() - 7);
    weekStarts.push(pastWeek);
    weekStarts.push(currentWeekStart);
    for (let i = 1; i <= 4; i++) {
      const fw = new Date(currentWeekStart);
      fw.setUTCDate(fw.getUTCDate() + i * 7);
      weekStarts.push(fw);
    }

    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_inherits')) {
          const tableName = params?.[0] as string;
          // Return all expected partitions for this table
          return weekStarts.map((ws) => {
            const we = new Date(ws);
            we.setUTCDate(we.getUTCDate() + 7);
            return {
              partition_name: _internals.getPartitionName(tableName, ws),
              partition_bounds: `FOR VALUES FROM ('${ws.toISOString()}') TO ('${we.toISOString()}')`,
              estimated_rows: '100',
            };
          });
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient);
    const status = await manager.verifyAndRepair();

    expect(status.healthy).toBe(true);
    expect(status.missingPartitions).toBe(0);
    expect(status.createdPartitions).toHaveLength(0);
  });

  it('should create missing partitions and report them', async () => {
    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        // Return no existing partitions (all missing)
        if (sql.includes('pg_inherits')) {
          return [];
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient);
    const status = await manager.verifyAndRepair();

    // Should detect missing partitions
    expect(status.missingPartitions).toBeGreaterThan(0);
    // Should create them all
    expect(status.createdPartitions.length).toBe(status.missingPartitions);
    // healthy = true because all missing were successfully created
    expect(status.healthy).toBe(true);
  });

  it('should report healthy=false if some partitions could not be created', async () => {
    let createAttempts = 0;
    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_inherits')) {
          return [];
        }
        // Fail some partition creations
        if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
          createAttempts++;
          if (createAttempts % 3 === 0) {
            throw new Error('Simulated partition creation failure');
          }
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient);
    const status = await manager.verifyAndRepair();

    // Some partitions should have failed
    expect(status.healthy).toBe(false);
    expect(status.createdPartitions.length).toBeLessThan(status.missingPartitions);
  });
});

// ─── listPartitions Tests ──────────────────────────────────────────────────────

describe('PartitionManager.listPartitions', () => {
  it('should query pg_inherits for the given table', async () => {
    const queryMock = vi.fn().mockResolvedValue([]);
    const mockClient = createMockPgClient({ query: queryMock });

    const manager = createPartitionManager(mockClient);
    await manager.listPartitions('monitoring.system_metrics');

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('pg_inherits'),
      ['monitoring.system_metrics']
    );
  });

  it('should parse partition bounds correctly', async () => {
    const start = '2024-01-08T00:00:00.000Z';
    const end = '2024-01-15T00:00:00.000Z';

    const mockClient = createMockPgClient({
      query: vi.fn().mockResolvedValue([
        {
          partition_name: 'monitoring_system_metrics_2024_01_08',
          partition_bounds: `FOR VALUES FROM ('${start}') TO ('${end}')`,
          estimated_rows: '1500',
        },
      ]),
    });

    const manager = createPartitionManager(mockClient);
    const partitions = await manager.listPartitions('monitoring.system_metrics');

    expect(partitions).toHaveLength(1);
    expect(partitions[0].name).toBe('monitoring_system_metrics_2024_01_08');
    expect(partitions[0].rangeStart.toISOString()).toBe(start);
    expect(partitions[0].rangeEnd.toISOString()).toBe(end);
    expect(partitions[0].estimatedRows).toBe(1500);
  });

  it('should handle partitions with zero estimated rows', async () => {
    const mockClient = createMockPgClient({
      query: vi.fn().mockResolvedValue([
        {
          partition_name: 'monitoring_system_metrics_2024_02_05',
          partition_bounds: `FOR VALUES FROM ('2024-02-05T00:00:00.000Z') TO ('2024-02-12T00:00:00.000Z')`,
          estimated_rows: '-1',
        },
      ]),
    });

    const manager = createPartitionManager(mockClient);
    const partitions = await manager.listPartitions('monitoring.system_metrics');

    expect(partitions[0].estimatedRows).toBe(0);
  });

  it('should return empty array when no partitions exist', async () => {
    const mockClient = createMockPgClient({
      query: vi.fn().mockResolvedValue([]),
    });

    const manager = createPartitionManager(mockClient);
    const partitions = await manager.listPartitions('monitoring.system_metrics');

    expect(partitions).toHaveLength(0);
  });
});

// ─── Error Handling & Alert Emission Tests ─────────────────────────────────────

describe('PartitionManager error handling', () => {
  it('should emit critical alert when partition creation fails', async () => {
    const alertCalls: any[] = [];
    const onAlert: AlertCallback = vi.fn().mockImplementation(async (event) => {
      alertCalls.push(event);
      return 'alert-id';
    });

    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_inherits')) {
          return [];
        }
        if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
          throw new Error('Disk full');
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient, { onAlert });
    await manager.verifyAndRepair();

    // Should have emitted critical alerts
    expect(alertCalls.length).toBeGreaterThan(0);
    expect(alertCalls[0].severity).toBe('critical');
    expect(alertCalls[0].eventType).toBe('partition_management_failure');
    expect(alertCalls[0].message).toContain('Disk full');
  });

  it('should continue processing remaining partitions after a failure', async () => {
    let createAttempts = 0;
    let successfulCreations = 0;
    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_inherits')) {
          return [];
        }
        if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
          createAttempts++;
          // Fail only the first creation
          if (createAttempts === 1) {
            throw new Error('First partition failed');
          }
          successfulCreations++;
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient);
    await manager.ensureFuturePartitions();

    // Should have attempted multiple creations and most should succeed
    expect(createAttempts).toBeGreaterThan(1);
    expect(successfulCreations).toBe(createAttempts - 1);
  });

  it('should not throw if alert callback itself fails', async () => {
    const onAlert: AlertCallback = vi.fn().mockRejectedValue(new Error('Alert system down'));

    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_inherits')) {
          return [];
        }
        if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
          throw new Error('Partition creation error');
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient, { onAlert });

    // Should not throw even if both partition creation and alert emission fail
    await expect(manager.ensureFuturePartitions()).resolves.toBeUndefined();
  });

  it('should log warning and continue when partition drop fails', async () => {
    const oldDate = new Date('2022-01-01T00:00:00Z');
    const oldDateEnd = new Date('2022-01-08T00:00:00Z');

    const mockClient = createMockPgClient({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_inherits')) {
          return [
            {
              partition_name: 'monitoring_system_metrics_2022_01_01',
              partition_bounds: `FOR VALUES FROM ('${oldDate.toISOString()}') TO ('${oldDateEnd.toISOString()}')`,
              estimated_rows: '50',
            },
          ];
        }
        if (sql.includes('DROP TABLE')) {
          throw new Error('Permission denied');
        }
        return [];
      }),
    });

    const manager = createPartitionManager(mockClient);
    // Should not throw
    const dropped = await manager.pruneExpiredPartitions(365);
    expect(dropped).toHaveLength(0);
  });
});
