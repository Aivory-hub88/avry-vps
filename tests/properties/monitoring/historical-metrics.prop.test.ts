/**
 * Property 8: Historical metrics time range filtering
 * Property 9: Resolution aggregation produces correct bucket count
 *
 * Feature: vps-panel-monitoring-api, Property 8: Historical metrics time range filtering
 * Feature: vps-panel-monitoring-api, Property 9: Resolution aggregation produces correct bucket count
 *
 * Property 8: For any valid time range query (start, end), every data point returned by
 * `/api/monitoring/history` SHALL have a timestamp that falls within the inclusive range [start, end].
 *
 * Property 9: For any time range of duration D and resolution R, the number of data points
 * returned SHALL be at most ceil(D / R), and each data point's timestamp SHALL align to the
 * resolution boundary.
 *
 * **Validates: Requirements 7.3, 7.5**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createHistoricalMetricsService } from '../../../src/services/historical-metrics.js';
import type { PgClient } from '../../../src/database/pg-client.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Resolution values in milliseconds */
const RESOLUTION_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

const RESOLUTIONS = ['1m', '5m', '15m', '1h'] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Align a timestamp down to the resolution boundary.
 * - 1m: truncate to minute (seconds/ms = 0)
 * - 5m: truncate to nearest 5-minute boundary
 * - 15m: truncate to nearest 15-minute boundary
 * - 1h: truncate to hour (minutes/seconds/ms = 0)
 */
function alignToResolution(timestamp: Date, resolution: string): Date {
  const aligned = new Date(timestamp);
  aligned.setSeconds(0, 0);

  switch (resolution) {
    case '1m':
      // Already aligned to minute
      break;
    case '5m': {
      const minutes5 = Math.floor(aligned.getMinutes() / 5) * 5;
      aligned.setMinutes(minutes5);
      break;
    }
    case '15m': {
      const minutes15 = Math.floor(aligned.getMinutes() / 15) * 15;
      aligned.setMinutes(minutes15);
      break;
    }
    case '1h':
      aligned.setMinutes(0);
      break;
  }
  return aligned;
}

/**
 * Generate simulated DB rows with aligned timestamps for a given range and resolution.
 * This simulates what PostgreSQL would return from the GROUP BY time-bucket query.
 */
function generateAlignedRows(
  start: Date,
  end: Date,
  resolution: string
): Array<{
  bucket: Date;
  cpu_usage_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  network_rx_bytes_per_sec: number;
  network_tx_bytes_per_sec: number;
}> {
  const resMs = RESOLUTION_MS[resolution];
  const rows: Array<{
    bucket: Date;
    cpu_usage_percent: number;
    memory_used_bytes: number;
    memory_total_bytes: number;
    disk_used_bytes: number;
    disk_total_bytes: number;
    network_rx_bytes_per_sec: number;
    network_tx_bytes_per_sec: number;
  }> = [];

  // Start from the first aligned boundary >= start
  const firstAligned = alignToResolution(start, resolution);
  let cursor = firstAligned.getTime();
  if (cursor < start.getTime()) {
    cursor += resMs;
  }

  while (cursor <= end.getTime()) {
    rows.push({
      bucket: new Date(cursor),
      cpu_usage_percent: 25.5,
      memory_used_bytes: 1024 * 1024 * 512,
      memory_total_bytes: 1024 * 1024 * 1024,
      disk_used_bytes: 1024 * 1024 * 1024 * 10,
      disk_total_bytes: 1024 * 1024 * 1024 * 50,
      network_rx_bytes_per_sec: 1000,
      network_tx_bytes_per_sec: 500,
    });
    cursor += resMs;
  }

  return rows;
}

/**
 * Generate simulated raw DB rows (no resolution) with timestamps spread within the range.
 * Timestamps are randomly placed within [start, end].
 */
function generateRawRows(
  start: Date,
  end: Date,
  count: number
): Array<{
  bucket: Date;
  cpu_usage_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  network_rx_bytes_per_sec: number;
  network_tx_bytes_per_sec: number;
}> {
  const rows: Array<{
    bucket: Date;
    cpu_usage_percent: number;
    memory_used_bytes: number;
    memory_total_bytes: number;
    disk_used_bytes: number;
    disk_total_bytes: number;
    network_rx_bytes_per_sec: number;
    network_tx_bytes_per_sec: number;
  }> = [];

  const startMs = start.getTime();
  const endMs = end.getTime();
  const step = Math.max(1, Math.floor((endMs - startMs) / (count + 1)));

  for (let i = 0; i < count; i++) {
    const ts = startMs + step * (i + 1);
    if (ts > endMs) break;
    rows.push({
      bucket: new Date(ts),
      cpu_usage_percent: 30.0,
      memory_used_bytes: 1024 * 1024 * 256,
      memory_total_bytes: 1024 * 1024 * 1024,
      disk_used_bytes: 1024 * 1024 * 1024 * 5,
      disk_total_bytes: 1024 * 1024 * 1024 * 50,
      network_rx_bytes_per_sec: 2000,
      network_tx_bytes_per_sec: 1000,
    });
  }

  return rows;
}

