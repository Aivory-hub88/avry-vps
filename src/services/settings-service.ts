/**
 * Settings Service
 *
 * PostgreSQL-backed settings system with hot-reload via EventEmitter.
 * Manages persistent runtime-configurable settings stored in the
 * `vps_panel.settings` table. Supports typed access, validation against
 * declared data_types, and emits change events for hot-reload by
 * subscribing services.
 *
 * @module services/settings-service
 * @validates Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.5
 */
import { EventEmitter } from 'events';
import type { PgClient } from '../database/pg-client.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SettingCategory = 'General' | 'Monitoring' | 'Alerts' | 'Backups' | 'Security' | 'Network';
export type SettingDataType = 'string' | 'number' | 'boolean' | 'json' | 'email' | 'url' | 'cron';

export interface SettingDefinition {
  key: string;
  category: SettingCategory;
  dataType: SettingDataType;
  defaultValue: string;
  description: string;
  validation?: ValidationRule;
}

export interface ValidationRule {
  min?: number;
  max?: number;
  pattern?: string;
  options?: string[];
}

export interface SettingRecord {
  key: string;
  value: string;
  category: SettingCategory;
  dataType: SettingDataType;
  updatedAt: string;
  description: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface SettingsService extends EventEmitter {
  /** Get all settings grouped by category */
  getAll(): Promise<Record<SettingCategory, SettingRecord[]>>;
  /** Get a single setting value (returns default if not explicitly set) */
  get(key: string): Promise<string>;
  /** Get a setting as a typed value */
  getTyped<T>(key: string): Promise<T>;
  /** Update one or more settings (validates before persisting) */
  update(updates: Record<string, string>): Promise<void>;
  /** Validate a value against a setting's data_type and rules */
  validate(key: string, value: string): ValidationResult;
  /** Get all setting definitions */
  getDefinitions(): SettingDefinition[];
}

// ─── Default Settings Registry ───────────────────────────────────────────────

export const DEFAULT_SETTINGS: SettingDefinition[] = [
  // Monitoring
  {
    key: 'collection_interval_ms',
    category: 'Monitoring',
    dataType: 'number',
    defaultValue: '30000',
    description: 'Metrics collection interval in ms',
    validation: { min: 1000, max: 300000 },
  },
  {
    key: 'retention_raw_hours',
    category: 'Monitoring',
    dataType: 'number',
    defaultValue: '24',
    description: 'Hours to retain raw 30s data',
    validation: { min: 1, max: 168 },
  },
  {
    key: 'retention_5m_days',
    category: 'Monitoring',
    dataType: 'number',
    defaultValue: '30',
    description: 'Days to retain 5-minute data',
    validation: { min: 1, max: 365 },
  },
  {
    key: 'retention_1h_days',
    category: 'Monitoring',
    dataType: 'number',
    defaultValue: '365',
    description: 'Days to retain 1-hour data',
    validation: { min: 1, max: 3650 },
  },

  // Alerts
  {
    key: 'alert_cpu_warning',
    category: 'Alerts',
    dataType: 'number',
    defaultValue: '80',
    description: 'CPU warning threshold %',
    validation: { min: 1, max: 100 },
  },
  {
    key: 'alert_cpu_critical',
    category: 'Alerts',
    dataType: 'number',
    defaultValue: '95',
    description: 'CPU critical threshold %',
    validation: { min: 1, max: 100 },
  },
  {
    key: 'alert_memory_warning',
    category: 'Alerts',
    dataType: 'number',
    defaultValue: '80',
    description: 'Memory warning threshold %',
    validation: { min: 1, max: 100 },
  },
  {
    key: 'alert_memory_critical',
    category: 'Alerts',
    dataType: 'number',
    defaultValue: '95',
    description: 'Memory critical threshold %',
    validation: { min: 1, max: 100 },
  },
  {
    key: 'alert_disk_warning',
    category: 'Alerts',
    dataType: 'number',
    defaultValue: '90',
    description: 'Disk warning threshold %',
    validation: { min: 1, max: 100 },
  },
  {
    key: 'alert_disk_critical',
    category: 'Alerts',
    dataType: 'number',
    defaultValue: '95',
    description: 'Disk critical threshold %',
    validation: { min: 1, max: 100 },
  },
  {
    key: 'alert_consecutive_checks',
    category: 'Alerts',
    dataType: 'number',
    defaultValue: '3',
    description: 'Consecutive breaches before alert',
    validation: { min: 1, max: 20 },
  },
  {
    key: 'webhook_url',
    category: 'Alerts',
    dataType: 'url',
    defaultValue: '',
    description: 'Webhook URL for alert delivery',
  },
  {
    key: 'smtp_host',
    category: 'Alerts',
    dataType: 'string',
    defaultValue: '',
    description: 'SMTP server host',
  },
  {
    key: 'smtp_port',
    category: 'Alerts',
    dataType: 'number',
    defaultValue: '587',
    description: 'SMTP server port',
    validation: { min: 1, max: 65535 },
  },
  {
    key: 'smtp_username',
    category: 'Alerts',
    dataType: 'string',
    defaultValue: '',
    description: 'SMTP username',
  },
  {
    key: 'smtp_password',
    category: 'Alerts',
    dataType: 'string',
    defaultValue: '',
    description: 'SMTP password',
  },
  {
    key: 'smtp_from_address',
    category: 'Alerts',
    dataType: 'email',
    defaultValue: '',
    description: 'SMTP from address',
  },

  // Backups
  {
    key: 'backup_local_path',
    category: 'Backups',
    dataType: 'string',
    defaultValue: '/data/backups',
    description: 'Local backup storage path',
  },
  {
    key: 'backup_s3_enabled',
    category: 'Backups',
    dataType: 'boolean',
    defaultValue: 'false',
    description: 'Enable S3 upload',
  },
  {
    key: 'backup_s3_endpoint',
    category: 'Backups',
    dataType: 'url',
    defaultValue: '',
    description: 'S3-compatible endpoint',
  },
  {
    key: 'backup_s3_bucket',
    category: 'Backups',
    dataType: 'string',
    defaultValue: '',
    description: 'S3 bucket name',
  },
  {
    key: 'backup_s3_access_key',
    category: 'Backups',
    dataType: 'string',
    defaultValue: '',
    description: 'S3 access key',
  },
  {
    key: 'backup_s3_secret_key',
    category: 'Backups',
    dataType: 'string',
    defaultValue: '',
    description: 'S3 secret key',
  },
  {
    key: 'backup_s3_region',
    category: 'Backups',
    dataType: 'string',
    defaultValue: 'us-east-1',
    description: 'S3 region',
  },
  {
    key: 'backup_s3_prefix',
    category: 'Backups',
    dataType: 'string',
    defaultValue: 'vps-panel',
    description: 'S3 key prefix',
  },
  {
    key: 'snapshot_schedule_cron',
    category: 'Backups',
    dataType: 'cron',
    defaultValue: '0 2 * * *',
    description: 'Snapshot schedule cron expression',
  },
  {
    key: 'snapshot_targets',
    category: 'Backups',
    dataType: 'json',
    defaultValue: '[]',
    description: 'Target container names for scheduled snapshots',
  },
  {
    key: 'snapshot_retention_count',
    category: 'Backups',
    dataType: 'number',
    defaultValue: '7',
    description: 'Number of snapshots to retain per container',
    validation: { min: 1, max: 100 },
  },
  {
    key: 'snapshot_schedule_enabled',
    category: 'Backups',
    dataType: 'boolean',
    defaultValue: 'false',
    description: 'Enable scheduled snapshots',
  },
];

// ─── Validation Functions ────────────────────────────────────────────────────

/**
 * Validate a value against a data type.
 * Returns a ValidationResult indicating validity and optional error message.
 */
export function validateValue(
  value: string,
  dataType: SettingDataType,
  validation?: ValidationRule
): ValidationResult {
  // Allow empty strings for optional settings (url, email, string)
  if (value === '' && (dataType === 'url' || dataType === 'email' || dataType === 'string')) {
    return { valid: true };
  }

  switch (dataType) {
    case 'string':
      return validateString(value, validation);
    case 'number':
      return validateNumber(value, validation);
    case 'boolean':
      return validateBoolean(value);
    case 'json':
      return validateJson(value);
    case 'email':
      return validateEmail(value);
    case 'url':
      return validateUrl(value);
    case 'cron':
      return validateCron(value);
    default:
      return { valid: false, error: `Unknown data type: ${dataType}` };
  }
}

function validateString(value: string, validation?: ValidationRule): ValidationResult {
  if (validation?.pattern) {
    const regex = new RegExp(validation.pattern);
    if (!regex.test(value)) {
      return { valid: false, error: `Value does not match pattern: ${validation.pattern}` };
    }
  }
  if (validation?.options && !validation.options.includes(value)) {
    return { valid: false, error: `Value must be one of: ${validation.options.join(', ')}` };
  }
  return { valid: true };
}

function validateNumber(value: string, validation?: ValidationRule): ValidationResult {
  const num = Number(value);
  if (!isFinite(num) || value.trim() === '') {
    return { valid: false, error: 'Value must be a valid finite number' };
  }
  if (validation?.min !== undefined && num < validation.min) {
    return { valid: false, error: `Value must be at least ${validation.min}` };
  }
  if (validation?.max !== undefined && num > validation.max) {
    return { valid: false, error: `Value must be at most ${validation.max}` };
  }
  return { valid: true };
}

function validateBoolean(value: string): ValidationResult {
  if (value !== 'true' && value !== 'false') {
    return { valid: false, error: 'Value must be "true" or "false"' };
  }
  return { valid: true };
}

function validateJson(value: string): ValidationResult {
  try {
    JSON.parse(value);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Value must be valid JSON' };
  }
}

function validateEmail(value: string): ValidationResult {
  // Basic email pattern: requires @ and domain with at least one dot
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(value)) {
    return { valid: false, error: 'Value must be a valid email address' };
  }
  return { valid: true };
}

