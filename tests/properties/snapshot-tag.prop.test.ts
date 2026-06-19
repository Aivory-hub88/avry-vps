/**
 * Property-based tests for snapshot tag format correctness.
 *
 * Feature: VPS Panel Premium Upgrade, Property 11: Snapshot tag format correctness
 * For any valid container name (non-empty string without special characters) and any valid
 * timestamp, the generated snapshot image tag SHALL match the pattern
 * `{container_name}-snapshot-{YYYYMMDD-HHmmss}` where the date/time components are zero-padded.
 *
 * **Validates: Requirements 13.2**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { generateSnapshotTag } from '../../src/modules/backup-manager.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate random container names: alphanumeric + hyphens, 1-30 characters.
 * Must start and end with alphanumeric (Docker naming convention).
 */
const containerNameArb = fc
  .stringOf(
    fc.oneof(
      fc.char().filter((c) => /[a-z0-9]/.test(c)),
      fc.constant('-')
    ),
    { minLength: 1, maxLength: 30 }
  )
  .filter((s) => /^[a-z0-9]/.test(s) && /[a-z0-9]$/.test(s) && !s.includes('--'));

/**
 * Generate random Date objects within a reasonable range (2000-01-01 to 2099-12-31).
 */
const dateArb = fc.date({
  min: new Date('2000-01-01T00:00:00.000Z'),
  max: new Date('2099-12-31T23:59:59.999Z'),
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Snapshot Tag Format Property Tests (Property 11)', () => {
  it('Property 11.1: tag matches regex pattern ^{containerName}-snapshot-\\d{8}-\\d{6}$', () => {
    fc.assert(
      fc.property(containerNameArb, dateArb, (containerName, date) => {
        const tag = generateSnapshotTag(containerName, date);
        const expectedPattern = new RegExp(
          `^${containerName.replace(/[-]/g, '\\-')}-snapshot-\\d{8}-\\d{6}$`
        );
        expect(tag).toMatch(expectedPattern);
      }),
      { numRuns: 1000 }
    );
  });

  it('Property 11.2: date/time components are correctly zero-padded', () => {
    fc.assert(
      fc.property(containerNameArb, dateArb, (containerName, date) => {
        const tag = generateSnapshotTag(containerName, date);

        // Extract the timestamp portion after "{containerName}-snapshot-"
        const prefix = `${containerName}-snapshot-`;
        const timestampPart = tag.slice(prefix.length);

        // Should be exactly 15 chars: YYYYMMDD-HHmmss
        expect(timestampPart).toHaveLength(15);

        // Verify format: 8 digits, hyphen, 6 digits
        expect(timestampPart).toMatch(/^\d{8}-\d{6}$/);
      }),
      { numRuns: 1000 }
    );
  });

  it('Property 11.3: month is 01-12 (not 0-indexed)', () => {
    fc.assert(
      fc.property(containerNameArb, dateArb, (containerName, date) => {
        const tag = generateSnapshotTag(containerName, date);

        const prefix = `${containerName}-snapshot-`;
        const timestampPart = tag.slice(prefix.length);

        // Extract month (characters 4-5 of the date portion)
        const month = parseInt(timestampPart.slice(4, 6), 10);
        expect(month).toBeGreaterThanOrEqual(1);
        expect(month).toBeLessThanOrEqual(12);

        // Verify it matches the input date's month (getMonth() is 0-indexed)
        expect(month).toBe(date.getMonth() + 1);
      }),
      { numRuns: 1000 }
    );
  });

  it('Property 11.4: day is 01-31', () => {
    fc.assert(
      fc.property(containerNameArb, dateArb, (containerName, date) => {
        const tag = generateSnapshotTag(containerName, date);

        const prefix = `${containerName}-snapshot-`;
        const timestampPart = tag.slice(prefix.length);

        // Extract day (characters 6-7 of the date portion)
        const day = parseInt(timestampPart.slice(6, 8), 10);
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(31);

        // Verify it matches the input date's day
        expect(day).toBe(date.getDate());
      }),
      { numRuns: 1000 }
    );
  });

  it('Property 11.5: hours 00-23, minutes 00-59, seconds 00-59', () => {
    fc.assert(
      fc.property(containerNameArb, dateArb, (containerName, date) => {
        const tag = generateSnapshotTag(containerName, date);

        const prefix = `${containerName}-snapshot-`;
        const timestampPart = tag.slice(prefix.length);

        // Extract time portion (after the hyphen)
        const timePart = timestampPart.slice(9); // HHmmss
        const hours = parseInt(timePart.slice(0, 2), 10);
        const minutes = parseInt(timePart.slice(2, 4), 10);
        const seconds = parseInt(timePart.slice(4, 6), 10);

        expect(hours).toBeGreaterThanOrEqual(0);
        expect(hours).toBeLessThanOrEqual(23);
        expect(minutes).toBeGreaterThanOrEqual(0);
        expect(minutes).toBeLessThanOrEqual(59);
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(seconds).toBeLessThanOrEqual(59);

        // Verify they match the input date's time components
        expect(hours).toBe(date.getHours());
        expect(minutes).toBe(date.getMinutes());
        expect(seconds).toBe(date.getSeconds());
      }),
      { numRuns: 1000 }
    );
  });
});
