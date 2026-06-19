/**
 * Property-based tests for aggregated response shape (Property 14).
 *
 * Feature: VPS Panel Premium Upgrade, Property 14: Aggregated query response includes both avg and max values
 *
 * For any query at '5m' or '1h' resolution, every returned data point SHALL contain both
 * an average value and a maximum value for CPU, memory, and disk metrics. Raw '30s'
 * resolution queries SHALL NOT include max values (they represent single observations).
 *
 * **Validates: Requirements 18.5**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  createHistoricalMetricsService,
  type TimeSeriesDataPointV2,
} from '../../src/services/historical-metrics.js';
import type { PgClient } from '../../src/database/pg-client.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/** Generate a positive float for CPU usage percent (0–100) */
const cpuPercentArb = fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true });

/** Generate a positive integer for byte counts (1 byte to 1 TB) */
const bytesArb = fc.integer({ min: 1, max: 1_000_000_000_000 });

/** Generate a positive integer for network rates (bytes/sec) */
const networkRateArb = fc.integer({ min: 0, max: 10_000_000_000 });

/** Generate a valid bucket_start timestamp (aligned to 5-min or 1-hour boundary) */
const bucketTimestampArb = fc.date({
  min: new Date('2020-01-01T00:00:00.000Z'),
  max: new Date('2030-12-31T23:00:00.000Z'),
}).map((d) => {
  // Align to nearest hour boundary for simplicity (valid for both 5m and 1h)
  const aligned = new Date(d);
  aligned.setUTCMinutes(0, 0, 0);
  return aligned;
});

/** Generate a raw row matching monitoring.system_metrics schema */
const rawSystemRowArb = fc.record({
  timestamp: bucketTimestampArb,
  cpu_usage_percent: cpuPercentArb,
  memory_used_bytes: bytesArb.map(String),
  memory_total_bytes: bytesArb.map(String),
  disk_used_bytes: bytesArb.map(String),
  disk_total_bytes: bytesArb.map(String),
  network_rx_bytes_per_sec: networkRateArb.map(String),
  network_tx_bytes_per_sec: networkRateArb.map(String),
});

/** Generate an aggregated row matching system_metrics_5m / system_metrics_1h schema */
const aggregatedSystemRowArb = fc.record({
  bucket_start: bucketTimestampArb,
  cpu_usage_percent_avg: cpuPercentArb,
  cpu_usage_percent_max: cpuPercentArb,
  memory_used_bytes_avg: bytesArb.map(String),
  memory_used_bytes_max: bytesArb.map(String),
  memory_total_bytes: bytesArb.map(String),
  disk_used_bytes_avg: bytesArb.map(String),
  disk_used_bytes_max: bytesArb.map(String),
  disk_total_bytes: bytesArb.map(String),
  network_rx_bytes_per_sec_avg: networkRateArb.map(String),
  network_tx_bytes_per_sec_avg: networkRateArb.map(String),
});

/** Generate 1–10 raw rows */
const rawRowsArb = fc.array(rawSystemRowArb, { minLength: 1, maxLength: 10 });

/** Generate 1–10 aggregated rows */
const aggregatedRowsArb = fc.array(aggregatedSystemRowArb, { minLength: 1, maxLength: 10 });

/** Aggregated resolution: '5m' or '1h' */
const aggregatedResolutionArb = fc.constantFrom('5m' as const, '1h' as const);

// ─── Mock PgClient Factory ─────────────────────────────────────────────────────

