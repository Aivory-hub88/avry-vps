import { describe, it, expect } from 'vitest';
import { getResourceBarColor } from './resourceBarColor';

describe('getResourceBarColor', () => {
  it('returns green for percentage below 70', () => {
    expect(getResourceBarColor(0)).toBe('green');
    expect(getResourceBarColor(35)).toBe('green');
    expect(getResourceBarColor(69)).toBe('green');
    expect(getResourceBarColor(69.9)).toBe('green');
  });

  it('returns yellow for percentage between 70 (inclusive) and 90 (exclusive)', () => {
    expect(getResourceBarColor(70)).toBe('yellow');
    expect(getResourceBarColor(75)).toBe('yellow');
    expect(getResourceBarColor(80)).toBe('yellow');
    expect(getResourceBarColor(89)).toBe('yellow');
    expect(getResourceBarColor(89.9)).toBe('yellow');
  });

  it('returns red for percentage at or above 90', () => {
    expect(getResourceBarColor(90)).toBe('red');
    expect(getResourceBarColor(95)).toBe('red');
    expect(getResourceBarColor(100)).toBe('red');
  });

  it('handles boundary values correctly', () => {
    // Exact boundary at 70
    expect(getResourceBarColor(70)).toBe('yellow');
    // Just below 70
    expect(getResourceBarColor(69.999)).toBe('green');
    // Exact boundary at 90
    expect(getResourceBarColor(90)).toBe('red');
    // Just below 90
    expect(getResourceBarColor(89.999)).toBe('yellow');
  });
});
