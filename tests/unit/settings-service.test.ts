/**
 * Unit tests for the Settings Service.
 * Tests getAll, get, getTyped, update, validate, getDefinitions,
 * and event emission (setting:changed, settings:batch-changed).
 *
 * @validates Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.5
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSettingsService,
  validateValue,
  DEFAULT_SETTINGS,
  SettingsServiceError,
  type SettingsService,
  type SettingCategory,
  type ValidationResult,
} from '../../src/services/settings-service.js';
import type { PgClient } from '../../src/database/pg-client.js';

// ─── Mock PgClient ─────────────────────────────────────────────────────────────

function createMockPgClient(queryResults?: Map<string, any[]>): PgClient & {
  queryCalls: Array<{ sql: string; params?: unknown[] }>;
  mockQueryResults: Map<string, any[]>;
} {
  const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
  const mockQueryResults = queryResults ?? new Map<string, any[]>();

  return {
    queryCalls,
    mockQueryResults,
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      queryCalls.push({ sql, params });
      // Return matching result based on SQL content
      for (const [pattern, result] of mockQueryResults.entries()) {
        if (sql.includes(pattern)) {
          return result;
        }
      }
      return [];
    }),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(true),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Settings Service', () => {
  let pgClient: ReturnType<typeof createMockPgClient>;
  let service: SettingsService;

  beforeEach(() => {
    pgClient = createMockPgClient();
    service = createSettingsService(pgClient);
  });

  // ─── getDefinitions() ──────────────────────────────────────────────────────

  describe('getDefinitions()', () => {
    it('should return all default setting definitions', () => {
      const defs = service.getDefinitions();
      expect(defs).toHaveLength(DEFAULT_SETTINGS.length);
      expect(defs).toEqual(DEFAULT_SETTINGS);
    });

    it('should include settings for all expected categories', () => {
      const defs = service.getDefinitions();
      const categories = new Set(defs.map((d) => d.category));
      expect(categories.has('Monitoring')).toBe(true);
      expect(categories.has('Alerts')).toBe(true);
      expect(categories.has('Backups')).toBe(true);
    });

    it('should have non-null, non-undefined default values for all settings', () => {
      const defs = service.getDefinitions();
      for (const def of defs) {
        expect(def.defaultValue).toBeDefined();
        expect(def.defaultValue).not.toBeNull();
        expect(typeof def.defaultValue).toBe('string');
      }
    });
  });

  // ─── getAll() ──────────────────────────────────────────────────────────────

  describe('getAll()', () => {
    it('should return settings grouped by category with defaults when DB is empty', async () => {
      const result = await service.getAll();

      // Should have all categories
      expect(result).toHaveProperty('General');
      expect(result).toHaveProperty('Monitoring');
      expect(result).toHaveProperty('Alerts');
      expect(result).toHaveProperty('Backups');
      expect(result).toHaveProperty('Security');
      expect(result).toHaveProperty('Network');
    });

    it('should use default values when no persisted values exist', async () => {
      const result = await service.getAll();
      const monitoringSettings = result.Monitoring;

      const collectionInterval = monitoringSettings.find(
        (s) => s.key === 'collection_interval_ms'
      );
      expect(collectionInterval).toBeDefined();
      expect(collectionInterval!.value).toBe('30000');
    });

    it('should use persisted values when they exist in the database', async () => {
      const queryResults = new Map<string, any[]>();
      queryResults.set('SELECT key, value, category', [
        {
          key: 'collection_interval_ms',
          value: '60000',
          category: 'Monitoring',
          data_type: 'number',
          description: 'Metrics collection interval in ms',
          updated_at: '2024-01-15T10:00:00Z',
        },
      ]);
      pgClient = createMockPgClient(queryResults);
      service = createSettingsService(pgClient);

      const result = await service.getAll();
      const monitoringSettings = result.Monitoring;
      const collectionInterval = monitoringSettings.find(
        (s) => s.key === 'collection_interval_ms'
      );
      expect(collectionInterval!.value).toBe('60000');
    });

    it('should query the vps_panel.settings table', async () => {
      await service.getAll();

      expect(pgClient.queryCalls).toHaveLength(1);
      expect(pgClient.queryCalls[0].sql).toContain('vps_panel.settings');
    });
  });

  // ─── get() ─────────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('should return default value when key is not persisted', async () => {
      const value = await service.get('collection_interval_ms');
      expect(value).toBe('30000');
    });

    it('should return persisted value when it exists in DB', async () => {
      const queryResults = new Map<string, any[]>();
      queryResults.set('SELECT value FROM vps_panel.settings', [{ value: '15000' }]);
      pgClient = createMockPgClient(queryResults);
      service = createSettingsService(pgClient);

      const value = await service.get('collection_interval_ms');
      expect(value).toBe('15000');
    });

    it('should throw SETTING_NOT_FOUND for unknown keys', async () => {
      await expect(service.get('nonexistent_key')).rejects.toThrow(SettingsServiceError);

      try {
        await service.get('nonexistent_key');
      } catch (err) {
        expect(err).toBeInstanceOf(SettingsServiceError);
        expect((err as SettingsServiceError).code).toBe('SETTING_NOT_FOUND');
        expect((err as SettingsServiceError).statusCode).toBe(404);
      }
    });
  });

  // ─── getTyped() ────────────────────────────────────────────────────────────

  describe('getTyped()', () => {
    it('should parse number settings as numbers', async () => {
      const value = await service.getTyped<number>('collection_interval_ms');
      expect(value).toBe(30000);
      expect(typeof value).toBe('number');
    });

    it('should parse boolean settings as booleans', async () => {
      const value = await service.getTyped<boolean>('backup_s3_enabled');
      expect(value).toBe(false);
      expect(typeof value).toBe('boolean');
    });

    it('should parse json settings as parsed objects', async () => {
      const value = await service.getTyped<string[]>('snapshot_targets');
      expect(value).toEqual([]);
      expect(Array.isArray(value)).toBe(true);
    });

    it('should return string for string-type settings', async () => {
      const value = await service.getTyped<string>('backup_s3_region');
      expect(value).toBe('us-east-1');
      expect(typeof value).toBe('string');
    });

    it('should throw SETTING_NOT_FOUND for unknown keys', async () => {
      await expect(service.getTyped<string>('unknown_key')).rejects.toThrow(
        SettingsServiceError
      );
    });
  });

  // ─── update() ──────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('should persist valid updates using INSERT ON CONFLICT', async () => {
      await service.update({ collection_interval_ms: '60000' });

      const insertCall = pgClient.queryCalls.find((c) =>
        c.sql.includes('INSERT INTO vps_panel.settings')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall!.sql).toContain('ON CONFLICT (key)');
      expect(insertCall!.sql).toContain('DO UPDATE SET');
      expect(insertCall!.params).toContain('collection_interval_ms');
      expect(insertCall!.params).toContain('60000');
    });

    it('should throw VALIDATION_FAILED for invalid values', async () => {
      await expect(
        service.update({ collection_interval_ms: 'not-a-number' })
      ).rejects.toThrow(SettingsServiceError);

      try {
        await service.update({ collection_interval_ms: 'not-a-number' });
      } catch (err) {
        expect((err as SettingsServiceError).code).toBe('VALIDATION_FAILED');
        expect((err as SettingsServiceError).statusCode).toBe(400);
      }
    });

    it('should throw SETTING_NOT_FOUND for unknown keys', async () => {
      await expect(
        service.update({ unknown_setting: 'value' })
      ).rejects.toThrow(SettingsServiceError);

      try {
        await service.update({ unknown_setting: 'value' });
      } catch (err) {
        expect((err as SettingsServiceError).code).toBe('SETTING_NOT_FOUND');
        expect((err as SettingsServiceError).statusCode).toBe(404);
      }
    });

    it('should not persist any updates if one validation fails (all-or-nothing)', async () => {
      try {
        await service.update({
          collection_interval_ms: '60000',
          alert_cpu_warning: 'invalid',
        });
      } catch {
        // Expected
      }

      // Should not have any INSERT calls (validation failed before persistence)
      const insertCalls = pgClient.queryCalls.filter((c) =>
        c.sql.includes('INSERT INTO vps_panel.settings')
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('should do nothing when updates is empty', async () => {
      await service.update({});
      // Should not make any queries at all
      expect(pgClient.queryCalls).toHaveLength(0);
    });
  });

  // ─── Event Emission ────────────────────────────────────────────────────────

  describe('Event Emission', () => {
    it('should emit setting:changed when a value actually changes', async () => {
      const handler = vi.fn();
      service.on('setting:changed', handler);

      await service.update({ collection_interval_ms: '60000' });

      expect(handler).toHaveBeenCalledWith({
        key: 'collection_interval_ms',
        oldValue: '30000', // Default value (nothing in DB)
        newValue: '60000',
        category: 'Monitoring',
      });
    });

    it('should emit settings:batch-changed with all changes', async () => {
      const handler = vi.fn();
      service.on('settings:batch-changed', handler);

      await service.update({
        collection_interval_ms: '60000',
        alert_cpu_warning: '75',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.changes).toHaveLength(2);
      expect(payload.changes).toContainEqual({
        key: 'collection_interval_ms',
        oldValue: '30000',
        newValue: '60000',
      });
      expect(payload.changes).toContainEqual({
        key: 'alert_cpu_warning',
        oldValue: '80',
        newValue: '75',
      });
    });

    it('should NOT emit events when the value does not change', async () => {
      // Mock DB to return the same default value
      const queryResults = new Map<string, any[]>();
      queryResults.set('SELECT value FROM vps_panel.settings', [{ value: '30000' }]);
      pgClient = createMockPgClient(queryResults);
      service = createSettingsService(pgClient);

      const handler = vi.fn();
      service.on('setting:changed', handler);

      await service.update({ collection_interval_ms: '30000' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─── validate() ────────────────────────────────────────────────────────────

  describe('validate()', () => {
    it('should return valid for correct number values', () => {
      const result = service.validate('collection_interval_ms', '60000');
      expect(result.valid).toBe(true);
    });

    it('should return invalid for non-numeric values on number settings', () => {
      const result = service.validate('collection_interval_ms', 'abc');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return invalid for numbers below min', () => {
      const result = service.validate('collection_interval_ms', '100');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least');
    });

    it('should return invalid for numbers above max', () => {
      const result = service.validate('collection_interval_ms', '999999');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at most');
    });

    it('should return valid for correct boolean values', () => {
      expect(service.validate('backup_s3_enabled', 'true').valid).toBe(true);
      expect(service.validate('backup_s3_enabled', 'false').valid).toBe(true);
    });

    it('should return invalid for incorrect boolean values', () => {
      const result = service.validate('backup_s3_enabled', 'yes');
      expect(result.valid).toBe(false);
    });

    it('should return valid for correct JSON values', () => {
      expect(service.validate('snapshot_targets', '["container1"]').valid).toBe(true);
      expect(service.validate('snapshot_targets', '{}').valid).toBe(true);
    });

    it('should return invalid for malformed JSON', () => {
      const result = service.validate('snapshot_targets', '{not json}');
      expect(result.valid).toBe(false);
    });

    it('should return valid for correct email values', () => {
      expect(service.validate('smtp_from_address', 'test@example.com').valid).toBe(true);
    });

    it('should return invalid for incorrect email values', () => {
      expect(service.validate('smtp_from_address', 'not-an-email').valid).toBe(false);
    });

    it('should allow empty string for optional email settings', () => {
      expect(service.validate('smtp_from_address', '').valid).toBe(true);
    });

    it('should return valid for correct URL values', () => {
      expect(service.validate('webhook_url', 'https://example.com/hook').valid).toBe(true);
    });

    it('should return invalid for incorrect URL values', () => {
      expect(service.validate('webhook_url', 'not-a-url').valid).toBe(false);
    });

    it('should allow empty string for optional URL settings', () => {
      expect(service.validate('webhook_url', '').valid).toBe(true);
    });

    it('should return valid for correct cron expressions', () => {
      expect(service.validate('snapshot_schedule_cron', '0 2 * * *').valid).toBe(true);
      expect(service.validate('snapshot_schedule_cron', '*/5 * * * *').valid).toBe(true);
      expect(service.validate('snapshot_schedule_cron', '0 0 1,15 * *').valid).toBe(true);
    });

    it('should return invalid for incorrect cron expressions', () => {
      expect(service.validate('snapshot_schedule_cron', '* * *').valid).toBe(false);
      expect(service.validate('snapshot_schedule_cron', '60 * * * *').valid).toBe(false);
    });

    it('should return invalid for unknown settings', () => {
      const result = service.validate('unknown_key', 'value');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown setting');
    });
  });
});

