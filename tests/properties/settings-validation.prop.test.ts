/**
 * Property-based tests for setting value validation against data_type.
 *
 * Feature: VPS Panel Premium Upgrade, Property 5: Setting value validation against data_type
 * For any setting definition with a declared data_type and any candidate value,
 * the validation function SHALL accept the value if and only if it conforms to the
 * data_type constraints.
 *
 * **Validates: Requirements 6.5**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateValue } from '../../src/services/settings-service.js';
import type { SettingDataType, ValidationRule } from '../../src/services/settings-service.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

// --- Number type generators ---

/** Generate strings that are valid finite numbers */
const validNumberArb = fc.oneof(
  fc.integer().map(String),
  fc.float({ noNaN: true, noDefaultInfinity: true }).map(String),
  fc.constantFrom('0', '-1', '3.14', '100', '-99.5', '1e3', '0.001')
);

/** Generate strings that are NOT parseable as finite numbers */
const invalidNumberArb = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.constant('NaN'),
  fc.constant('Infinity'),
  fc.constant('-Infinity'),
  fc.constant('abc'),
  fc.constant('12abc'),
  fc.constant('--5'),
  fc.constant('1.2.3'),
  fc.stringOf(fc.constantFrom('a', 'b', 'c', 'x', '!', '@'), { minLength: 1, maxLength: 10 })
);

// --- Boolean type generators ---

/** Generate valid boolean strings */
const validBooleanArb = fc.constantFrom('true', 'false');

/** Generate strings that are NOT valid booleans */
const invalidBooleanArb = fc.oneof(
  fc.constant(''),
  fc.constant('True'),
  fc.constant('False'),
  fc.constant('TRUE'),
  fc.constant('FALSE'),
  fc.constant('1'),
  fc.constant('0'),
  fc.constant('yes'),
  fc.constant('no'),
  fc.string({ minLength: 1, maxLength: 15 }).filter(s => s !== 'true' && s !== 'false')
);

// --- URL type generators ---

/** Generate valid http/https URLs */
const validUrlArb = fc.oneof(
  fc.webUrl({ withFragments: false, withQueryParameters: false }),
  fc.tuple(
    fc.constantFrom('http', 'https'),
    fc.domain()
  ).map(([proto, domain]) => `${proto}://${domain}`),
  fc.tuple(
    fc.constantFrom('http', 'https'),
    fc.domain(),
    fc.webPath()
  ).map(([proto, domain, path]) => `${proto}://${domain}${path}`)
);

/** Generate strings that are NOT valid URLs (non-empty) */
const invalidUrlArb = fc.oneof(
  fc.constant('not-a-url'),
  fc.constant('ftp://example.com'),
  fc.constant('://missing-scheme'),
  fc.constant('http//missing-colon.com'),
  fc.constant('just text'),
  fc.constant('http:'),
  fc.stringOf(fc.constantFrom('a', 'b', '.', '/', ':'), { minLength: 3, maxLength: 20 })
    .filter(s => {
      try { const u = new URL(s); return !['http:', 'https:'].includes(u.protocol); } catch { return true; }
    })
);

// --- Email type generators ---

/** Generate valid email patterns */
const validEmailArb = fc.tuple(
  fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2', '.', '_', '-'), { minLength: 1, maxLength: 10 })
    .filter(s => !s.startsWith('.') && !s.endsWith('.') && s.length > 0),
  fc.domain()
).map(([local, domain]) => `${local}@${domain}`);

/** Generate strings that are NOT valid emails (non-empty) */
const invalidEmailArb = fc.oneof(
  fc.constant('notanemail'),
  fc.constant('@missing-local.com'),
  fc.constant('missing-at-sign'),
  fc.constant('user@'),
  fc.constant('user@nodot'),
  fc.constant('user @domain.com'),
  fc.constant('us er@domain.com'),
  fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2'), { minLength: 1, maxLength: 10 })
    .filter(s => !s.includes('@'))
);

