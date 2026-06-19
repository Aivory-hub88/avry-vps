import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getResourceBarColor } from './resourceBarColor';

/**
 * Property 4: Resource bar color-coding threshold function
 *
 * For any usage percentage value between 0 and 100 (inclusive),
 * the color function SHALL return 'green' when percentage < 70,
 * 'yellow' when 70 ≤ percentage < 90, and 'red' when percentage ≥ 90.
 *
 * **Validates: Requirements 5.2**
 */
describe('Property 4: Resource bar color-coding threshold function', () => {
  it('returns green for any percentage in [0, 70)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 69.999999999, noNaN: true, noDefaultInfinity: true }),
        (percentage) => {
          expect(getResourceBarColor(percentage)).toBe('green');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns yellow for any percentage in [70, 90)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 70, max: 89.999999999, noNaN: true, noDefaultInfinity: true }),
        (percentage) => {
          expect(getResourceBarColor(percentage)).toBe('yellow');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns red for any percentage in [90, 100]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 90, max: 100, noNaN: true, noDefaultInfinity: true }),
        (percentage) => {
          expect(getResourceBarColor(percentage)).toBe('red');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('boundary values: exactly 0, 70, 90, 100 produce correct colors', () => {
    // Exact boundary: 0 → green
    expect(getResourceBarColor(0)).toBe('green');
    // Exact boundary: 70 → yellow
    expect(getResourceBarColor(70)).toBe('yellow');
    // Exact boundary: 90 → red
    expect(getResourceBarColor(90)).toBe('red');
    // Exact boundary: 100 → red
    expect(getResourceBarColor(100)).toBe('red');
  });

  it('integer percentages 0-100 all return a valid color matching the threshold rules', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (percentage) => {
          const color = getResourceBarColor(percentage);
          if (percentage < 70) {
            expect(color).toBe('green');
          } else if (percentage < 90) {
            expect(color).toBe('yellow');
          } else {
            expect(color).toBe('red');
          }
        }
      ),
      { numRuns: 101 }
    );
  });
});
