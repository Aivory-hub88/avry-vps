/**
 * Property-based tests for Resource Threshold Alert Triggering.
 *
 * Feature: vps-panel, Property 10: Resource threshold alert triggering
 * Tests that alerts fire iff metric exceeds threshold for 3+ consecutive intervals.
 *
 * Key behaviours:
 * - Alerts fire ONLY when a metric EXCEEDS (strictly >) the threshold for
 *   consecutiveChecks (default 3) consecutive intervals.
 * - If the value drops to or below threshold at any point, the counter resets.
 * - Different resources are tracked independently.
 * - Values exactly at threshold do NOT trigger (must exceed).
 * - Custom consecutive check counts are respected.
 *
 * **Validates: Requirements 14.2**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import { createAlertSystem, type AlertResourceType, type AlertRecord } from '../../src/modules/alert-system.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create required tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      threshold REAL,
      consecutive_checks INTEGER DEFAULT 3,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT NOT NULL,
      affected_resource TEXT NOT NULL,
      severity TEXT NOT NULL,
      delivery_status TEXT,
      message TEXT,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      resolved_at TEXT,
      resolution_status TEXT DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);
  `);

  return db;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const resourceTypeArb: fc.Arbitrary<AlertResourceType> = fc.constantFrom(
  'cpu',
  'memory',
  'disk'
);

const resourceNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 1, maxLength: 20 }
);

/** Threshold between 10 and 95 */
const thresholdArb = fc.integer({ min: 10, max: 95 });

/** Consecutive checks between 2 and 10 */
const consecutiveChecksArb = fc.integer({ min: 2, max: 10 });

/** A metric value between 0 and 100 */
const metricValueArb = fc.integer({ min: 0, max: 100 });

/**
 * Generates a sequence of metric values.
 * Each value is an integer between 0 and 100.
 */
const metricSequenceArb = fc.array(metricValueArb, { minLength: 1, maxLength: 30 });

// ─── Model (reference implementation) ────────────────────────────────────────

/**
 * Model that computes how many alerts should fire for a given sequence of
 * metric values against a threshold with a specified consecutive check count.
 *
 * Returns the number of expected alert firings.
 */
