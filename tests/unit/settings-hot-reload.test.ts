/**
 * Unit tests for the Settings Hot-Reload integration module.
 * Verifies that changing settings triggers the appropriate service reconfiguration.
 *
 * @validates Requirements 7.1, 7.2, 7.3, 7.4
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  createSettingsHotReload,
  createMetricsCollectionHandle,
  createAlertThresholdHandle,
  createBackupScheduleHandle,
  type MetricsCollectionHandle,
  type AlertThresholdHandle,
  type BackupScheduleHandle,
  type SettingChangedEvent,
  type HotReloadSubscription,
} from '../../src/services/settings-hot-reload.js';
import type { SettingsService } from '../../src/services/settings-service.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createMockSettingsService(): SettingsService {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getAll: vi.fn(),
    get: vi.fn(),
    getTyped: vi.fn(),
    update: vi.fn(),
    validate: vi.fn(),
    getDefinitions: vi.fn(),
  }) as unknown as SettingsService;
}

function createMockMetricsCollection(): MetricsCollectionHandle & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    setInterval(intervalMs: number) {
      calls.push(intervalMs);
    },
    getInterval() {
      return calls.length > 0 ? calls[calls.length - 1] : 30000;
    },
  };
}

function createMockAlertThresholds(): AlertThresholdHandle & {
  updates: Array<{ key: string; value: number }>;
} {
  const updates: Array<{ key: string; value: number }> = [];
  const thresholds = new Map<string, number>();

  return {
    updates,
    updateThreshold(key: string, value: number) {
      updates.push({ key, value });
      thresholds.set(key, value);
    },
    getThreshold(key: string) {
      return thresholds.get(key);
    },
  };
}

function createMockBackupSchedule(): BackupScheduleHandle & {
  rescheduleCalls: Array<Parameters<BackupScheduleHandle['reschedule']>[0]>;
} {
  const rescheduleCalls: Array<Parameters<BackupScheduleHandle['reschedule']>[0]> = [];
  let config = {
    cronExpression: '0 2 * * *',
    targets: [] as string[],
    retentionCount: 7,
    enabled: false,
  };

  return {
    rescheduleCalls,
    reschedule(updates) {
      rescheduleCalls.push(updates);
      config = {
        cronExpression: updates.cronExpression ?? config.cronExpression,
        targets: updates.targets ?? config.targets,
        retentionCount: updates.retentionCount ?? config.retentionCount,
        enabled: updates.enabled ?? config.enabled,
      };
    },
    getScheduleConfig() {
      return { ...config };
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Settings Hot-Reload', () => {
  let settingsService: SettingsService;
  let metricsCollection: ReturnType<typeof createMockMetricsCollection>;
  let alertThresholds: ReturnType<typeof createMockAlertThresholds>;
  let backupSchedule: ReturnType<typeof createMockBackupSchedule>;
  let subscription: HotReloadSubscription;
  let logMessages: string[];

  beforeEach(() => {
    settingsService = createMockSettingsService();
    metricsCollection = createMockMetricsCollection();
    alertThresholds = createMockAlertThresholds();
    backupSchedule = createMockBackupSchedule();
    logMessages = [];

    subscription = createSettingsHotReload({
      settingsService,
      metricsCollection,
      alertThresholds,
      backupSchedule,
      logger: (msg) => logMessages.push(msg),
    });
  });

  afterEach(() => {
    subscription.dispose();
  });

  // ─── Metrics Collector Hot-Reload ──────────────────────────────────────────

  describe('Metrics Collector - collection_interval_ms', () => {
    it('should adjust polling interval when collection_interval_ms changes', () => {
      settingsService.emit('setting:changed', {
        key: 'collection_interval_ms',
        oldValue: '30000',
        newValue: '60000',
        category: 'Monitoring',
      } satisfies SettingChangedEvent);

      expect(metricsCollection.calls).toHaveLength(1);
      expect(metricsCollection.calls[0]).toBe(60000);
    });

    it('should log the interval change', () => {
      settingsService.emit('setting:changed', {
        key: 'collection_interval_ms',
        oldValue: '30000',
        newValue: '15000',
        category: 'Monitoring',
      } satisfies SettingChangedEvent);

      expect(logMessages).toHaveLength(1);
      expect(logMessages[0]).toContain('30000ms');
      expect(logMessages[0]).toContain('15000ms');
    });

    it('should not adjust interval for invalid numeric values', () => {
      settingsService.emit('setting:changed', {
        key: 'collection_interval_ms',
        oldValue: '30000',
        newValue: 'not-a-number',
        category: 'Monitoring',
      } satisfies SettingChangedEvent);

      expect(metricsCollection.calls).toHaveLength(0);
    });

    it('should not adjust interval for values below 1000ms', () => {
      settingsService.emit('setting:changed', {
        key: 'collection_interval_ms',
        oldValue: '30000',
        newValue: '500',
        category: 'Monitoring',
      } satisfies SettingChangedEvent);

      expect(metricsCollection.calls).toHaveLength(0);
    });

    it('should not react if metricsCollection handle is not provided', () => {
      subscription.dispose();
      subscription = createSettingsHotReload({
        settingsService,
        logger: (msg) => logMessages.push(msg),
      });

      // Should not throw
      settingsService.emit('setting:changed', {
        key: 'collection_interval_ms',
        oldValue: '30000',
        newValue: '60000',
        category: 'Monitoring',
      } satisfies SettingChangedEvent);

      expect(metricsCollection.calls).toHaveLength(0);
    });
  });

  // ─── Alert System Hot-Reload ───────────────────────────────────────────────

  describe('Alert System - threshold settings', () => {
    it('should update alert_cpu_warning threshold', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_cpu_warning',
        oldValue: '80',
        newValue: '75',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(1);
      expect(alertThresholds.updates[0]).toEqual({ key: 'alert_cpu_warning', value: 75 });
    });

    it('should update alert_cpu_critical threshold', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_cpu_critical',
        oldValue: '95',
        newValue: '90',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(1);
      expect(alertThresholds.updates[0]).toEqual({ key: 'alert_cpu_critical', value: 90 });
    });

    it('should update alert_memory_warning threshold', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_memory_warning',
        oldValue: '80',
        newValue: '70',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(1);
      expect(alertThresholds.updates[0]).toEqual({ key: 'alert_memory_warning', value: 70 });
    });

    it('should update alert_memory_critical threshold', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_memory_critical',
        oldValue: '95',
        newValue: '92',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(1);
      expect(alertThresholds.updates[0]).toEqual({ key: 'alert_memory_critical', value: 92 });
    });

    it('should update alert_disk_warning threshold', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_disk_warning',
        oldValue: '90',
        newValue: '85',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(1);
      expect(alertThresholds.updates[0]).toEqual({ key: 'alert_disk_warning', value: 85 });
    });

    it('should update alert_disk_critical threshold', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_disk_critical',
        oldValue: '95',
        newValue: '98',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(1);
      expect(alertThresholds.updates[0]).toEqual({ key: 'alert_disk_critical', value: 98 });
    });

    it('should update alert_consecutive_checks', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_consecutive_checks',
        oldValue: '3',
        newValue: '5',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(1);
      expect(alertThresholds.updates[0]).toEqual({ key: 'alert_consecutive_checks', value: 5 });
    });

    it('should not react to non-alert settings', () => {
      settingsService.emit('setting:changed', {
        key: 'webhook_url',
        oldValue: '',
        newValue: 'https://example.com/hook',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(0);
    });

    it('should ignore non-numeric threshold values', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_cpu_warning',
        oldValue: '80',
        newValue: 'invalid',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(alertThresholds.updates).toHaveLength(0);
    });

    it('should log threshold changes', () => {
      settingsService.emit('setting:changed', {
        key: 'alert_cpu_warning',
        oldValue: '80',
        newValue: '75',
        category: 'Alerts',
      } satisfies SettingChangedEvent);

      expect(logMessages).toHaveLength(1);
      expect(logMessages[0]).toContain('alert_cpu_warning');
      expect(logMessages[0]).toContain('80');
      expect(logMessages[0]).toContain('75');
    });
  });

  // ─── Backup Manager Hot-Reload ─────────────────────────────────────────────

  describe('Backup Manager - schedule settings', () => {
    it('should reschedule when snapshot_schedule_cron changes', () => {
      settingsService.emit('setting:changed', {
        key: 'snapshot_schedule_cron',
        oldValue: '0 2 * * *',
        newValue: '0 3 * * *',
        category: 'Backups',
      } satisfies SettingChangedEvent);

      expect(backupSchedule.rescheduleCalls).toHaveLength(1);
      expect(backupSchedule.rescheduleCalls[0]).toEqual({ cronExpression: '0 3 * * *' });
    });

    it('should reschedule when snapshot_targets changes', () => {
      settingsService.emit('setting:changed', {
        key: 'snapshot_targets',
        oldValue: '[]',
        newValue: '["web-app","database"]',
        category: 'Backups',
      } satisfies SettingChangedEvent);

      expect(backupSchedule.rescheduleCalls).toHaveLength(1);
      expect(backupSchedule.rescheduleCalls[0]).toEqual({
        targets: ['web-app', 'database'],
      });
    });

    it('should reschedule when snapshot_retention_count changes', () => {
      settingsService.emit('setting:changed', {
        key: 'snapshot_retention_count',
        oldValue: '7',
        newValue: '14',
        category: 'Backups',
      } satisfies SettingChangedEvent);

      expect(backupSchedule.rescheduleCalls).toHaveLength(1);
      expect(backupSchedule.rescheduleCalls[0]).toEqual({ retentionCount: 14 });
    });

    it('should reschedule when snapshot_schedule_enabled changes to true', () => {
      settingsService.emit('setting:changed', {
        key: 'snapshot_schedule_enabled',
        oldValue: 'false',
        newValue: 'true',
        category: 'Backups',
      } satisfies SettingChangedEvent);

      expect(backupSchedule.rescheduleCalls).toHaveLength(1);
      expect(backupSchedule.rescheduleCalls[0]).toEqual({ enabled: true });
    });

    it('should reschedule when snapshot_schedule_enabled changes to false', () => {
      settingsService.emit('setting:changed', {
        key: 'snapshot_schedule_enabled',
        oldValue: 'true',
        newValue: 'false',
        category: 'Backups',
      } satisfies SettingChangedEvent);

      expect(backupSchedule.rescheduleCalls).toHaveLength(1);
      expect(backupSchedule.rescheduleCalls[0]).toEqual({ enabled: false });
    });

    it('should not reschedule for invalid JSON in snapshot_targets', () => {
      settingsService.emit('setting:changed', {
        key: 'snapshot_targets',
        oldValue: '[]',
        newValue: '{invalid json}',
        category: 'Backups',
      } satisfies SettingChangedEvent);

      expect(backupSchedule.rescheduleCalls).toHaveLength(0);
      expect(logMessages.some((m) => m.includes('Invalid JSON'))).toBe(true);
    });

    it('should not react to non-schedule backup settings', () => {
      settingsService.emit('setting:changed', {
        key: 'backup_local_path',
        oldValue: '/data/backups',
        newValue: '/mnt/backups',
        category: 'Backups',
      } satisfies SettingChangedEvent);

      expect(backupSchedule.rescheduleCalls).toHaveLength(0);
    });

    it('should log schedule changes', () => {
      settingsService.emit('setting:changed', {
        key: 'snapshot_schedule_cron',
        oldValue: '0 2 * * *',
        newValue: '0 4 * * *',
        category: 'Backups',
      } satisfies SettingChangedEvent);

      expect(logMessages).toHaveLength(1);
      expect(logMessages[0]).toContain('snapshot_schedule_cron');
    });
  });

  // ─── Subscription Disposal ─────────────────────────────────────────────────

  describe('Subscription disposal', () => {
    it('should stop receiving events after dispose()', () => {
      subscription.dispose();

      settingsService.emit('setting:changed', {
        key: 'collection_interval_ms',
        oldValue: '30000',
        newValue: '60000',
        category: 'Monitoring',
      } satisfies SettingChangedEvent);

      expect(metricsCollection.calls).toHaveLength(0);
      expect(alertThresholds.updates).toHaveLength(0);
      expect(backupSchedule.rescheduleCalls).toHaveLength(0);
    });
  });
});

// ─── createMetricsCollectionHandle tests ─────────────────────────────────────

describe('createMetricsCollectionHandle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start collecting at the specified interval', async () => {
    const collectionFn = vi.fn().mockResolvedValue(undefined);
    const handle = createMetricsCollectionHandle(5000, collectionFn);

    // Advance time to trigger collection
    await vi.advanceTimersByTimeAsync(5000);
    expect(collectionFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(collectionFn).toHaveBeenCalledTimes(2);

    handle.dispose();
  });

  it('should restart collection at new interval when setInterval is called', async () => {
    const collectionFn = vi.fn().mockResolvedValue(undefined);
    const handle = createMetricsCollectionHandle(5000, collectionFn);

    // Change interval to 10000ms
    handle.setInterval(10000);

    // After 5000ms, should NOT have collected (old interval cleared)
    await vi.advanceTimersByTimeAsync(5000);
    expect(collectionFn).toHaveBeenCalledTimes(0);

    // After 10000ms total, should have collected once
    await vi.advanceTimersByTimeAsync(5000);
    expect(collectionFn).toHaveBeenCalledTimes(1);

    handle.dispose();
  });

  it('should report the current interval via getInterval()', () => {
    const collectionFn = vi.fn().mockResolvedValue(undefined);
    const handle = createMetricsCollectionHandle(30000, collectionFn);

    expect(handle.getInterval()).toBe(30000);

    handle.setInterval(60000);
    expect(handle.getInterval()).toBe(60000);

    handle.dispose();
  });

  it('should stop collecting after dispose()', async () => {
    const collectionFn = vi.fn().mockResolvedValue(undefined);
    const handle = createMetricsCollectionHandle(5000, collectionFn);

    handle.dispose();

    await vi.advanceTimersByTimeAsync(10000);
    expect(collectionFn).toHaveBeenCalledTimes(0);
  });
});

// ─── createAlertThresholdHandle tests ────────────────────────────────────────

describe('createAlertThresholdHandle', () => {
  it('should store and retrieve thresholds', () => {
    const handle = createAlertThresholdHandle({
      alert_cpu_warning: 80,
      alert_cpu_critical: 95,
    });

    expect(handle.getThreshold('alert_cpu_warning')).toBe(80);
    expect(handle.getThreshold('alert_cpu_critical')).toBe(95);
  });

  it('should update existing thresholds', () => {
    const handle = createAlertThresholdHandle({ alert_cpu_warning: 80 });

    handle.updateThreshold('alert_cpu_warning', 75);
    expect(handle.getThreshold('alert_cpu_warning')).toBe(75);
  });

  it('should add new thresholds', () => {
    const handle = createAlertThresholdHandle();

    handle.updateThreshold('alert_disk_warning', 90);
    expect(handle.getThreshold('alert_disk_warning')).toBe(90);
  });

  it('should return undefined for unknown thresholds', () => {
    const handle = createAlertThresholdHandle();
    expect(handle.getThreshold('unknown_key')).toBeUndefined();
  });
});

// ─── createBackupScheduleHandle tests ────────────────────────────────────────

describe('createBackupScheduleHandle', () => {
  it('should return initial config via getScheduleConfig()', () => {
    const handle = createBackupScheduleHandle({
      cronExpression: '0 2 * * *',
      targets: ['web-app'],
      retentionCount: 7,
      enabled: true,
    });

    expect(handle.getScheduleConfig()).toEqual({
      cronExpression: '0 2 * * *',
      targets: ['web-app'],
      retentionCount: 7,
      enabled: true,
    });
  });

  it('should merge partial updates when reschedule is called', () => {
    const handle = createBackupScheduleHandle({
      cronExpression: '0 2 * * *',
      targets: ['web-app'],
      retentionCount: 7,
      enabled: true,
    });

    handle.reschedule({ cronExpression: '0 4 * * *' });

    expect(handle.getScheduleConfig()).toEqual({
      cronExpression: '0 4 * * *',
      targets: ['web-app'],
      retentionCount: 7,
      enabled: true,
    });
  });

  it('should call onReschedule callback with full config', () => {
    const onReschedule = vi.fn();
    const handle = createBackupScheduleHandle(
      {
        cronExpression: '0 2 * * *',
        targets: [],
        retentionCount: 7,
        enabled: false,
      },
      onReschedule
    );

    handle.reschedule({ enabled: true, targets: ['db'] });

    expect(onReschedule).toHaveBeenCalledWith({
      cronExpression: '0 2 * * *',
      targets: ['db'],
      retentionCount: 7,
      enabled: true,
    });
  });

  it('should handle multiple sequential reschedules', () => {
    const handle = createBackupScheduleHandle({
      cronExpression: '0 2 * * *',
      targets: [],
      retentionCount: 7,
      enabled: false,
    });

    handle.reschedule({ cronExpression: '0 3 * * *' });
    handle.reschedule({ retentionCount: 14 });
    handle.reschedule({ enabled: true });

    expect(handle.getScheduleConfig()).toEqual({
      cronExpression: '0 3 * * *',
      targets: [],
      retentionCount: 14,
      enabled: true,
    });
  });
});