function createMockPgClient(rows: unknown[]): PgClient {
  return {
    async connect() {},
    async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
      return rows as T[];
    },
    async transaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
      return fn({} as any);
    },
    async close() {},
    async isHealthy() { return true; },
  };
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Property 14: Aggregated query response includes both avg and max values', () => {
  describe('5m/1h resolution: data points include avg AND max values', () => {
    it('every data point has cpu.maxPercent defined as a number', async () => {
      await fc.assert(
        fc.asyncProperty(
          aggregatedRowsArb,
          aggregatedResolutionArb,
          async (rows, resolution) => {
            const pgClient = createMockPgClient(rows);
            const service = createHistoricalMetricsService(pgClient);

            // Use a time range that auto-selects the desired resolution
            const start = resolution === '5m'
              ? '2024-01-10T00:00:00Z'  // >24h range → 5m
              : '2023-06-01T00:00:00Z'; // >30d range → 1h
            const end = '2024-01-15T00:00:00Z';

            const result = await service.queryV2({ start, end, resolution });

            expect(result.length).toBe(rows.length);
            for (const point of result) {
              expect(point.cpu.maxPercent).toBeDefined();
              expect(typeof point.cpu.maxPercent).toBe('number');
              expect(Number.isFinite(point.cpu.maxPercent)).toBe(true);
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('every data point has memory.maxUsedBytes defined as a number', async () => {
      await fc.assert(
        fc.asyncProperty(
          aggregatedRowsArb,
          aggregatedResolutionArb,
          async (rows, resolution) => {
            const pgClient = createMockPgClient(rows);
            const service = createHistoricalMetricsService(pgClient);

            const start = resolution === '5m'
              ? '2024-01-10T00:00:00Z'
              : '2023-06-01T00:00:00Z';
            const end = '2024-01-15T00:00:00Z';

            const result = await service.queryV2({ start, end, resolution });

            expect(result.length).toBe(rows.length);
            for (const point of result) {
              expect(point.memory.maxUsedBytes).toBeDefined();
              expect(typeof point.memory.maxUsedBytes).toBe('number');
              expect(Number.isFinite(point.memory.maxUsedBytes)).toBe(true);
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('every data point has disk.maxUsedBytes defined as a number', async () => {
      await fc.assert(
        fc.asyncProperty(
          aggregatedRowsArb,
          aggregatedResolutionArb,
          async (rows, resolution) => {
            const pgClient = createMockPgClient(rows);
            const service = createHistoricalMetricsService(pgClient);

            const start = resolution === '5m'
              ? '2024-01-10T00:00:00Z'
              : '2023-06-01T00:00:00Z';
            const end = '2024-01-15T00:00:00Z';

            const result = await service.queryV2({ start, end, resolution });

            expect(result.length).toBe(rows.length);
            for (const point of result) {
              expect(point.disk.maxUsedBytes).toBeDefined();
              expect(typeof point.disk.maxUsedBytes).toBe('number');
              expect(Number.isFinite(point.disk.maxUsedBytes)).toBe(true);
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('every data point also includes avg values (usagePercent, usedBytes, totalBytes)', async () => {
      await fc.assert(
        fc.asyncProperty(
          aggregatedRowsArb,
          aggregatedResolutionArb,
          async (rows, resolution) => {
            const pgClient = createMockPgClient(rows);
            const service = createHistoricalMetricsService(pgClient);

            const start = resolution === '5m'
              ? '2024-01-10T00:00:00Z'
              : '2023-06-01T00:00:00Z';
            const end = '2024-01-15T00:00:00Z';

            const result = await service.queryV2({ start, end, resolution });

            expect(result.length).toBe(rows.length);
            for (const point of result) {
              // CPU avg
              expect(typeof point.cpu.usagePercent).toBe('number');
              expect(Number.isFinite(point.cpu.usagePercent)).toBe(true);

              // Memory avg + total
              expect(typeof point.memory.usedBytes).toBe('number');
              expect(Number.isFinite(point.memory.usedBytes)).toBe(true);
              expect(typeof point.memory.totalBytes).toBe('number');
              expect(Number.isFinite(point.memory.totalBytes)).toBe(true);

              // Disk avg + total
              expect(typeof point.disk.usedBytes).toBe('number');
              expect(Number.isFinite(point.disk.usedBytes)).toBe(true);
              expect(typeof point.disk.totalBytes).toBe('number');
              expect(Number.isFinite(point.disk.totalBytes)).toBe(true);
            }
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('30s resolution: data points do NOT include max values', () => {
    it('every data point has cpu.maxPercent undefined', async () => {
      await fc.assert(
        fc.asyncProperty(rawRowsArb, async (rows) => {
          const pgClient = createMockPgClient(rows);
          const service = createHistoricalMetricsService(pgClient);

          // 2-hour range → auto-selects 30s
          const result = await service.queryV2({
            start: '2024-01-15T10:00:00Z',
            end: '2024-01-15T12:00:00Z',
            resolution: '30s',
          });

          expect(result.length).toBe(rows.length);
          for (const point of result) {
            expect(point.cpu.maxPercent).toBeUndefined();
          }
        }),
        { numRuns: 200 }
      );
    });

    it('every data point has memory.maxUsedBytes undefined', async () => {
      await fc.assert(
        fc.asyncProperty(rawRowsArb, async (rows) => {
          const pgClient = createMockPgClient(rows);
          const service = createHistoricalMetricsService(pgClient);

          const result = await service.queryV2({
            start: '2024-01-15T10:00:00Z',
            end: '2024-01-15T12:00:00Z',
            resolution: '30s',
          });

          expect(result.length).toBe(rows.length);
          for (const point of result) {
            expect(point.memory.maxUsedBytes).toBeUndefined();
          }
        }),
        { numRuns: 200 }
      );
    });

    it('every data point has disk.maxUsedBytes undefined', async () => {
      await fc.assert(
        fc.asyncProperty(rawRowsArb, async (rows) => {
          const pgClient = createMockPgClient(rows);
          const service = createHistoricalMetricsService(pgClient);

          const result = await service.queryV2({
            start: '2024-01-15T10:00:00Z',
            end: '2024-01-15T12:00:00Z',
            resolution: '30s',
          });

          expect(result.length).toBe(rows.length);
          for (const point of result) {
            expect(point.disk.maxUsedBytes).toBeUndefined();
          }
        }),
        { numRuns: 200 }
      );
    });

    it('every data point still includes base metric values (usagePercent, usedBytes, totalBytes)', async () => {
      await fc.assert(
        fc.asyncProperty(rawRowsArb, async (rows) => {
          const pgClient = createMockPgClient(rows);
          const service = createHistoricalMetricsService(pgClient);

          const result = await service.queryV2({
            start: '2024-01-15T10:00:00Z',
            end: '2024-01-15T12:00:00Z',
            resolution: '30s',
          });

          expect(result.length).toBe(rows.length);
          for (const point of result) {
            // CPU
            expect(typeof point.cpu.usagePercent).toBe('number');
            expect(Number.isFinite(point.cpu.usagePercent)).toBe(true);

            // Memory
            expect(typeof point.memory.usedBytes).toBe('number');
            expect(Number.isFinite(point.memory.usedBytes)).toBe(true);
            expect(typeof point.memory.totalBytes).toBe('number');
            expect(Number.isFinite(point.memory.totalBytes)).toBe(true);

            // Disk
            expect(typeof point.disk.usedBytes).toBe('number');
            expect(Number.isFinite(point.disk.usedBytes)).toBe(true);
            expect(typeof point.disk.totalBytes).toBe('number');
            expect(Number.isFinite(point.disk.totalBytes)).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });
  });
});