// --- JSON type generators ---

/** Generate valid JSON strings */
const validJsonArb = fc.oneof(
  fc.json(),
  fc.constant('null'),
  fc.constant('true'),
  fc.constant('false'),
  fc.constant('123'),
  fc.constant('"hello"'),
  fc.constant('[]'),
  fc.constant('{}'),
  fc.array(fc.integer(), { minLength: 0, maxLength: 5 }).map(arr => JSON.stringify(arr)),
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 5 }).filter(s => !s.includes('"') && !s.includes('\\')),
    fc.oneof(fc.integer(), fc.boolean(), fc.constant(null))
  ).map(obj => JSON.stringify(obj))
);

/** Generate strings that are NOT valid JSON */
const invalidJsonArb = fc.oneof(
  fc.constant('{invalid'),
  fc.constant('[1, 2,]'),
  fc.constant("{'key': 'value'}"),
  fc.constant('undefined'),
  fc.constant('{key: value}'),
  fc.constant('[1, 2, ]'),
  fc.constant(''),
  fc.stringOf(fc.constantFrom('a', 'b', '{', '}', '['), { minLength: 2, maxLength: 15 })
    .filter(s => { try { JSON.parse(s); return false; } catch { return true; } })
);

// --- Cron type generators ---

/** Generate valid 5-field cron expressions */
const validCronArb = fc.tuple(
  fc.oneof(fc.constant('*'), fc.integer({ min: 0, max: 59 }).map(String)),
  fc.oneof(fc.constant('*'), fc.integer({ min: 0, max: 23 }).map(String)),
  fc.oneof(fc.constant('*'), fc.integer({ min: 1, max: 31 }).map(String)),
  fc.oneof(fc.constant('*'), fc.integer({ min: 1, max: 12 }).map(String)),
  fc.oneof(fc.constant('*'), fc.integer({ min: 0, max: 7 }).map(String))
).map(fields => fields.join(' '));

