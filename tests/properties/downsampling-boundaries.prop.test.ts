/**
 * Property-based tests for downsampling bucket boundary alignment.
 *
 * Feature: VPS Panel Premium Upgrade, Property 1: Downsampling produces correct time bucket boundaries
 * For any set of raw metric data points with timestamps within a known time range,
 * when the Downsampling Engine aggregates them into 5-minute buckets, each bucket's
 * `bucket_start` timestamp SHALL be aligned to a 5-minute boundary (minute divisible by 5,
 * seconds = 0), and all source data points SHALL fall within [bucket_start, bucket_start + 5 minutes).
 * The same property applies to 1-hour aggregation with hour-aligned boundaries.
 *
 * **Validates: Requirements 1.2, 1.3**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { alignTo5MinBucket, alignTo1HourBucket } from '../../src/services/downsampling-engine.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate random timestamps within a reasonable range (2020-01-01 to 2030-12-31).
 * This covers a wide variety of minute/second/ms combinations.
 */
const timestampArb = fc.date({
  min: new Date('2020-01-01T00:00:00.000Z'),
  max: new Date('2030-12-31T23:59:59.999Z'),
});

// ─── Constants ─────────────────────────────────────────────────────────────────

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Downsampling Bucket Boundaries Property Tests (Property 1)', () => {
  describe('5-minute bucket alignment', () => {
    it('Property 1.1: bucket_start minute is divisible by 5', () => {
      fc.assert(
        fc.property(timestampArb, (timestamp) => {
          const bucketStart = alignTo5MinBucket(timestamp);
          const minutes = bucketStart.getUTCMinutes();
          expect(minutes % 5).toBe(0);
        }),
        { numRuns: 1000 }
      );
    });

    it('Property 1.2: bucket_start has seconds and milliseconds set to 0', () => {
      fc.assert(
        fc.property(timestampArb, (timestamp) => {
          const bucketStart = alignTo5MinBucket(timestamp);
          expect(bucketStart.getUTCSeconds()).toBe(0);
          expect(bucketStart.getUTCMilliseconds()).toBe(0);
        }),
        { numRuns: 1000 }
      );
    });

    it('Property 1.3: source timestamp falls within [bucket_start, bucket_start + 5 minutes)', () => {
      fc.assert(
        fc.property(timestampArb, (timestamp) => {
          const bucketStart = alignTo5MinBucket(timestamp);
          const bucketEnd = new Date(bucketStart.getTime() + FIVE_MINUTES_MS);

          // timestamp >= bucket_start
          expect(timestamp.getTime()).toBeGreaterThanOrEqual(bucketStart.getTime());
          // timestamp < bucket_start + 5 minutes
          expect(timestamp.getTime()).toBeLessThan(bucketEnd.getTime());
        }),
        { numRuns: 1000 }
      );
    });

    it('Property 1.4: bucket_start is always <= original timestamp (floor behavior)', () => {
      fc.assert(
        fc.property(timestampArb, (timestamp) => {
          const bucketStart = alignTo5MinBucket(timestamp);
          expect(bucketStart.getTime()).toBeLessThanOrEqual(timestamp.getTime());
        }),
        { numRuns: 1000 }
      );
    });
  });

  describe('1-hour bucket alignment', () => {
    it('Property 1.5: bucket_start minutes, seconds, and milliseconds are all 0', () => {
      fc.assert(
        fc.property(timestampArb, (timestamp) => {
          const bucketStart = alignTo1HourBucket(timestamp);
          expect(bucketStart.getUTCMinutes()).toBe(0);
          expect(bucketStart.getUTCSeconds()).toBe(0);
          expect(bucketStart.getUTCMilliseconds()).toBe(0);
        }),
        { numRuns: 1000 }
      );
    });

    it('Property 1.6: source timestamp falls within [bucket_start, bucket_start + 1 hour)', () => {
      fc.assert(
        fc.property(timestampArb, (timestamp) => {
          const bucketStart = alignTo1HourBucket(timestamp);
          const bucketEnd = new Date(bucketStart.getTime() + ONE_HOUR_MS);

          // timestamp >= bucket_start
          expect(timestamp.getTime()).toBeGreaterThanOrEqual(bucketStart.getTime());
          // timestamp < bucket_start + 1 hour
          expect(timestamp.getTime()).toBeLessThan(bucketEnd.getTime());
        }),
        { numRuns: 1000 }
      );
    });

    it('Property 1.7: bucket_start is always <= original timestamp (floor behavior)', () => {
      fc.assert(
        fc.property(timestampArb, (timestamp) => {
          const bucketStart = alignTo1HourBucket(timestamp);
          expect(bucketStart.getTime()).toBeLessThanOrEqual(timestamp.getTime());
        }),
        { numRuns: 1000 }
      );
    });

    it('Property 1.8: bucket_start preserves the same hour as the original timestamp', () => {
      fc.assert(
        fc.property(timestampArb, (timestamp) => {
          const bucketStart = alignTo1HourBucket(timestamp);
          expect(bucketStart.getUTCHours()).toBe(timestamp.getUTCHours());
          expect(bucketStart.getUTCFullYear()).toBe(timestamp.getUTCFullYear());
          expect(bucketStart.getUTCMonth()).toBe(timestamp.getUTCMonth());
          expect(bucketStart.getUTCDate()).toBe(timestamp.getUTCDate());
        }),
        { numRuns: 1000 }
      );
    });
  });
});
