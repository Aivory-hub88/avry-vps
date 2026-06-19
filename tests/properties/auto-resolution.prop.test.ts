/**
 * Property-based tests for auto-resolution selection based on time range.
 *
 * Feature: VPS Panel Premium Upgrade, Property 13: Auto-resolution selection based on time range
 * For any query time range (start, end) where no explicit resolution is provided:
 * - if the range is ≤ 24 hours, the effective resolution SHALL be '30s' (raw data)
 * - if the range is > 24 hours and ≤ 30 days, the effective resolution SHALL be '5m'
 * - if the range is > 30 days, the effective resolution SHALL be '1h'
 * An explicitly provided resolution SHALL always override the automatic selection.
 *
 * **Validates: Requirements 18.2, 18.3**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { selectResolutionV2 } from '../../src/services/historical-metrics.js';
import type { ResolutionV2 } from '../../src/services/historical-metrics.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 60 * 60 * MS_PER_SECOND;
const RANGE_24H_MS = 24 * MS_PER_HOUR;
const RANGE_30D_MS = 30 * 24 * MS_PER_HOUR;

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate a random range in milliseconds that is > 0 and ≤ 24 hours.
 * Minimum is 1ms to avoid zero-duration ranges.
 */
const rangeUpTo24hArb = fc.integer({ min: 1, max: RANGE_24H_MS });

/**
 * Generate a random range in milliseconds that is > 24 hours and ≤ 30 days.
 */
const rangeOver24hUpTo30dArb = fc.integer({ min: RANGE_24H_MS + 1, max: RANGE_30D_MS });

/**
 * Generate a random range in milliseconds that is > 30 days.
 * Upper bound: ~365 days to keep tests reasonable.
 */
const rangeOver30dArb = fc.integer({ min: RANGE_30D_MS + 1, max: 365 * 24 * MS_PER_HOUR });

/**
 * Generate any valid positive range in milliseconds.
 */
const anyPositiveRangeArb = fc.integer({ min: 1, max: 365 * 24 * MS_PER_HOUR });

/**
 * Generate a valid V2 resolution value.
 */
const resolutionArb = fc.constantFrom<ResolutionV2>('30s', '5m', '1h');

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Auto-Resolution Selection Property Tests (Property 13)', () => {
  describe('Range ≤ 24 hours → 30s resolution', () => {
    it('Property 13.1: ranges up to and including 24h return 30s when no explicit resolution', () => {
      fc.assert(
        fc.property(rangeUpTo24hArb, (rangeMs) => {
          const result = selectResolutionV2(rangeMs);
          expect(result).toBe('30s');
        }),
        { numRuns: 1000 }
      );
    });
  });

  describe('Range > 24 hours and ≤ 30 days → 5m resolution', () => {
    it('Property 13.2: ranges between 24h (exclusive) and 30d (inclusive) return 5m when no explicit resolution', () => {
      fc.assert(
        fc.property(rangeOver24hUpTo30dArb, (rangeMs) => {
          const result = selectResolutionV2(rangeMs);
          expect(result).toBe('5m');
        }),
        { numRuns: 1000 }
      );
    });
  });

  describe('Range > 30 days → 1h resolution', () => {
    it('Property 13.3: ranges exceeding 30 days return 1h when no explicit resolution', () => {
      fc.assert(
        fc.property(rangeOver30dArb, (rangeMs) => {
          const result = selectResolutionV2(rangeMs);
          expect(result).toBe('1h');
        }),
        { numRuns: 1000 }
      );
    });
  });

  describe('Explicit resolution always overrides auto-selection', () => {
    it('Property 13.4: any range with an explicit resolution returns that explicit value', () => {
      fc.assert(
        fc.property(anyPositiveRangeArb, resolutionArb, (rangeMs, explicit) => {
          const result = selectResolutionV2(rangeMs, explicit);
          expect(result).toBe(explicit);
        }),
        { numRuns: 1000 }
      );
    });
  });
});
