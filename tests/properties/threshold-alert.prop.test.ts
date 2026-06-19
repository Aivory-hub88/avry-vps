/**
 * Property-based tests for configurable threshold alert evaluation (Property 7).
 *
 * Feature: VPS Panel Premium Upgrade
 * Property 7: Threshold alert fires with correct severity after consecutive breaches
 *
 * For any sequence of metric values and any configured threshold (warning or critical),
 * the Alert System SHALL emit an alert only after the configured number of consecutive
 * threshold breaches. The alert severity SHALL be 'warning' when the value exceeds the
 * warning threshold but is below the critical threshold, and 'critical' when the value
 * exceeds the critical threshold. Values below the warning threshold SHALL reset the
 * consecutive counter.
 *
 * **Validates: Requirements 9.2, 9.3, 9.4**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import {
  createAlertSystem,
  type AlertSystem,
  type ThresholdMetricType,
  type ThresholdEvaluationResult,
} from '../../src/modules/alert-system.js';
import {
  createAlertThresholdHandle,
  type AlertThresholdHandle,
} from '../../src/services/settings-hot-reload.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

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
      resolved_at TEXT,
      resolution_status TEXT DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);
  `);

  return db;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const metricTypeArb: fc.Arbitrary<ThresholdMetricType> = fc.constantFrom('cpu', 'memory', 'disk');

const resourceNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
  { minLength: 1, maxLength: 15 }
);

/** Warning threshold between 50 and 90 */
const warningThresholdArb = fc.integer({ min: 50, max: 90 });

/** Critical threshold: warning + 1 to 100 (generated relative to warning) */
function criticalThresholdArb(warningThreshold: number): fc.Arbitrary<number> {
  return fc.integer({ min: warningThreshold + 1, max: 100 });
}

/** Consecutive checks required between 1 and 10 */
const consecutiveChecksArb = fc.integer({ min: 1, max: 10 });

/**
 * Generate a metric value categorized into three zones:
 * - 'below': value < warningThreshold (0 to warningThreshold - 1)
 * - 'warning': warningThreshold < value <= criticalThreshold
 * - 'critical': value > criticalThreshold (criticalThreshold + 1 to 100)
 */
function metricValueArb(warningThreshold: number, criticalThreshold: number) {
  return fc.oneof(
    // Below warning (resets counter)
    fc.integer({ min: 0, max: warningThreshold }).map((v) => ({ zone: 'below' as const, value: v })),
    // Above warning but at or below critical
    fc.integer({ min: warningThreshold + 1, max: criticalThreshold }).map((v) => ({
      zone: 'warning' as const,
      value: v,
    })),
    // Above critical (criticalThreshold + 1 to 120 to allow some headroom)
    fc.integer({ min: criticalThreshold + 1, max: 120 }).map((v) => ({
      zone: 'critical' as const,
      value: v,
    }))
  );
}

type MetricZone = 'below' | 'warning' | 'critical';

interface ZonedValue {
  zone: MetricZone;
  value: number;
}

// ─── Model (Reference Implementation) ────────────────────────────────────────

interface ModelAlert {
  severity: 'warning' | 'critical';
}

/**
 * Reference model that computes expected alerts for a sequence of metric values.
 *
 * Rules (matching the implementation):
 * - value > critical: increment criticalCount AND warningCount
 *   - if criticalCount >= consecutiveChecks: fire critical alert, reset both counters
 * - value > warning (but <= critical): increment warningCount, reset criticalCount
 *   - if warningCount >= consecutiveChecks: fire warning alert, reset warningCount
 * - value <= warning: reset both counters
 */
