/**
 * Property-based tests for the Project Registry Service.
 *
 * Feature: vps-panel-monitoring-api, Property 7: Glob pattern matching correctness
 * For any project registration with glob patterns and any set of container names,
 * the `matchContainers` function SHALL return exactly those names where `*` matches
 * any sequence of characters, and no others.
 *
 * Feature: vps-panel-monitoring-api, Property 12: Project registry duplicate rejection
 * For any existing project registration with identifier X, a POST request to create
 * a new project with the same identifier X SHALL return HTTP 409 and the existing
 * registration SHALL remain unchanged.
 *
 * **Validates: Requirements 4.5, 4.6**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  globToRegex,
  createProjectRegistry,
  ProjectRegistryError,
  type ProjectRegistration,
} from '../../../src/services/project-registry.js';
import type { PgClient } from '../../../src/database/pg-client.js';

// ─── Reference Implementation ──────────────────────────────────────────────────

/**
 * Reference implementation of glob matching. Converts a glob pattern (with `*`)
 * to a regex by escaping all special regex chars then replacing `*` with `.*`.
 * This is the specification-level "expected behavior" we test against.
 */
function referenceGlobMatch(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(name);
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Characters that can appear in container names (alphanumeric, dash, underscore, dot).
 */
const containerNameCharArb = fc.constantFrom(
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '-', '_', '.'
);

/**
 * Generate a valid container name (alphanumeric with dashes, underscores, dots).
 */
const containerNameArb = fc.stringOf(containerNameCharArb, { minLength: 1, maxLength: 40 });

/**
 * Generate a glob pattern: a mix of literal container name chars and `*` wildcards.
 */
const globPatternArb = fc.stringOf(
  fc.oneof(
    { weight: 5, arbitrary: containerNameCharArb },
    { weight: 1, arbitrary: fc.constant('*') }
  ),
  { minLength: 1, maxLength: 30 }
);

/**
 * Generate an array of glob patterns (1-5 patterns per project).
 */
const patternsArrayArb = fc.array(globPatternArb, { minLength: 1, maxLength: 5 });

/**
 * Generate an array of container names (1-20 names).
 */
const containerNamesArb = fc.array(containerNameArb, { minLength: 1, maxLength: 20 });

/**
 * Generate a valid project ID (lowercase alphanumeric with dashes).
 */
const projectIdArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-'
  ),
  { minLength: 3, maxLength: 30 }
).filter((s) => /^[a-z]/.test(s) && !s.endsWith('-'));

/**
 * Generate a display name for a project.
 */
const displayNameArb = fc.stringOf(
  fc.constantFrom(
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    ' ', '-'
  ),
  { minLength: 1, maxLength: 50 }
);

// ─── Mock PgClient ─────────────────────────────────────────────────────────────

/**
 * Creates a mock PgClient backed by an in-memory store for project_registry rows.
 * Simulates the database behavior without needing a real PostgreSQL instance.
 */
