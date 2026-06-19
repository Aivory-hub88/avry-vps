/**
 * Property 11: User resource tracking round-trip
 *
 * Feature: vps-panel-monitoring-api, Property 11: User resource tracking round-trip
 *
 * For any valid user resource tracking POST (with projectId, userId, and allocation data),
 * a subsequent GET to `/api/monitoring/projects/:projectId/users/:userId` SHALL return a
 * response that includes the tracked container and its allocation values.
 *
 * **Validates: Requirements 12.1, 12.2**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createUserResourceTracker } from '../../../src/services/user-resource-tracking.js';
import type { PgClient } from '../../../src/database/pg-client.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StoredAllocation {
  id: string;
  project_id: string;
  user_id: string;
  container_name: string;
  cpu_allocation: number;
  memory_allocation: number;
  tracked_at: string;
}

// ─── Mock PgClient ─────────────────────────────────────────────────────────────

/**
 * Creates a mock PgClient with in-memory storage that implements
 * INSERT/ON CONFLICT and SELECT behavior for the user_resource_allocations table.
 */
function createInMemoryPgClient(): PgClient {
  const store: Map<string, StoredAllocation> = new Map();
  let idCounter = 0;

  return {
    async connect() {},
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      // Handle INSERT ... ON CONFLICT (track operation)
      if (sql.includes('INSERT INTO monitoring.user_resource_allocations')) {
        const [projectId, userId, containerName, cpuAllocation, memoryAllocation] = params as [
          string, string, string, number, number
        ];

        // Unique key: project_id + user_id + container_name
        const key = `${projectId}::${userId}::${containerName}`;
        const existing = store.get(key);

        if (existing) {
          // ON CONFLICT DO UPDATE
          existing.cpu_allocation = cpuAllocation;
          existing.memory_allocation = memoryAllocation;
          existing.tracked_at = new Date().toISOString();
        } else {
          // INSERT new record
          idCounter++;
          store.set(key, {
            id: `uuid-${idCounter}`,
            project_id: projectId,
            user_id: userId,
            container_name: containerName,
            cpu_allocation: cpuAllocation,
            memory_allocation: memoryAllocation,
            tracked_at: new Date().toISOString(),
          });
        }

        return [] as T[];
      }

      // Handle SELECT for getUserMetrics (project_id + user_id filter)
      if (
        sql.includes('SELECT') &&
        sql.includes('FROM monitoring.user_resource_allocations') &&
        sql.includes('WHERE project_id = $1 AND user_id = $2') &&
        !sql.includes('DELETE')
      ) {
        const [projectId, userId] = params as [string, string];
        const rows: StoredAllocation[] = [];

        for (const allocation of store.values()) {
          if (allocation.project_id === projectId && allocation.user_id === userId) {
            rows.push({ ...allocation });
          }
        }

        // Sort by tracked_at ASC to match the service query
        rows.sort((a, b) => a.tracked_at.localeCompare(b.tracked_at));

        return rows as T[];
      }

      // Handle SELECT for listProjectUsers (project_id filter only)
      if (
        sql.includes('SELECT') &&
        sql.includes('FROM monitoring.user_resource_allocations') &&
        sql.includes('WHERE project_id = $1') &&
        !sql.includes('user_id = $2')
      ) {
        const [projectId] = params as [string];
        const rows: StoredAllocation[] = [];

        for (const allocation of store.values()) {
          if (allocation.project_id === projectId) {
            rows.push({ ...allocation });
          }
        }

        rows.sort((a, b) => {
          if (a.user_id !== b.user_id) return a.user_id.localeCompare(b.user_id);
          return a.tracked_at.localeCompare(b.tracked_at);
        });

        return rows as T[];
      }

      // Handle DELETE for untrack
      if (sql.includes('DELETE FROM monitoring.user_resource_allocations')) {
        const [projectId, userId] = params as [string, string];

        for (const [key, allocation] of store.entries()) {
          if (allocation.project_id === projectId && allocation.user_id === userId) {
            store.delete(key);
          }
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
 * Generate a valid user ID (alphanumeric with underscores/dashes).
 */
const userIdArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '_', '-'
  ),
  { minLength: 3, maxLength: 30 }
).filter((s) => /^[a-z]/.test(s));

/**
 * Generate a valid container name (lowercase with dashes/underscores).
 */
const containerNameArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', '_'
  ),
  { minLength: 2, maxLength: 30 }
).filter((s) => /^[a-z]/.test(s) && !s.endsWith('-') && !s.endsWith('_'));