function validateUrl(value: string): ValidationResult {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'URL must use http or https protocol' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Value must be a valid URL' };
  }
}

function validateCron(value: string): ValidationResult {
  // Validate a 5-field cron expression (minute hour dom month dow)
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: 'Cron expression must have exactly 5 fields (minute hour dom month dow)' };
  }

  const ranges = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12 },
    { name: 'day of week', min: 0, max: 7 },
  ];

  for (let i = 0; i < 5; i++) {
    if (!isValidCronField(parts[i], ranges[i].min, ranges[i].max)) {
      return { valid: false, error: `Invalid cron field "${parts[i]}" for ${ranges[i].name}` };
    }
  }

  return { valid: true };
}

/**
 * Validate a single cron field. Supports: wildcards, numbers, ranges (1-5),
 * step values (star/5), comma-separated lists (1,2,3), and combined (1-5/2).
 */
function isValidCronField(field: string, min: number, max: number): boolean {
  // Handle comma-separated list
  const parts = field.split(',');
  for (const part of parts) {
    if (!isValidCronPart(part, min, max)) {
      return false;
    }
  }
  return true;
}

function isValidCronPart(part: string, min: number, max: number): boolean {
  // Wildcard
  if (part === '*') return true;

  // Step value on wildcard: */N
  if (part.startsWith('*/')) {
    const step = Number(part.slice(2));
    return isFinite(step) && step >= 1 && step <= max;
  }

  // Range with optional step: N-M or N-M/S
  if (part.includes('-')) {
    const [rangePart, stepPart] = part.split('/');
    const [startStr, endStr] = rangePart.split('-');
    const start = Number(startStr);
    const end = Number(endStr);
    if (!isFinite(start) || !isFinite(end) || start < min || end > max || start > end) {
      return false;
    }
    if (stepPart !== undefined) {
      const step = Number(stepPart);
      if (!isFinite(step) || step < 1) return false;
    }
    return true;
  }

  // Single number with optional step: N/S
  if (part.includes('/')) {
    const [numStr, stepStr] = part.split('/');
    const num = Number(numStr);
    const step = Number(stepStr);
    return isFinite(num) && num >= min && num <= max && isFinite(step) && step >= 1;
  }

  // Plain number
  const num = Number(part);
  return isFinite(num) && num >= min && num <= max;
}