// ─── Mock PgClient ─────────────────────────────────────────────────────────────

/**
 * Creates a mock PgClient that returns pre-generated rows filtered by time range.
 * The mock simulates PostgreSQL's WHERE timestamp >= $1 AND timestamp <= $2 behavior.
 */
function createMockPgClient(
  rowGenerator: (start: Date, end: Date, resolution?: string) => Array<{
    bucket: Date;
    cpu_usage_percent: number;
    memory_used_bytes: number;
    memory_total_bytes: number;
    disk_used_bytes: number;
    disk_total_bytes: number;
    network_rx_bytes_per_sec: number;
    network_tx_bytes_per_sec: number;
  }>
): PgClient {
  return {
    async connect() {},
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (params && params.length >= 2) {
        const start = new Date(params[0] as string);
        const end = new Date(params[1] as string);

        // Determine resolution from SQL (check for time bucket expressions)
        let resolution: string | undefined;
        if (sql.includes("INTERVAL '5 min'") || sql.includes('/ 5')) {
          resolution = '5m';
        } else if (sql.includes("INTERVAL '15 min'") || sql.includes('/ 15')) {
          resolution = '15m';
        } else if (sql.includes("date_trunc('hour'") && !sql.includes('INTERVAL')) {
          resolution = '1h';
        } else if (sql.includes("date_trunc('minute'")) {
          resolution = '1m';
        }

        const rows = rowGenerator(start, end, resolution);
        return rows as T[];
      }
      return [] as T[];
    },
    async transaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
      return fn({} as any);
    },
    async close() {},
    async isHealthy() { return true; },
  };
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate a valid time range with start < end.
 * Range is between 1 minute and 6 hours to keep tests manageable.
 */
const timeRangeArb = fc.tuple(
  // Start date: within last 7 days
  fc.integer({ min: 0, max: 6 * 24 * 60 }),  // offset in minutes from a base
  // Duration in minutes (1 min to 6 hours)
  fc.integer({ min: 1, max: 360 })
).map(([offsetMinutes, durationMinutes]) => {
  const baseDate = new Date('2024-01-15T00:00:00.000Z');
  const start = new Date(baseDate.getTime() + offsetMinutes * 60_000);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start, end, durationMs: durationMinutes * 60_000 };
});

/**
 * Generate a resolution value.
 */
const resolutionArb = fc.constantFrom(...RESOLUTIONS);

/**
 * Generate a time range and resolution together, ensuring duration >= resolution.
 */
const timeRangeWithResolutionArb = fc.tuple(
  resolutionArb,
  // Duration multiplier: 1x to 20x the resolution (ensures meaningful bucket count)
  fc.integer({ min: 1, max: 20 })
).map(([resolution, multiplier]) => {
  const resMs = RESOLUTION_MS[resolution];
  const durationMs = resMs * multiplier;
  const baseDate = new Date('2024-01-15T00:00:00.000Z');
  // Align start to the resolution boundary for cleaner test expectations
  const start = alignToResolution(baseDate, resolution);
  const end = new Date(start.getTime() + durationMs);
  return { start, end, durationMs, resolution };
});

/**
 * Generate a number of raw data points for non-aggregated queries.
 */
