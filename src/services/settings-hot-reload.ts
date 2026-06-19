/**
 * Settings Hot-Reload Integration
 *
 * Wires the SettingsService `setting:changed` events to the appropriate
 * backend services so that configuration changes take effect immediately
 * without restart.
 *
 * - Metrics Collector: adjusts polling interval on `collection_interval_ms` change
 * - Alert System: applies new thresholds on `alert_*` setting changes
 * - Backup Manager: reschedules jobs on backup schedule setting changes
 *
 * @module services/settings-hot-reload
 * @validates Requirements 7.1, 7.2, 7.3, 7.4
 */

import type { SettingsService, SettingCategory } from './settings-service.js';
import type { AlertSystem } from '../modules/alert-system.js';
import type { BackupManager } from '../modules/backup-manager.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SettingChangedEvent {
  key: string;
  oldValue: string;
  newValue: string;
  category: SettingCategory;
}

/**
 * Interface for the metrics collection loop, allowing hot-reload
 * to clear and reset the interval timer.
 */
export interface MetricsCollectionHandle {
  /** Replace the current collection interval with a new one */
  setInterval(intervalMs: number): void;
  /** Get the current interval in ms */
  getInterval(): number;
}

/**
 * Interface for the alert system thresholds that can be hot-reloaded.
 */
export interface AlertThresholdHandle {
  /** Update a threshold value used for metric evaluation */
  updateThreshold(key: string, value: number): void;
  /** Get the current threshold value for a key */
  getThreshold(key: string): number | undefined;
}

/**
 * Interface for the backup manager schedule that can be hot-reloaded.
 */
export interface BackupScheduleHandle {
  /** Reschedule backup jobs with updated configuration */
  reschedule(config: {
    cronExpression?: string;
    targets?: string[];
    retentionCount?: number;
    enabled?: boolean;
  }): void;
  /** Get the current schedule config */
  getScheduleConfig(): {
    cronExpression: string;
    targets: string[];
    retentionCount: number;
    enabled: boolean;
  };
}

export interface HotReloadConfig {
  settingsService: SettingsService;
  metricsCollection?: MetricsCollectionHandle;
  alertThresholds?: AlertThresholdHandle;
  backupSchedule?: BackupScheduleHandle;
  /** Optional logger function (defaults to console.log) */
  logger?: (message: string) => void;
}

export interface HotReloadSubscription {
  /** Unsubscribe all listeners */
  dispose(): void;
}

// ─── Alert threshold setting keys ────────────────────────────────────────────

const ALERT_THRESHOLD_KEYS = new Set([
  'alert_cpu_warning',
  'alert_cpu_critical',
  'alert_memory_warning',
  'alert_memory_critical',
  'alert_disk_warning',
  'alert_disk_critical',
  'alert_consecutive_checks',
]);

// ─── Backup schedule setting keys ────────────────────────────────────────────

const BACKUP_SCHEDULE_KEYS = new Set([
  'snapshot_schedule_cron',
  'snapshot_targets',
  'snapshot_retention_count',
  'snapshot_schedule_enabled',
]);

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Subscribe to settings change events and wire them to the appropriate
 * service handlers. Returns a disposable subscription.
 */
