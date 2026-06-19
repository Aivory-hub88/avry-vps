/**
 * Alert System Module
 *
 * Event-driven alert system with multi-channel delivery (email, webhook, in-app),
 * alert rules with resource thresholds and consecutive check logic,
 * exponential backoff retry for webhooks, and alert history.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7
 * @validates Requirements 9.1, 9.2, 9.3, 9.4, 11.5
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import type { AlertThresholdHandle } from '../services/settings-hot-reload.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export type AlertChannelType = 'email' | 'webhook' | 'in-app';
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertResourceType = 'cpu' | 'memory' | 'disk' | 'container-health';
export type DeliveryStatus = 'delivered' | 'failed' | 'pending' | 'retrying';

export interface AlertChannel {
  id?: string;
  type: AlertChannelType;
  config: Record<string, string>;
  enabled?: boolean;
}

export interface AlertRule {
  id?: string;
  resourceType: AlertResourceType;
  threshold?: number;
  consecutiveChecks?: number;
  enabled?: boolean;
}

export interface AlertEvent {
  eventType: string;
  affectedResource: string;
  severity: AlertSeverity;
  message: string;
}

export interface AlertRecord {
  id: string;
  timestamp: string;
  eventType: string;
  affectedResource: string;
  severity: AlertSeverity;
  deliveryStatus: Record<string, DeliveryStatus>;
  message: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolutionStatus: 'active' | 'acknowledged' | 'resolved' | 'silenced';
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface SilenceRecord {
  id: string;
  ruleId: string;
  adminId: string;
  expiresAt: string;
  createdAt: string;
}

export interface PaginatedAlerts {
  items: AlertRecord[];
  total: number;
  page: number;
  pageSize: number;
}

/** Metric type for configurable threshold evaluation */
export type ThresholdMetricType = 'cpu' | 'memory' | 'disk';

/** Result of a threshold evaluation */
export interface ThresholdEvaluationResult {
  /** Whether an alert was emitted */
  alertEmitted: boolean;
  /** The severity of the emitted alert (if any) */
  severity?: 'warning' | 'critical';
  /** The alert ID (if emitted) */
  alertId?: string;
  /** Whether an existing alert was auto-resolved */
  resolved: boolean;
  /** Current consecutive breach count */
  consecutiveBreaches: number;
}

/** Active alert tracking for auto-resolution */
export interface ActiveThresholdAlert {
  alertId: string;
  metricType: ThresholdMetricType;
  severity: 'warning' | 'critical';
  resource: string;
}

export interface AlertSystem {
  /** Configure a notification channel (email/webhook/in-app) */
  configureChannel(channel: AlertChannel): Promise<string>;
  /** Configure an alert rule with resource thresholds */
  configureRule(rule: AlertRule): Promise<string>;
  /** Emit an alert event and deliver to all configured channels */
  emitAlert(event: AlertEvent): Promise<string>;
  /** Get the last 500 alert events */
  getAlertHistory(): Promise<AlertRecord[]>;
  /** Record a metric value for threshold-based alert checking */
  recordMetric(resourceType: AlertResourceType, resource: string, value: number): Promise<void>;
  /** Get configured channels */
  getChannels(): AlertChannel[];
  /** Get configured rules */
  getRules(): AlertRule[];
  /** Remove a channel by ID */
  removeChannel(id: string): void;
  /** Remove a rule by ID */
  removeRule(id: string): void;
  /**
   * Evaluate a metric value against configurable thresholds from Settings Service.
   * Uses the AlertThresholdHandle for reading current threshold values and
   * tracks consecutive breaches per metric type + resource.
   *
   * @param metricType - The type of metric (cpu, memory, disk)
   * @param resource - The resource identifier (e.g., 'system', container name)
   * @param value - The current metric value (0-100 percentage)
   * @returns ThresholdEvaluationResult indicating what actions were taken
   * @validates Requirements 9.1, 9.2, 9.3, 9.4, 11.5
   */
  evaluateThreshold(metricType: ThresholdMetricType, resource: string, value: number): Promise<ThresholdEvaluationResult>;
  /** Get the current consecutive breach count for a metric/resource pair */
  getBreachCount(metricType: ThresholdMetricType, resource: string): number;
  /** Get active threshold alerts (not yet resolved) */
  getActiveThresholdAlerts(): ActiveThresholdAlert[];
  /**
   * Record a container health status transition.
   * Emits a high-severity alert on healthy→unhealthy transitions
   * and a low-severity resolution alert on unhealthy→healthy transitions.
   * Transitions involving 'starting' or 'none' are ignored.
   *
   * @param containerId - The container ID
   * @param containerName - The container display name
   * @param from - The previous health status
   * @param to - The new health status
   * @validates Requirements 10.1, 10.2, 10.3
   */
  recordHealthTransition(containerId: string, containerName: string, from: HealthStatus, to: HealthStatus): Promise<void>;
  /** Acknowledge an alert by ID with admin identifier and timestamp @validates Requirements 11.3 */
  acknowledgeAlert(alertId: string, adminId: string): Promise<void>;
  /** Silence a rule for a specified duration, suppressing notifications @validates Requirements 11.4 */
  silenceRule(ruleId: string, durationMs: number, adminId: string): Promise<string>;
  /** Remove an active silence by ID */
  removeSilence(silenceId: string): Promise<void>;
  /** Get all currently active (non-expired) silences */
  getActiveSilences(): Promise<SilenceRecord[]>;
  /** Mark an alert as auto-resolved @validates Requirements 11.5 */
  resolveAlert(alertId: string): Promise<void>;
  /** Get paginated alert history @validates Requirements 11.2 */
  getAlertHistoryPaginated(page: number, pageSize: number): Promise<PaginatedAlerts>;
}

