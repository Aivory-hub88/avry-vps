/**
 * Unit tests for the Alert System module.
 * Tests channel configuration, rule configuration, alert emission,
 * consecutive threshold logic, history management, and delivery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import {
  createAlertSystem,
  type AlertSystem,
  type AlertChannel,
  type AlertRule,
  type AlertEvent,
  type HealthStatus,
} from '../../src/modules/alert-system.js';
import type Database from 'better-sqlite3';

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-alert-system-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Alert System Module', () => {
  let dbPath: string;
  let db: Database.Database;
  let alertSystem: AlertSystem;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });
    alertSystem = createAlertSystem(db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  describe('configureChannel', () => {
    it('should create a new email channel', async () => {
      const channel: AlertChannel = {
        type: 'email',
        config: { host: 'smtp.example.com', port: '587', user: 'test@example.com', pass: 'secret', to: 'admin@example.com' },
      };

      const id = await alertSystem.configureChannel(channel);
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe('email');
      expect(channels[0].config.host).toBe('smtp.example.com');
    });

    it('should create a new webhook channel', async () => {
      const channel: AlertChannel = {
        type: 'webhook',
        config: { url: 'https://hooks.slack.com/services/xxx', format: 'slack' },
      };

      const id = await alertSystem.configureChannel(channel);
      expect(id).toBeDefined();

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe('webhook');
      expect(channels[0].config.url).toBe('https://hooks.slack.com/services/xxx');
    });

    it('should create an in-app notification channel', async () => {
      const channel: AlertChannel = {
        type: 'in-app',
        config: {},
      };

      const id = await alertSystem.configureChannel(channel);
      expect(id).toBeDefined();

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe('in-app');
    });

    it('should update an existing channel by ID', async () => {
      const channel: AlertChannel = {
        type: 'webhook',
        config: { url: 'https://old-url.com/hook' },
      };

      const id = await alertSystem.configureChannel(channel);

      // Update with same ID
      await alertSystem.configureChannel({
        id,
        type: 'webhook',
        config: { url: 'https://new-url.com/hook' },
      });

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].config.url).toBe('https://new-url.com/hook');
    });

    it('should support multiple channels simultaneously', async () => {
      await alertSystem.configureChannel({ type: 'email', config: { to: 'a@b.com' } });
      await alertSystem.configureChannel({ type: 'webhook', config: { url: 'https://hook.com' } });
      await alertSystem.configureChannel({ type: 'in-app', config: {} });

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(3);
    });

    it('should support disabling a channel', async () => {
      const id = await alertSystem.configureChannel({
        type: 'email',
        config: { to: 'a@b.com' },
        enabled: false,
      });

      const channels = alertSystem.getChannels();
      const channel = channels.find((c) => c.id === id);
      expect(channel?.enabled).toBe(false);
    });
  });

  describe('configureRule', () => {
    it('should create a CPU threshold rule', async () => {
      const rule: AlertRule = {
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      };

      const id = await alertSystem.configureRule(rule);
      expect(id).toBeDefined();

      const rules = alertSystem.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].resourceType).toBe('cpu');
      expect(rules[0].threshold).toBe(80);
      expect(rules[0].consecutiveChecks).toBe(3);
    });

    it('should create a memory threshold rule', async () => {
      const id = await alertSystem.configureRule({
        resourceType: 'memory',
        threshold: 90,
      });

      const rules = alertSystem.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].resourceType).toBe('memory');
      expect(rules[0].threshold).toBe(90);
    });

    it('should default to 3 consecutive checks', async () => {
      await alertSystem.configureRule({
        resourceType: 'disk',
        threshold: 85,
      });

      const rules = alertSystem.getRules();
      expect(rules[0].consecutiveChecks).toBe(3);
    });

    it('should update an existing rule by ID', async () => {
      const id = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });

      await alertSystem.configureRule({
        id,
        resourceType: 'cpu',
        threshold: 90,
        consecutiveChecks: 5,
      });

      const rules = alertSystem.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].threshold).toBe(90);
      expect(rules[0].consecutiveChecks).toBe(5);
    });
  });

  describe('emitAlert', () => {
    it('should emit an alert and store it in history', async () => {
      const event: AlertEvent = {
        eventType: 'container_unhealthy',
        affectedResource: 'nginx-proxy',
        severity: 'high',
        message: 'Container nginx-proxy has become unhealthy',
      };

      const id = await alertSystem.emitAlert(event);
      expect(id).toBeDefined();

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].eventType).toBe('container_unhealthy');
      expect(history[0].affectedResource).toBe('nginx-proxy');
      expect(history[0].severity).toBe('high');
      expect(history[0].message).toBe('Container nginx-proxy has become unhealthy');
      expect(history[0].timestamp).toBeDefined();
    });

    it('should store delivery status for each channel', async () => {
      // Configure an in-app channel (will always succeed)
      await alertSystem.configureChannel({ type: 'in-app', config: {} });

      const id = await alertSystem.emitAlert({
        eventType: 'test_event',
        affectedResource: 'test',
        severity: 'low',
        message: 'Test',
      });

      const history = await alertSystem.getAlertHistory();
      expect(history[0].deliveryStatus).toBeDefined();
      expect(typeof history[0].deliveryStatus).toBe('object');
    });

    it('should trigger in-app notification callback', async () => {
      const callback = vi.fn();
      const system = createAlertSystem(db, { onInAppNotification: callback });

      await system.configureChannel({ type: 'in-app', config: {} });
      await system.emitAlert({
        eventType: 'test',
        affectedResource: 'resource',
        severity: 'medium',
        message: 'Test message',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'test',
          affectedResource: 'resource',
          severity: 'medium',
        })
      );
    });

    it('should handle alerts with no configured channels', async () => {
      const id = await alertSystem.emitAlert({
        eventType: 'test',
        affectedResource: 'resource',
        severity: 'low',
        message: 'No channels configured',
      });

      expect(id).toBeDefined();
      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].deliveryStatus).toEqual({});
    });
  });

  describe('getAlertHistory', () => {
    it('should return empty array when no alerts exist', async () => {
      const history = await alertSystem.getAlertHistory();
      expect(history).toEqual([]);
    });

    it('should return alerts ordered by most recent first', async () => {
      await alertSystem.emitAlert({
        eventType: 'first',
        affectedResource: 'r1',
        severity: 'low',
        message: 'first',
      });

      // Small delay to ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 10));

      await alertSystem.emitAlert({
        eventType: 'second',
        affectedResource: 'r2',
        severity: 'medium',
        message: 'second',
      });

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(2);
      expect(history[0].eventType).toBe('second');
      expect(history[1].eventType).toBe('first');
    });

    it('should limit history to 500 entries', async () => {
      const system = createAlertSystem(db, { maxHistorySize: 5 });

      for (let i = 0; i < 10; i++) {
        await system.emitAlert({
          eventType: `event_${i}`,
          affectedResource: 'test',
          severity: 'low',
          message: `Message ${i}`,
        });
      }

      const history = await system.getAlertHistory();
      expect(history.length).toBeLessThanOrEqual(5);
    });
  });

  describe('recordMetric - consecutive threshold logic', () => {
    it('should not fire alert for fewer than 3 consecutive breaches', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      // Only 2 breaches - should not fire
      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should fire alert after 3 consecutive threshold breaches', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);
      await alertSystem.recordMetric('cpu', 'server', 88);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].eventType).toBe('cpu_threshold_exceeded');
      expect(history[0].affectedResource).toBe('server');
    });

    it('should reset counter when value drops below threshold', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);
      // Value drops below threshold - should reset counter
      await alertSystem.recordMetric('cpu', 'server', 70);
      // Start counting again from 0
      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should track resources independently', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      // Server A breaches 3 times
      await alertSystem.recordMetric('cpu', 'serverA', 85);
      await alertSystem.recordMetric('cpu', 'serverA', 90);
      await alertSystem.recordMetric('cpu', 'serverA', 88);

      // Server B only breaches once
      await alertSystem.recordMetric('cpu', 'serverB', 85);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].affectedResource).toBe('serverA');
    });

    it('should not fire alert when metric is at threshold (not above)', async () => {
      await alertSystem.configureRule({
        resourceType: 'memory',
        threshold: 90,
        consecutiveChecks: 3,
      });

      // Exactly at threshold - should NOT trigger (must exceed)
      await alertSystem.recordMetric('memory', 'server', 90);
      await alertSystem.recordMetric('memory', 'server', 90);
      await alertSystem.recordMetric('memory', 'server', 90);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should fire alert when metric exceeds threshold', async () => {
      await alertSystem.configureRule({
        resourceType: 'memory',
        threshold: 90,
        consecutiveChecks: 3,
      });

      await alertSystem.recordMetric('memory', 'server', 91);
      await alertSystem.recordMetric('memory', 'server', 92);
      await alertSystem.recordMetric('memory', 'server', 93);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
    });

    it('should support custom consecutive check count', async () => {
      await alertSystem.configureRule({
        resourceType: 'disk',
        threshold: 85,
        consecutiveChecks: 5,
      });

      // 4 breaches - not enough for 5 consecutive
      for (let i = 0; i < 4; i++) {
        await alertSystem.recordMetric('disk', 'volume', 90);
      }
      expect(await alertSystem.getAlertHistory()).toHaveLength(0);

      // 5th breach triggers
      await alertSystem.recordMetric('disk', 'volume', 90);
      expect(await alertSystem.getAlertHistory()).toHaveLength(1);
    });
  });

  describe('removeChannel', () => {
    it('should remove a channel by ID', async () => {
      const id = await alertSystem.configureChannel({
        type: 'webhook',
        config: { url: 'https://hooks.example.com' },
      });

      alertSystem.removeChannel(id);

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(0);
    });
  });

  describe('removeRule', () => {
    it('should remove a rule by ID', async () => {
      const id = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });

      alertSystem.removeRule(id);

      const rules = alertSystem.getRules();
      expect(rules).toHaveLength(0);
    });

    it('should clean up threshold trackers when rule is removed', async () => {
      const id = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      // Record 2 breaches (below threshold to fire)
      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);

      // Remove the rule
      alertSystem.removeRule(id);

      // Re-add the same rule type
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      // Should need 3 fresh breaches now
      await alertSystem.recordMetric('cpu', 'server', 85);
      expect(await alertSystem.getAlertHistory()).toHaveLength(0);
    });
  });

  describe('alert severity determination', () => {
    it('should assign critical severity for values >= 95%', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 1,
      });

      await alertSystem.recordMetric('cpu', 'server', 96);

      const history = await alertSystem.getAlertHistory();
      expect(history[0].severity).toBe('critical');
    });

    it('should assign high severity for values >= 90%', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 1,
      });

      await alertSystem.recordMetric('cpu', 'server', 91);

      const history = await alertSystem.getAlertHistory();
      expect(history[0].severity).toBe('high');
    });
  });

  describe('recordHealthTransition', () => {
    it('should emit high-severity alert on healthy→unhealthy transition', async () => {
      await alertSystem.recordHealthTransition(
        'container123',
        'nginx-proxy',
        'healthy',
        'unhealthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].eventType).toBe('container_health_unhealthy');
      expect(history[0].severity).toBe('high');
      expect(history[0].affectedResource).toBe('container123');
      expect(history[0].message).toContain('nginx-proxy');
      expect(history[0].message).toContain('healthy to unhealthy');
    });

    it('should emit low-severity resolution alert on unhealthy→healthy transition', async () => {
      await alertSystem.recordHealthTransition(
        'container456',
        'api-server',
        'unhealthy',
        'healthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].eventType).toBe('container_health_recovered');
      expect(history[0].severity).toBe('low');
      expect(history[0].affectedResource).toBe('container456');
      expect(history[0].message).toContain('api-server');
      expect(history[0].message).toContain('unhealthy to healthy');
    });

    it('should ignore transitions from starting to healthy', async () => {
      await alertSystem.recordHealthTransition(
        'container789',
        'redis',
        'starting',
        'healthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should ignore transitions from starting to unhealthy', async () => {
      await alertSystem.recordHealthTransition(
        'container789',
        'redis',
        'starting',
        'unhealthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should ignore transitions from none to healthy', async () => {
      await alertSystem.recordHealthTransition(
        'container789',
        'redis',
        'none',
        'healthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should ignore transitions from none to unhealthy', async () => {
      await alertSystem.recordHealthTransition(
        'container789',
        'redis',
        'none',
        'unhealthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should ignore transitions from healthy to starting', async () => {
      await alertSystem.recordHealthTransition(
        'container789',
        'redis',
        'healthy',
        'starting'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should ignore transitions from unhealthy to none', async () => {
      await alertSystem.recordHealthTransition(
        'container789',
        'redis',
        'unhealthy',
        'none'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should ignore no-op transitions (same status)', async () => {
      await alertSystem.recordHealthTransition(
        'container789',
        'redis',
        'healthy',
        'healthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should store health transition events in alert history with timestamps', async () => {
      await alertSystem.recordHealthTransition(
        'container123',
        'web-app',
        'healthy',
        'unhealthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBeDefined();
      expect(history[0].timestamp).toBeDefined();
      // Verify timestamp is a valid ISO string
      expect(new Date(history[0].timestamp).toISOString()).toBe(history[0].timestamp);
    });

    it('should store both unhealthy and recovery alerts in history', async () => {
      await alertSystem.recordHealthTransition(
        'container123',
        'web-app',
        'healthy',
        'unhealthy'
      );

      // Small delay to ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 10));

      await alertSystem.recordHealthTransition(
        'container123',
        'web-app',
        'unhealthy',
        'healthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(2);
      const eventTypes = history.map((h) => h.eventType);
      expect(eventTypes).toContain('container_health_unhealthy');
      expect(eventTypes).toContain('container_health_recovered');
    });

    it('should include container name in alert message for unhealthy transition', async () => {
      await alertSystem.recordHealthTransition(
        'abc123',
        'my-important-service',
        'healthy',
        'unhealthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history[0].message).toContain('my-important-service');
    });

    it('should include container name in alert message for recovery transition', async () => {
      await alertSystem.recordHealthTransition(
        'abc123',
        'my-important-service',
        'unhealthy',
        'healthy'
      );

      const history = await alertSystem.getAlertHistory();
      expect(history[0].message).toContain('my-important-service');
    });
  });

  describe('acknowledgeAlert', () => {
    it('should mark an alert as acknowledged with admin ID and timestamp', async () => {
      const alertId = await alertSystem.emitAlert({
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'high',
        message: 'CPU too high',
      });

      await alertSystem.acknowledgeAlert(alertId, 'admin-user-1');

      const history = await alertSystem.getAlertHistory();
      const alert = history.find((a) => a.id === alertId);
      expect(alert).toBeDefined();
      expect(alert!.acknowledgedBy).toBe('admin-user-1');
      expect(alert!.acknowledgedAt).toBeDefined();
      expect(alert!.resolutionStatus).toBe('acknowledged');
    });

    it('should throw an error for non-existent alert ID', async () => {
      await expect(
        alertSystem.acknowledgeAlert('non-existent-id', 'admin1')
      ).rejects.toThrow('Alert not found');
    });

    it('should set a valid ISO timestamp when acknowledging', async () => {
      const alertId = await alertSystem.emitAlert({
        eventType: 'test',
        affectedResource: 'r1',
        severity: 'low',
        message: 'test',
      });

      await alertSystem.acknowledgeAlert(alertId, 'admin1');

      const history = await alertSystem.getAlertHistory();
      const alert = history.find((a) => a.id === alertId)!;
      expect(new Date(alert.acknowledgedAt!).toISOString()).toBe(alert.acknowledgedAt);
    });
  });

  describe('silenceRule', () => {
    it('should create a silence record with UUID', async () => {
      const ruleId = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });

      const silenceId = await alertSystem.silenceRule(ruleId, 3600000, 'admin1');
      expect(silenceId).toBeDefined();
      expect(typeof silenceId).toBe('string');
      expect(silenceId.length).toBeGreaterThan(0);
    });

    it('should appear in active silences', async () => {
      const ruleId = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });

      const silenceId = await alertSystem.silenceRule(ruleId, 3600000, 'admin1');
      const silences = await alertSystem.getActiveSilences();

      expect(silences).toHaveLength(1);
      expect(silences[0].id).toBe(silenceId);
      expect(silences[0].ruleId).toBe(ruleId);
      expect(silences[0].adminId).toBe('admin1');
    });

    it('should suppress notifications when rule is silenced', async () => {
      const ruleId = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 1,
      });

      // Configure a channel to verify suppression
      const callback = vi.fn();
      const system = createAlertSystem(db, { onInAppNotification: callback });

      // Re-create rule in the new system instance
      const newRuleId = await system.configureRule({
        id: ruleId,
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 1,
      });
      await system.configureChannel({ type: 'in-app', config: {} });

      // Silence the rule
      await system.silenceRule(newRuleId, 3600000, 'admin1');

      // Trigger an alert via recordMetric
      await system.recordMetric('cpu', 'server', 95);

      // Alert should be stored but notifications suppressed
      const history = await system.getAlertHistory();
      expect(history.length).toBeGreaterThan(0);
      // Notification callback should NOT have been called
      expect(callback).not.toHaveBeenCalled();
    });

    it('should set correct expiration time', async () => {
      const ruleId = await alertSystem.configureRule({
        resourceType: 'memory',
        threshold: 90,
      });

      const before = Date.now();
      const durationMs = 7200000; // 2 hours
      await alertSystem.silenceRule(ruleId, durationMs, 'admin1');
      const after = Date.now();

      const silences = await alertSystem.getActiveSilences();
      const expiresAt = new Date(silences[0].expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + durationMs);
      expect(expiresAt).toBeLessThanOrEqual(after + durationMs);
    });
  });

  describe('removeSilence', () => {
    it('should remove an existing silence', async () => {
      const ruleId = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });

      const silenceId = await alertSystem.silenceRule(ruleId, 3600000, 'admin1');
      await alertSystem.removeSilence(silenceId);

      const silences = await alertSystem.getActiveSilences();
      expect(silences).toHaveLength(0);
    });

    it('should throw an error for non-existent silence ID', async () => {
      await expect(
        alertSystem.removeSilence('non-existent-id')
      ).rejects.toThrow('Silence not found');
    });
  });

  describe('getActiveSilences', () => {
    it('should return empty array when no silences exist', async () => {
      const silences = await alertSystem.getActiveSilences();
      expect(silences).toEqual([]);
    });

    it('should not return expired silences', async () => {
      const ruleId = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });

      // Create a silence that expires in 1 ms
      await alertSystem.silenceRule(ruleId, 1, 'admin1');

      // Wait for it to expire
      await new Promise((r) => setTimeout(r, 10));

      const silences = await alertSystem.getActiveSilences();
      expect(silences).toHaveLength(0);
    });

    it('should return multiple active silences', async () => {
      const ruleId1 = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });
      const ruleId2 = await alertSystem.configureRule({
        resourceType: 'memory',
        threshold: 90,
      });

      await alertSystem.silenceRule(ruleId1, 3600000, 'admin1');
      await alertSystem.silenceRule(ruleId2, 3600000, 'admin2');

      const silences = await alertSystem.getActiveSilences();
      expect(silences).toHaveLength(2);
    });
  });

  describe('resolveAlert', () => {
    it('should mark an alert as resolved with timestamp', async () => {
      const alertId = await alertSystem.emitAlert({
        eventType: 'disk_threshold_exceeded',
        affectedResource: 'volume1',
        severity: 'medium',
        message: 'Disk usage high',
      });

      await alertSystem.resolveAlert(alertId);

      const history = await alertSystem.getAlertHistory();
      const alert = history.find((a) => a.id === alertId);
      expect(alert!.resolutionStatus).toBe('resolved');
      expect(alert!.resolvedAt).toBeDefined();
      expect(new Date(alert!.resolvedAt!).toISOString()).toBe(alert!.resolvedAt);
    });

    it('should throw an error for non-existent alert ID', async () => {
      await expect(
        alertSystem.resolveAlert('non-existent-id')
      ).rejects.toThrow('Alert not found');
    });
  });

  describe('getAlertHistoryPaginated', () => {
    it('should return empty items when no alerts exist', async () => {
      const result = await alertSystem.getAlertHistoryPaginated(1, 10);
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
    });

    it('should return paginated results', async () => {
      // Create 15 alerts
      for (let i = 0; i < 15; i++) {
        await alertSystem.emitAlert({
          eventType: `event_${i}`,
          affectedResource: 'resource',
          severity: 'low',
          message: `Message ${i}`,
        });
      }

      const page1 = await alertSystem.getAlertHistoryPaginated(1, 10);
      expect(page1.items).toHaveLength(10);
      expect(page1.total).toBe(15);
      expect(page1.page).toBe(1);
      expect(page1.pageSize).toBe(10);

      const page2 = await alertSystem.getAlertHistoryPaginated(2, 10);
      expect(page2.items).toHaveLength(5);
      expect(page2.total).toBe(15);
      expect(page2.page).toBe(2);
    });

    it('should return records ordered by most recent first', async () => {
      await alertSystem.emitAlert({
        eventType: 'first',
        affectedResource: 'r1',
        severity: 'low',
        message: 'first',
      });

      await new Promise((r) => setTimeout(r, 10));

      await alertSystem.emitAlert({
        eventType: 'second',
        affectedResource: 'r2',
        severity: 'medium',
        message: 'second',
      });

      const result = await alertSystem.getAlertHistoryPaginated(1, 10);
      expect(result.items[0].eventType).toBe('second');
      expect(result.items[1].eventType).toBe('first');
    });

    it('should include all required alert fields', async () => {
      await alertSystem.emitAlert({
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'critical',
        message: 'CPU is critical',
      });

      const result = await alertSystem.getAlertHistoryPaginated(1, 10);
      const alert = result.items[0];

      // All required fields present
      expect(alert.id).toBeDefined();
      expect(typeof alert.id).toBe('string');
      expect(alert.timestamp).toBeDefined();
      expect(alert.severity).toBe('critical');
      expect(alert.eventType).toBe('cpu_threshold_exceeded');
      expect(alert.affectedResource).toBe('server1');
      expect(alert.resolutionStatus).toBe('active');
    });

    it('should reflect acknowledgment status', async () => {
      const alertId = await alertSystem.emitAlert({
        eventType: 'test',
        affectedResource: 'r1',
        severity: 'low',
        message: 'test',
      });

      await alertSystem.acknowledgeAlert(alertId, 'admin1');

      const result = await alertSystem.getAlertHistoryPaginated(1, 10);
      const alert = result.items.find((a) => a.id === alertId);
      expect(alert!.resolutionStatus).toBe('acknowledged');
      expect(alert!.acknowledgedBy).toBe('admin1');
    });

    it('should reflect resolved status', async () => {
      const alertId = await alertSystem.emitAlert({
        eventType: 'test',
        affectedResource: 'r1',
        severity: 'low',
        message: 'test',
      });

      await alertSystem.resolveAlert(alertId);

      const result = await alertSystem.getAlertHistoryPaginated(1, 10);
      const alert = result.items.find((a) => a.id === alertId);
      expect(alert!.resolutionStatus).toBe('resolved');
      expect(alert!.resolvedAt).toBeDefined();
    });
  });

  describe('alert deduplication', () => {
    it('should suppress notification delivery for identical alerts within deduplication window', async () => {
      const callback = vi.fn();
      const system = createAlertSystem(db, {
        onInAppNotification: callback,
        deduplicationWindowMs: 60_000,
      });
      await system.configureChannel({ type: 'in-app', config: {} });

      const event: AlertEvent = {
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'high',
        message: 'CPU too high',
      };

      // First alert should deliver
      await system.emitAlert(event);
      expect(callback).toHaveBeenCalledTimes(1);

      // Second identical alert within window should NOT deliver
      await system.emitAlert(event);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should still store the alert in history even when deduplicated', async () => {
      const system = createAlertSystem(db, { deduplicationWindowMs: 60_000 });

      const event: AlertEvent = {
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'high',
        message: 'CPU too high',
      };

      await system.emitAlert(event);
      await system.emitAlert(event);

      const history = await system.getAlertHistory();
      // Both alerts should be stored
      expect(history).toHaveLength(2);
    });

    it('should allow delivery after the deduplication window expires', async () => {
      const callback = vi.fn();
      // Use a very short deduplication window for testing
      const system = createAlertSystem(db, {
        onInAppNotification: callback,
        deduplicationWindowMs: 50,
      });
      await system.configureChannel({ type: 'in-app', config: {} });

      const event: AlertEvent = {
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'high',
        message: 'CPU too high',
      };

      // First alert delivers
      await system.emitAlert(event);
      expect(callback).toHaveBeenCalledTimes(1);

      // Wait for window to expire
      await new Promise((r) => setTimeout(r, 60));

      // Second alert should now deliver
      await system.emitAlert(event);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should not deduplicate alerts with different eventType', async () => {
      const callback = vi.fn();
      const system = createAlertSystem(db, {
        onInAppNotification: callback,
        deduplicationWindowMs: 60_000,
      });
      await system.configureChannel({ type: 'in-app', config: {} });

      await system.emitAlert({
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'high',
        message: 'CPU too high',
      });

      await system.emitAlert({
        eventType: 'memory_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'high',
        message: 'Memory too high',
      });

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should not deduplicate alerts with different affectedResource', async () => {
      const callback = vi.fn();
      const system = createAlertSystem(db, {
        onInAppNotification: callback,
        deduplicationWindowMs: 60_000,
      });
      await system.configureChannel({ type: 'in-app', config: {} });

      await system.emitAlert({
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'high',
        message: 'CPU too high on server1',
      });

      await system.emitAlert({
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server2',
        severity: 'high',
        message: 'CPU too high on server2',
      });

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should not deduplicate alerts with different severity', async () => {
      const callback = vi.fn();
      const system = createAlertSystem(db, {
        onInAppNotification: callback,
        deduplicationWindowMs: 60_000,
      });
      await system.configureChannel({ type: 'in-app', config: {} });

      await system.emitAlert({
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'high',
        message: 'CPU high',
      });

      await system.emitAlert({
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'critical',
        message: 'CPU critical',
      });

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should deduplicate based on key: eventType + affectedResource + severity', async () => {
      const callback = vi.fn();
      const system = createAlertSystem(db, {
        onInAppNotification: callback,
        deduplicationWindowMs: 60_000,
      });
      await system.configureChannel({ type: 'in-app', config: {} });

      const event: AlertEvent = {
        eventType: 'disk_threshold_exceeded',
        affectedResource: 'volume1',
        severity: 'medium',
        message: 'Disk usage high - first occurrence',
      };

      await system.emitAlert(event);
      // Same key but different message — should still be deduplicated
      await system.emitAlert({
        ...event,
        message: 'Disk usage high - second occurrence',
      });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should suppress multiple rapid duplicate alerts', async () => {
      const callback = vi.fn();
      const system = createAlertSystem(db, {
        onInAppNotification: callback,
        deduplicationWindowMs: 60_000,
      });
      await system.configureChannel({ type: 'in-app', config: {} });

      const event: AlertEvent = {
        eventType: 'cpu_threshold_exceeded',
        affectedResource: 'server1',
        severity: 'critical',
        message: 'CPU critical',
      };

      // Emit 5 identical alerts rapidly
      for (let i = 0; i < 5; i++) {
        await system.emitAlert(event);
      }

      // Only the first should have delivered notifications
      expect(callback).toHaveBeenCalledTimes(1);

      // But all 5 should be in history
      const history = await system.getAlertHistory();
      expect(history).toHaveLength(5);
    });

    it('should default to 60 second deduplication window', async () => {
      // Create system without specifying deduplicationWindowMs — defaults to 60_000
      const callback = vi.fn();
      const system = createAlertSystem(db, { onInAppNotification: callback });
      await system.configureChannel({ type: 'in-app', config: {} });

      const event: AlertEvent = {
        eventType: 'test_event',
        affectedResource: 'resource1',
        severity: 'low',
        message: 'test',
      };

      await system.emitAlert(event);
      await system.emitAlert(event);

      // Second alert should be suppressed (default 60s window)
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
