/**
 * Property 5: Project scope isolation
 *
 * Feature: vps-panel-monitoring-api, Property 5: Project scope isolation
 *
 * For any project ID and its associated container patterns, the metrics returned by
 * `/api/monitoring/projects/:projectId` SHALL only contain containers whose names
 * match the project's registered patterns, and SHALL NOT include containers belonging
 * to other projects.
 *
 * **Validates: Requirements 3.1, 3.2, 11.6**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { globToRegex, createProjectRegistry } from '../../../src/services/project-registry.js';
import type { PgClient } from '../../../src/database/pg-client.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate a valid project ID (lowercase alphanumeric with dashes).
 */
const projectIdArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-'
  ),
  { minLength: 3, maxLength: 20 }
).filter((s) => /^[a-z]/.test(s) && !s.endsWith('-') && !s.includes('--'));

/**
 * Generate a glob pattern prefix (e.g., "app", "db", "web", "svc").
 * These prefixes are used to construct patterns like "app-*".
 */
const prefixArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'
  ),
  { minLength: 2, maxLength: 6 }
);

/**
 * Generate a container name suffix (what comes after the prefix-).
 */
const suffixArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-'
  ),
  { minLength: 1, maxLength: 12 }
).filter((s) => !s.startsWith('-') && !s.endsWith('-'));

/**
 * Generate a container name that does NOT match any of the given prefixes.
 * Uses a fixed "unrelated" prefix to guarantee isolation.
 */
function unrelatedContainerArb(avoidPrefixes: string[]): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
      'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
    ),
    { minLength: 3, maxLength: 15 }
  ).filter((name) => {
    // Ensure the generated name does not match any glob pattern "prefix-*"
    return avoidPrefixes.every((prefix) => !name.startsWith(prefix + '-'));
  });
}

/**
 * Generate test data for two projects with distinct, non-overlapping patterns.
 * Each project has a unique prefix, and we generate containers for each plus orphans.
 */
const twoProjectsArb = fc.tuple(
  projectIdArb,
  projectIdArb,
  prefixArb,
  prefixArb,
  fc.array(suffixArb, { minLength: 1, maxLength: 5 }),
  fc.array(suffixArb, { minLength: 1, maxLength: 5 }),
  fc.array(suffixArb, { minLength: 0, maxLength: 3 })
).filter(([idA, idB, prefixA, prefixB]) => {
  // Ensure distinct project IDs and non-overlapping prefixes
  return idA !== idB && prefixA !== prefixB;
}).map(([idA, idB, prefixA, prefixB, suffixesA, suffixesB, orphanSuffixes]) => {
  const patternsA = [`${prefixA}-*`];
  const patternsB = [`${prefixB}-*`];

  const containersA = suffixesA.map((s) => `${prefixA}-${s}`);
  const containersB = suffixesB.map((s) => `${prefixB}-${s}`);
  // Orphan containers that match neither project
  const orphans = orphanSuffixes.map((s) => `orphan-${s}`);

  return {
    projectA: { id: idA, patterns: patternsA, containers: containersA },
    projectB: { id: idB, patterns: patternsB, containers: containersB },
    orphans,
    allContainers: [...containersA, ...containersB, ...orphans],
  };
});

// ─── Mock PgClient ─────────────────────────────────────────────────────────────

/**
 * Creates a mock PgClient that returns patterns for the specified projects.
 */