export interface AlertSystemConfig {
  /** Maximum number of alert history entries to keep. Default: 500 */
  maxHistorySize?: number;
  /** Webhook timeout in milliseconds. Default: 10000 (10 seconds) */
  webhookTimeoutMs?: number;
  /** Webhook retry delays in milliseconds. Default: [5000, 15000, 45000] */
  webhookRetryDelaysMs?: number[];
  /** Callback for in-app notifications (e.g., Socket.IO emit) */
  onInAppNotification?: (alert: AlertRecord) => void;
  /** AlertThresholdHandle for reading configurable thresholds from Settings Service */
  thresholdHandle?: AlertThresholdHandle;
  /** Deduplication window in milliseconds. Default: 60000 (60 seconds) */
  deduplicationWindowMs?: number;
}

// ─── Internal Types ────────────────────────────────────────────────────────────

interface AlertChannelRow {
  id: string;
  type: string;
  config: string;
  enabled: number;
  created_at: string;
}

interface AlertRuleRow {
  id: string;
  resource_type: string;
  threshold: number | null;
  consecutive_checks: number;
  enabled: number;
  created_at: string;
}

interface AlertRow {
  id: string;
  timestamp: string;
  event_type: string;
  affected_resource: string;
  severity: string;
  delivery_status: string | null;
  message: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolution_status: string | null;
}

/** Tracks consecutive threshold breaches per resource+rule */
interface ThresholdTracker {
  count: number;
  lastValue: number;
}