// ─── Settings Service Error ──────────────────────────────────────────────────

export class SettingsServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'SettingsServiceError';
  }
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Database row shape from vps_panel.settings
 */
interface SettingsRow {
  key: string;
  value: string;
  category: string;
  data_type: string;
  description: string | null;
  updated_at: string | Date;
}

/**
 * Create a new SettingsService instance backed by PostgreSQL.
 *
 * @param pgClient - Connected PgClient instance for database operations
 */
export function createSettingsService(pgClient: PgClient): SettingsService {
  const emitter = new EventEmitter();

  // Build a lookup map from definitions for fast access
  const definitionsMap = new Map<string, SettingDefinition>();
  for (const def of DEFAULT_SETTINGS) {
    definitionsMap.set(def.key, def);
  }

  /**
   * Get all settings grouped by category.
   * Merges persisted values with defaults for any settings not yet stored.
   */
  async function getAll(): Promise<Record<SettingCategory, SettingRecord[]>> {
    const rows = await pgClient.query<SettingsRow>(
      `SELECT key, value, category, data_type, description, updated_at
       FROM vps_panel.settings
       ORDER BY category, key`
    );

    // Build a map of stored settings
    const storedMap = new Map<string, SettingsRow>();
    for (const row of rows) {
      storedMap.set(row.key, row);
    }

    // Initialize all categories
    const result: Record<SettingCategory, SettingRecord[]> = {
      General: [],
      Monitoring: [],
      Alerts: [],
      Backups: [],
      Security: [],
      Network: [],
    };

    // Merge stored values with defaults
    for (const def of DEFAULT_SETTINGS) {
      const stored = storedMap.get(def.key);
      const record: SettingRecord = {
        key: def.key,
        value: stored?.value ?? def.defaultValue,
        category: def.category,
        dataType: def.dataType,
        updatedAt: stored?.updated_at
          ? (stored.updated_at instanceof Date
              ? stored.updated_at.toISOString()
              : new Date(stored.updated_at).toISOString())
          : new Date().toISOString(),
        description: def.description,
      };
      result[def.category].push(record);
    }

    // Include any stored settings not in the default registry
    for (const row of rows) {
      if (!definitionsMap.has(row.key)) {
        const category = row.category as SettingCategory;
        if (result[category]) {
          result[category].push({
            key: row.key,
            value: row.value,
            category,
            dataType: row.data_type as SettingDataType,
            updatedAt: row.updated_at instanceof Date
              ? row.updated_at.toISOString()
              : new Date(row.updated_at).toISOString(),
            description: row.description ?? '',
          });
        }
      }
    }

    return result;
  }

  /**
   * Get a single setting value by key.
   * Returns the persisted value if it exists, otherwise the default value.
   * Throws if the key is unknown.
   */
  async function get(key: string): Promise<string> {
    const def = definitionsMap.get(key);
    if (!def) {
      throw new SettingsServiceError(
        `Setting not found: ${key}`,
        'SETTING_NOT_FOUND',
        404
      );
    }

    const rows = await pgClient.query<{ value: string }>(
      `SELECT value FROM vps_panel.settings WHERE key = $1`,
      [key]
    );

    return rows[0]?.value ?? def.defaultValue;
  }

  /**
   * Get a setting as a typed value.
   * Parses the stored string value according to the declared data_type.
   */
  async function getTyped<T>(key: string): Promise<T> {
    const def = definitionsMap.get(key);
    if (!def) {
      throw new SettingsServiceError(
        `Setting not found: ${key}`,
        'SETTING_NOT_FOUND',
        404
      );
    }

    const stringValue = await get(key);
    return parseTypedValue<T>(stringValue, def.dataType);
  }

  /**
   * Update one or more settings.
   * Validates all values before persisting. If any validation fails, no changes are made.
   * Emits change events after successful persistence.
   */
  async function update(updates: Record<string, string>): Promise<void> {
    const keys = Object.keys(updates);
    if (keys.length === 0) return;

    // Validate all updates first
    for (const key of keys) {
      const def = definitionsMap.get(key);
      if (!def) {
        throw new SettingsServiceError(
          `Setting not found: ${key}`,
          'SETTING_NOT_FOUND',
          404
        );
      }

      const result = validate(key, updates[key]);
      if (!result.valid) {
        throw new SettingsServiceError(
          `Validation failed for "${key}": ${result.error}`,
          'VALIDATION_FAILED',
          400
        );
      }
    }

    // Fetch current values for change detection
    const currentValues = new Map<string, string>();
    for (const key of keys) {
      const def = definitionsMap.get(key)!;
      const rows = await pgClient.query<{ value: string }>(
        `SELECT value FROM vps_panel.settings WHERE key = $1`,
        [key]
      );
      currentValues.set(key, rows[0]?.value ?? def.defaultValue);
    }

    // Persist all updates using INSERT ON CONFLICT UPDATE (upsert)
    for (const key of keys) {
      const def = definitionsMap.get(key)!;
      await pgClient.query(
        `INSERT INTO vps_panel.settings (key, value, category, data_type, description, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (key)
         DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, updates[key], def.category, def.dataType, def.description]
      );
    }

    // Emit change events
    const changes: Array<{ key: string; oldValue: string; newValue: string }> = [];
    for (const key of keys) {
      const oldValue = currentValues.get(key)!;
      const newValue = updates[key];
      if (oldValue !== newValue) {
        const def = definitionsMap.get(key)!;
        changes.push({ key, oldValue, newValue });
        emitter.emit('setting:changed', {
          key,
          oldValue,
          newValue,
          category: def.category,
        });
      }
    }

    if (changes.length > 0) {
      emitter.emit('settings:batch-changed', { changes });
    }
  }

  /**
   * Validate a value against a setting's declared data_type and rules.
   */
  function validate(key: string, value: string): ValidationResult {
    const def = definitionsMap.get(key);
    if (!def) {
      return { valid: false, error: `Unknown setting: ${key}` };
    }
    return validateValue(value, def.dataType, def.validation);
  }

  /**
   * Get all registered setting definitions.
   */
  function getDefinitions(): SettingDefinition[] {
    return [...DEFAULT_SETTINGS];
  }

  // ─── Build the service object combining EventEmitter with our methods ──────

  const service = Object.assign(emitter, {
    getAll,
    get,
    getTyped,
    update,
    validate,
    getDefinitions,
  }) as SettingsService;

  return service;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a string value into the appropriate typed representation.
 */
function parseTypedValue<T>(value: string, dataType: SettingDataType): T {
  switch (dataType) {
    case 'number':
      return Number(value) as unknown as T;
    case 'boolean':
      return (value === 'true') as unknown as T;
    case 'json':
      return JSON.parse(value) as T;
    case 'string':
    case 'email':
    case 'url':
    case 'cron':
      return value as unknown as T;
    default:
      return value as unknown as T;
  }
}
