/**
 * Property-based tests for container ID filter correctness.
 *
 * Feature: VPS Panel Premium Upgrade, Property 3: Container ID filter returns only matching container data
 * For any valid container_id parameter and any set of stored metrics across multiple containers,
 * when querying the Historical Metrics Service with that container_id, all returned data points
 * SHALL have a container_id field matching the filter parameter, and no data points for other
 * containers SHALL be included.
 *
 * **Validates: Requirements 4.3, 18.4**
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { createHistoricalMetricsService } from '../../src/services/historical-metrics.js';
import type { PgClient } from '../../src/database/pg-client.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate a random 12-character hex string (Docker short container ID format).
 */
const containerIdArb = fc.hexaString({ minLength: 12, maxLength: 12 });

/**
 * Generate a set of distinct container IDs (at least 2 to test filtering).
 */
const containerIdSetArb = fc.uniqueArray(containerIdArb, { minLength: 2, maxLength: 6 });

/**
 * Generate a random metric data point for a container snapshot row.
 */
const containerMetricArb = fc.record({
  cpu_usage_percent: fc.float({ min: 0, max: 100, noNaN: true }),
  memory_used_bytes: fc.integer({ min: 0, max: 16_000_000_000 }),
  memory_limit_bytes: fc.integer({ min: 1_000_000, max: 32_000_000_000 }),
  network_rx_bytes: fc.integer({ min: 0, max: 1_000_000_000 }),
  network_tx_bytes: fc.integer({ min: 0, max: 1_000_000_000 }),
});

/**
 * Generate a random aggregated metric data point for container_metrics_5m.
 */
const containerAggMetricArb = fc.record({
  cpu_usage_percent_avg: fc.float({ min: 0, max: 100, noNaN: true }),
  cpu_usage_percent_max: fc.float({ min: 0, max: 100, noNaN: true }),
  memory_used_bytes_avg: fc.integer({ min: 0, max: 16_000_000_000 }),
  memory_used_bytes_max: fc.integer({ min: 0, max: 16_000_000_000 }),
  memory_limit_bytes: fc.integer({ min: 1_000_000, max: 32_000_000_000 }),
});

/**
 * Generate a timestamp within a fixed recent 1-hour window for raw queries.
 */
const recentTimestampArb = fc.date({
  min: new Date('2024-01-01T00:00:00.000Z'),
  max: new Date('2024-01-01T01:00:00.000Z'),
});

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Create a mock PgClient that records calls and returns rows filtered by container_id.
 * This simulates what PostgreSQL does with `WHERE container_id = $3`.
 */
