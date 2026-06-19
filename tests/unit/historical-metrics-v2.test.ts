/**
 * Unit tests for the Historical Metrics Service V2 extensions.
 * Tests queryV2 with tiered resolution support, auto-resolution selection,
 * container filtering, and avg/max value handling.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 4.3
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createHistoricalMetricsService,
  selectResolutionV2,
  HistoricalMetricsError,
  type HistoricalMetricsService,
  type ResolutionV2,
} from '../../src/services/historical-metrics.js';
import type { PgClient } from '../../src/database/pg-client.js';

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

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Historical Metrics Service V2', () => {
  let pgClient: ReturnType<typeof createMockPgClient>;
  let service: HistoricalMetricsService;

  beforeEach(() => {
    pgClient = createMockPgClient();
    service = createHistoricalMetricsService(pgClient);
  });

  // ─── selectResolutionV2() ──────────────────────────────────────────────────

  describe('selectResolutionV2()', () => {
    it('should return "30s" for range ≤ 24h without explicit resolution', () => {
      const range12h = 12 * 60 * 60 * 1000;
      expect(selectResolutionV2(range12h)).toBe('30s');
    });

    it('should return "30s" for exactly 24h range without explicit resolution', () => {
      const range24h = 24 * 60 * 60 * 1000;
      expect(selectResolutionV2(range24h)).toBe('30s');
    });

    it('should return "5m" for range > 24h and ≤ 30 days without explicit resolution', () => {
      const range3days = 3 * 24 * 60 * 60 * 1000;
      expect(selectResolutionV2(range3days)).toBe('5m');
    });

    it('should return "5m" for exactly 30 days range without explicit resolution', () => {
      const range30d = 30 * 24 * 60 * 60 * 1000;
      expect(selectResolutionV2(range30d)).toBe('5m');
    });

    it('should return "1h" for range > 30 days without explicit resolution', () => {
      const range60d = 60 * 24 * 60 * 60 * 1000;
      expect(selectResolutionV2(range60d)).toBe('1h');
    });

    it('should override auto-selection when explicit resolution is provided', () => {
      const range60d = 60 * 24 * 60 * 60 * 1000; // Would auto-select '1h'
      expect(selectResolutionV2(range60d, '30s')).toBe('30s');
      expect(selectResolutionV2(range60d, '5m')).toBe('5m');
    });

    it('should allow explicit "1h" even for short ranges', () => {
      const range2h = 2 * 60 * 60 * 1000; // Would auto-select '30s'
      expect(selectResolutionV2(range2h, '1h')).toBe('1h');
    });
  });

  // ─── queryV2() - validation ────────────────────────────────────────────────

  describe('queryV2() - parameter validation', () => {
    it('should throw INVALID_PARAMS for invalid start parameter', async () => {
      await expect(
        service.queryV2({ start: 'bad-date', end: '2024-01-15T12:00:00Z' })
      ).rejects.toThrow(HistoricalMetricsError);

      try {
        await service.queryV2({ start: 'bad-date', end: '2024-01-15T12:00:00Z' });
      } catch (err) {
        expect((err as HistoricalMetricsError).code).toBe('INVALID_PARAMS');
        expect((err as HistoricalMetricsError).statusCode).toBe(400);
      }
    });

    it('should throw INVALID_PARAMS for invalid end parameter', async () => {
      await expect(
        service.queryV2({ start: '2024-01-15T10:00:00Z', end: 'garbage' })
      ).rejects.toThrow(HistoricalMetricsError);

      try {
        await service.queryV2({ start: '2024-01-15T10:00:00Z', end: 'garbage' });
      } catch (err) {
        expect((err as HistoricalMetricsError).code).toBe('INVALID_PARAMS');
        expect((err as HistoricalMetricsError).statusCode).toBe(400);
      }
    });

    it('should throw INVALID_PARAMS for invalid resolution', async () => {
      await expect(
        service.queryV2({
          start: '2024-01-15T10:00:00Z',
          end: '2024-01-15T12:00:00Z',
          resolution: '2m' as any,
        })
      ).rejects.toThrow(HistoricalMetricsError);
    });

    it('should accept valid V2 resolution values', async () => {
      const validResolutions: ResolutionV2[] = ['30s', '5m', '1h'];
      for (const res of validResolutions) {
        pgClient = createMockPgClient([]);
        service = createHistoricalMetricsService(pgClient);
        const result = await service.queryV2({
          start: '2024-01-15T10:00:00Z',
          end: '2024-01-15T12:00:00Z',
          resolution: res,
        });
        expect(result).toEqual([]);
      }
    });
  });

  // ─── queryV2() - raw (30s) system queries ──────────────────────────────────

  describe('queryV2() - raw 30s system queries', () => {
    it('should query monitoring.system_metrics for 30s resolution', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T12:00:00Z',
        resolution: '30s',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.system_metrics');
      expect(sql).not.toContain('system_metrics_5m');
      expect(sql).not.toContain('system_metrics_1h');
    });

    it('should auto-select 30s for range ≤ 24h', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T14:00:00Z', // 4 hours
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.system_metrics');
      expect(sql).toContain('WHERE timestamp >= $1 AND timestamp <= $2');
    });

    it('should return data points without max values for raw data', async () => {
      const mockRows = [{
        timestamp: new Date('2024-01-15T10:00:00Z'),
        cpu_usage_percent: 55.5,
        memory_used_bytes: '4000000000',
        memory_total_bytes: '8000000000',
        disk_used_bytes: '50000000000',
        disk_total_bytes: '100000000000',
        network_rx_bytes_per_sec: '1024',
        network_tx_bytes_per_sec: '2048',
      }];
      pgClient = createMockPgClient(mockRows);
      service = createHistoricalMetricsService(pgClient);

      const result = await service.queryV2({
        start: '2024-01-15T09:00:00Z',
        end: '2024-01-15T11:00:00Z',
        resolution: '30s',
      });

      expect(result).toHaveLength(1);
      expect(result[0].cpu.usagePercent).toBe(55.5);
      expect(result[0].cpu.maxPercent).toBeUndefined();
      expect(result[0].memory.usedBytes).toBe(4_000_000_000);
      expect(result[0].memory.maxUsedBytes).toBeUndefined();
      expect(result[0].disk.usedBytes).toBe(50_000_000_000);
      expect(result[0].disk.maxUsedBytes).toBeUndefined();
      expect(result[0].network.rxBytesPerSec).toBe(1024);
      expect(result[0].network.txBytesPerSec).toBe(2048);
    });
  });

  // ─── queryV2() - 5m aggregated system queries ──────────────────────────────

  describe('queryV2() - 5m aggregated system queries', () => {
    it('should query monitoring.system_metrics_5m for 5m resolution', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-13T00:00:00Z',
        end: '2024-01-15T12:00:00Z',
        resolution: '5m',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.system_metrics_5m');
    });

    it('should auto-select 5m for range > 24h and ≤ 30 days', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-10T00:00:00Z',
        end: '2024-01-15T00:00:00Z', // 5 days
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.system_metrics_5m');
    });

    it('should return data points with both avg and max values', async () => {
      const mockRows = [{
        bucket_start: new Date('2024-01-15T10:00:00Z'),
        cpu_usage_percent_avg: 55.5,
        cpu_usage_percent_max: 85.2,
        memory_used_bytes_avg: '4000000000',
        memory_used_bytes_max: '6000000000',
        memory_total_bytes: '8000000000',
        disk_used_bytes_avg: '50000000000',
        disk_used_bytes_max: '60000000000',
        disk_total_bytes: '100000000000',
        network_rx_bytes_per_sec_avg: '1024',
        network_tx_bytes_per_sec_avg: '2048',
      }];
      pgClient = createMockPgClient(mockRows);
      service = createHistoricalMetricsService(pgClient);

      const result = await service.queryV2({
        start: '2024-01-13T00:00:00Z',
        end: '2024-01-15T12:00:00Z',
        resolution: '5m',
      });

      expect(result).toHaveLength(1);
      expect(result[0].cpu.usagePercent).toBe(55.5);
      expect(result[0].cpu.maxPercent).toBe(85.2);
      expect(result[0].memory.usedBytes).toBe(4_000_000_000);
      expect(result[0].memory.maxUsedBytes).toBe(6_000_000_000);
      expect(result[0].memory.totalBytes).toBe(8_000_000_000);
      expect(result[0].disk.usedBytes).toBe(50_000_000_000);
      expect(result[0].disk.maxUsedBytes).toBe(60_000_000_000);
      expect(result[0].disk.totalBytes).toBe(100_000_000_000);
      expect(result[0].network.rxBytesPerSec).toBe(1024);
      expect(result[0].network.txBytesPerSec).toBe(2048);
    });
  });

  // ─── queryV2() - 1h aggregated system queries ──────────────────────────────

  describe('queryV2() - 1h aggregated system queries', () => {
    it('should query monitoring.system_metrics_1h for 1h resolution', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-01T00:00:00Z',
        end: '2024-03-01T00:00:00Z',
        resolution: '1h',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.system_metrics_1h');
    });

    it('should auto-select 1h for range > 30 days', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2023-06-01T00:00:00Z',
        end: '2024-01-15T00:00:00Z', // ~7 months
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.system_metrics_1h');
    });

    it('should return avg and max for 1h aggregated data', async () => {
      const mockRows = [{
        bucket_start: '2024-01-15T10:00:00.000Z',
        cpu_usage_percent_avg: 40.12,
        cpu_usage_percent_max: 92.5,
        memory_used_bytes_avg: '3000000000',
        memory_used_bytes_max: '7000000000',
        memory_total_bytes: '8000000000',
        disk_used_bytes_avg: '45000000000',
        disk_used_bytes_max: '55000000000',
        disk_total_bytes: '100000000000',
        network_rx_bytes_per_sec_avg: '512',
        network_tx_bytes_per_sec_avg: '1024',
      }];
      pgClient = createMockPgClient(mockRows);
      service = createHistoricalMetricsService(pgClient);

      const result = await service.queryV2({
        start: '2023-06-01T00:00:00Z',
        end: '2024-01-15T00:00:00Z',
        resolution: '1h',
      });

      expect(result).toHaveLength(1);
      expect(result[0].cpu.maxPercent).toBe(92.5);
      expect(result[0].memory.maxUsedBytes).toBe(7_000_000_000);
      expect(result[0].disk.maxUsedBytes).toBe(55_000_000_000);
    });
  });

  // ─── queryV2() - container filtering ───────────────────────────────────────

  describe('queryV2() - container filtering', () => {
    it('should query container_snapshots for 30s resolution with containerId', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T12:00:00Z',
        resolution: '30s',
        containerId: 'abc123def456',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.container_snapshots');
      expect(sql).toContain('container_id = $3');
      expect(pgClient.queryCalls[0].params?.[2]).toBe('abc123def456');
    });

    it('should query container_metrics_5m for 5m resolution with containerId', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-10T00:00:00Z',
        end: '2024-01-15T00:00:00Z',
        resolution: '5m',
        containerId: 'abc123def456',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.container_metrics_5m');
      expect(sql).toContain('container_id = $3');
      expect(pgClient.queryCalls[0].params?.[2]).toBe('abc123def456');
    });

    it('should return container raw data with correct field mapping', async () => {
      const mockRows = [{
        timestamp: new Date('2024-01-15T10:00:00Z'),
        cpu_usage_percent: 65.3,
        memory_used_bytes: '2000000000',
        memory_limit_bytes: '4000000000',
        network_rx_bytes: '512',
        network_tx_bytes: '1024',
      }];
      pgClient = createMockPgClient(mockRows);
      service = createHistoricalMetricsService(pgClient);

      const result = await service.queryV2({
        start: '2024-01-15T09:00:00Z',
        end: '2024-01-15T11:00:00Z',
        resolution: '30s',
        containerId: 'test-container',
      });

      expect(result).toHaveLength(1);
      expect(result[0].cpu.usagePercent).toBe(65.3);
      expect(result[0].cpu.maxPercent).toBeUndefined();
      expect(result[0].memory.usedBytes).toBe(2_000_000_000);
      expect(result[0].memory.totalBytes).toBe(4_000_000_000);
      expect(result[0].disk.usedBytes).toBe(0); // no disk data for containers
      expect(result[0].network.rxBytesPerSec).toBe(512);
      expect(result[0].network.txBytesPerSec).toBe(1024);
    });

    it('should return container aggregated data with avg and max', async () => {
      const mockRows = [{
        bucket_start: new Date('2024-01-15T10:00:00Z'),
        cpu_usage_percent_avg: 50.0,
        cpu_usage_percent_max: 88.0,
        memory_used_bytes_avg: '2500000000',
        memory_used_bytes_max: '3500000000',
        memory_limit_bytes: '4000000000',
      }];
      pgClient = createMockPgClient(mockRows);
      service = createHistoricalMetricsService(pgClient);

      const result = await service.queryV2({
        start: '2024-01-10T00:00:00Z',
        end: '2024-01-15T00:00:00Z',
        resolution: '5m',
        containerId: 'test-container',
      });

      expect(result).toHaveLength(1);
      expect(result[0].cpu.usagePercent).toBe(50.0);
      expect(result[0].cpu.maxPercent).toBe(88.0);
      expect(result[0].memory.usedBytes).toBe(2_500_000_000);
      expect(result[0].memory.maxUsedBytes).toBe(3_500_000_000);
      expect(result[0].memory.totalBytes).toBe(4_000_000_000);
    });

    it('should use container_metrics_5m for 1h resolution with containerId', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2023-06-01T00:00:00Z',
        end: '2024-01-15T00:00:00Z',
        resolution: '1h',
        containerId: 'abc123def456',
      });

      const sql = pgClient.queryCalls[0].sql;
      // Falls back to container_metrics_5m (no 1h container table)
      expect(sql).toContain('monitoring.container_metrics_5m');
    });
  });

  // ─── queryV2() - explicit resolution override ──────────────────────────────

  describe('queryV2() - explicit resolution override', () => {
    it('should allow explicit 30s even for long time ranges', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-10T00:00:00Z',
        end: '2024-01-15T00:00:00Z', // 5 days - normally would be 5m
        resolution: '30s',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.system_metrics');
      expect(sql).not.toContain('system_metrics_5m');
    });

    it('should allow explicit 1h for short time ranges', async () => {
      pgClient = createMockPgClient([]);
      service = createHistoricalMetricsService(pgClient);

      await service.queryV2({
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T14:00:00Z', // 4 hours - normally would be 30s
        resolution: '1h',
      });

      const sql = pgClient.queryCalls[0].sql;
      expect(sql).toContain('monitoring.system_metrics_1h');
    });
  });
});