// ─── validateValue() function tests ──────────────────────────────────────────

describe('validateValue()', () => {
  describe('string type', () => {
    it('should accept any string without validation rules', () => {
      expect(validateValue('hello', 'string').valid).toBe(true);
    });

    it('should validate against pattern when provided', () => {
      const result = validateValue('test', 'string', { pattern: '^[0-9]+$' });
      expect(result.valid).toBe(false);

      const result2 = validateValue('123', 'string', { pattern: '^[0-9]+$' });
      expect(result2.valid).toBe(true);
    });

    it('should validate against options when provided', () => {
      const result = validateValue('invalid', 'string', { options: ['a', 'b', 'c'] });
      expect(result.valid).toBe(false);

      const result2 = validateValue('a', 'string', { options: ['a', 'b', 'c'] });
      expect(result2.valid).toBe(true);
    });
  });

  describe('number type', () => {
    it('should accept valid numbers', () => {
      expect(validateValue('42', 'number').valid).toBe(true);
      expect(validateValue('3.14', 'number').valid).toBe(true);
      expect(validateValue('-10', 'number').valid).toBe(true);
    });

    it('should reject non-numeric strings', () => {
      expect(validateValue('abc', 'number').valid).toBe(false);
      expect(validateValue('', 'number').valid).toBe(false);
      expect(validateValue('Infinity', 'number').valid).toBe(false);
      expect(validateValue('NaN', 'number').valid).toBe(false);
    });

    it('should respect min/max constraints', () => {
      expect(validateValue('5', 'number', { min: 1, max: 10 }).valid).toBe(true);
      expect(validateValue('0', 'number', { min: 1, max: 10 }).valid).toBe(false);
      expect(validateValue('11', 'number', { min: 1, max: 10 }).valid).toBe(false);
    });
  });

  describe('boolean type', () => {
    it('should accept "true" and "false"', () => {
      expect(validateValue('true', 'boolean').valid).toBe(true);
      expect(validateValue('false', 'boolean').valid).toBe(true);
    });

    it('should reject other values', () => {
      expect(validateValue('1', 'boolean').valid).toBe(false);
      expect(validateValue('yes', 'boolean').valid).toBe(false);
      expect(validateValue('True', 'boolean').valid).toBe(false);
    });
  });

  describe('json type', () => {
    it('should accept valid JSON', () => {
      expect(validateValue('{}', 'json').valid).toBe(true);
      expect(validateValue('[]', 'json').valid).toBe(true);
      expect(validateValue('{"key":"value"}', 'json').valid).toBe(true);
      expect(validateValue('"string"', 'json').valid).toBe(true);
    });

    it('should reject invalid JSON', () => {
      expect(validateValue('{invalid}', 'json').valid).toBe(false);
      expect(validateValue('not json', 'json').valid).toBe(false);
    });
  });

  describe('email type', () => {
    it('should accept valid emails', () => {
      expect(validateValue('user@example.com', 'email').valid).toBe(true);
      expect(validateValue('a@b.c', 'email').valid).toBe(true);
    });

    it('should reject invalid emails', () => {
      expect(validateValue('no-at-sign', 'email').valid).toBe(false);
      expect(validateValue('@nodomain', 'email').valid).toBe(false);
      expect(validateValue('user@', 'email').valid).toBe(false);
    });

    it('should allow empty string (optional field)', () => {
      expect(validateValue('', 'email').valid).toBe(true);
    });
  });

  describe('url type', () => {
    it('should accept valid http/https URLs', () => {
      expect(validateValue('https://example.com', 'url').valid).toBe(true);
      expect(validateValue('http://localhost:3000', 'url').valid).toBe(true);
      expect(validateValue('https://s3.us-east-1.amazonaws.com', 'url').valid).toBe(true);
    });

    it('should reject non-http URLs', () => {
      expect(validateValue('ftp://example.com', 'url').valid).toBe(false);
    });

    it('should reject invalid URLs', () => {
      expect(validateValue('not-a-url', 'url').valid).toBe(false);
    });

    it('should allow empty string (optional field)', () => {
      expect(validateValue('', 'url').valid).toBe(true);
    });
  });

  describe('cron type', () => {
    it('should accept valid 5-field cron expressions', () => {
      expect(validateValue('0 2 * * *', 'cron').valid).toBe(true);
      expect(validateValue('*/5 * * * *', 'cron').valid).toBe(true);
      expect(validateValue('0 0 1,15 * *', 'cron').valid).toBe(true);
      expect(validateValue('30 4 1-7 * 1', 'cron').valid).toBe(true);
      expect(validateValue('0 */2 * * *', 'cron').valid).toBe(true);
    });

    it('should reject invalid cron expressions', () => {
      expect(validateValue('* * *', 'cron').valid).toBe(false); // only 3 fields
      expect(validateValue('60 * * * *', 'cron').valid).toBe(false); // minute > 59
      expect(validateValue('* 25 * * *', 'cron').valid).toBe(false); // hour > 23
      expect(validateValue('* * 32 * *', 'cron').valid).toBe(false); // dom > 31
      expect(validateValue('* * * 13 *', 'cron').valid).toBe(false); // month > 12
      expect(validateValue('* * * * 8', 'cron').valid).toBe(false); // dow > 7
    });
  });
});
