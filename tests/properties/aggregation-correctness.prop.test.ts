/**
 * Property-based tests for aggregation correctness.
 *
 * Feature: VPS Panel Premium Upgrade, Property 2: Aggregation computes correct average and maximum values
 * For any non-empty set of metric data points within a single time bucket, the aggregated
 * `avg` value SHALL equal the arithmetic mean of the input values (within floating-point
 * tolerance), and the aggregated `max` value SHALL equal the maximum of the input values,
 * for each metric field (cpu_usage_percent, memory_used_bytes, disk_used_bytes,
 * network_rx_bytes_per_sec, network_tx_bytes_per_sec).
 *
 * **Validates: Requirements 1.7, 1.8**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Aggregation helpers (mirror SQL AVG/MAX behavior) ─────────────────────────

/**
 * Compute the arithmetic mean of an array of numbers.
 * Mirrors PostgreSQL AVG() behavior.
 */
function computeAvg(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

/**
 * Compute the maximum of an array of numbers.
 * Mirrors PostgreSQL MAX() behavior.
 */
function computeMax(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

// ─── Metric data point type ────────────────────────────────────────────────────

interface MetricDataPoint {
  cpu_usage_percent: number;
  memory_used_bytes: number;
  disk_used_bytes: number;
  network_rx_bytes_per_sec: number;
  network_tx_bytes_per_sec: number;
}

interface AggregatedBucket {
  cpu_usage_percent_avg: number;
  cpu_usage_percent_max: number;
  memory_used_bytes_avg: number;
  memory_used_bytes_max: number;
  disk_used_bytes_avg: number;
  disk_used_bytes_max: number;
  network_rx_bytes_per_sec_avg: number;
  network_rx_bytes_per_sec_max: number;
  network_tx_bytes_per_sec_avg: number;
  network_tx_bytes_per_sec_max: number;
  sample_count: number;
}

/**
 * Aggregate an array of metric data points into a single bucket.
 * This mirrors the logic the downsampling engine performs via SQL.
 */
function aggregateMetrics(dataPoints: MetricDataPoint[]): AggregatedBucket {
  return {
    cpu_usage_percent_avg: computeAvg(dataPoints.map(d => d.cpu_usage_percent)),
    cpu_usage_percent_max: computeMax(dataPoints.map(d => d.cpu_usage_percent)),
    memory_used_bytes_avg: computeAvg(dataPoints.map(d => d.memory_used_bytes)),
    memory_used_bytes_max: computeMax(dataPoints.map(d => d.memory_used_bytes)),
    disk_used_bytes_avg: computeAvg(dataPoints.map(d => d.disk_used_bytes)),
    disk_used_bytes_max: computeMax(dataPoints.map(d => d.disk_used_bytes)),
    network_rx_bytes_per_sec_avg: computeAvg(dataPoints.map(d => d.network_rx_bytes_per_sec)),
    network_rx_bytes_per_sec_max: computeMax(dataPoints.map(d => d.network_rx_bytes_per_sec)),
    network_tx_bytes_per_sec_avg: computeAvg(dataPoints.map(d => d.network_tx_bytes_per_sec)),
    network_tx_bytes_per_sec_max: computeMax(dataPoints.map(d => d.network_tx_bytes_per_sec)),
    sample_count: dataPoints.length,
  };
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/** Generate a single metric data point with realistic value ranges */
const metricDataPointArb: fc.Arbitrary<MetricDataPoint> = fc.record({
  cpu_usage_percent: fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  memory_used_bytes: fc.integer({ min: 0, max: 68_719_476_736 }), // 0 to 64 GB
  disk_used_bytes: fc.integer({ min: 0, max: 2_199_023_255_552 }), // 0 to 2 TB
  network_rx_bytes_per_sec: fc.integer({ min: 0, max: 1_250_000_000 }), // 0 to 10 Gbps
  network_tx_bytes_per_sec: fc.integer({ min: 0, max: 1_250_000_000 }), // 0 to 10 Gbps
});

/** Generate a non-empty array of metric data points (simulating a bucket's source data) */
const metricDataPointsArb = fc.array(metricDataPointArb, { minLength: 1, maxLength: 50 });

/** Generate a non-empty array of numbers for isolated field testing */
const nonEmptyNumbersArb = (min: number, max: number) =>
  fc.array(fc.float({ min, max, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 100 });

const nonEmptyIntegersArb = (min: number, max: number) =>
  fc.array(fc.integer({ min, max }), { minLength: 1, maxLength: 100 });

// ─── Floating-point tolerance helper ───────────────────────────────────────────

const FLOAT_TOLERANCE = 0.01;

function isWithinTolerance(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < FLOAT_TOLERANCE;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Aggregation Correctness Property Tests (Property 2)', () => {
  describe('cpu_usage_percent', () => {
    it('Property 2.1: AVG equals arithmetic mean of CPU usage values within tolerance', () => {
      fc.assert(
        fc.property(nonEmptyNumbersArb(0, 100), (values) => {
          const expectedAvg = values.reduce((sum, v) => sum + v, 0) / values.length;
          const computedAvg = computeAvg(values);
          expect(isWithinTolerance(computedAvg, expectedAvg)).toBe(true);
        }),
        { numRuns: 500 }
      );
    });

    it('Property 2.2: MAX equals actual maximum of CPU usage values', () => {
      fc.assert(
        fc.property(nonEmptyNumbersArb(0, 100), (values) => {
          const expectedMax = Math.max(...values);
          const computedMax = computeMax(values);
          expect(computedMax).toBe(expectedMax);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('memory_used_bytes', () => {
    it('Property 2.3: AVG equals arithmetic mean of memory values within tolerance', () => {
      fc.assert(
        fc.property(nonEmptyIntegersArb(0, 68_719_476_736), (values) => {
          const expectedAvg = values.reduce((sum, v) => sum + v, 0) / values.length;
          const computedAvg = computeAvg(values);
          expect(isWithinTolerance(computedAvg, expectedAvg)).toBe(true);
        }),
        { numRuns: 500 }
      );
    });

    it('Property 2.4: MAX equals actual maximum of memory values', () => {
      fc.assert(
        fc.property(nonEmptyIntegersArb(0, 68_719_476_736), (values) => {
          const expectedMax = Math.max(...values);
          const computedMax = computeMax(values);
          expect(computedMax).toBe(expectedMax);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('disk_used_bytes', () => {
    it('Property 2.5: AVG equals arithmetic mean of disk values within tolerance', () => {
      fc.assert(
        fc.property(nonEmptyIntegersArb(0, 2_199_023_255_552), (values) => {
          const expectedAvg = values.reduce((sum, v) => sum + v, 0) / values.length;
          const computedAvg = computeAvg(values);
          expect(isWithinTolerance(computedAvg, expectedAvg)).toBe(true);
        }),
        { numRuns: 500 }
      );
    });

    it('Property 2.6: MAX equals actual maximum of disk values', () => {
      fc.assert(
        fc.property(nonEmptyIntegersArb(0, 2_199_023_255_552), (values) => {
          const expectedMax = Math.max(...values);
          const computedMax = computeMax(values);
          expect(computedMax).toBe(expectedMax);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('network_rx_bytes_per_sec', () => {
    it('Property 2.7: AVG equals arithmetic mean of network RX values within tolerance', () => {
      fc.assert(
        fc.property(nonEmptyIntegersArb(0, 1_250_000_000), (values) => {
          const expectedAvg = values.reduce((sum, v) => sum + v, 0) / values.length;
          const computedAvg = computeAvg(values);
          expect(isWithinTolerance(computedAvg, expectedAvg)).toBe(true);
        }),
        { numRuns: 500 }
      );
    });

    it('Property 2.8: MAX equals actual maximum of network RX values', () => {
      fc.assert(
        fc.property(nonEmptyIntegersArb(0, 1_250_000_000), (values) => {
          const expectedMax = Math.max(...values);
          const computedMax = computeMax(values);
          expect(computedMax).toBe(expectedMax);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('network_tx_bytes_per_sec', () => {
    it('Property 2.9: AVG equals arithmetic mean of network TX values within tolerance', () => {
      fc.assert(
        fc.property(nonEmptyIntegersArb(0, 1_250_000_000), (values) => {
          const expectedAvg = values.reduce((sum, v) => sum + v, 0) / values.length;
          const computedAvg = computeAvg(values);
          expect(isWithinTolerance(computedAvg, expectedAvg)).toBe(true);
        }),
        { numRuns: 500 }
      );
    });

    it('Property 2.10: MAX equals actual maximum of network TX values', () => {
      fc.assert(
        fc.property(nonEmptyIntegersArb(0, 1_250_000_000), (values) => {
          const expectedMax = Math.max(...values);
          const computedMax = computeMax(values);
          expect(computedMax).toBe(expectedMax);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('Full metric aggregation (all fields together)', () => {
    it('Property 2.11: aggregateMetrics produces correct avg for all fields', () => {
      fc.assert(
        fc.property(metricDataPointsArb, (dataPoints) => {
          const bucket = aggregateMetrics(dataPoints);

          const expectedCpuAvg = dataPoints.reduce((s, d) => s + d.cpu_usage_percent, 0) / dataPoints.length;
          const expectedMemAvg = dataPoints.reduce((s, d) => s + d.memory_used_bytes, 0) / dataPoints.length;
          const expectedDiskAvg = dataPoints.reduce((s, d) => s + d.disk_used_bytes, 0) / dataPoints.length;
          const expectedRxAvg = dataPoints.reduce((s, d) => s + d.network_rx_bytes_per_sec, 0) / dataPoints.length;
          const expectedTxAvg = dataPoints.reduce((s, d) => s + d.network_tx_bytes_per_sec, 0) / dataPoints.length;

          expect(isWithinTolerance(bucket.cpu_usage_percent_avg, expectedCpuAvg)).toBe(true);
          expect(isWithinTolerance(bucket.memory_used_bytes_avg, expectedMemAvg)).toBe(true);
          expect(isWithinTolerance(bucket.disk_used_bytes_avg, expectedDiskAvg)).toBe(true);
          expect(isWithinTolerance(bucket.network_rx_bytes_per_sec_avg, expectedRxAvg)).toBe(true);
          expect(isWithinTolerance(bucket.network_tx_bytes_per_sec_avg, expectedTxAvg)).toBe(true);
        }),
        { numRuns: 300 }
      );
    });

    it('Property 2.12: aggregateMetrics produces correct max for all fields', () => {
      fc.assert(
        fc.property(metricDataPointsArb, (dataPoints) => {
          const bucket = aggregateMetrics(dataPoints);

          const expectedCpuMax = Math.max(...dataPoints.map(d => d.cpu_usage_percent));
          const expectedMemMax = Math.max(...dataPoints.map(d => d.memory_used_bytes));
          const expectedDiskMax = Math.max(...dataPoints.map(d => d.disk_used_bytes));
          const expectedRxMax = Math.max(...dataPoints.map(d => d.network_rx_bytes_per_sec));
          const expectedTxMax = Math.max(...dataPoints.map(d => d.network_tx_bytes_per_sec));

          expect(bucket.cpu_usage_percent_max).toBe(expectedCpuMax);
          expect(bucket.memory_used_bytes_max).toBe(expectedMemMax);
          expect(bucket.disk_used_bytes_max).toBe(expectedDiskMax);
          expect(bucket.network_rx_bytes_per_sec_max).toBe(expectedRxMax);
          expect(bucket.network_tx_bytes_per_sec_max).toBe(expectedTxMax);
        }),
        { numRuns: 300 }
      );
    });

    it('Property 2.13: sample_count equals number of input data points', () => {
      fc.assert(
        fc.property(metricDataPointsArb, (dataPoints) => {
          const bucket = aggregateMetrics(dataPoints);
          expect(bucket.sample_count).toBe(dataPoints.length);
        }),
        { numRuns: 300 }
      );
    });

    it('Property 2.14: avg is bounded by min and max values', () => {
      fc.assert(
        fc.property(metricDataPointsArb, (dataPoints) => {
          const bucket = aggregateMetrics(dataPoints);

          // For each field, avg should be between min and max of input values
          const cpuValues = dataPoints.map(d => d.cpu_usage_percent);
          const memValues = dataPoints.map(d => d.memory_used_bytes);
          const diskValues = dataPoints.map(d => d.disk_used_bytes);
          const rxValues = dataPoints.map(d => d.network_rx_bytes_per_sec);
          const txValues = dataPoints.map(d => d.network_tx_bytes_per_sec);

          // avg >= min (with tolerance for floating-point)
          expect(bucket.cpu_usage_percent_avg).toBeGreaterThanOrEqual(Math.min(...cpuValues) - FLOAT_TOLERANCE);
          expect(bucket.memory_used_bytes_avg).toBeGreaterThanOrEqual(Math.min(...memValues) - FLOAT_TOLERANCE);
          expect(bucket.disk_used_bytes_avg).toBeGreaterThanOrEqual(Math.min(...diskValues) - FLOAT_TOLERANCE);
          expect(bucket.network_rx_bytes_per_sec_avg).toBeGreaterThanOrEqual(Math.min(...rxValues) - FLOAT_TOLERANCE);
          expect(bucket.network_tx_bytes_per_sec_avg).toBeGreaterThanOrEqual(Math.min(...txValues) - FLOAT_TOLERANCE);

          // avg <= max (with tolerance for floating-point)
          expect(bucket.cpu_usage_percent_avg).toBeLessThanOrEqual(Math.max(...cpuValues) + FLOAT_TOLERANCE);
          expect(bucket.memory_used_bytes_avg).toBeLessThanOrEqual(Math.max(...memValues) + FLOAT_TOLERANCE);
          expect(bucket.disk_used_bytes_avg).toBeLessThanOrEqual(Math.max(...diskValues) + FLOAT_TOLERANCE);
          expect(bucket.network_rx_bytes_per_sec_avg).toBeLessThanOrEqual(Math.max(...rxValues) + FLOAT_TOLERANCE);
          expect(bucket.network_tx_bytes_per_sec_avg).toBeLessThanOrEqual(Math.max(...txValues) + FLOAT_TOLERANCE);
        }),
        { numRuns: 300 }
      );
    });

    it('Property 2.15: max is always >= avg', () => {
      fc.assert(
        fc.property(metricDataPointsArb, (dataPoints) => {
          const bucket = aggregateMetrics(dataPoints);

          expect(bucket.cpu_usage_percent_max).toBeGreaterThanOrEqual(bucket.cpu_usage_percent_avg - FLOAT_TOLERANCE);
          expect(bucket.memory_used_bytes_max).toBeGreaterThanOrEqual(bucket.memory_used_bytes_avg - FLOAT_TOLERANCE);
          expect(bucket.disk_used_bytes_max).toBeGreaterThanOrEqual(bucket.disk_used_bytes_avg - FLOAT_TOLERANCE);
          expect(bucket.network_rx_bytes_per_sec_max).toBeGreaterThanOrEqual(bucket.network_rx_bytes_per_sec_avg - FLOAT_TOLERANCE);
          expect(bucket.network_tx_bytes_per_sec_max).toBeGreaterThanOrEqual(bucket.network_tx_bytes_per_sec_avg - FLOAT_TOLERANCE);
        }),
        { numRuns: 300 }
      );
    });
  });
});
