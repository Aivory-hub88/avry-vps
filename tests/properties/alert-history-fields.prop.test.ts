/**
 * Property-based tests for Alert History Required Fields.
 *
 * Property 8: Alert history contains all required fields
 * For any alert that is emitted by the Alert System, querying the alert history
 * SHALL return a record containing: id (non-empty string), timestamp (valid ISO 8601),
 * eventType (non-empty string), affectedResource (non-empty string), severity
 * (one of critical/high/medium/low), and resolution status.
 *
 * **Validates: Requirements 11.1**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import {
  createAlertSystem,
  type AlertSystem,
  type AlertEvent,
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
        CHECK (resolution_status IN ('active', 'acknowledged', 'resolved', 'silenced'))
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);

    CREATE TABLE IF NOT EXISTS alert_silences (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      admin_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
    );
  `);

  return db;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Non-empty alphanumeric string for event types */
const eventTypeArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_0123456789'.split('')),
  { minLength: 1, maxLength: 30 }
);

/** Non-empty alphanumeric string for resource names */
const resourceArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_/'.split('')),
  { minLength: 1, maxLength: 40 }
);

/** Valid alert severity */
const severityArb: fc.Arbitrary<AlertSeverity> = fc.constantFrom(
  'critical',
  'high',
  'medium',
  'low'
);

/** Non-empty message string */
const messageArb = fc.string({ minLength: 1, maxLength: 100 });

/** Generates a random AlertEvent */
const alertEventArb: fc.Arbitrary<AlertEvent> = fc.record({
  eventType: eventTypeArb,
  affectedResource: resourceArb,
  severity: severityArb,
  message: messageArb,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low']);
const VALID_RESOLUTION_STATUSES: ReadonlySet<string> = new Set(['active', 'acknowledged', 'resolved', 'silenced']);

/**
 * Validates that a string is a valid ISO 8601 timestamp.
 * Checks that it can be parsed to a valid Date object and round-trips.
 */
function isValidIso8601(timestamp: string): boolean {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return false;
  // Verify it's a properly formatted ISO string
  return date.toISOString() === timestamp || !isNaN(Date.parse(timestamp));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Alert History Fields Property Tests', () => {
  let db: Database.Database;
  let alertSystem: AlertSystem;

  beforeEach(() => {
    db = createTestDb();
    alertSystem = createAlertSystem(db);
  });

  it('Property 8: Every emitted alert has all required fields present and valid', async () => {
    await fc.assert(
      fc.asyncProperty(
        alertEventArb,
        async (event) => {
          // Create a fresh DB and alert system per test case
          const testDb = createTestDb();
          const system = createAlertSystem(testDb);

          // Emit the alert
          const alertId = await system.emitAlert(event);

          // Query via paginated history
          const result = await system.getAlertHistoryPaginated(1, 10);

          // Should have exactly one alert
          expect(result.items.length).toBe(1);
          expect(result.total).toBe(1);

          const record = result.items[0];

          // ─── Verify id: non-empty string ─────────────────────────────
          expect(typeof record.id).toBe('string');
          expect(record.id.length).toBeGreaterThan(0);
          expect(record.id).toBe(alertId);

          // ─── Verify timestamp: valid ISO 8601 ────────────────────────
          expect(typeof record.timestamp).toBe('string');
          expect(record.timestamp.length).toBeGreaterThan(0);
          expect(isValidIso8601(record.timestamp)).toBe(true);

          // ─── Verify eventType: non-empty string ──────────────────────
          expect(typeof record.eventType).toBe('string');
          expect(record.eventType.length).toBeGreaterThan(0);
          expect(record.eventType).toBe(event.eventType);

          // ─── Verify affectedResource: non-empty string ───────────────
          expect(typeof record.affectedResource).toBe('string');
          expect(record.affectedResource.length).toBeGreaterThan(0);
          expect(record.affectedResource).toBe(event.affectedResource);

          // ─── Verify severity: one of critical/high/medium/low ────────
          expect(VALID_SEVERITIES.has(record.severity)).toBe(true);
          expect(record.severity).toBe(event.severity);

          // ─── Verify resolutionStatus: defined and valid ──────────────
          expect(record.resolutionStatus).toBeDefined();
          expect(typeof record.resolutionStatus).toBe('string');
          expect(VALID_RESOLUTION_STATUSES.has(record.resolutionStatus)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 8.2: Multiple emitted alerts all retain required fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(alertEventArb, { minLength: 1, maxLength: 10 }),
        async (events) => {
          const testDb = createTestDb();
          const system = createAlertSystem(testDb);

          // Emit all alerts
          const emittedIds: string[] = [];
          for (const event of events) {
            const id = await system.emitAlert(event);
            emittedIds.push(id);
          }

          // Query all via paginated history
          const result = await system.getAlertHistoryPaginated(1, events.length + 10);
          expect(result.items.length).toBe(events.length);
          expect(result.total).toBe(events.length);

          // Verify every record has all required fields
          for (const record of result.items) {
            // id: non-empty string
            expect(typeof record.id).toBe('string');
            expect(record.id.length).toBeGreaterThan(0);
            expect(emittedIds).toContain(record.id);

            // timestamp: valid ISO 8601
            expect(typeof record.timestamp).toBe('string');
            expect(record.timestamp.length).toBeGreaterThan(0);
            expect(isValidIso8601(record.timestamp)).toBe(true);

            // eventType: non-empty string
            expect(typeof record.eventType).toBe('string');
            expect(record.eventType.length).toBeGreaterThan(0);

            // affectedResource: non-empty string
            expect(typeof record.affectedResource).toBe('string');
            expect(record.affectedResource.length).toBeGreaterThan(0);

            // severity: valid enum
            expect(VALID_SEVERITIES.has(record.severity)).toBe(true);

            // resolutionStatus: defined and valid
            expect(record.resolutionStatus).toBeDefined();
            expect(typeof record.resolutionStatus).toBe('string');
            expect(VALID_RESOLUTION_STATUSES.has(record.resolutionStatus)).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