export function createSettingsHotReload(config: HotReloadConfig): HotReloadSubscription {
  const { settingsService, metricsCollection, alertThresholds, backupSchedule } = config;
  const log = config.logger ?? ((msg: string) => console.log(`[Settings Hot-Reload] ${msg}`));

  function onSettingChanged(event: SettingChangedEvent): void {
    const { key, oldValue, newValue } = event;

    // ─── Metrics Collector: collection_interval_ms ─────────────────────────
    if (key === 'collection_interval_ms' && metricsCollection) {
      const newInterval = Number(newValue);
      if (isFinite(newInterval) && newInterval >= 1000) {
        metricsCollection.setInterval(newInterval);
        log(`Metrics collection interval updated: ${oldValue}ms → ${newValue}ms`);
      }
      return;
    }

    // ─── Alert System: alert threshold keys ────────────────────────────────
    if (ALERT_THRESHOLD_KEYS.has(key) && alertThresholds) {
      const numericValue = Number(newValue);
      if (isFinite(numericValue)) {
        alertThresholds.updateThreshold(key, numericValue);
        log(`Alert threshold "${key}" updated: ${oldValue} → ${newValue}`);
      }
      return;
    }

    // ─── Backup Manager: backup schedule keys ──────────────────────────────
    if (BACKUP_SCHEDULE_KEYS.has(key) && backupSchedule) {
      const rescheduleConfig: Parameters<BackupScheduleHandle['reschedule']>[0] = {};

      switch (key) {
        case 'snapshot_schedule_cron':
          rescheduleConfig.cronExpression = newValue;
          break;
        case 'snapshot_targets':
          try {
            rescheduleConfig.targets = JSON.parse(newValue);
          } catch {
            log(`Warning: Invalid JSON for snapshot_targets, skipping reschedule`);
            return;
          }
          break;
        case 'snapshot_retention_count':
          rescheduleConfig.retentionCount = Number(newValue);
          break;
        case 'snapshot_schedule_enabled':
          rescheduleConfig.enabled = newValue === 'true';
          break;
      }

      backupSchedule.reschedule(rescheduleConfig);
      log(`Backup schedule updated for "${key}": ${oldValue} → ${newValue}`);
      return;
    }
  }

  // Subscribe to the settings service events
  settingsService.on('setting:changed', onSettingChanged);

  return {
    dispose() {
      settingsService.off('setting:changed', onSettingChanged);
    },
  };
}

/**
 * Create a MetricsCollectionHandle wrapping a setInterval-based collection loop.
 * This allows hot-reloading the interval without needing access to the raw timer.
 */
export function createMetricsCollectionHandle(
  initialIntervalMs: number,
  collectionFn: () => Promise<void>
): MetricsCollectionHandle & { dispose(): void } {
  let currentIntervalMs = initialIntervalMs;
  let timer: ReturnType<typeof setInterval> | null = null;

  function startTimer(): void {
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(async () => {
      try {
        await collectionFn();
      } catch {
        // Errors handled by caller's collectionFn
      }
    }, currentIntervalMs);
    // Don't prevent Node.js from exiting
    if (timer.unref) {
      timer.unref();
    }
  }

  // Start immediately
  startTimer();

  return {
    setInterval(intervalMs: number) {
      currentIntervalMs = intervalMs;
      startTimer();
    },
    getInterval() {
      return currentIntervalMs;
    },
    dispose() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Create an AlertThresholdHandle that stores thresholds in a map.
 * This is a lightweight adapter for services that need to look up
 * current threshold values during metric evaluation.
 */
export function createAlertThresholdHandle(
  initialThresholds?: Record<string, number>
): AlertThresholdHandle {
  const thresholds = new Map<string, number>(
    Object.entries(initialThresholds ?? {})
  );

  return {
    updateThreshold(key: string, value: number) {
      thresholds.set(key, value);
    },
    getThreshold(key: string) {
      return thresholds.get(key);
    },
  };
}

/**
 * Create a BackupScheduleHandle that manages schedule configuration
 * and triggers rescheduling when settings change.
 */
export function createBackupScheduleHandle(
  initialConfig: {
    cronExpression: string;
    targets: string[];
    retentionCount: number;
    enabled: boolean;
  },
  onReschedule?: (config: {
    cronExpression: string;
    targets: string[];
    retentionCount: number;
    enabled: boolean;
  }) => void
): BackupScheduleHandle {
  let currentConfig = { ...initialConfig };

  return {
    reschedule(updates) {
      currentConfig = {
        cronExpression: updates.cronExpression ?? currentConfig.cronExpression,
        targets: updates.targets ?? currentConfig.targets,
        retentionCount: updates.retentionCount ?? currentConfig.retentionCount,
        enabled: updates.enabled ?? currentConfig.enabled,
      };
      if (onReschedule) {
        onReschedule(currentConfig);
      }
    },
    getScheduleConfig() {
      return { ...currentConfig };
    },
  };
}