/**
 * Generate a CPU allocation between 0 and 100 (percentage).
 */
const cpuAllocationArb = fc.integer({ min: 0, max: 100 });

/**
 * Generate a memory allocation (positive integer, in bytes).
 */
const memoryAllocationArb = fc.integer({ min: 1, max: 68_719_476_736 }); // 1 byte to 64 GB

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Feature: vps-panel-monitoring-api, Property 11: User resource tracking round-trip', () => {
  it('tracking a user resource allocation and then querying returns the tracked container with correct values', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectIdArb,
        userIdArb,
        containerNameArb,
        cpuAllocationArb,
        memoryAllocationArb,
        async (projectId, userId, containerName, cpuAllocation, memoryAllocation) => {
          const mockDb = createInMemoryPgClient();
          const tracker = createUserResourceTracker(mockDb);

          // Track the user resource allocation (simulates POST)
          await tracker.track(projectId, userId, {
            containerName,
            cpuAllocation,
            memoryAllocation,
          });

          // Query the user metrics (simulates GET)
          const summary = await tracker.getUserMetrics(projectId, userId);

          // Property: The response includes the userId
          expect(summary.userId).toBe(userId);

          // Property: The response contains a container with the tracked name
          const trackedContainer = summary.containers.find((c) => c.name === containerName);
          expect(trackedContainer).toBeDefined();

          // Property: The allocation values match what was tracked
          expect(trackedContainer!.cpu).toBe(cpuAllocation);
          expect(trackedContainer!.memory).toBe(memoryAllocation);

          // Property: Totals include the tracked allocation
          expect(summary.totalCpuPercent).toBeGreaterThanOrEqual(cpuAllocation);
          expect(summary.totalMemoryBytes).toBeGreaterThanOrEqual(memoryAllocation);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('tracking multiple containers for the same user returns all containers in the summary', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectIdArb,
        userIdArb,
        fc.uniqueArray(containerNameArb, { minLength: 2, maxLength: 5 }),
        fc.array(cpuAllocationArb, { minLength: 2, maxLength: 5 }),
        fc.array(memoryAllocationArb, { minLength: 2, maxLength: 5 }),
        async (projectId, userId, containerNames, cpuAllocations, memoryAllocations) => {
          // Ensure we have matching arrays (trim to shortest length)
          const count = Math.min(containerNames.length, cpuAllocations.length, memoryAllocations.length);
          const names = containerNames.slice(0, count);
          const cpus = cpuAllocations.slice(0, count);
          const mems = memoryAllocations.slice(0, count);

          const mockDb = createInMemoryPgClient();
          const tracker = createUserResourceTracker(mockDb);

          // Track multiple containers
          for (let i = 0; i < count; i++) {
            await tracker.track(projectId, userId, {
              containerName: names[i],
              cpuAllocation: cpus[i],
              memoryAllocation: mems[i],
            });
          }

          // Query user metrics
          const summary = await tracker.getUserMetrics(projectId, userId);

          // Property: All tracked containers are present
          for (let i = 0; i < count; i++) {
            const container = summary.containers.find((c) => c.name === names[i]);
            expect(container).toBeDefined();
            expect(container!.cpu).toBe(cpus[i]);
            expect(container!.memory).toBe(mems[i]);
          }

          // Property: Totals are the sum of all allocations
          const expectedCpuTotal = cpus.reduce((sum, v) => sum + v, 0);
          const expectedMemTotal = mems.reduce((sum, v) => sum + v, 0);
          expect(summary.totalCpuPercent).toBe(expectedCpuTotal);
          expect(summary.totalMemoryBytes).toBe(expectedMemTotal);
        }
      ),
      { numRuns: 100 }
    );
  });
});