/** Tracks consecutive breaches for configurable threshold evaluation */
interface ConfigurableThresholdTracker {
  /** Warning threshold consecutive breach count */
  warningCount: number;
  /** Critical threshold consecutive breach count */
  criticalCount: number;
  /** Last metric value recorded */
  lastValue: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_HISTORY_SIZE = 500;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const DEFAULT_CONSECUTIVE_CHECKS = 3;

// ─── Implementation ────────────────────────────────────────────────────────────

export function createAlertSystem(
  db: Database.Database,
  config?: AlertSystemConfig
): AlertSystem {
  const maxHistorySize = config?.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE;
  const webhookTimeoutMs = config?.webhookTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const webhookRetryDelaysMs = config?.webhookRetryDelaysMs ?? DEFAULT_WEBHOOK_RETRY_DELAYS_MS;
  const onInAppNotification = config?.onInAppNotification;
  const thresholdHandle = config?.thresholdHandle;
  const deduplicationWindowMs = config?.deduplicationWindowMs ?? 60_000;

  // Consecutive threshold breach tracker: key is `${ruleId}:${resource}`
  const thresholdTrackers = new Map<string, ThresholdTracker>();

  // Configurable threshold tracker: key is `${metricType}:${resource}`
  const configurableTrackers = new Map<string, ConfigurableThresholdTracker>();

  // Active threshold alerts for auto-resolution: key is `${metricType}:${resource}`
  const activeThresholdAlerts = new Map<string, ActiveThresholdAlert>();

  // Deduplication tracker: key is `${eventType}:${affectedResource}:${severity}`, value is timestamp (ms)
  // Identical alerts within the deduplication window are stored but notification delivery is suppressed.
  const recentAlerts = new Map<string, number>();

  // ─── Prepared Statements ───────────────────────────────────────────────

  const insertChannel = db.prepare(
    `INSERT INTO alert_channels (id, type, config, enabled) VALUES (?, ?, ?, ?)`
  );

  const updateChannel = db.prepare(
    `UPDATE alert_channels SET type = ?, config = ?, enabled = ? WHERE id = ?`
  );

  const deleteChannel = db.prepare(`DELETE FROM alert_channels WHERE id = ?`);

  const getAllChannels = db.prepare(
    `SELECT * FROM alert_channels WHERE enabled = 1`
  );

  const getAllChannelsIncludingDisabled = db.prepare(
    `SELECT * FROM alert_channels`
  );

  const insertRule = db.prepare(
    `INSERT INTO alert_rules (id, resource_type, threshold, consecutive_checks, enabled) VALUES (?, ?, ?, ?, ?)`
  );

  const updateRule = db.prepare(
    `UPDATE alert_rules SET resource_type = ?, threshold = ?, consecutive_checks = ?, enabled = ? WHERE id = ?`
  );

  const deleteRule = db.prepare(`DELETE FROM alert_rules WHERE id = ?`);

  const getAllRules = db.prepare(`SELECT * FROM alert_rules`);

  const getEnabledRulesByResourceType = db.prepare(
    `SELECT * FROM alert_rules WHERE resource_type = ? AND enabled = 1`
  );

  const insertAlert = db.prepare(
    `INSERT INTO alerts (id, timestamp, event_type, affected_resource, severity, delivery_status, message, resolution_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const getAlertHistoryStmt = db.prepare(
    `SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`
  );

  const getAlertCount = db.prepare(`SELECT COUNT(*) as count FROM alerts`);

  const pruneOldAlerts = db.prepare(
    `DELETE FROM alerts WHERE id IN (
      SELECT id FROM alerts ORDER BY timestamp DESC LIMIT -1 OFFSET ?
    )`
  );

  // ─── Channel Configuration ─────────────────────────────────────────────

  async function configureChannel(channel: AlertChannel): Promise<string> {
    const id = channel.id ?? uuidv4();
    const enabled = channel.enabled !== false ? 1 : 0;
    const configJson = JSON.stringify(channel.config);

    if (channel.id) {
      // Update existing channel
      const existing = db.prepare('SELECT id FROM alert_channels WHERE id = ?').get(channel.id);
      if (existing) {
        updateChannel.run(channel.type, configJson, enabled, channel.id);
        return channel.id;
      }
    }

    insertChannel.run(id, channel.type, configJson, enabled);
    return id;
  }

  // ─── Rule Configuration ─────────────────────────────────────────────────

  async function configureRule(rule: AlertRule): Promise<string> {
    const id = rule.id ?? uuidv4();
    const consecutiveChecks = rule.consecutiveChecks ?? DEFAULT_CONSECUTIVE_CHECKS;
    const enabled = rule.enabled !== false ? 1 : 0;

    if (rule.id) {
      const existing = db.prepare('SELECT id FROM alert_rules WHERE id = ?').get(rule.id);
      if (existing) {
        updateRule.run(rule.resourceType, rule.threshold ?? null, consecutiveChecks, enabled, rule.id);
        return rule.id;
      }
    }

    insertRule.run(id, rule.resourceType, rule.threshold ?? null, consecutiveChecks, enabled);
    return id;
  }

  // ─── Alert Emission ─────────────────────────────────────────────────────

  async function emitAlert(event: AlertEvent): Promise<string> {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    const now = Date.now();

    // ─── Deduplication: suppress delivery for identical alerts within 60s ──
    const dedupeKey = `${event.eventType}:${event.affectedResource}:${event.severity}`;
    const lastEmitted = recentAlerts.get(dedupeKey);
    const isDuplicate = lastEmitted !== undefined && (now - lastEmitted) < deduplicationWindowMs;

    // Always update the timestamp for this alert fingerprint
    if (!isDuplicate) {
      recentAlerts.set(dedupeKey, now);
    }

    // Prune stale entries from the deduplication map periodically
    if (recentAlerts.size > 100) {
      for (const [key, ts] of recentAlerts) {
        if (now - ts >= deduplicationWindowMs) {
          recentAlerts.delete(key);
        }
      }
    }

    // Check if the event is silenced — if so, store but skip delivery
    const silenced = isEventSilenced(event);

    // Get all enabled channels
    const channels = getAllChannels.all() as AlertChannelRow[];

    // Deliver to all channels independently (unless silenced or deduplicated)
    const deliveryStatus: Record<string, DeliveryStatus> = {};

    if (!silenced && !isDuplicate) {
      // Launch all deliveries in parallel (independent failures)
      const deliveryPromises = channels.map(async (channel) => {
        try {
          await deliverToChannel(channel, event);
          deliveryStatus[channel.id] = 'delivered';
        } catch {
          deliveryStatus[channel.id] = 'failed';
        }
      });

      // Wait for all deliveries (with 30-second overall deadline)
      await Promise.race([
        Promise.allSettled(deliveryPromises),
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);

      // Mark any still-pending channels
      for (const channel of channels) {
        if (!deliveryStatus[channel.id]) {
          deliveryStatus[channel.id] = 'pending';
        }
      }
    }

    // Persist the alert record (always stored regardless of silence)
    const resolutionStatus = silenced ? 'silenced' : 'active';
    const alertRecord: AlertRecord = {
      id,
      timestamp,
      eventType: event.eventType,
      affectedResource: event.affectedResource,
      severity: event.severity,
      deliveryStatus,
      message: event.message,
      resolutionStatus,
    };

    insertAlert.run(
      id,
      timestamp,
      event.eventType,
      event.affectedResource,
      event.severity,
      JSON.stringify(deliveryStatus),
      event.message,
      resolutionStatus
    );

    // Prune history if needed
    pruneHistory();

    // In-app notification callback (only if not silenced and not deduplicated)
    if (onInAppNotification && !silenced && !isDuplicate) {
      onInAppNotification(alertRecord);
    }

    return id;
  }

  // ─── Channel Delivery ───────────────────────────────────────────────────

  async function deliverToChannel(channel: AlertChannelRow, event: AlertEvent): Promise<void> {
    const channelConfig = JSON.parse(channel.config) as Record<string, string>;

    switch (channel.type) {
      case 'email':
        await deliverEmail(channelConfig, event);
        break;
      case 'webhook':
        await deliverWebhook(channelConfig, event);
        break;
      case 'in-app':
        // In-app notifications are handled via the callback in emitAlert
        break;
      default:
        throw new Error(`Unknown channel type: ${channel.type}`);
    }
  }

  // ─── Email Delivery (SMTP via nodemailer) ───────────────────────────────

  async function deliverEmail(
    channelConfig: Record<string, string>,
    event: AlertEvent
  ): Promise<void> {
    const transport = nodemailer.createTransport({
      host: channelConfig.host,
      port: parseInt(channelConfig.port ?? '587', 10),
      secure: channelConfig.secure === 'true',
      auth: channelConfig.user
        ? {
            user: channelConfig.user,
            pass: channelConfig.pass ?? '',
          }
        : undefined,
    });

    const severityLabel = event.severity.toUpperCase();
    const subject = `[${severityLabel}] Alert: ${event.eventType} - ${event.affectedResource}`;

    await transport.sendMail({
      from: channelConfig.from ?? channelConfig.user ?? 'alerts@vps-panel.local',
      to: channelConfig.to,
      subject,
      text: `Alert: ${event.eventType}\nResource: ${event.affectedResource}\nSeverity: ${event.severity}\n\n${event.message}`,
      html: `<h2>VPS Panel Alert</h2>
<p><strong>Event:</strong> ${event.eventType}</p>
<p><strong>Resource:</strong> ${event.affectedResource}</p>
<p><strong>Severity:</strong> ${event.severity}</p>
<p>${event.message}</p>`,
    });
  }

  // ─── Webhook Delivery (Slack/Discord compatible HTTP POST) ──────────────

  async function deliverWebhook(
    channelConfig: Record<string, string>,
    event: AlertEvent
  ): Promise<void> {
    const url = channelConfig.url;
    if (!url) throw new Error('Webhook URL not configured');

    const payload = buildWebhookPayload(channelConfig, event);
    const maxRetries = webhookRetryDelaysMs.length;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), webhookTimeoutMs);

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          return; // Success
        }

        lastError = new Error(`Webhook returned status ${response.status}`);
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // If this wasn't the last attempt, wait with exponential backoff
      if (attempt < maxRetries) {
        const delay = webhookRetryDelaysMs[attempt];
        await sleep(delay);
      }
    }

    throw lastError ?? new Error('Webhook delivery failed after retries');
  }

  function buildWebhookPayload(
    channelConfig: Record<string, string>,
    event: AlertEvent
  ): Record<string, unknown> {
    const format = channelConfig.format ?? 'slack';

    // Slack/Discord-compatible payload format
    if (format === 'discord' || format === 'slack') {
      const colorMap: Record<AlertSeverity, string> = {
        critical: '#dc3545',
        high: '#fd7e14',
        medium: '#ffc107',
        low: '#17a2b8',
      };

      return {
        text: `[${event.severity.toUpperCase()}] ${event.eventType}: ${event.affectedResource}`,
        attachments: [
          {
            color: colorMap[event.severity] ?? '#6c757d',
            title: `Alert: ${event.eventType}`,
            fields: [
              { title: 'Resource', value: event.affectedResource, short: true },
              { title: 'Severity', value: event.severity, short: true },
            ],
            text: event.message,
            ts: Math.floor(Date.now() / 1000),
          },
        ],
        // Discord embeds format (works alongside Slack format for Discord webhooks)
        embeds: [
          {
            title: `[${event.severity.toUpperCase()}] ${event.eventType}`,
            description: event.message,
            color: parseInt(colorMap[event.severity]?.replace('#', '') ?? '6c757d', 16),
            fields: [
              { name: 'Resource', value: event.affectedResource, inline: true },
              { name: 'Severity', value: event.severity, inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    // Generic JSON format
    return {
      eventType: event.eventType,
      affectedResource: event.affectedResource,
      severity: event.severity,
      message: event.message,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Metric Recording and Threshold Checking ───────────────────────────

  async function recordMetric(
    resourceType: AlertResourceType,
    resource: string,
    value: number
  ): Promise<void> {
    const rules = getEnabledRulesByResourceType.all(resourceType) as AlertRuleRow[];

    for (const rule of rules) {
      if (rule.threshold === null) continue;

      const key = `${rule.id}:${resource}`;
      const tracker = thresholdTrackers.get(key) ?? { count: 0, lastValue: 0 };

      if (value > rule.threshold) {
        tracker.count++;
        tracker.lastValue = value;
      } else {
        // Reset counter when value drops below threshold
        tracker.count = 0;
        tracker.lastValue = value;
      }

      thresholdTrackers.set(key, tracker);

      // Fire alert if consecutive threshold exceeded
      if (tracker.count >= rule.consecutive_checks) {
        await emitAlert({
          eventType: `${resourceType}_threshold_exceeded`,
          affectedResource: resource,
          severity: determineSeverity(resourceType, value, rule.threshold),
          message: `${resourceType} exceeded threshold: ${value.toFixed(1)}% (threshold: ${rule.threshold}%) for ${tracker.count} consecutive checks`,
        });

        // Reset the tracker after firing to avoid alert floods
        tracker.count = 0;
        thresholdTrackers.set(key, tracker);
      }
    }
  }

  function determineSeverity(
    resourceType: AlertResourceType,
    value: number,
    threshold: number
  ): AlertSeverity {
    const excess = value - threshold;
    if (excess >= 20 || value >= 95) return 'critical';
    if (excess >= 10 || value >= 90) return 'high';
    if (excess >= 5) return 'medium';
    return 'low';
  }

  // ─── Alert History ──────────────────────────────────────────────────────

  async function getAlertHistory(): Promise<AlertRecord[]> {
    const rows = getAlertHistoryStmt.all(maxHistorySize) as AlertRow[];

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      eventType: row.event_type,
      affectedResource: row.affected_resource,
      severity: row.severity as AlertSeverity,
      deliveryStatus: row.delivery_status ? JSON.parse(row.delivery_status) : {},
      message: row.message ?? '',
      acknowledgedAt: row.acknowledged_at ?? undefined,
      acknowledgedBy: row.acknowledged_by ?? undefined,
      resolvedAt: row.resolved_at ?? undefined,
      resolutionStatus: (row.resolution_status as AlertRecord['resolutionStatus']) ?? 'active',
    }));
  }

  function pruneHistory(): void {
    const countRow = getAlertCount.get() as { count: number };
    if (countRow.count > maxHistorySize) {
      pruneOldAlerts.run(maxHistorySize);
    }
  }

  // ─── Channel & Rule Accessors ──────────────────────────────────────────

  function getChannels(): AlertChannel[] {
    const rows = getAllChannelsIncludingDisabled.all() as AlertChannelRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type as AlertChannelType,
      config: JSON.parse(row.config),
      enabled: row.enabled === 1,
    }));
  }

  function getRules(): AlertRule[] {
    const rows = getAllRules.all() as AlertRuleRow[];
    return rows.map((row) => ({
      id: row.id,
      resourceType: row.resource_type as AlertResourceType,
      threshold: row.threshold ?? undefined,
      consecutiveChecks: row.consecutive_checks,
      enabled: row.enabled === 1,
    }));
  }

  function removeChannel(id: string): void {
    deleteChannel.run(id);
  }

  function removeRule(id: string): void {
    deleteRule.run(id);
    // Clean up any threshold trackers associated with this rule
    for (const key of thresholdTrackers.keys()) {
      if (key.startsWith(`${id}:`)) {
        thresholdTrackers.delete(key);
      }
    }
  }

  // ─── Configurable Threshold Evaluation ──────────────────────────────────

  /**
   * Default threshold values matching the Settings Service defaults.
   * Used when the AlertThresholdHandle doesn't have a value set yet.
   */
  const DEFAULT_THRESHOLDS: Record<string, number> = {
    alert_cpu_warning: 80,
    alert_cpu_critical: 95,
    alert_memory_warning: 80,
    alert_memory_critical: 95,
    alert_disk_warning: 90,
    alert_disk_critical: 95,
    alert_consecutive_checks: 3,
  };

  /**
   * Get a threshold value from the handle, falling back to defaults.
   */
  function getThresholdValue(key: string): number {
    if (thresholdHandle) {
      const value = thresholdHandle.getThreshold(key);
      if (value !== undefined) return value;
    }
    return DEFAULT_THRESHOLDS[key] ?? 0;
  }

  /**
   * Evaluate a metric value against configurable warning/critical thresholds.
   * Tracks consecutive breaches and auto-resolves when conditions return to normal.
   *
   * @validates Requirements 9.1, 9.2, 9.3, 9.4, 11.5
   */
  async function evaluateThreshold(
    metricType: ThresholdMetricType,
    resource: string,
    value: number
  ): Promise<ThresholdEvaluationResult> {
    const warningThreshold = getThresholdValue(`alert_${metricType}_warning`);
    const criticalThreshold = getThresholdValue(`alert_${metricType}_critical`);
    const consecutiveChecksRequired = getThresholdValue('alert_consecutive_checks');

    const key = `${metricType}:${resource}`;
    const tracker = configurableTrackers.get(key) ?? {
      warningCount: 0,
      criticalCount: 0,
      lastValue: 0,
    };

    const result: ThresholdEvaluationResult = {
      alertEmitted: false,
      resolved: false,
      consecutiveBreaches: 0,
    };

    // Check if value exceeds critical threshold
    if (value > criticalThreshold) {
      tracker.criticalCount++;
      tracker.warningCount++; // Critical is also above warning
      tracker.lastValue = value;
      configurableTrackers.set(key, tracker);

      result.consecutiveBreaches = tracker.criticalCount;

      // Fire critical alert if consecutive breaches met
      if (tracker.criticalCount >= consecutiveChecksRequired) {
        const alertId = await emitAlert({
          eventType: `${metricType}_threshold_critical`,
          affectedResource: resource,
          severity: 'critical',
          message: `${metricType.toUpperCase()} usage critical: ${value.toFixed(1)}% exceeds critical threshold ${criticalThreshold}% for ${tracker.criticalCount} consecutive checks`,
        });

        // Track as active alert for auto-resolution
        activeThresholdAlerts.set(key, {
          alertId,
          metricType,
          severity: 'critical',
          resource,
        });

        result.alertEmitted = true;
        result.severity = 'critical';
        result.alertId = alertId;

        // Reset counters after firing to avoid alert floods
        tracker.criticalCount = 0;
        tracker.warningCount = 0;
        configurableTrackers.set(key, tracker);
      }

      return result;
    }

    // Check if value exceeds warning threshold (but not critical)
    if (value > warningThreshold) {
      tracker.warningCount++;
      tracker.criticalCount = 0; // Reset critical counter since we're below critical
      tracker.lastValue = value;
      configurableTrackers.set(key, tracker);

      result.consecutiveBreaches = tracker.warningCount;

      // Fire warning alert if consecutive breaches met
      if (tracker.warningCount >= consecutiveChecksRequired) {
        const alertId = await emitAlert({
          eventType: `${metricType}_threshold_warning`,
          affectedResource: resource,
          severity: 'medium',
          message: `${metricType.toUpperCase()} usage warning: ${value.toFixed(1)}% exceeds warning threshold ${warningThreshold}% for ${tracker.warningCount} consecutive checks`,
        });

        // Track as active alert for auto-resolution
        activeThresholdAlerts.set(key, {
          alertId,
          metricType,
          severity: 'warning',
          resource,
        });

        result.alertEmitted = true;
        result.severity = 'warning';
        result.alertId = alertId;

        // Reset counter after firing to avoid alert floods
        tracker.warningCount = 0;
        configurableTrackers.set(key, tracker);
      }

      return result;
    }

    // Value is below warning threshold — reset counters and auto-resolve
    tracker.warningCount = 0;
    tracker.criticalCount = 0;
    tracker.lastValue = value;
    configurableTrackers.set(key, tracker);

    result.consecutiveBreaches = 0;

    // Auto-resolve any active alert for this metric+resource
    const activeAlert = activeThresholdAlerts.get(key);
    if (activeAlert) {
      // Mark the alert as resolved in the database
      try {
        db.prepare(
          `UPDATE alerts SET resolved_at = ?, resolution_status = 'resolved' WHERE id = ?`
        ).run(new Date().toISOString(), activeAlert.alertId);
      } catch {
        // Ignore errors from resolution update (e.g., alert already resolved)
      }

      activeThresholdAlerts.delete(key);
      result.resolved = true;
    }

    return result;
  }

  /**
   * Get the current consecutive breach count for a metric/resource pair.
   * Returns the higher of warning or critical counts.
   */
  function getBreachCount(metricType: ThresholdMetricType, resource: string): number {
    const key = `${metricType}:${resource}`;
    const tracker = configurableTrackers.get(key);
    if (!tracker) return 0;
    return Math.max(tracker.warningCount, tracker.criticalCount);
  }

  /**
   * Get all active threshold alerts that have not been resolved.
   */
  function getActiveThresholdAlerts(): ActiveThresholdAlert[] {
    return Array.from(activeThresholdAlerts.values());
  }

  // ─── Utility ────────────────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Container Health Transition ────────────────────────────────────────

  /**
   * Record a container health status transition.
   * Only healthy↔unhealthy transitions generate alerts.
   * Transitions to/from 'starting' or 'none' are ignored.
   *
   * @validates Requirements 10.1, 10.2, 10.3
   */
  async function recordHealthTransition(
    containerId: string,
    containerName: string,
    from: HealthStatus,
    to: HealthStatus
  ): Promise<void> {
    // Only healthy↔unhealthy transitions generate alerts
    if (from === to) return;

    // Detect healthy→unhealthy: emit high-severity alert
    if (from === 'healthy' && to === 'unhealthy') {
      await emitAlert({
        eventType: 'container_health_unhealthy',
        affectedResource: containerId,
        severity: 'high',
        message: `Container "${containerName}" transitioned from healthy to unhealthy`,
      });
      return;
    }

    // Detect unhealthy→healthy: emit low-severity resolution alert
    if (from === 'unhealthy' && to === 'healthy') {
      await emitAlert({
        eventType: 'container_health_recovered',
        affectedResource: containerId,
        severity: 'low',
        message: `Container "${containerName}" recovered: transitioned from unhealthy to healthy`,
      });
      return;
    }

    // All other transitions (involving 'starting' or 'none') are ignored
  }

  // ─── Alert Acknowledgment, Silencing, and History ───────────────────────

  /**
   * Acknowledge an alert by ID.
   * Updates the alert record with admin ID and timestamp.
   * @validates Requirements 11.3
   */
  async function acknowledgeAlert(alertId: string, adminId: string): Promise<void> {
    const now = new Date().toISOString();
    const result = db.prepare(
      `UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ?, resolution_status = 'acknowledged' WHERE id = ?`
    ).run(now, adminId, alertId);

    if (result.changes === 0) {
      throw new Error(`Alert not found: ${alertId}`);
    }
  }

  /**
   * Silence a rule for a specified duration.
   * Inserts a silence record that suppresses notifications within the window.
   * @validates Requirements 11.4
   */
  async function silenceRule(ruleId: string, durationMs: number, adminId: string): Promise<string> {
    const id = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMs).toISOString();
    const createdAt = now.toISOString();

    db.prepare(
      `INSERT INTO alert_silences (id, rule_id, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, ruleId, adminId, expiresAt, createdAt);

    return id;
  }

  /**
   * Remove a silence by ID.
   */
  async function removeSilence(silenceId: string): Promise<void> {
    const result = db.prepare(`DELETE FROM alert_silences WHERE id = ?`).run(silenceId);
    if (result.changes === 0) {
      throw new Error(`Silence not found: ${silenceId}`);
    }
  }

  /**
   * Get all currently active (non-expired) silences.
   */
  async function getActiveSilences(): Promise<SilenceRecord[]> {
    const now = new Date().toISOString();
    const rows = db.prepare(
      `SELECT id, rule_id, admin_id, expires_at, created_at FROM alert_silences WHERE expires_at > ?`
    ).all(now) as Array<{ id: string; rule_id: string; admin_id: string; expires_at: string; created_at: string }>;

    return rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      adminId: row.admin_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * Mark an alert as resolved (auto-resolution).
   * @validates Requirements 11.5
   */
  async function resolveAlert(alertId: string): Promise<void> {
    const now = new Date().toISOString();
    const result = db.prepare(
      `UPDATE alerts SET resolved_at = ?, resolution_status = 'resolved' WHERE id = ?`
    ).run(now, alertId);

    if (result.changes === 0) {
      throw new Error(`Alert not found: ${alertId}`);
    }
  }

  /**
   * Get paginated alert history.
   * Returns records with all required fields ordered by most recent first.
   * @validates Requirements 11.2
   */
  async function getAlertHistoryPaginated(page: number, pageSize: number): Promise<PaginatedAlerts> {
    const offset = (page - 1) * pageSize;

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM alerts`).get() as { total: number };
    const total = countRow.total;

    const rows = db.prepare(
      `SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(pageSize, offset) as AlertRow[];

    const items: AlertRecord[] = rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      eventType: row.event_type,
      affectedResource: row.affected_resource,
      severity: row.severity as AlertSeverity,
      deliveryStatus: row.delivery_status ? JSON.parse(row.delivery_status) : {},
      message: row.message ?? '',
      acknowledgedAt: row.acknowledged_at ?? undefined,
      acknowledgedBy: row.acknowledged_by ?? undefined,
      resolvedAt: row.resolved_at ?? undefined,
      resolutionStatus: (row.resolution_status as AlertRecord['resolutionStatus']) ?? 'active',
    }));

    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  /**
   * Check if any active silence exists for the given rule IDs.
   * Used by emitAlert to suppress notifications for silenced rules.
   */
  function isRuleSilenced(ruleIds: string[]): boolean {
    if (ruleIds.length === 0) return false;
    const now = new Date().toISOString();
    const placeholders = ruleIds.map(() => '?').join(',');
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM alert_silences WHERE rule_id IN (${placeholders}) AND expires_at > ?`
    ).get(...ruleIds, now) as { cnt: number };
    return row.cnt > 0;
  }

  /**
   * Check if there's any active silence matching an event type pattern.
   * Maps alert event types to potential rule resource types for silence checks.
   */
  function isEventSilenced(event: AlertEvent): boolean {
    const now = new Date().toISOString();
    // Get all rules that could match this alert's resource type
    const resourceType = extractResourceTypeFromEvent(event.eventType);
    if (!resourceType) return false;

    const rules = getEnabledRulesByResourceType.all(resourceType) as AlertRuleRow[];
    const ruleIds = rules.map(r => r.id);
    return isRuleSilenced(ruleIds);
  }

  /**
   * Extract the resource type from an event type string.
   */
  function extractResourceTypeFromEvent(eventType: string): AlertResourceType | null {
    if (eventType.startsWith('cpu')) return 'cpu';
    if (eventType.startsWith('memory')) return 'memory';
    if (eventType.startsWith('disk')) return 'disk';
    if (eventType.startsWith('container_health')) return 'container-health';
    return null;
  }

  // ─── Return Public API ──────────────────────────────────────────────────

  return {
    configureChannel,
    configureRule,
    emitAlert,
    getAlertHistory,
    recordMetric,
    getChannels,
    getRules,
    removeChannel,
    removeRule,
    evaluateThreshold,
    getBreachCount,
    getActiveThresholdAlerts,
    recordHealthTransition,
    acknowledgeAlert,
    silenceRule,
    removeSilence,
    getActiveSilences,
    resolveAlert,
    getAlertHistoryPaginated,
  };
}