function createMockPgClient(
  projects: Record<string, string[]>
): PgClient {
  return {
    async connect() {},
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      // Match on SELECT patterns query used by matchContainers
      if (sql.includes('SELECT patterns') && params && params.length > 0) {
        const projectId = params[0] as string;
        if (projects[projectId]) {
          return [{ patterns: projects[projectId] }] as T[];
        }
        return [] as T[];
      }
      // Match on SELECT id query used by existence checks
      if (sql.includes('SELECT id') && params && params.length > 0) {
        const projectId = params[0] as string;
        if (projects[projectId]) {
          return [{ id: projectId }] as T[];
        }
        return [] as T[];
      }
      return [] as T[];
    },
    async transaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
      return fn({} as any);
    },
    async close() {},
    async isHealthy() { return true; },
  };
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Feature: vps-panel-monitoring-api, Property 5: Project scope isolation', () => {
  it('matchContainers for project A returns ONLY containers matching A\'s patterns, none of B\'s', async () => {
    await fc.assert(
      fc.asyncProperty(twoProjectsArb, async ({ projectA, projectB, orphans, allContainers }) => {
        const mockDb = createMockPgClient({
          [projectA.id]: projectA.patterns,
          [projectB.id]: projectB.patterns,
        });

        const registry = createProjectRegistry(mockDb);

        // Get containers matched for project A
        const matchedA = await registry.matchContainers(projectA.id, allContainers);

        // Property: Every matched container for project A must match A's patterns
        const regexesA = projectA.patterns.map(globToRegex);
        for (const name of matchedA) {
          const matchesA = regexesA.some((r) => r.test(name));
          expect(matchesA).toBe(true);
        }

        // Property: No container from project B's set should appear in A's results
        for (const name of matchedA) {
          const regexesB = projectB.patterns.map(globToRegex);
          const matchesB = regexesB.some((r) => r.test(name));
          // A matched container for A should NOT match B's patterns
          // (since prefixes are guaranteed different)
          expect(matchesB).toBe(false);
        }

        // Property: Orphan containers should not appear in A's results
        for (const orphan of orphans) {
          expect(matchedA).not.toContain(orphan);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('matchContainers for project B returns ONLY containers matching B\'s patterns, none of A\'s', async () => {
    await fc.assert(
      fc.asyncProperty(twoProjectsArb, async ({ projectA, projectB, orphans, allContainers }) => {
        const mockDb = createMockPgClient({
          [projectA.id]: projectA.patterns,
          [projectB.id]: projectB.patterns,
        });

        const registry = createProjectRegistry(mockDb);

        // Get containers matched for project B
        const matchedB = await registry.matchContainers(projectB.id, allContainers);

        // Property: Every matched container for project B must match B's patterns
        const regexesB = projectB.patterns.map(globToRegex);
        for (const name of matchedB) {
          const matchesB = regexesB.some((r) => r.test(name));
          expect(matchesB).toBe(true);
        }

        // Property: No container from project A's set should appear in B's results
        for (const name of matchedB) {
          const regexesA = projectA.patterns.map(globToRegex);
          const matchesA = regexesA.some((r) => r.test(name));
          expect(matchesA).toBe(false);
        }

        // Property: Orphan containers should not appear in B's results
        for (const orphan of orphans) {
          expect(matchedB).not.toContain(orphan);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('matched containers for A and B are disjoint — no container appears in both', async () => {
    await fc.assert(
      fc.asyncProperty(twoProjectsArb, async ({ projectA, projectB, allContainers }) => {
        const mockDb = createMockPgClient({
          [projectA.id]: projectA.patterns,
          [projectB.id]: projectB.patterns,
        });

        const registry = createProjectRegistry(mockDb);

        const matchedA = await registry.matchContainers(projectA.id, allContainers);
        const matchedB = await registry.matchContainers(projectB.id, allContainers);

        // Property: The intersection of matched sets must be empty
        const intersection = matchedA.filter((name) => matchedB.includes(name));
        expect(intersection).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });

  it('all containers matching A\'s patterns are included in A\'s results (completeness)', async () => {
    await fc.assert(
      fc.asyncProperty(twoProjectsArb, async ({ projectA, projectB, allContainers }) => {
        const mockDb = createMockPgClient({
          [projectA.id]: projectA.patterns,
          [projectB.id]: projectB.patterns,
        });

        const registry = createProjectRegistry(mockDb);

        const matchedA = await registry.matchContainers(projectA.id, allContainers);

        // Property: Every container in allContainers that SHOULD match A's patterns IS in the result
        const regexesA = projectA.patterns.map(globToRegex);
        const expectedA = allContainers.filter((name) =>
          regexesA.some((r) => r.test(name))
        );

        expect(matchedA.sort()).toEqual(expectedA.sort());
      }),
      { numRuns: 100 }
    );
  });
});
