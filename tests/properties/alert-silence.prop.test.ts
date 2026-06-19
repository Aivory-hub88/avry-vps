/**
 * Property-based tests for alert silence suppression (Property 9).
 *
 * Feature: VPS Panel Premium Upgrade
 * Property 9: Alert silence suppresses notifications within duration
 *
 * For any alert rule that has an active silence with a specified duration, when a
 * threshold breach occurs for that rule within the silence window, the Alert System
 * SHALL NOT deliver notifications to any channel. After the silence period expires,
 * subsequent breaches SHALL trigger normal notification delivery.
 *
 * **Validates: Requirements 11.4**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import {
  createAlertSystem,
  type AlertResourceType,
  type AlertRecord,
} from '../../src/modules/alert-system.js';

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
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      resolved_at TEXT,
      resolution_status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS alert_silences (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      admin_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
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
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
  { minLength: 1, maxLength: 15 }
);

/** Silence duration between 100ms and 5000ms (fast test execution) */
const silenceDurationArb = fc.integer({ min: 100, max: 5000 });

/** Threshold between 30 and 80 (ensure we can easily exceed it) */
const thresholdArb = fc.integer({ min: 30, max: 80 });

/** Consecutive checks: 1 to 5 (keep tests quick) */
const consecutiveChecksArb = fc.integer({ min: 1, max: 5 });