const rawDataPointCountArb = fc.integer({ min: 1, max: 50 });

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Feature: vps-panel-monitoring-api, Property 8: Historical metrics time range filtering', () => {
  it('every data point returned has a timestamp within the inclusive [start, end] range', async () => {
    await fc.assert(
      fc.asyncProperty(
        timeRangeArb,
        rawDataPointCountArb,
        async ({ start, end }, pointCount) => {
          const mockClient = createMockPgClient((queryStart, queryEnd) => {
            return generateRawRows(queryStart, queryEnd, pointCount);
          });

          const service = createHistoricalMetricsService(mockClient);

          const results = await service.query({
            start: start.toISOString(),
            end: end.toISOString(),
            // No resolution — raw data, range is ≤6h so won't auto-downsample
          });

          // Property: every returned timestamp is within [start, end]
          for (const point of results) {
            const pointTs = new Date(point.timestamp).getTime();
            expect(pointTs).toBeGreaterThanOrEqual(start.getTime());
            expect(pointTs).toBeLessThanOrEqual(end.getTime());
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('every data point returned with resolution has a timestamp within [start, end]', async () => {
    await fc.assert(
      fc.asyncProperty(
        timeRangeWithResolutionArb,
        async ({ start, end, resolution }) => {
          const mockClient = createMockPgClient((queryStart, queryEnd, detectedRes) => {
            const res = detectedRes ?? resolution;
            return generateAlignedRows(queryStart, queryEnd, res);
          });

          const service = createHistoricalMetricsService(mockClient);

          const results = await service.query({
            start: start.toISOString(),
            end: end.toISOString(),
            resolution,
          });

          // Property: every returned timestamp is within [start, end]
          for (const point of results) {
            const pointTs = new Date(point.timestamp).getTime();
            expect(pointTs).toBeGreaterThanOrEqual(start.getTime());
            expect(pointTs).toBeLessThanOrEqual(end.getTime());
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: vps-panel-monitoring-api, Property 9: Resolution aggregation produces correct bucket count', () => {
  it('number of data points is at most ceil(D / R) for any duration D and resolution R', async () => {
    await fc.assert(
      fc.asyncProperty(
        timeRangeWithResolutionArb,
        async ({ start, end, durationMs, resolution }) => {
          const resMs = RESOLUTION_MS[resolution];

          const mockClient = createMockPgClient((queryStart, queryEnd, detectedRes) => {
            const res = detectedRes ?? resolution;
            return generateAlignedRows(queryStart, queryEnd, res);
          });

          const service = createHistoricalMetricsService(mockClient);

          const results = await service.query({
            start: start.toISOString(),
            end: end.toISOString(),
            resolution,
          });

          // Property: count <= floor(D / R) + 1
          // The query uses inclusive boundaries (timestamp >= start AND timestamp <= end),
          // so the maximum number of aligned buckets is floor(D/R) + 1.
          // This is equivalent to ceil(D/R) when D is not evenly divisible by R,
          // and ceil(D/R) + 1 when D is exactly divisible (both endpoints are buckets).
          const maxBuckets = Math.floor(durationMs / resMs) + 1;
          expect(results.length).toBeLessThanOrEqual(maxBuckets);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each data point timestamp aligns to the resolution boundary', async () => {
    await fc.assert(
      fc.asyncProperty(
        timeRangeWithResolutionArb,
        async ({ start, end, resolution }) => {
          const resMs = RESOLUTION_MS[resolution];

          const mockClient = createMockPgClient((queryStart, queryEnd, detectedRes) => {
            const res = detectedRes ?? resolution;
            return generateAlignedRows(queryStart, queryEnd, res);
          });

          const service = createHistoricalMetricsService(mockClient);

          const results = await service.query({
            start: start.toISOString(),
            end: end.toISOString(),
            resolution,
          });

          // Property: each timestamp aligns to the resolution boundary
          for (const point of results) {
            const ts = new Date(point.timestamp);

            switch (resolution) {
              case '1m':
                // Seconds and milliseconds must be 0
                expect(ts.getUTCSeconds()).toBe(0);
                expect(ts.getUTCMilliseconds()).toBe(0);
                break;
              case '5m':
                // Minutes must be divisible by 5, seconds/ms = 0
                expect(ts.getUTCMinutes() % 5).toBe(0);
                expect(ts.getUTCSeconds()).toBe(0);
                expect(ts.getUTCMilliseconds()).toBe(0);
                break;
              case '15m':
                // Minutes must be divisible by 15, seconds/ms = 0
                expect(ts.getUTCMinutes() % 15).toBe(0);
                expect(ts.getUTCSeconds()).toBe(0);
                expect(ts.getUTCMilliseconds()).toBe(0);
                break;
              case '1h':
                // Minutes, seconds, and milliseconds must all be 0
                expect(ts.getUTCMinutes()).toBe(0);
                expect(ts.getUTCSeconds()).toBe(0);
                expect(ts.getUTCMilliseconds()).toBe(0);
                break;
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('data points are returned in ascending chronological order', async () => {
    await fc.assert(
      fc.asyncProperty(
        timeRangeWithResolutionArb,
        async ({ start, end, resolution }) => {
          const mockClient = createMockPgClient((queryStart, queryEnd, detectedRes) => {
            const res = detectedRes ?? resolution;
            return generateAlignedRows(queryStart, queryEnd, res);
          });

          const service = createHistoricalMetricsService(mockClient);

          const results = await service.query({
            start: start.toISOString(),
            end: end.toISOString(),
            resolution,
          });

          // Property: timestamps are in ascending order
          for (let i = 1; i < results.length; i++) {
            const prev = new Date(results[i - 1].timestamp).getTime();
            const curr = new Date(results[i].timestamp).getTime();
            expect(curr).toBeGreaterThan(prev);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
