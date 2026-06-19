/**
 * Unit tests for the configurable threshold evaluation with consecutive breach tracking.
 *
 * Tests the `evaluateThreshold` method added to the Alert System for
 * reading thresholds from the Settings Service via AlertThresholdHandle,
 * tracking consecutive breaches, emitting warning/critical alerts, and
 * auto-resolving alerts when conditions return to normal.
 *
 * @validates Requirements 9.1, 9.2, 9.3, 9.4, 11.5
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import {
  createAlertSystem,
  type AlertSystem,
  type ThresholdMetricType,
} from '../../src/modules/alert-system.js';
import { createAlertThresholdHandle } from '../../src/services/settings-hot-reload.js';
import type { AlertThresholdHandle } from '../../src/services/settings-hot-reload.js';
import type Database from 'better-sqlite3';

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-threshold-eval-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Alert System - Configurable Threshold Evaluation', () => {
  let dbPath: string;
  let db: Database.Database;
  let alertSystem: AlertSystem;
  let thresholdHandle: AlertThresholdHandle;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });
    thresholdHandle = createAlertThresholdHandle({
      alert_cpu_warning: 80,
      alert_cpu_critical: 95,
      alert_memory_warning: 80,
      alert_memory_critical: 95,
      alert_disk_warning: 90,
      alert_disk_critical: 95,
      alert_consecutive_checks: 3,
    });
    alertSystem = createAlertSystem(db, { thresholdHandle });
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  describe('reads threshold values from Settings Service', () => {
    it('should use thresholds from AlertThresholdHandle', async () => {
      // Set custom thresholds
      thresholdHandle.updateThreshold('alert_cpu_warning', 70);
      thresholdHandle.updateThreshold('alert_cpu_critical', 90);
      thresholdHandle.updateThreshold('alert_consecutive_checks', 2);

      // 2 checks above warning (70) — should fire with custom consecutive=2
      await alertSystem.evaluateThreshold('cpu', 'system', 75);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 75);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });

    it('should use default thresholds when handle has no value', async () => {
      // Create system without any thresholds pre-loaded
      const emptyHandle = createAlertThresholdHandle();
      const system = createAlertSystem(db, { thresholdHandle: emptyHandle });

      // Default CPU warning is 80, consecutive is 3
      await system.evaluateThreshold('cpu', 'system', 85);
      await system.evaluateThreshold('cpu', 'system', 85);
      const result = await system.evaluateThreshold('cpu', 'system', 85);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });

    it('should react to threshold updates via hot-reload', async () => {
      // Initially warning at 80, need 3 consecutive
      await alertSystem.evaluateThreshold('cpu', 'system', 75);
      let result = await alertSystem.evaluateThreshold('cpu', 'system', 75);
      // 75 is below default 80 warning — no breach
      expect(result.consecutiveBreaches).toBe(0);

      // Lower the warning threshold to 70 via hot-reload
      thresholdHandle.updateThreshold('alert_cpu_warning', 70);

      // Now 75 exceeds 70
      await alertSystem.evaluateThreshold('cpu', 'system', 75);
      await alertSystem.evaluateThreshold('cpu', 'system', 75);
      result = await alertSystem.evaluateThreshold('cpu', 'system', 75);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });
  });

  describe('consecutive breach counter', () => {
    it('should not emit alert before reaching consecutive threshold', async () => {
      // Default consecutive is 3
      const r1 = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      const r2 = await alertSystem.evaluateThreshold('cpu', 'system', 85);

      expect(r1.alertEmitted).toBe(false);
      expect(r2.alertEmitted).toBe(false);
      expect(r1.consecutiveBreaches).toBe(1);
      expect(r2.consecutiveBreaches).toBe(2);
    });

    it('should emit warning alert after N consecutive breaches above warning threshold', async () => {
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      await alertSystem.evaluateThreshold('cpu', 'system', 87);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 90);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
      expect(result.alertId).toBeDefined();
    });

    it('should emit critical alert after N consecutive breaches above critical threshold', async () => {
      // CPU critical is 95
      await alertSystem.evaluateThreshold('cpu', 'system', 96);
      await alertSystem.evaluateThreshold('cpu', 'system', 97);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 98);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('critical');
      expect(result.alertId).toBeDefined();
    });

    it('should use configurable consecutive_checks value', async () => {
      thresholdHandle.updateThreshold('alert_consecutive_checks', 5);

      for (let i = 0; i < 4; i++) {
        const r = await alertSystem.evaluateThreshold('cpu', 'system', 85);
        expect(r.alertEmitted).toBe(false);
      }

      const result = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });

    it('should work with consecutive_checks = 1', async () => {
      thresholdHandle.updateThreshold('alert_consecutive_checks', 1);

      const result = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });
  });

  describe('warning-severity alerts', () => {
    it('should emit warning when value is between warning and critical thresholds', async () => {
      // CPU warning=80, critical=95 → 85 is above warning but below critical
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 85);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });

    it('should store warning alert in history', async () => {
      await alertSystem.evaluateThreshold('memory', 'system', 85);
      await alertSystem.evaluateThreshold('memory', 'system', 85);
      await alertSystem.evaluateThreshold('memory', 'system', 85);

      const history = await alertSystem.getAlertHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].eventType).toBe('memory_threshold_warning');
      expect(history[0].affectedResource).toBe('system');
    });
  });

  describe('critical-severity alerts', () => {
    it('should emit critical when value exceeds critical threshold', async () => {
      // CPU critical=95
      await alertSystem.evaluateThreshold('cpu', 'system', 96);
      await alertSystem.evaluateThreshold('cpu', 'system', 97);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 98);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('should store critical alert in history', async () => {
      await alertSystem.evaluateThreshold('disk', 'system', 96);
      await alertSystem.evaluateThreshold('disk', 'system', 97);
      await alertSystem.evaluateThreshold('disk', 'system', 98);

      const history = await alertSystem.getAlertHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].eventType).toBe('disk_threshold_critical');
    });

    it('should prioritize critical over warning for values above both', async () => {
      // Value=96 exceeds both warning (80) and critical (95)
      await alertSystem.evaluateThreshold('cpu', 'system', 96);
      await alertSystem.evaluateThreshold('cpu', 'system', 96);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 96);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('critical');
    });
  });

  describe('counter reset when value drops below threshold', () => {
    it('should reset counters when value drops below warning threshold', async () => {
      // 2 breaches
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      await alertSystem.evaluateThreshold('cpu', 'system', 85);

      // Drop below threshold
      const resetResult = await alertSystem.evaluateThreshold('cpu', 'system', 70);
      expect(resetResult.consecutiveBreaches).toBe(0);

      // Need 3 fresh breaches now
      const r1 = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      const r2 = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(r1.alertEmitted).toBe(false);
      expect(r2.alertEmitted).toBe(false);
      expect(r1.consecutiveBreaches).toBe(1);
      expect(r2.consecutiveBreaches).toBe(2);
    });

    it('should reset critical counter when value drops to warning zone', async () => {
      // 2 critical breaches
      await alertSystem.evaluateThreshold('cpu', 'system', 96);
      await alertSystem.evaluateThreshold('cpu', 'system', 97);

      // Drop to warning zone (above 80 but below 95)
      // The value is still above the warning threshold, so warning counter keeps accumulating
      // Critical counter resets to 0 since we're no longer in critical zone
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 85);

      // Warning count was 2 (from critical breaches) + 1 = 3, which triggers warning alert
      // because value never went below warning threshold
      expect(result.consecutiveBreaches).toBe(3);
      // With default consecutive_checks=3, this actually fires a warning alert
      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });

    it('should track getBreachCount correctly', async () => {
      expect(alertSystem.getBreachCount('cpu', 'system')).toBe(0);

      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(alertSystem.getBreachCount('cpu', 'system')).toBe(1);

      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(alertSystem.getBreachCount('cpu', 'system')).toBe(2);

      // Drop below
      await alertSystem.evaluateThreshold('cpu', 'system', 70);
      expect(alertSystem.getBreachCount('cpu', 'system')).toBe(0);
    });
  });

  describe('auto-resolve alert when condition returns to normal', () => {
    it('should auto-resolve when value drops below warning threshold', async () => {
      // Trigger a warning alert
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      const triggerResult = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(triggerResult.alertEmitted).toBe(true);

      // Verify active alert exists
      expect(alertSystem.getActiveThresholdAlerts()).toHaveLength(1);

      // Value returns to normal
      const resolveResult = await alertSystem.evaluateThreshold('cpu', 'system', 70);
      expect(resolveResult.resolved).toBe(true);

      // Active alerts should be empty
      expect(alertSystem.getActiveThresholdAlerts()).toHaveLength(0);
    });

    it('should mark alert as resolved in database', async () => {
      // Trigger a warning alert
      await alertSystem.evaluateThreshold('memory', 'system', 85);
      await alertSystem.evaluateThreshold('memory', 'system', 85);
      const triggerResult = await alertSystem.evaluateThreshold('memory', 'system', 85);
      const alertId = triggerResult.alertId!;

      // Return to normal
      await alertSystem.evaluateThreshold('memory', 'system', 70);

      // Verify database record updated
      const row = db.prepare('SELECT resolution_status, resolved_at FROM alerts WHERE id = ?').get(alertId) as any;
      expect(row.resolution_status).toBe('resolved');
      expect(row.resolved_at).toBeTruthy();
    });

    it('should not report resolved if no active alert exists', async () => {
      // Never triggered any alert
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 70);
      expect(result.resolved).toBe(false);
    });

    it('should auto-resolve critical alert when value drops below warning', async () => {
      // Trigger a critical alert
      await alertSystem.evaluateThreshold('cpu', 'system', 96);
      await alertSystem.evaluateThreshold('cpu', 'system', 97);
      await alertSystem.evaluateThreshold('cpu', 'system', 98);

      expect(alertSystem.getActiveThresholdAlerts()).toHaveLength(1);
      expect(alertSystem.getActiveThresholdAlerts()[0].severity).toBe('critical');

      // Drop fully below warning
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 70);
      expect(result.resolved).toBe(true);
      expect(alertSystem.getActiveThresholdAlerts()).toHaveLength(0);
    });
  });

  describe('metric type support', () => {
    it('should evaluate CPU thresholds correctly', async () => {
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(result.alertEmitted).toBe(true);
    });

    it('should evaluate memory thresholds correctly', async () => {
      await alertSystem.evaluateThreshold('memory', 'system', 85);
      await alertSystem.evaluateThreshold('memory', 'system', 85);
      const result = await alertSystem.evaluateThreshold('memory', 'system', 85);
      expect(result.alertEmitted).toBe(true);
    });

    it('should evaluate disk thresholds correctly', async () => {
      // Disk warning=90, critical=95
      await alertSystem.evaluateThreshold('disk', 'system', 92);
      await alertSystem.evaluateThreshold('disk', 'system', 92);
      const result = await alertSystem.evaluateThreshold('disk', 'system', 92);
      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });

    it('should track each metric type independently', async () => {
      // CPU breaches
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      await alertSystem.evaluateThreshold('cpu', 'system', 85);

      // Memory breaches (should not carry over CPU count)
      const memResult = await alertSystem.evaluateThreshold('memory', 'system', 85);
      expect(memResult.consecutiveBreaches).toBe(1);

      // CPU should still have count 2
      expect(alertSystem.getBreachCount('cpu', 'system')).toBe(2);
    });

    it('should track each resource independently', async () => {
      await alertSystem.evaluateThreshold('cpu', 'server-a', 85);
      await alertSystem.evaluateThreshold('cpu', 'server-a', 85);

      // server-b starts fresh
      const result = await alertSystem.evaluateThreshold('cpu', 'server-b', 85);
      expect(result.consecutiveBreaches).toBe(1);

      expect(alertSystem.getBreachCount('cpu', 'server-a')).toBe(2);
      expect(alertSystem.getBreachCount('cpu', 'server-b')).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should not trigger for values exactly at warning threshold', async () => {
      // Exactly at threshold (80) should NOT trigger (must EXCEED)
      await alertSystem.evaluateThreshold('cpu', 'system', 80);
      await alertSystem.evaluateThreshold('cpu', 'system', 80);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 80);
      expect(result.alertEmitted).toBe(false);
      expect(result.consecutiveBreaches).toBe(0); // At threshold = below
    });

    it('should not trigger for values exactly at critical threshold', async () => {
      // Exactly at critical (95) should NOT trigger
      await alertSystem.evaluateThreshold('cpu', 'system', 95);
      await alertSystem.evaluateThreshold('cpu', 'system', 95);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 95);
      // 95 > 80 warning, so it's in warning zone
      expect(result.severity).toBe('warning');
    });

    it('should handle value=0 without issues', async () => {
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 0);
      expect(result.alertEmitted).toBe(false);
      expect(result.consecutiveBreaches).toBe(0);
    });

    it('should handle value=100 as critical breach', async () => {
      await alertSystem.evaluateThreshold('cpu', 'system', 100);
      await alertSystem.evaluateThreshold('cpu', 'system', 100);
      const result = await alertSystem.evaluateThreshold('cpu', 'system', 100);
      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('should reset counter after alert is fired to prevent flooding', async () => {
      // Fire first alert
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      await alertSystem.evaluateThreshold('cpu', 'system', 85);
      const first = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(first.alertEmitted).toBe(true);

      // Next check should start counting again from 0
      const next = await alertSystem.evaluateThreshold('cpu', 'system', 85);
      expect(next.alertEmitted).toBe(false);
      expect(next.consecutiveBreaches).toBe(1);
    });

    it('should work without a thresholdHandle (uses defaults)', async () => {
      const system = createAlertSystem(db);

      // Default CPU warning is 80, consecutive is 3
      await system.evaluateThreshold('cpu', 'system', 85);
      await system.evaluateThreshold('cpu', 'system', 85);
      const result = await system.evaluateThreshold('cpu', 'system', 85);

      expect(result.alertEmitted).toBe(true);
      expect(result.severity).toBe('warning');
    });
  });
});