function modelAlertCount(
  values: number[],
  threshold: number,
  consecutiveChecks: number
): number {
  let count = 0;
  let alerts = 0;

  for (const value of values) {
    if (value > threshold) {
      count++;
    } else {
      count = 0;
    }

    if (count >= consecutiveChecks) {
      alerts++;
      count = 0; // Reset after firing (matches implementation)
    }
  }

  return alerts;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Alert Threshold Property Tests', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('Property 10.1: Alerts fire iff metric exceeds threshold for consecutiveChecks consecutive intervals', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        resourceNameArb,
        thresholdArb,
        consecutiveChecksArb,
        metricSequenceArb,
        async (resourceType, resource, threshold, consecutiveChecks, values) => {
          const testDb = createTestDb();
          const alertsFired: AlertRecord[] = [];

          const alertSystem = createAlertSystem(testDb, {
            onInAppNotification: (alert) => alertsFired.push(alert),
          });

          // Configure a rule
          await alertSystem.configureRule({
            resourceType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          // Record each metric value
          for (const value of values) {
            await alertSystem.recordMetric(resourceType, resource, value);
          }

          // Count alerts from the model
          const expectedAlerts = modelAlertCount(values, threshold, consecutiveChecks);

          // Verify the system fired the correct number of alerts
          const history = await alertSystem.getAlertHistory();
          expect(history.length).toBe(expectedAlerts);
          expect(alertsFired.length).toBe(expectedAlerts);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 10.2: Counter resets when value drops to or below threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        resourceNameArb,
        thresholdArb,
        async (resourceType, resource, threshold) => {
          const testDb = createTestDb();
          const alertsFired: AlertRecord[] = [];

          const alertSystem = createAlertSystem(testDb, {
            onInAppNotification: (alert) => alertsFired.push(alert),
          });

          const consecutiveChecks = 3;
          await alertSystem.configureRule({
            resourceType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          // Record 2 values above threshold (not enough to trigger)
          const aboveValue = threshold + 1;
          await alertSystem.recordMetric(resourceType, resource, aboveValue);
          await alertSystem.recordMetric(resourceType, resource, aboveValue);

          // Drop below threshold — counter should reset
          const belowValue = threshold - 1;
          await alertSystem.recordMetric(resourceType, resource, belowValue);

          // Record 2 more above threshold (still not enough after reset)
          await alertSystem.recordMetric(resourceType, resource, aboveValue);
          await alertSystem.recordMetric(resourceType, resource, aboveValue);

          // No alert should have fired
          const history = await alertSystem.getAlertHistory();
          expect(history.length).toBe(0);
          expect(alertsFired.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 10.3: Different resources are tracked independently', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        thresholdArb,
        fc.tuple(resourceNameArb, resourceNameArb).filter(([a, b]) => a !== b),
        async (resourceType, threshold, [resourceA, resourceB]) => {
          const testDb = createTestDb();
          const alertsFired: AlertRecord[] = [];

          const alertSystem = createAlertSystem(testDb, {
            onInAppNotification: (alert) => alertsFired.push(alert),
          });

          const consecutiveChecks = 3;
          await alertSystem.configureRule({
            resourceType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          const aboveValue = threshold + 1;

          // Resource A gets 3 consecutive readings above threshold → alert
          await alertSystem.recordMetric(resourceType, resourceA, aboveValue);
          await alertSystem.recordMetric(resourceType, resourceA, aboveValue);
          await alertSystem.recordMetric(resourceType, resourceA, aboveValue);

          // Resource B only gets 2 consecutive readings above threshold → no alert
          await alertSystem.recordMetric(resourceType, resourceB, aboveValue);
          await alertSystem.recordMetric(resourceType, resourceB, aboveValue);

          // Only 1 alert should have fired (for resource A)
          const history = await alertSystem.getAlertHistory();
          expect(history.length).toBe(1);
          expect(history[0].affectedResource).toBe(resourceA);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 10.4: Values exactly at threshold do NOT trigger alerts (must exceed)', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        resourceNameArb,
        thresholdArb,
        fc.integer({ min: 5, max: 20 }),
        async (resourceType, resource, threshold, repeatCount) => {
          const testDb = createTestDb();
          const alertsFired: AlertRecord[] = [];

          const alertSystem = createAlertSystem(testDb, {
            onInAppNotification: (alert) => alertsFired.push(alert),
          });

          await alertSystem.configureRule({
            resourceType,
            threshold,
            consecutiveChecks: 3,
            enabled: true,
          });

          // Record the exact threshold value many times — should never trigger
          for (let i = 0; i < repeatCount; i++) {
            await alertSystem.recordMetric(resourceType, resource, threshold);
          }

          const history = await alertSystem.getAlertHistory();
          expect(history.length).toBe(0);
          expect(alertsFired.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 10.5: Custom consecutive check counts are respected', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        resourceNameArb,
        thresholdArb,
        consecutiveChecksArb,
        async (resourceType, resource, threshold, consecutiveChecks) => {
          const testDb = createTestDb();
          const alertsFired: AlertRecord[] = [];

          const alertSystem = createAlertSystem(testDb, {
            onInAppNotification: (alert) => alertsFired.push(alert),
          });

          await alertSystem.configureRule({
            resourceType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          const aboveValue = threshold + 1;

          // Record exactly (consecutiveChecks - 1) values above threshold
          for (let i = 0; i < consecutiveChecks - 1; i++) {
            await alertSystem.recordMetric(resourceType, resource, aboveValue);
          }

          // Should NOT have fired yet
          let history = await alertSystem.getAlertHistory();
          expect(history.length).toBe(0);

          // One more above threshold → should now fire
          await alertSystem.recordMetric(resourceType, resource, aboveValue);

          history = await alertSystem.getAlertHistory();
          expect(history.length).toBe(1);
          expect(alertsFired.length).toBe(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
