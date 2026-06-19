/**
 * Unit tests for the Historical Metrics Service.
 * Tests store, query (with time range and resolution), purgeOldRecords, and validation.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createHistoricalMetricsService,
  HistoricalMetricsError,
  type HistoricalMetricsService,
} from '../../src/services/historical-metrics.js';
import type { PgClient } from '../../src/database/pg-client.js';
import type { SystemMetricsResponse } from '../../src/services/metrics-collector.js';

// ─── Mock PgClient ─────────────────────────────────────────────────────────────

function createMockPgClient(queryResult: any[] = []): PgClient & { queryCalls: Array<{ sql: string; params?: unknown[] }> } {
  const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];

  return {
    queryCalls,
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      queryCalls.push({ sql, params });
      return queryResult;
    }),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(true),
  };
}

// ─── Sample metrics ────────────────────────────────────────────────────────────

function createSampleMetrics(overrides?: Partial<SystemMetricsResponse>): SystemMetricsResponse {
  return {
    cpu: { usagePercent: 45.5 },
    memory: { usedBytes: 4_000_000_000, totalBytes: 8_000_000_000 },
    disk: { usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
    network: { rxBytesPerSec: 1024, txBytesPerSec: 2048 },
    timestamp: '2024-01-15T10:30:00.000Z',
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Historical Metrics Service', () => {
  let pgClient: ReturnType<typeof createMockPgClient>;
  let service: HistoricalMetricsService;

  beforeEach(() => {
    pgClient = createMockPgClient();
    service = createHistoricalMetricsService(pgClient);
  });

  // ─── store() ───────────────────────────────────────────────────────────────

  describe('store()', () => {
    it('should insert metrics into monitoring.system_metrics', async () => {
      const metrics = createSampleMetrics();
      await service.store(metrics);

      expect(pgClient.queryCalls).toHaveLength(1);
      const call = pgClient.queryCalls[0];
      expect(call.sql).toContain('INSERT INTO monitoring.system_metrics');
      expect(call.params).toEqual([
        '2024-01-15T10:30:00.000Z',
        45.5,
        4_000_000_000,
        8_000_000_000,
        50_000_000_000,
        100_000_000_000,
        1024,
        2048,
      ]);
    });

    it('should include all required columns in the INSERT', async () => {
      const metrics = createSampleMetrics();
      await service.store(metrics);

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('timestamp');
      expect(sql).toContain('cpu_usage_percent');
      expect(sql).toContain('memory_used_bytes');
      expect(sql).toContain('memory_total_bytes');
      expect(sql).toContain('disk_used_bytes');
      expect(sql).toContain('disk_total_bytes');
      expect(sql).toContain('network_rx_bytes_per_sec');
      expect(sql).toContain('network_tx_bytes_per_sec');
    });
  });

  // ─── query() - validation ──────────────────────────────────────────────────

  describe('query() - parameter validation', () => {
    it('should throw INVALID_PARAMS (400) for invalid start parameter', async () => {
      await expect(
        service.query({ start: 'not-a-date', end: '2024-01-15T12:00:00Z' })
      ).rejects.toThrow(HistoricalMetricsError);

      try {
        await service.query({ start: 'not-a-date', end: '2024-01-15T12:00:00Z' });
      } catch (err) {
        expect(err).toBeInstanceOf(HistoricalMetricsError);
        expect((err as HistoricalMetricsError).code).toBe('INVALID_PARAMS');
        expect((err as HistoricalMetricsError).statusCode).toBe(400);
      }
    });

    it('should throw INVALID_PARAMS (400) for invalid end parameter', async () => {
      await expect(
        service.query({ start: '2024-01-15T10:00:00Z', end: 'garbage' })
      ).rejects.toThrow(HistoricalMetricsError);

      try {
        await service.query({ start: '2024-01-15T10:00:00Z', end: 'garbage' });
      } catch (err) {
        expect(err).toBeInstanceOf(HistoricalMetricsError);
        expect((err as HistoricalMetricsError).code).toBe('INVALID_PARAMS');
        expect((err as HistoricalMetricsError).statusCode).toBe(400);
      }
    });

    it('should throw INVALID_PARAMS (400) for empty start string', async () => {
      await expect(
        service.query({ start: '', end: '2024-01-15T12:00:00Z' })
      ).rejects.toThrow(HistoricalMetricsError);
    });

    it('should throw INVALID_PARAMS for invalid resolution', async () => {
      await expect(
        service.query({
          start: '2024-01-15T10:00:00Z',
          end: '2024-01-15T12:00:00Z',
          resolution: '2m' as any,
        })
      ).rejects.toThrow(HistoricalMetricsError);
    });

    it('should accept valid ISO 8601 timestamps', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      const result = await service.query({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T12:00:00Z',
      });

      expect(result).toEqual([]);
      expect(pgClient.queryCalls).toHaveLength(1);
    });
  });

  // ─── query() - resolution logic ───────────────────────────────────────────

  describe('query() - resolution and aggregation', () => {
    it('should default to 5m resolution when range exceeds 24h and no resolution specified', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.query({
        start: '2024-01-13T00:00:00Z',
        end: '2024-01-15T12:00:00Z',  // > 24 hours
      });

      const sql = pgClient.queryCalls[0].sql;
      // Should contain time bucket aggregation for 5m
      expect(sql).toContain('FLOOR(EXTRACT(MINUTE FROM timestamp) / 5)');
      expect(sql).toContain('GROUP BY bucket');
    });

    it('should NOT aggregate when range is under 24h and no resolution specified', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.query({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T12:00:00Z',  // 2 hours
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).not.toContain('GROUP BY');
      expect(sql).toContain('ORDER BY timestamp ASC');
    });

    it('should use date_trunc minute for 1m resolution', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.query({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T12:00:00Z',
        resolution: '1m',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain("date_trunc('minute', timestamp)");
      expect(sql).toContain('GROUP BY bucket');
    });

    it('should use date_trunc hour for 1h resolution', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.query({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T18:00:00Z',
        resolution: '1h',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain("date_trunc('hour', timestamp)");
      expect(sql).toContain('GROUP BY bucket');
    });

    it('should use 15-minute bucket for 15m resolution', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.query({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T18:00:00Z',
        resolution: '15m',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('FLOOR(EXTRACT(MINUTE FROM timestamp) / 15)');
      expect(sql).toContain('GROUP BY bucket');
    });

    it('should filter by time range using WHERE clause', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.query({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T12:00:00Z',
      });

      const call = pgClient.queryCalls[0];
      expect(call.sql).toContain('WHERE timestamp >= $1 AND timestamp <= $2');
      expect(call.params).toEqual([
        '2024-01-15T10:00:00.000Z',
        '2024-01-15T12:00:00.000Z',
      ]);
    });
  });

  // ─── query() - result mapping ─────────────────────────────────────────────

  describe('query() - result mapping', () => {
    it('should map database rows to TimeSeriesDataPoint format', async () => {
      const mockRows = [
        {
          bucket: new Date('2024-01-15T10:00:00Z'),
          cpu_usage_percent: 55.123,
          memory_used_bytes: '4000000000',
          memory_total_bytes: '8000000000',
          disk_used_bytes: '50000000000',
          disk_total_bytes: '100000000000',
          network_rx_bytes_per_sec: '1024',
          network_tx_bytes_per_sec: '2048',
        },
      ];
      pgClient = createMockPgClient(mockRows);
      service = createHistoricalMetricsService(pgClient);

      const result = await service.query({
        start: '2024-01-15T09:00:00Z',
        end: '2024-01-15T11:00:00Z',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        timestamp: '2024-01-15T10:00:00.000Z',
        cpu: { usagePercent: 55.12 },
        memory: { usedBytes: 4_000_000_000, totalBytes: 8_000_000_000 },
        disk: { usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
        network: { rxBytesPerSec: 1024, txBytesPerSec: 2048 },
      });
    });

    it('should handle string timestamps from the database', async () => {
      const mockRows = [
        {
          bucket: '2024-01-15T10:05:00.000Z',
          cpu_usage_percent: 30,
          memory_used_bytes: 2000000000,
          memory_total_bytes: 8000000000,
          disk_used_bytes: 25000000000,
          disk_total_bytes: 100000000000,
          network_rx_bytes_per_sec: 512,
          network_tx_bytes_per_sec: 256,
        },
      ];
      pgClient = createMockPgClient(mockRows);
      service = createHistoricalMetricsService(pgClient);

      const result = await service.query({
        start: '2024-01-15T09:00:00Z',
        end: '2024-01-15T11:00:00Z',
      });

      expect(result[0].timestamp).toBe('2024-01-15T10:05:00.000Z');
    });
  });

  // ─── purgeOldRecords() ─────────────────────────────────────────────────────

  describe('purgeOldRecords()', () => {
    it('should execute DELETE for records older than 7 days', async () => {
      pgClient = createMockPgClient([{ count: '42' }]);
      service = createHistoricalMetricsService(pgClient);

      const count = await service.purgeOldRecords();

      expect(count).toBe(42);
      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('DELETE FROM monitoring.system_metrics');
      expect(sql).toContain("NOW() - INTERVAL '7 days'");
    });

    it('should return 0 when no records are deleted', async () => {
      pgClient = createMockPgClient([{ count: '0' }]);
      service = createHistoricalMetricsService(pgClient);

      const count = await service.purgeOldRecords();
      expect(count).toBe(0);
    });
  });

  // ─── ensurePartitions() ────────────────────────────────────────────────────

  describe('ensurePartitions()', () => {
    it('should call the pgClient to create future partitions', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      // Should not throw
      await service.ensurePartitions();

      // Should have made queries for partition creation
      expect(pgClient.queryCalls.length).toBeGreaterThan(0);
    });
  });
});
