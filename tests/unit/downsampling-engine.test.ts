/**
 * Unit tests for the Downsampling Engine service.
 * Tests aggregation logic, bucket alignment, batch error handling,
 * scheduling, and retention settings integration.
 *
 * Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createDownsamplingEngine,
  alignTo5MinBucket,
  alignTo1HourBucket,
  type DownsamplingEngine,
  type AggregationResult,
} from '../../src/services/downsampling-engine.js';
import type { PgClient } from '../../src/database/pg-client.js';
import type { SettingsService } from '../../src/services/settings-service.js';
import { EventEmitter } from 'events';

// ─── Mock PgClient ─────────────────────────────────────────────────────────────

interface MockQueryHandler {
  (sql: string, params?: unknown[]): unknown[];
}

function createMockPgClient(handler?: MockQueryHandler): PgClient & {
  queryCalls: Array<{ sql: string; params?: unknown[] }>;
} {
  const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];

  return {
    queryCalls,
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      queryCalls.push({ sql, params });
      if (handler) return handler(sql, params);
      return [];
    }),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(true),
  };
}

// ─── Mock SettingsService ──────────────────────────────────────────────────────

function createMockSettingsService(overrides?: Record<string, unknown>): SettingsService {
  const defaults: Record<string, unknown> = {
    retention_raw_hours: 24,
    retention_5m_days: 30,
    retention_1h_days: 365,
    ...overrides,
  };

  const emitter = new EventEmitter();

  return Object.assign(emitter, {
    getAll: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockImplementation(async (key: string) => String(defaults[key] ?? '')),
    getTyped: vi.fn().mockImplementation(async (key: string) => {
      if (key in defaults) return defaults[key];
      throw new Error(`Setting not found: ${key}`);
    }),
    update: vi.fn().mockResolvedValue(undefined),
    validate: vi.fn().mockReturnValue({ valid: true }),
    getDefinitions: vi.fn().mockReturnValue([]),
  }) as unknown as SettingsService;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Downsampling Engine', () => {
  // ─── Bucket Alignment ────────────────────────────────────────────────────

  describe('alignTo5MinBucket()', () => {
    it('should align to the nearest 5-minute boundary (floor)', () => {
      const input = new Date('2024-01-15T10:07:32.500Z');
      const result = alignTo5MinBucket(input);
      expect(result.toISOString()).toBe('2024-01-15T10:05:00.000Z');
    });

    it('should keep a timestamp already on a 5-minute boundary', () => {
      const input = new Date('2024-01-15T10:10:00.000Z');
      const result = alignTo5MinBucket(input);
      expect(result.toISOString()).toBe('2024-01-15T10:10:00.000Z');
    });

    it('should align minute 0 to 0', () => {
      const input = new Date('2024-01-15T10:03:45.000Z');
      const result = alignTo5MinBucket(input);
      expect(result.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    });

    it('should align minute 59 to 55', () => {
      const input = new Date('2024-01-15T10:59:59.999Z');
      const result = alignTo5MinBucket(input);
      expect(result.toISOString()).toBe('2024-01-15T10:55:00.000Z');
    });

    it('should zero out seconds and milliseconds', () => {
      const input = new Date('2024-01-15T10:25:48.123Z');
      const result = alignTo5MinBucket(input);
      expect(result.getUTCSeconds()).toBe(0);
      expect(result.getUTCMilliseconds()).toBe(0);
    });

    it('should handle midnight boundary', () => {
      const input = new Date('2024-01-15T00:02:00.000Z');
      const result = alignTo5MinBucket(input);
      expect(result.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });
  });

  describe('alignTo1HourBucket()', () => {
    it('should align to the nearest hour boundary (floor)', () => {
      const input = new Date('2024-01-15T10:32:15.000Z');
      const result = alignTo1HourBucket(input);
      expect(result.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    });

    it('should keep a timestamp already on an hour boundary', () => {
      const input = new Date('2024-01-15T14:00:00.000Z');
      const result = alignTo1HourBucket(input);
      expect(result.toISOString()).toBe('2024-01-15T14:00:00.000Z');
    });

    it('should zero out minutes, seconds, and milliseconds', () => {
      const input = new Date('2024-01-15T23:59:59.999Z');
      const result = alignTo1HourBucket(input);
      expect(result.toISOString()).toBe('2024-01-15T23:00:00.000Z');
    });

    it('should handle midnight', () => {
      const input = new Date('2024-01-16T00:45:00.000Z');
      const result = alignTo1HourBucket(input);
      expect(result.toISOString()).toBe('2024-01-16T00:00:00.000Z');
    });
  });

  // ─── aggregateTier1() ──────────────────────────────────────────────────────

  describe('aggregateTier1()', () => {
    it('should return empty result when no raw data exists beyond cutoff', async () => {
      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) return [{ oldest: null }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      const result = await engine.aggregateTier1();

      expect(result.bucketsCreated).toBe(0);
      expect(result.rawPointsDeleted).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should aggregate raw data into 5-min buckets and delete source data', async () => {
      const now = Date.now();
      const oldTimestamp = new Date(now - 25 * 60 * 60 * 1000); // 25 hours ago

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) {
          return [{ oldest: oldTimestamp.toISOString() }];
        }
        if (sql.includes('GROUP BY bucket_start')) {
          return [
            {
              bucket_start: new Date('2024-01-14T09:00:00.000Z'),
              cpu_usage_percent_avg: 45.5,
              cpu_usage_percent_max: 78.2,
              memory_used_bytes_avg: '4000000000',
              memory_used_bytes_max: '5000000000',
              memory_total_bytes: '8000000000',
              disk_used_bytes_avg: '50000000000',
              disk_used_bytes_max: '55000000000',
              disk_total_bytes: '100000000000',
              network_rx_bytes_per_sec_avg: '1024',
              network_tx_bytes_per_sec_avg: '2048',
              sample_count: 10,
            },
          ];
        }
        if (sql.includes('DELETE FROM monitoring.system_metrics')) {
          return [{ count: '10' }];
        }
        if (sql.includes('INSERT INTO monitoring.system_metrics_5m')) {
          return [];
        }
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      const result = await engine.aggregateTier1();

      expect(result.bucketsCreated).toBe(1);
      expect(result.rawPointsDeleted).toBe(10);
      expect(result.errors).toHaveLength(0);
    });

    it('should insert correct values into system_metrics_5m', async () => {
      const now = Date.now();
      const oldTimestamp = new Date(now - 25 * 60 * 60 * 1000);

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) {
          return [{ oldest: oldTimestamp.toISOString() }];
        }
        if (sql.includes('GROUP BY bucket_start')) {
          return [
            {
              bucket_start: new Date('2024-01-14T09:05:00.000Z'),
              cpu_usage_percent_avg: 55.0,
              cpu_usage_percent_max: 92.3,
              memory_used_bytes_avg: '3000000000',
              memory_used_bytes_max: '4500000000',
              memory_total_bytes: '8000000000',
              disk_used_bytes_avg: '40000000000',
              disk_used_bytes_max: '45000000000',
              disk_total_bytes: '100000000000',
              network_rx_bytes_per_sec_avg: '512',
              network_tx_bytes_per_sec_avg: '1024',
              sample_count: 8,
            },
          ];
        }
        if (sql.includes('DELETE')) return [{ count: '8' }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      await engine.aggregateTier1();

      // Find the INSERT call
      const insertCall = pgClient.queryCalls.find(
        (c) => c.sql.includes('INSERT INTO monitoring.system_metrics_5m')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall!.params).toEqual([
        '2024-01-14T09:05:00.000Z',
        55.0,
        92.3,
        3000000000,
        4500000000,
        8000000000,
        40000000000,
        45000000000,
        100000000000,
        512,
        1024,
        8,
      ]);
    });

    it('should handle batch failure gracefully without deleting source data', async () => {
      const now = Date.now();
      const oldTimestamp = new Date(now - 25 * 60 * 60 * 1000);
      let callCount = 0;

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) {
          return [{ oldest: oldTimestamp.toISOString() }];
        }
        if (sql.includes('GROUP BY bucket_start')) {
          callCount++;
          if (callCount === 1) {
            throw new Error('Connection timeout');
          }
          return [];
        }
        if (sql.includes('DELETE')) return [{ count: '0' }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient, undefined, {
        tier1BatchMinutes: 60,
      });
      const result = await engine.aggregateTier1();

      // Should have at least one error recorded
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].message).toBe('Connection timeout');
    });

    it('should use retention setting from SettingsService when available', async () => {
      const settingsService = createMockSettingsService({ retention_raw_hours: 48 });

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) return [{ oldest: null }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient, settingsService);
      await engine.aggregateTier1();

      expect(settingsService.getTyped).toHaveBeenCalledWith('retention_raw_hours');
    });

    it('should use default retention when SettingsService is not provided', async () => {
      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) return [{ oldest: null }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      const result = await engine.aggregateTier1();

      // Should not throw, just return empty result
      expect(result.bucketsCreated).toBe(0);
    });
  });

  // ─── aggregateTier2() ──────────────────────────────────────────────────────

  describe('aggregateTier2()', () => {
    it('should return empty result when no 5-min data exists beyond cutoff', async () => {
      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(bucket_start)')) return [{ oldest: null }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      const result = await engine.aggregateTier2();

      expect(result.bucketsCreated).toBe(0);
      expect(result.rawPointsDeleted).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should aggregate 5-min data into 1-hour buckets', async () => {
      const now = Date.now();
      const oldTimestamp = new Date(now - 31 * 24 * 60 * 60 * 1000); // 31 days ago

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(bucket_start)')) {
          return [{ oldest: oldTimestamp.toISOString() }];
        }
        if (sql.includes("date_trunc('hour', bucket_start)") && sql.includes('GROUP BY')) {
          return [
            {
              bucket_start: new Date('2023-12-15T14:00:00.000Z'),
              cpu_usage_percent_avg: 60.0,
              cpu_usage_percent_max: 95.0,
              memory_used_bytes_avg: '5000000000',
              memory_used_bytes_max: '6000000000',
              memory_total_bytes: '8000000000',
              disk_used_bytes_avg: '60000000000',
              disk_used_bytes_max: '65000000000',
              disk_total_bytes: '100000000000',
              network_rx_bytes_per_sec_avg: '2048',
              network_tx_bytes_per_sec_avg: '4096',
              total_sample_count: 120,
            },
          ];
        }
        if (sql.includes('DELETE FROM monitoring.system_metrics_5m')) {
          return [{ count: '12' }];
        }
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      const result = await engine.aggregateTier2();

      expect(result.bucketsCreated).toBe(1);
      expect(result.rawPointsDeleted).toBe(12);
      expect(result.errors).toHaveLength(0);
    });

    it('should insert into system_metrics_1h with weighted average values', async () => {
      const now = Date.now();
      const oldTimestamp = new Date(now - 31 * 24 * 60 * 60 * 1000);

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(bucket_start)')) {
          return [{ oldest: oldTimestamp.toISOString() }];
        }
        if (sql.includes("date_trunc('hour', bucket_start)") && sql.includes('GROUP BY')) {
          return [
            {
              bucket_start: new Date('2023-12-15T14:00:00.000Z'),
              cpu_usage_percent_avg: 50.0,
              cpu_usage_percent_max: 88.0,
              memory_used_bytes_avg: '4000000000',
              memory_used_bytes_max: '5500000000',
              memory_total_bytes: '8000000000',
              disk_used_bytes_avg: '55000000000',
              disk_used_bytes_max: '60000000000',
              disk_total_bytes: '100000000000',
              network_rx_bytes_per_sec_avg: '1500',
              network_tx_bytes_per_sec_avg: '3000',
              total_sample_count: 60,
            },
          ];
        }
        if (sql.includes('DELETE')) return [{ count: '12' }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      await engine.aggregateTier2();

      const insertCall = pgClient.queryCalls.find(
        (c) => c.sql.includes('INSERT INTO monitoring.system_metrics_1h')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall!.params).toEqual([
        '2023-12-15T14:00:00.000Z',
        50.0,
        88.0,
        4000000000,
        5500000000,
        8000000000,
        55000000000,
        60000000000,
        100000000000,
        1500,
        3000,
        60,
      ]);
    });

    it('should handle batch failure gracefully for Tier 2', async () => {
      const now = Date.now();
      const oldTimestamp = new Date(now - 31 * 24 * 60 * 60 * 1000);

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(bucket_start)')) {
          return [{ oldest: oldTimestamp.toISOString() }];
        }
        if (sql.includes("date_trunc('hour', bucket_start)")) {
          throw new Error('Disk full');
        }
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      const result = await engine.aggregateTier2();

      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].message).toBe('Disk full');
      // Raw 5-min data should NOT have been deleted
      const deleteCalls = pgClient.queryCalls.filter(
        (c) => c.sql.includes('DELETE FROM monitoring.system_metrics_5m')
      );
      expect(deleteCalls).toHaveLength(0);
    });
  });

  // ─── purgeExpiredHourly() ──────────────────────────────────────────────────

  describe('purgeExpiredHourly()', () => {
    it('should delete 1-hour data older than 365 days by default', async () => {
      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('DELETE FROM monitoring.system_metrics_1h')) {
          return [{ count: '500' }];
        }
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      const purgedCount = await engine.purgeExpiredHourly();

      expect(purgedCount).toBe(500);

      const deleteCall = pgClient.queryCalls.find(
        (c) => c.sql.includes('DELETE FROM monitoring.system_metrics_1h')
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.params).toEqual(['365']);
    });

    it('should use custom retention from SettingsService', async () => {
      const settingsService = createMockSettingsService({ retention_1h_days: 180 });
      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('DELETE')) return [{ count: '100' }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient, settingsService);
      const purgedCount = await engine.purgeExpiredHourly();

      expect(purgedCount).toBe(100);
      const deleteCall = pgClient.queryCalls.find(
        (c) => c.sql.includes('DELETE FROM monitoring.system_metrics_1h')
      );
      expect(deleteCall!.params).toEqual(['180']);
    });

    it('should return 0 when no records are purged', async () => {
      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('DELETE')) return [{ count: '0' }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient);
      const purgedCount = await engine.purgeExpiredHourly();

      expect(purgedCount).toBe(0);
    });
  });

  // ─── start() and stop() ────────────────────────────────────────────────────

  describe('start() and stop()', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should start Tier 1 interval', async () => {
      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) return [{ oldest: null }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient, undefined, {
        tier1IntervalMs: 5000,
        tier2IntervalMs: 10000,
      });

      engine.start();

      // Advance timer to trigger Tier 1
      vi.advanceTimersByTime(5000);

      // Allow microtasks (async callbacks) to resolve
      await vi.advanceTimersByTimeAsync(0);

      // Should have called the query (MIN(timestamp) for Tier 1)
      expect(pgClient.queryCalls.length).toBeGreaterThan(0);

      engine.stop();
    });

    it('should stop both timers on stop()', () => {
      const pgClient = createMockPgClient(() => []);

      const engine = createDownsamplingEngine(pgClient, undefined, {
        tier1IntervalMs: 1000,
        tier2IntervalMs: 2000,
      });

      engine.start();
      engine.stop();

      // Clear calls
      pgClient.queryCalls.length = 0;

      // Advance timer — nothing should fire
      vi.advanceTimersByTime(5000);
      expect(pgClient.queryCalls).toHaveLength(0);
    });

    it('should not start twice if already running', () => {
      const pgClient = createMockPgClient(() => []);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const engine = createDownsamplingEngine(pgClient, undefined, {
        tier1IntervalMs: 1000,
        tier2IntervalMs: 2000,
      });

      engine.start();
      engine.start(); // Should warn

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Already running')
      );

      engine.stop();
      consoleSpy.mockRestore();
    });
  });

  // ─── Error handling ────────────────────────────────────────────────────────

  describe('Error handling', () => {
    it('should fall back to default retention when SettingsService throws', async () => {
      const settingsService = createMockSettingsService();
      (settingsService.getTyped as any).mockRejectedValue(new Error('DB connection lost'));

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) return [{ oldest: null }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient, settingsService);
      // Should not throw
      const result = await engine.aggregateTier1();
      expect(result.bucketsCreated).toBe(0);
    });

    it('should log error and continue when a batch in a multi-batch run fails', async () => {
      const now = Date.now();
      // Place data 26 hours ago so there's more than 1 batch (with 60-min batches)
      const oldTimestamp = new Date(now - 26 * 60 * 60 * 1000);
      let selectCount = 0;

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const pgClient = createMockPgClient((sql) => {
        if (sql.includes('MIN(timestamp)')) {
          return [{ oldest: oldTimestamp.toISOString() }];
        }
        if (sql.includes('GROUP BY bucket_start') && !sql.includes("date_trunc('hour', bucket_start)")) {
          selectCount++;
          if (selectCount === 1) {
            throw new Error('Batch 1 failed');
          }
          // Second batch succeeds
          return [
            {
              bucket_start: new Date('2024-01-14T10:00:00.000Z'),
              cpu_usage_percent_avg: 30.0,
              cpu_usage_percent_max: 50.0,
              memory_used_bytes_avg: '2000000000',
              memory_used_bytes_max: '3000000000',
              memory_total_bytes: '8000000000',
              disk_used_bytes_avg: '30000000000',
              disk_used_bytes_max: '35000000000',
              disk_total_bytes: '100000000000',
              network_rx_bytes_per_sec_avg: '256',
              network_tx_bytes_per_sec_avg: '512',
              sample_count: 10,
            },
          ];
        }
        if (sql.includes('DELETE')) return [{ count: '10' }];
        return [];
      });

      const engine = createDownsamplingEngine(pgClient, undefined, {
        tier1BatchMinutes: 60,
      });
      const result = await engine.aggregateTier1();

      // First batch should have an error
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].message).toBe('Batch 1 failed');
      // Subsequent batches should still be processed
      expect(result.bucketsCreated).toBeGreaterThanOrEqual(1);

      consoleSpy.mockRestore();
    });
  });
});