function modelExpectedAlerts(
  values: ZonedValue[],
  warningThreshold: number,
  criticalThreshold: number,
  consecutiveChecks: number
): ModelAlert[] {
  const alerts: ModelAlert[] = [];
  let warningCount = 0;
  let criticalCount = 0;

  for (const { value } of values) {
    if (value > criticalThreshold) {
      // Critical zone: both counters increment
      criticalCount++;
      warningCount++;

      if (criticalCount >= consecutiveChecks) {
        alerts.push({ severity: 'critical' });
        // Reset both counters after firing
        criticalCount = 0;
        warningCount = 0;
      }
    } else if (value > warningThreshold) {
      // Warning zone: warning counter increments, critical resets
      warningCount++;
      criticalCount = 0;

      if (warningCount >= consecutiveChecks) {
        alerts.push({ severity: 'warning' });
        // Reset warning counter after firing
        warningCount = 0;
      }
    } else {
      // Below warning: reset both counters
      warningCount = 0;
      criticalCount = 0;
    }
  }

  return alerts;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Threshold Alert Property Tests (Property 7)', () => {
  it('Property 7.1: Alert fires only after N consecutive breaches with correct severity', async () => {
    await fc.assert(
      fc.asyncProperty(
        metricTypeArb,
        resourceNameArb,
        warningThresholdArb,
        consecutiveChecksArb,
        fc.gen(),
        async (metricType, resource, warningThreshold, consecutiveChecks, gen) => {
          const criticalThreshold = gen(criticalThresholdArb, warningThreshold);
          const values = gen(fc.array, metricValueArb(warningThreshold, criticalThreshold), {
            minLength: 1,
            maxLength: 25,
          });

          const db = createTestDb();
          const thresholdHandle = createAlertThresholdHandle({
            [`alert_${metricType}_warning`]: warningThreshold,
            [`alert_${metricType}_critical`]: criticalThreshold,
            alert_consecutive_checks: consecutiveChecks,
          });

          const alertSystem = createAlertSystem(db, { thresholdHandle });

          // Collect emitted alerts
          const emittedAlerts: ThresholdEvaluationResult[] = [];

          for (const zonedValue of values) {
            const result = await alertSystem.evaluateThreshold(metricType, resource, zonedValue.value);
            if (result.alertEmitted) {
              emittedAlerts.push(result);
            }
          }

          // Compare with model
          const expectedAlerts = modelExpectedAlerts(
            values,
            warningThreshold,
            criticalThreshold,
            consecutiveChecks
          );

          // Verify count matches
          expect(emittedAlerts.length).toBe(expectedAlerts.length);

          // Verify each alert's severity matches
          for (let i = 0; i < emittedAlerts.length; i++) {
            expect(emittedAlerts[i].severity).toBe(expectedAlerts[i].severity);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 7.2: Values below warning threshold reset the consecutive counter', async () => {
    await fc.assert(
      fc.asyncProperty(
        metricTypeArb,
        resourceNameArb,
        warningThresholdArb,
        consecutiveChecksArb.filter((n) => n >= 2),
        fc.gen(),
        async (metricType, resource, warningThreshold, consecutiveChecks, gen) => {
          const criticalThreshold = gen(criticalThresholdArb, warningThreshold);

          const db = createTestDb();
          const thresholdHandle = createAlertThresholdHandle({
            [`alert_${metricType}_warning`]: warningThreshold,
            [`alert_${metricType}_critical`]: criticalThreshold,
            alert_consecutive_checks: consecutiveChecks,
          });

          const alertSystem = createAlertSystem(db, { thresholdHandle });

          // Feed (consecutiveChecks - 1) values above warning
          const aboveWarning = warningThreshold + 1;
          for (let i = 0; i < consecutiveChecks - 1; i++) {
            await alertSystem.evaluateThreshold(metricType, resource, aboveWarning);
          }

          // Verify no alert fired yet
          expect(alertSystem.getBreachCount(metricType, resource)).toBeGreaterThan(0);

          // Feed a value below warning → resets counter
          const belowWarning = gen(fc.integer, { min: 0, max: warningThreshold });
          const resetResult = await alertSystem.evaluateThreshold(metricType, resource, belowWarning);
          expect(resetResult.alertEmitted).toBe(false);
          expect(alertSystem.getBreachCount(metricType, resource)).toBe(0);

          // Feed (consecutiveChecks - 1) more values above warning — still not enough
          for (let i = 0; i < consecutiveChecks - 1; i++) {
            await alertSystem.evaluateThreshold(metricType, resource, aboveWarning);
          }

          // Should NOT have fired an alert through this whole sequence
          const history = await alertSystem.getAlertHistory();
          expect(history.length).toBe(0);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Property 7.3: Warning severity when value exceeds warning but not critical', async () => {
    await fc.assert(
      fc.asyncProperty(
        metricTypeArb,
        resourceNameArb,
        warningThresholdArb,
        consecutiveChecksArb,
        fc.gen(),
        async (metricType, resource, warningThreshold, consecutiveChecks, gen) => {
          const criticalThreshold = gen(criticalThresholdArb, warningThreshold);

          const db = createTestDb();
          const thresholdHandle = createAlertThresholdHandle({
            [`alert_${metricType}_warning`]: warningThreshold,
            [`alert_${metricType}_critical`]: criticalThreshold,
            alert_consecutive_checks: consecutiveChecks,
          });

          const alertSystem = createAlertSystem(db, { thresholdHandle });

          // Feed exactly consecutiveChecks values in warning zone (above warning, at or below critical)
          const warningValue = gen(fc.integer, {
            min: warningThreshold + 1,
            max: criticalThreshold,
          });
          let firedResult: ThresholdEvaluationResult | null = null;

          for (let i = 0; i < consecutiveChecks; i++) {
            const result = await alertSystem.evaluateThreshold(metricType, resource, warningValue);
            if (result.alertEmitted) {
              firedResult = result;
            }
          }

          // Alert should have fired with warning severity
          expect(firedResult).not.toBeNull();
          expect(firedResult!.severity).toBe('warning');
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Property 7.4: Critical severity when value exceeds critical threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        metricTypeArb,
        resourceNameArb,
        warningThresholdArb,
        consecutiveChecksArb,
        fc.gen(),
        async (metricType, resource, warningThreshold, consecutiveChecks, gen) => {
          const criticalThreshold = gen(criticalThresholdArb, warningThreshold);

          const db = createTestDb();
          const thresholdHandle = createAlertThresholdHandle({
            [`alert_${metricType}_warning`]: warningThreshold,
            [`alert_${metricType}_critical`]: criticalThreshold,
            alert_consecutive_checks: consecutiveChecks,
          });

          const alertSystem = createAlertSystem(db, { thresholdHandle });

          // Feed exactly consecutiveChecks values above critical
          const criticalValue = criticalThreshold + 1;
          let firedResult: ThresholdEvaluationResult | null = null;

          for (let i = 0; i < consecutiveChecks; i++) {
            const result = await alertSystem.evaluateThreshold(metricType, resource, criticalValue);
            if (result.alertEmitted) {
              firedResult = result;
            }
          }

          // Alert should have fired with critical severity
          expect(firedResult).not.toBeNull();
          expect(firedResult!.severity).toBe('critical');
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Property 7.5: No alert fires before reaching consecutive check threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        metricTypeArb,
        resourceNameArb,
        warningThresholdArb,
        consecutiveChecksArb.filter((n) => n >= 2),
        fc.gen(),
        async (metricType, resource, warningThreshold, consecutiveChecks, gen) => {
          const criticalThreshold = gen(criticalThresholdArb, warningThreshold);

          const db = createTestDb();
          const thresholdHandle = createAlertThresholdHandle({
            [`alert_${metricType}_warning`]: warningThreshold,
            [`alert_${metricType}_critical`]: criticalThreshold,
            alert_consecutive_checks: consecutiveChecks,
          });

          const alertSystem = createAlertSystem(db, { thresholdHandle });

          // Feed exactly (consecutiveChecks - 1) values above critical — not enough to trigger
          const criticalValue = criticalThreshold + 5;
          for (let i = 0; i < consecutiveChecks - 1; i++) {
            const result = await alertSystem.evaluateThreshold(metricType, resource, criticalValue);
            expect(result.alertEmitted).toBe(false);
          }

          // Same for warning zone: (consecutiveChecks - 1) values
          const db2 = createTestDb();
          const thresholdHandle2 = createAlertThresholdHandle({
            [`alert_${metricType}_warning`]: warningThreshold,
            [`alert_${metricType}_critical`]: criticalThreshold,
            alert_consecutive_checks: consecutiveChecks,
          });

          const alertSystem2 = createAlertSystem(db2, { thresholdHandle: thresholdHandle2 });

          const warningValue = warningThreshold + 1;
          for (let i = 0; i < consecutiveChecks - 1; i++) {
            const result = await alertSystem2.evaluateThreshold(metricType, resource, warningValue);
            expect(result.alertEmitted).toBe(false);
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Property 7.6: Dropping from critical zone to warning zone resets critical counter but keeps warning counter', async () => {
    await fc.assert(
      fc.asyncProperty(
        metricTypeArb,
        resourceNameArb,
        warningThresholdArb,
        consecutiveChecksArb.filter((n) => n >= 3),
        fc.gen(),
        async (metricType, resource, warningThreshold, consecutiveChecks, gen) => {
          const criticalThreshold = gen(criticalThresholdArb, warningThreshold);

          const db = createTestDb();
          const thresholdHandle = createAlertThresholdHandle({
            [`alert_${metricType}_warning`]: warningThreshold,
            [`alert_${metricType}_critical`]: criticalThreshold,
            alert_consecutive_checks: consecutiveChecks,
          });

          const alertSystem = createAlertSystem(db, { thresholdHandle });

          // Use the model to compute expected behavior for a specific sequence:
          // 1 critical value, then reset with below-warning, then (consecutiveChecks - 1) critical values,
          // then drop to warning zone. The critical counter should be reset by the warning zone entry.
          const criticalValue = criticalThreshold + 5;

          // Start fresh: 1 critical value
          await alertSystem.evaluateThreshold(metricType, resource, criticalValue);

          // Reset everything with below-warning value
          const belowValue = gen(fc.integer, { min: 0, max: warningThreshold });
          await alertSystem.evaluateThreshold(metricType, resource, belowValue);

          // Now feed (consecutiveChecks - 1) critical values
          for (let i = 0; i < consecutiveChecks - 1; i++) {
            const result = await alertSystem.evaluateThreshold(metricType, resource, criticalValue);
            // Should not fire yet (not enough consecutive)
            expect(result.alertEmitted).toBe(false);
          }

          // Drop to warning zone — critical counter resets to 0
          const warningValue = warningThreshold + 1;
          await alertSystem.evaluateThreshold(metricType, resource, warningValue);

          // Now feed 1 more critical value — critical counter is only 1 (just reset)
          const afterResult = await alertSystem.evaluateThreshold(
            metricType,
            resource,
            criticalValue
          );
          // Should NOT fire a critical alert since criticalCount is only 1
          // (it might fire a warning if warningCount accumulated enough)
          if (afterResult.alertEmitted) {
            expect(afterResult.severity).not.toBe('critical');
          }
        }
      ),
      { numRuns: 150 }
    );
  });
});