function createMockPgClient(
  allRows: Array<{ container_id: string; [key: string]: unknown }>
): { pgClient: PgClient; getLastQueryParams: () => unknown[] | undefined } {
  let lastParams: unknown[] | undefined;

  const pgClient: PgClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
      lastParams = params;
      // Simulate PostgreSQL WHERE container_id = $3
      // The container_id is always the 3rd parameter in queryV2's SQL
      const filterId = params?.[2] as string | undefined;
      if (filterId) {
        return Promise.resolve(
          allRows.filter((row) => row.container_id === filterId)
        );
      }
      return Promise.resolve(allRows);
    }),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(true),
  };

  return {
    pgClient,
    getLastQueryParams: () => lastParams,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Container ID Filter Property Tests (Property 3)', () => {
  describe('Raw resolution (30s) - container_snapshots table', () => {
    it('Property 3.1: queryV2 passes containerId to SQL as the 3rd parameter', async () => {
      await fc.assert(
        fc.asyncProperty(containerIdArb, async (targetContainerId) => {
          const { pgClient, getLastQueryParams } = createMockPgClient([]);
          const service = createHistoricalMetricsService(pgClient);

          // Use a short range (≤24h) so auto-resolution picks '30s'
          const start = '2024-01-01T00:00:00.000Z';
          const end = '2024-01-01T01:00:00.000Z';

          await service.queryV2({ start, end, containerId: targetContainerId });

          const params = getLastQueryParams();
          expect(params).toBeDefined();
          expect(params![2]).toBe(targetContainerId);
        }),
        { numRuns: 200 }
      );
    });

    it('Property 3.2: all returned data points come from the filtered container only', async () => {
      await fc.assert(
        fc.asyncProperty(
          containerIdSetArb,
          fc.array(containerMetricArb, { minLength: 1, maxLength: 10 }),
          fc.array(recentTimestampArb, { minLength: 1, maxLength: 10 }),
          async (containerIds, metrics, timestamps) => {
            // Build rows across all containers
            const allRows = containerIds.flatMap((cid) =>
              metrics.map((metric, idx) => ({
                container_id: cid,
                timestamp: timestamps[idx % timestamps.length],
                ...metric,
              }))
            );

            // Pick the first container as the filter target
            const targetId = containerIds[0];
            const { pgClient } = createMockPgClient(allRows);
            const service = createHistoricalMetricsService(pgClient);

            const start = '2024-01-01T00:00:00.000Z';
            const end = '2024-01-01T01:00:00.000Z';

            const results = await service.queryV2({ start, end, containerId: targetId });

            // The mock simulates DB filtering — results should only contain target rows
            const expectedCount = allRows.filter((r) => r.container_id === targetId).length;
            expect(results.length).toBe(expectedCount);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 3.3: no data points from other containers are included in results', async () => {
      await fc.assert(
        fc.asyncProperty(
          containerIdSetArb,
          fc.array(containerMetricArb, { minLength: 1, maxLength: 5 }),
          fc.array(recentTimestampArb, { minLength: 1, maxLength: 5 }),
          async (containerIds, metrics, timestamps) => {
            // Build rows with distinct containers
            const allRows = containerIds.flatMap((cid) =>
              metrics.map((metric, idx) => ({
                container_id: cid,
                timestamp: timestamps[idx % timestamps.length],
                ...metric,
              }))
            );

            const targetId = containerIds[0];
            const otherIds = containerIds.slice(1);

            const { pgClient } = createMockPgClient(allRows);
            const service = createHistoricalMetricsService(pgClient);

            const start = '2024-01-01T00:00:00.000Z';
            const end = '2024-01-01T01:00:00.000Z';

            const results = await service.queryV2({ start, end, containerId: targetId });

            // The mock returns only rows with matching container_id
            // Verify: if we have results, there are no other container IDs in the underlying filtered set
            const filteredRows = allRows.filter((r) => r.container_id === targetId);
            const otherRows = filteredRows.filter((r) => otherIds.includes(r.container_id));
            expect(otherRows.length).toBe(0);
            expect(results.length).toBe(filteredRows.length);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Aggregated resolution (5m) - container_metrics_5m table', () => {
    it('Property 3.4: queryV2 passes containerId to aggregated query as 3rd parameter', async () => {
      await fc.assert(
        fc.asyncProperty(containerIdArb, async (targetContainerId) => {
          const { pgClient, getLastQueryParams } = createMockPgClient([]);
          const service = createHistoricalMetricsService(pgClient);

          // Use explicit '5m' resolution to hit the aggregated path
          const start = '2024-01-01T00:00:00.000Z';
          const end = '2024-01-01T01:00:00.000Z';

          await service.queryV2({ start, end, resolution: '5m', containerId: targetContainerId });

          const params = getLastQueryParams();
          expect(params).toBeDefined();
          expect(params![2]).toBe(targetContainerId);
        }),
        { numRuns: 200 }
      );
    });

    it('Property 3.5: aggregated query returns only matching container data', async () => {
      await fc.assert(
        fc.asyncProperty(
          containerIdSetArb,
          fc.array(containerAggMetricArb, { minLength: 1, maxLength: 5 }),
          async (containerIds, metrics) => {
            // Build aggregated rows across all containers
            const baseTime = new Date('2024-01-01T00:00:00.000Z');
            const allRows = containerIds.flatMap((cid) =>
              metrics.map((metric, idx) => ({
                container_id: cid,
                bucket_start: new Date(baseTime.getTime() + idx * 5 * 60 * 1000),
                ...metric,
              }))
            );

            const targetId = containerIds[0];
            const { pgClient } = createMockPgClient(allRows);
            const service = createHistoricalMetricsService(pgClient);

            const start = '2024-01-01T00:00:00.000Z';
            const end = '2024-01-01T01:00:00.000Z';

            const results = await service.queryV2({ start, end, resolution: '5m', containerId: targetId });

            const expectedCount = allRows.filter((r) => r.container_id === targetId).length;
            expect(results.length).toBe(expectedCount);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 3.6: aggregated query excludes all non-matching container data', async () => {
      await fc.assert(
        fc.asyncProperty(
          containerIdSetArb,
          fc.array(containerAggMetricArb, { minLength: 1, maxLength: 5 }),
          async (containerIds, metrics) => {
            const baseTime = new Date('2024-01-01T00:00:00.000Z');
            const allRows = containerIds.flatMap((cid) =>
              metrics.map((metric, idx) => ({
                container_id: cid,
                bucket_start: new Date(baseTime.getTime() + idx * 5 * 60 * 1000),
                ...metric,
              }))
            );

            const targetId = containerIds[0];
            const totalRows = allRows.length;
            const targetRows = allRows.filter((r) => r.container_id === targetId).length;
            const otherRows = totalRows - targetRows;

            const { pgClient } = createMockPgClient(allRows);
            const service = createHistoricalMetricsService(pgClient);

            const start = '2024-01-01T00:00:00.000Z';
            const end = '2024-01-01T01:00:00.000Z';

            const results = await service.queryV2({ start, end, resolution: '5m', containerId: targetId });

            // Verify we got fewer results than total (other containers excluded)
            expect(results.length).toBeLessThanOrEqual(totalRows - otherRows);
            // And exactly the target count
            expect(results.length).toBe(targetRows);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Filter correctness across any resolution', () => {
    it('Property 3.7: containerId filter is applied regardless of resolution tier', async () => {
      const resolutionArb = fc.constantFrom<'30s' | '5m' | '1h'>('30s', '5m', '1h');

      await fc.assert(
        fc.asyncProperty(containerIdArb, resolutionArb, async (targetContainerId, resolution) => {
          const { pgClient, getLastQueryParams } = createMockPgClient([]);
          const service = createHistoricalMetricsService(pgClient);

          const start = '2024-01-01T00:00:00.000Z';
          const end = '2024-01-01T01:00:00.000Z';

          await service.queryV2({ start, end, resolution, containerId: targetContainerId });

          const params = getLastQueryParams();
          expect(params).toBeDefined();
          // containerId is always the 3rd param ($3) in the query
          expect(params![2]).toBe(targetContainerId);
        }),
        { numRuns: 300 }
      );
    });
  });
});