/** Admin ID for silencing */
const adminIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 10 }
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Alert Silence Suppression Property Tests (Property 9)', () => {
  it('Property 9.1: When a rule is silenced, notifications are NOT delivered for matching alerts', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        resourceNameArb,
        thresholdArb,
        consecutiveChecksArb,
        silenceDurationArb,
        adminIdArb,
        async (resourceType, resource, threshold, consecutiveChecks, durationMs, adminId) => {
          const db = createTestDb();
          const notificationsDelivered: AlertRecord[] = [];

          const alertSystem = createAlertSystem(db, {
            onInAppNotification: (alert) => notificationsDelivered.push(alert),
            deduplicationWindowMs: 0, // Disable deduplication to isolate silence logic
          });

          // Configure a rule for the resource type
          const ruleId = await alertSystem.configureRule({
            resourceType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          // Silence the rule
          const silenceId = await alertSystem.silenceRule(ruleId, durationMs, adminId);

          // Verify silence is active
          const silences = await alertSystem.getActiveSilences();
          expect(silences.length).toBeGreaterThanOrEqual(1);
          expect(silences.some((s) => s.id === silenceId)).toBe(true);

          // Trigger enough threshold breaches to fire an alert
          const aboveThreshold = threshold + 10;
          for (let i = 0; i < consecutiveChecks; i++) {
            await alertSystem.recordMetric(resourceType, resource, aboveThreshold);
          }

          // Alert should be stored in history (with 'silenced' status)
          const history = await alertSystem.getAlertHistory();
          expect(history.length).toBeGreaterThanOrEqual(1);
          const silencedAlert = history.find((a) => a.resolutionStatus === 'silenced');
          expect(silencedAlert).toBeDefined();

          // But in-app notification callback should NOT have been called
          expect(notificationsDelivered.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 9.2: After silence is removed, notifications ARE delivered for subsequent alerts', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        resourceNameArb,
        thresholdArb,
        consecutiveChecksArb,
        silenceDurationArb,
        adminIdArb,
        async (resourceType, resource, threshold, consecutiveChecks, durationMs, adminId) => {
          const db = createTestDb();
          const notificationsDelivered: AlertRecord[] = [];

          const alertSystem = createAlertSystem(db, {
            onInAppNotification: (alert) => notificationsDelivered.push(alert),
            deduplicationWindowMs: 0, // Disable deduplication to isolate silence logic
          });

          // Configure a rule for the resource type
          const ruleId = await alertSystem.configureRule({
            resourceType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          // Silence the rule
          const silenceId = await alertSystem.silenceRule(ruleId, durationMs, adminId);

          // Trigger alert while silenced (to fire and reset the tracker)
          const aboveThreshold = threshold + 10;
          for (let i = 0; i < consecutiveChecks; i++) {
            await alertSystem.recordMetric(resourceType, resource, aboveThreshold);
          }

          // Confirm no notifications delivered while silenced
          expect(notificationsDelivered.length).toBe(0);

          // Remove the silence
          await alertSystem.removeSilence(silenceId);

          // Verify silence is no longer active
          const silences = await alertSystem.getActiveSilences();
          expect(silences.some((s) => s.id === silenceId)).toBe(false);

          // Trigger another alert — should now deliver
          for (let i = 0; i < consecutiveChecks; i++) {
            await alertSystem.recordMetric(resourceType, resource, aboveThreshold);
          }

          // Notification should have been delivered after silence removal
          expect(notificationsDelivered.length).toBeGreaterThanOrEqual(1);

          // The delivered alert should have 'active' resolution status (not silenced)
          const deliveredAlert = notificationsDelivered[0];
          expect(deliveredAlert.resolutionStatus).toBe('active');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 9.3: Silence only affects rules with matching resource type', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(resourceTypeArb, resourceTypeArb).filter(([a, b]) => a !== b),
        resourceNameArb,
        thresholdArb,
        consecutiveChecksArb,
        silenceDurationArb,
        adminIdArb,
        async ([silencedType, unsilencedType], resource, threshold, consecutiveChecks, durationMs, adminId) => {
          const db = createTestDb();
          const notificationsDelivered: AlertRecord[] = [];

          const alertSystem = createAlertSystem(db, {
            onInAppNotification: (alert) => notificationsDelivered.push(alert),
            deduplicationWindowMs: 0, // Disable deduplication to isolate silence logic
          });

          // Configure rules for both resource types
          const silencedRuleId = await alertSystem.configureRule({
            resourceType: silencedType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          await alertSystem.configureRule({
            resourceType: unsilencedType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          // Silence only the first rule
          await alertSystem.silenceRule(silencedRuleId, durationMs, adminId);

          // Trigger alert on the unsilenced resource type
          const aboveThreshold = threshold + 10;
          for (let i = 0; i < consecutiveChecks; i++) {
            await alertSystem.recordMetric(unsilencedType, resource, aboveThreshold);
          }

          // The unsilenced resource type should still deliver notifications
          expect(notificationsDelivered.length).toBeGreaterThanOrEqual(1);

          // Reset notifications
          notificationsDelivered.length = 0;

          // Trigger alert on the silenced resource type
          for (let i = 0; i < consecutiveChecks; i++) {
            await alertSystem.recordMetric(silencedType, resource, aboveThreshold);
          }

          // The silenced resource type should NOT deliver notifications
          expect(notificationsDelivered.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 9.4: Multiple silences on same rule still suppress notifications', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        resourceNameArb,
        thresholdArb,
        consecutiveChecksArb,
        silenceDurationArb,
        silenceDurationArb,
        adminIdArb,
        async (resourceType, resource, threshold, consecutiveChecks, duration1, duration2, adminId) => {
          const db = createTestDb();
          const notificationsDelivered: AlertRecord[] = [];

          const alertSystem = createAlertSystem(db, {
            onInAppNotification: (alert) => notificationsDelivered.push(alert),
            deduplicationWindowMs: 0, // Disable deduplication to isolate silence logic
          });

          // Configure a rule
          const ruleId = await alertSystem.configureRule({
            resourceType,
            threshold,
            consecutiveChecks,
            enabled: true,
          });

          // Add two silences on the same rule
          const silenceId1 = await alertSystem.silenceRule(ruleId, duration1, adminId);
          const silenceId2 = await alertSystem.silenceRule(ruleId, duration2, adminId);

          // Trigger alert
          const aboveThreshold = threshold + 10;
          for (let i = 0; i < consecutiveChecks; i++) {
            await alertSystem.recordMetric(resourceType, resource, aboveThreshold);
          }

          // Still suppressed (both silences active)
          expect(notificationsDelivered.length).toBe(0);

          // Remove first silence — second still active
          await alertSystem.removeSilence(silenceId1);

          // Trigger another alert
          for (let i = 0; i < consecutiveChecks; i++) {
            await alertSystem.recordMetric(resourceType, resource, aboveThreshold);
          }

          // Should still be suppressed (second silence remains)
          expect(notificationsDelivered.length).toBe(0);

          // Remove second silence
          await alertSystem.removeSilence(silenceId2);

          // Trigger alert now — should deliver
          for (let i = 0; i < consecutiveChecks; i++) {
            await alertSystem.recordMetric(resourceType, resource, aboveThreshold);
          }

          // Notification should now be delivered
          expect(notificationsDelivered.length).toBeGreaterThanOrEqual(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
