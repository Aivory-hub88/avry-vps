/**
 * Determines the color class for a container resource bar based on usage percentage.
 * - Green: usage below 70%
 * - Yellow: usage between 70% (inclusive) and 90% (exclusive)
 * - Red: usage at or above 90%
 */
export function getResourceBarColor(percentage: number): 'green' | 'yellow' | 'red' {
  if (percentage >= 90) return 'red';
  if (percentage >= 70) return 'yellow';
  return 'green';
}
