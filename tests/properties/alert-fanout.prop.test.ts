/**
 * Property-based tests for alert fan-out delivery (Property 10).
 *
 * Feature: VPS Panel Premium Upgrade
 * Property 10: Alert delivery fans out to all enabled channels
 *
 * For any alert event and any set of enabled notification channels (N ≥ 1),
 * the Alert System SHALL attempt delivery to exactly N channels. The delivery
 * status record SHALL contain an entry for each enabled channel.
 *
 * **Validates: Requirements 12.3**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import {
  createAlertSystem,
  type AlertSeverity,
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

/** Number of in-app channels to configure (1 to 5) */
const channelCountArb = fc.integer({ min: 1, max: 5 });

/** Alert severity */
const severityArb: fc.Arbitrary<AlertSeverity> = fc.constantFrom(
  'critical',
  'high',
  'medium',
  'low'
);

/** Alert event type */
const eventTypeArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')),
  { minLength: 3, maxLength: 20 }
);

/** Affected resource name */
const resourceArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
  { minLength: 1, maxLength: 15 }
);

/** Alert message */
const messageArb = fc.string({ minLength: 1, maxLength: 50 });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Alert Fan-Out Property Tests (Property 10)', () => {
  it('Property 10: deliveryStatus contains exactly N entries for N enabled in-app channels, all delivered', async () => {
    await fc.assert(
      fc.asyncProperty(
        channelCountArb,
        eventTypeArb,
        resourceArb,
        severityArb,
        messageArb,
        async (numChannels, eventType, resource, severity, message) => {
          const db = createTestDb();
          const inAppNotifications: unknown[] = [];

          const alertSystem = createAlertSystem(db, {
            onInAppNotification: (alert) => inAppNotifications.push(alert),
            deduplicationWindowMs: 0, // Disable deduplication to isolate fan-out logic
          });

          // Configure N in-app channels (which always succeed)
          const channelIds: string[] = [];
          for (let i = 0; i < numChannels; i++) {
            const channelId = await alertSystem.configureChannel({
              type: 'in-app',
              config: { target: `panel-${i}` },
              enabled: true,
            });
            channelIds.push(channelId);
          }

          // Emit an alert event
          const alertId = await alertSystem.emitAlert({
            eventType,
            affectedResource: resource,
            severity,
            message,
          });

          // Retrieve the alert record from history
          const history = await alertSystem.getAlertHistory();
          const alertRecord = history.find((a) => a.id === alertId);

          expect(alertRecord).toBeDefined();

          // Verify: deliveryStatus has exactly N entries (one per enabled channel)
          const deliveryStatusKeys = Object.keys(alertRecord!.deliveryStatus);
          expect(deliveryStatusKeys.length).toBe(numChannels);

          // Verify: each configured channel ID appears in deliveryStatus
          for (const channelId of channelIds) {
            expect(alertRecord!.deliveryStatus).toHaveProperty(channelId);
          }

          // Verify: all entries have 'delivered' status (in-app always succeeds)
          for (const channelId of channelIds) {
            expect(alertRecord!.deliveryStatus[channelId]).toBe('delivered');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