function createMockPgClient(): PgClient & { _store: Map<string, any> } {
  const store = new Map<string, any>();

  const client: PgClient & { _store: Map<string, any> } = {
    _store: store,

    async connect() {},

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      // Handle SELECT id FROM ... WHERE id = $1 (duplicate check)
      if (sql.includes('SELECT id FROM') && sql.includes('WHERE id =')) {
        const id = params?.[0] as string;
        const row = store.get(id);
        if (row) {
          return [{ id: row.id } as unknown as T];
        }
        return [];
      }

      // Handle SELECT patterns FROM ... WHERE id = $1 (matchContainers)
      if (sql.includes('SELECT patterns FROM') && sql.includes('WHERE id =')) {
        const id = params?.[0] as string;
        const row = store.get(id);
        if (row) {
          return [{ patterns: row.patterns } as unknown as T];
        }
        return [];
      }

      // Handle INSERT INTO ... RETURNING (create)
      if (sql.includes('INSERT INTO')) {
        const id = params?.[0] as string;
        const displayName = params?.[1] as string;
        const patterns = JSON.parse(params?.[2] as string);
        const now = new Date().toISOString();

        const row = {
          id,
          display_name: displayName,
          patterns,
          created_at: now,
          updated_at: now,
        };
        store.set(id, row);
        return [row as unknown as T];
      }

      return [];
    },

    async transaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
      return fn(client);
    },

    async close() {},

    async isHealthy(): Promise<boolean> {
      return true;
    },
  };

  return client;
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Feature: vps-panel-monitoring-api, Property 7: Glob pattern matching correctness', () => {
  it('globToRegex matches exactly the same names as a reference implementation for any pattern and container name', () => {
    fc.assert(
      fc.property(
        globPatternArb,
        containerNameArb,
        (pattern, containerName) => {
          const regex = globToRegex(pattern);
          const actual = regex.test(containerName);
          const expected = referenceGlobMatch(pattern, containerName);

          expect(actual).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for any set of patterns and container names, matchContainers returns exactly those names matched by the glob patterns', async () => {
    await fc.assert(
      fc.asyncProperty(
        patternsArrayArb,
        containerNamesArb,
        async (patterns, containerNames) => {
          // Set up mock DB with a project that has the given patterns
          const mockDb = createMockPgClient();
          const registry = createProjectRegistry(mockDb);

          // Create a project with the patterns
          const projectId = 'test-project';
          await registry.create({
            id: projectId,
            displayName: 'Test Project',
            patterns,
          });

          // Call matchContainers
          const matched = await registry.matchContainers(projectId, containerNames);

          // Compute expected result using the reference implementation
          const expected = containerNames.filter((name) =>
            patterns.some((pattern) => referenceGlobMatch(pattern, name))
          );

          // Property: matched set equals expected set (order may differ)
          expect(matched.sort()).toEqual(expected.sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('a container name matched by globToRegex always satisfies the `*` = any-sequence-of-chars semantics', () => {
    fc.assert(
      fc.property(
        globPatternArb,
        containerNamesArb,
        (pattern, names) => {
          const regex = globToRegex(pattern);

          for (const name of names) {
            const matches = regex.test(name);

            if (matches) {
              // If pattern has no wildcards, name must equal pattern exactly
              if (!pattern.includes('*')) {
                expect(name).toBe(pattern);
              }
              // The name must match the full pattern (anchored)
              expect(name).toMatch(regex);
            } else {
              // If it doesn't match, the regex shouldn't match either
              expect(regex.test(name)).toBe(false);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: vps-panel-monitoring-api, Property 12: Project registry duplicate rejection', () => {
  it('creating a project with an existing ID throws ProjectRegistryError with code PROJECT_EXISTS and statusCode 409', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectIdArb,
        displayNameArb,
        patternsArrayArb,
        displayNameArb,
        patternsArrayArb,
        async (projectId, displayName1, patterns1, displayName2, patterns2) => {
          const mockDb = createMockPgClient();
          const registry = createProjectRegistry(mockDb);

          // First creation should succeed
          const original = await registry.create({
            id: projectId,
            displayName: displayName1,
            patterns: patterns1,
          });

          expect(original.id).toBe(projectId);

          // Second creation with same ID should throw
          let thrownError: ProjectRegistryError | null = null;
          try {
            await registry.create({
              id: projectId,
              displayName: displayName2,
              patterns: patterns2,
            });
          } catch (err) {
            if (err instanceof ProjectRegistryError) {
              thrownError = err;
            } else {
              throw err;
            }
          }

          // Property: Must throw ProjectRegistryError
          expect(thrownError).not.toBeNull();
          expect(thrownError!.code).toBe('PROJECT_EXISTS');
          expect(thrownError!.statusCode).toBe(409);

          // Property: The existing registration remains unchanged
          const stored = mockDb._store.get(projectId);
          expect(stored).toBeDefined();
          expect(stored.display_name).toBe(displayName1);
          expect(stored.patterns).toEqual(patterns1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('the error message for duplicate project includes the project identifier', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectIdArb,
        displayNameArb,
        patternsArrayArb,
        async (projectId, displayName, patterns) => {
          const mockDb = createMockPgClient();
          const registry = createProjectRegistry(mockDb);

          // Create the first registration
          await registry.create({
            id: projectId,
            displayName,
            patterns,
          });

          // Attempt duplicate creation
          let thrownError: ProjectRegistryError | null = null;
          try {
            await registry.create({
              id: projectId,
              displayName: 'Different Name',
              patterns: ['different-*'],
            });
          } catch (err) {
            if (err instanceof ProjectRegistryError) {
              thrownError = err;
            } else {
              throw err;
            }
          }

          // Property: Error message includes the project ID
          expect(thrownError).not.toBeNull();
          expect(thrownError!.message).toContain(projectId);
        }
      ),
      { numRuns: 100 }
    );
  });
});