/** Generate strings that are NOT valid cron expressions */
const invalidCronArb = fc.oneof(
  // Wrong field count
  fc.constant('* * *'),
  fc.constant('* * * *'),
  fc.constant('* * * * * *'),
  fc.constant(''),
  fc.constant('0 0'),
  // Out-of-range values
  fc.constant('60 * * * *'),
  fc.constant('* 25 * * *'),
  fc.constant('* * 0 * *'),
  fc.constant('* * 32 * *'),
  fc.constant('* * * 0 *'),
  fc.constant('* * * 13 *'),
  fc.constant('* * * * 8'),
  // Non-numeric garbage
  fc.constant('a b c d e'),
  fc.constant('foo bar baz qux quux'),
  fc.stringOf(fc.constantFrom('a', 'b', 'c', ' ', '!'), { minLength: 3, maxLength: 20 })
    .filter(s => s.trim().split(/\s+/).length !== 5 || /[^0-9*\-,/ ]/.test(s))
);

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Settings Validation Property Tests (Property 5)', () => {
  describe('number data_type', () => {
    it('Property 5.1: Valid numeric strings are accepted', () => {
      fc.assert(
        fc.property(validNumberArb, (value) => {
          const result = validateValue(value, 'number');
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.2: Non-numeric strings are rejected', () => {
      fc.assert(
        fc.property(invalidNumberArb, (value) => {
          const result = validateValue(value, 'number');
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
          expect(result.error!.length).toBeGreaterThan(0);
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.3: Number validation respects min/max constraints', () => {
      const validationRule: ValidationRule = { min: 10, max: 100 };

      fc.assert(
        fc.property(fc.integer({ min: 10, max: 100 }), (num) => {
          const result = validateValue(String(num), 'number', validationRule);
          expect(result.valid).toBe(true);
        }),
        { numRuns: 200 }
      );

      fc.assert(
        fc.property(
          fc.oneof(
            fc.integer({ min: -1000, max: 9 }),
            fc.integer({ min: 101, max: 10000 })
          ),
          (num) => {
            const result = validateValue(String(num), 'number', validationRule);
            expect(result.valid).toBe(false);
            expect(result.error).toBeDefined();
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('boolean data_type', () => {
    it('Property 5.4: "true" and "false" are accepted', () => {
      fc.assert(
        fc.property(validBooleanArb, (value) => {
          const result = validateValue(value, 'boolean');
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        }),
        { numRuns: 100 }
      );
    });

    it('Property 5.5: Anything other than "true"/"false" is rejected', () => {
      fc.assert(
        fc.property(invalidBooleanArb, (value) => {
          const result = validateValue(value, 'boolean');
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('url data_type', () => {
    it('Property 5.6: Valid http/https URLs are accepted', () => {
      fc.assert(
        fc.property(validUrlArb, (value) => {
          const result = validateValue(value, 'url');
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.7: Malformed strings are rejected as URLs', () => {
      fc.assert(
        fc.property(invalidUrlArb, (value) => {
          const result = validateValue(value, 'url');
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.8: Empty string is valid for URL (optional field)', () => {
      const result = validateValue('', 'url');
      expect(result.valid).toBe(true);
    });
  });

  describe('email data_type', () => {
    it('Property 5.9: Valid email patterns are accepted', () => {
      fc.assert(
        fc.property(validEmailArb, (value) => {
          const result = validateValue(value, 'email');
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.10: Malformed strings are rejected as emails', () => {
      fc.assert(
        fc.property(invalidEmailArb, (value) => {
          const result = validateValue(value, 'email');
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.11: Empty string is valid for email (optional field)', () => {
      const result = validateValue('', 'email');
      expect(result.valid).toBe(true);
    });
  });

  describe('json data_type', () => {
    it('Property 5.12: Valid JSON strings are accepted', () => {
      fc.assert(
        fc.property(validJsonArb, (value) => {
          const result = validateValue(value, 'json');
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.13: Malformed strings are rejected as JSON', () => {
      fc.assert(
        fc.property(invalidJsonArb, (value) => {
          const result = validateValue(value, 'json');
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('cron data_type', () => {
    it('Property 5.14: Valid 5-field cron expressions are accepted', () => {
      fc.assert(
        fc.property(validCronArb, (value) => {
          const result = validateValue(value, 'cron');
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.15: Invalid cron expressions are rejected', () => {
      fc.assert(
        fc.property(invalidCronArb, (value) => {
          const result = validateValue(value, 'cron');
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('string data_type', () => {
    it('Property 5.16: Any string value is valid for string type without constraints', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 100 }), (value) => {
          const result = validateValue(value, 'string');
          expect(result.valid).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    it('Property 5.17: Empty string is valid for string type (optional)', () => {
      const result = validateValue('', 'string');
      expect(result.valid).toBe(true);
    });

    it('Property 5.18: String validation with pattern rejects non-matching values', () => {
      const rule: ValidationRule = { pattern: '^[a-z]+$' };

      fc.assert(
        fc.property(
          fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { minLength: 1, maxLength: 10 }),
          (value) => {
            const result = validateValue(value, 'string', rule);
            expect(result.valid).toBe(true);
          }
        ),
        { numRuns: 100 }
      );

      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }).filter(s => !/^[a-z]+$/.test(s)),
          (value) => {
            const result = validateValue(value, 'string', rule);
            expect(result.valid).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property 5.19: String validation with options rejects unlisted values', () => {
      const options = ['debug', 'info', 'warn', 'error'];
      const rule: ValidationRule = { options };

      fc.assert(
        fc.property(fc.constantFrom(...options), (value) => {
          const result = validateValue(value, 'string', rule);
          expect(result.valid).toBe(true);
        }),
        { numRuns: 50 }
      );

      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }).filter(s => !options.includes(s)),
          (value) => {
            const result = validateValue(value, 'string', rule);
            expect(result.valid).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
