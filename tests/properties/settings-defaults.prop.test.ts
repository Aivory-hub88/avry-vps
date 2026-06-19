/**
 * Property-based tests for Settings Defaults Completeness.
 *
 * Feature: vps-panel-premium-upgrade, Property 6: All settings have non-null defaults
 *
 * For any setting definition registered in the system, the `defaultValue` field
 * SHALL be a non-null, non-undefined string, and the setting category SHALL be
 * one of the valid categories (General, Monitoring, Alerts, Backups, Security, Network).
 *
 * **Validates: Requirements 6.7, 6.2**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  DEFAULT_SETTINGS,
  validateValue,
  type SettingCategory,
  type SettingDataType,
  type SettingDefinition,
} from '../../src/services/settings-service.js';

// ─── Valid Categories & Data Types ───────────────────────────────────────────

const VALID_CATEGORIES: SettingCategory[] = [
  'General',
  'Monitoring',
  'Alerts',
  'Backups',
  'Security',
  'Network',
];

const VALID_DATA_TYPES: SettingDataType[] = [
  'string',
  'number',
  'boolean',
  'json',
  'email',
  'url',
  'cron',
];

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Arbitrary that picks any registered setting definition from DEFAULT_SETTINGS.
 * This ensures property tests cover the full registry via random sampling.
 */
const settingDefinitionArb: fc.Arbitrary<SettingDefinition> = fc.constantFrom(
  ...DEFAULT_SETTINGS
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Settings Defaults Property Tests (Property 6)', () => {
  it('Property 6.1: All settings have non-null, non-undefined, string-type defaultValue', () => {
    fc.assert(
      fc.property(settingDefinitionArb, (setting) => {
        // defaultValue must exist and be a string (not null, not undefined)
        expect(setting.defaultValue).not.toBeNull();
        expect(setting.defaultValue).not.toBeUndefined();
        expect(typeof setting.defaultValue).toBe('string');
      }),
      { numRuns: 200 }
    );
  });

  it('Property 6.2: All settings have a valid category', () => {
    fc.assert(
      fc.property(settingDefinitionArb, (setting) => {
        expect(VALID_CATEGORIES).toContain(setting.category);
      }),
      { numRuns: 200 }
    );
  });

  it('Property 6.3: All settings have a valid dataType', () => {
    fc.assert(
      fc.property(settingDefinitionArb, (setting) => {
        expect(VALID_DATA_TYPES).toContain(setting.dataType);
      }),
      { numRuns: 200 }
    );
  });

  it('Property 6.4: All settings have a non-empty key', () => {
    fc.assert(
      fc.property(settingDefinitionArb, (setting) => {
        expect(setting.key).toBeDefined();
        expect(typeof setting.key).toBe('string');
        expect(setting.key.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 }
    );
  });

  it('Property 6.5: Default value passes validation against its declared data_type', () => {
    fc.assert(
      fc.property(settingDefinitionArb, (setting) => {
        const result = validateValue(
          setting.defaultValue,
          setting.dataType,
          setting.validation
        );
        expect(result.valid).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('Property 6.6: Exhaustive check — every registered setting satisfies all constraints', () => {
    // Deterministic pass over ALL settings to ensure full coverage
    for (const setting of DEFAULT_SETTINGS) {
      // Non-null, non-undefined string defaultValue
      expect(setting.defaultValue).not.toBeNull();
      expect(setting.defaultValue).not.toBeUndefined();
      expect(typeof setting.defaultValue).toBe('string');

      // Valid category
      expect(VALID_CATEGORIES).toContain(setting.category);

      // Valid dataType
      expect(VALID_DATA_TYPES).toContain(setting.dataType);

      // Non-empty key
      expect(setting.key.length).toBeGreaterThan(0);

      // Default value validates against its own data_type
      const result = validateValue(
        setting.defaultValue,
        setting.dataType,
        setting.validation
      );
      expect(result.valid).toBe(true);
    }
  });
});
