/**
 * Unit tests for the Per-User Resource Tracking Service
 *
 * Tests track/untrack operations, getUserMetrics aggregation,
 * listProjectUsers grouping, project scope enforcement, and 404 handling.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createUserResourceTracker,
  UserResourceTrackingError,
} from '../../src/services/user-resource-tracking.js';
import type { PgClient } from '../../src/database/pg-client.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a mock PgClient that captures queries and returns configurable results.
 */
function createMockDb(queryResults: unknown[][] = []) {
  let callIndex = 0;
  const calls: { sql: string; params?: unknown[] }[] = [];

  const db: PgClient = {
    async connect() {},
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      calls.push({ sql, params });
      const result = queryResults[callIndex] ?? [];
      callIndex++;
      return result as T[];
    },
    async transaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
      return fn({} as any);
    },
    async close() {},
    async isHealthy() {
      return true;
    },
  };

  return { db, calls };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('UserResourceTracker', () => {
  describe('track()', () => {
    it('should insert a new allocation with ON CONFLICT UPDATE', async () => {
      const { db, calls } = createMockDb([[]]);
      const tracker = createUserResourceTracker(db);

      await tracker.track('project-1', 'user-abc', {
        containerName: 'my-container',
        cpuAllocation: 25.5,
        memoryAllocation: 1073741824,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain('INSERT INTO monitoring.user_resource_allocations');
      expect(calls[0].sql).toContain('ON CONFLICT');
      expect(calls[0].params).toEqual([
        'project-1',
        'user-abc',
        'my-container',
        25.5,
        1073741824,
      ]);
    });

    it('should enforce project scope and throw 403 if scope mismatch', async () => {
      const { db } = createMockDb();
      const tracker = createUserResourceTracker(db);

      await expect(
        tracker.track('project-1', 'user-abc', {
          containerName: 'c1',
          cpuAllocation: 10,
          memoryAllocation: 512,
        }, 'other-project')
      ).rejects.toThrow(UserResourceTrackingError);

      try {
        await tracker.track('project-1', 'user-abc', {
          containerName: 'c1',
          cpuAllocation: 10,
          memoryAllocation: 512,
        }, 'other-project');
      } catch (err) {
        const error = err as UserResourceTrackingError;
        expect(error.code).toBe('PROJECT_SCOPE_DENIED');
        expect(error.statusCode).toBe(403);
      }
    });

    it('should allow track when projectScope matches projectId', async () => {
      const { db, calls } = createMockDb([[]]);
      const tracker = createUserResourceTracker(db);

      await tracker.track('project-1', 'user-abc', {
        containerName: 'c1',
        cpuAllocation: 10,
        memoryAllocation: 512,
      }, 'project-1');

      expect(calls).toHaveLength(1);
    });

    it('should allow track when projectScope is undefined', async () => {
      const { db, calls } = createMockDb([[]]);
      const tracker = createUserResourceTracker(db);

      await tracker.track('project-1', 'user-abc', {
        containerName: 'c1',
        cpuAllocation: 10,
        memoryAllocation: 512,
      });

      expect(calls).toHaveLength(1);
    });
  });

  describe('untrack()', () => {
    it('should delete all allocations for (project_id, user_id)', async () => {
      const { db, calls } = createMockDb([[]]);
      const tracker = createUserResourceTracker(db);

      await tracker.untrack('project-1', 'user-abc');

      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain('DELETE FROM monitoring.user_resource_allocations');
      expect(calls[0].params).toEqual(['project-1', 'user-abc']);
    });

    it('should enforce project scope on untrack', async () => {
      const { db } = createMockDb();
      const tracker = createUserResourceTracker(db);

      await expect(
        tracker.untrack('project-1', 'user-abc', 'different-project')
      ).rejects.toThrow(UserResourceTrackingError);
    });
  });

  describe('getUserMetrics()', () => {
    it('should return aggregated metrics for a user with multiple containers', async () => {
      const rows = [
        {
          id: 'uuid-1',
          project_id: 'project-1',
          user_id: 'user-abc',
          container_name: 'web-server',
          cpu_allocation: 20.0,
          memory_allocation: 1073741824,
          tracked_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'uuid-2',
          project_id: 'project-1',
          user_id: 'user-abc',
          container_name: 'worker',
          cpu_allocation: 15.5,
          memory_allocation: 536870912,
          tracked_at: '2024-01-01T00:01:00Z',
        },
      ];
      const { db } = createMockDb([rows]);
      const tracker = createUserResourceTracker(db);

      const result = await tracker.getUserMetrics('project-1', 'user-abc');

      expect(result.userId).toBe('user-abc');
      expect(result.totalCpuPercent).toBeCloseTo(35.5);
      expect(result.totalMemoryBytes).toBe(1073741824 + 536870912);
      expect(result.containers).toHaveLength(2);
      expect(result.containers[0]).toEqual({ name: 'web-server', cpu: 20.0, memory: 1073741824 });
      expect(result.containers[1]).toEqual({ name: 'worker', cpu: 15.5, memory: 536870912 });
    });

    it('should throw 404 when user has no tracked resources', async () => {
      const { db } = createMockDb([[]]);
      const tracker = createUserResourceTracker(db);

      await expect(
        tracker.getUserMetrics('project-1', 'nonexistent-user')
      ).rejects.toThrow(UserResourceTrackingError);

      try {
        await tracker.getUserMetrics('project-1', 'nonexistent-user');
      } catch (err) {
        const error = err as UserResourceTrackingError;
        expect(error.code).toBe('USER_NOT_FOUND');
        expect(error.statusCode).toBe(404);
      }
    });

    it('should enforce project scope on getUserMetrics', async () => {
      const { db } = createMockDb();
      const tracker = createUserResourceTracker(db);

      await expect(
        tracker.getUserMetrics('project-1', 'user-abc', 'other-project')
      ).rejects.toThrow(UserResourceTrackingError);

      try {
        await tracker.getUserMetrics('project-1', 'user-abc', 'other-project');
      } catch (err) {
        const error = err as UserResourceTrackingError;
        expect(error.code).toBe('PROJECT_SCOPE_DENIED');
        expect(error.statusCode).toBe(403);
      }
    });
  });

  describe('listProjectUsers()', () => {
    it('should return summaries grouped by user', async () => {
      const rows = [
        {
          id: 'uuid-1',
          project_id: 'project-1',
          user_id: 'user-a',
          container_name: 'web',
          cpu_allocation: 10,
          memory_allocation: 500000000,
          tracked_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'uuid-2',
          project_id: 'project-1',
          user_id: 'user-a',
          container_name: 'api',
          cpu_allocation: 5,
          memory_allocation: 250000000,
          tracked_at: '2024-01-01T00:01:00Z',
        },
        {
          id: 'uuid-3',
          project_id: 'project-1',
          user_id: 'user-b',
          container_name: 'worker',
          cpu_allocation: 30,
          memory_allocation: 2000000000,
          tracked_at: '2024-01-01T00:00:00Z',
        },
      ];
      const { db } = createMockDb([rows]);
      const tracker = createUserResourceTracker(db);

      const result = await tracker.listProjectUsers('project-1');

      expect(result).toHaveLength(2);

      // user-a comes first (alphabetical order from SQL)
      expect(result[0].userId).toBe('user-a');
      expect(result[0].totalCpuPercent).toBe(15);
      expect(result[0].totalMemoryBytes).toBe(750000000);
      expect(result[0].containers).toHaveLength(2);

      // user-b
      expect(result[1].userId).toBe('user-b');
      expect(result[1].totalCpuPercent).toBe(30);
      expect(result[1].totalMemoryBytes).toBe(2000000000);
      expect(result[1].containers).toHaveLength(1);
    });

    it('should return empty array when no users are tracked in the project', async () => {
      const { db } = createMockDb([[]]);
      const tracker = createUserResourceTracker(db);

      const result = await tracker.listProjectUsers('project-1');

      expect(result).toEqual([]);
    });

    it('should enforce project scope on listProjectUsers', async () => {
      const { db } = createMockDb();
      const tracker = createUserResourceTracker(db);

      await expect(
        tracker.listProjectUsers('project-1', 'wrong-project')
      ).rejects.toThrow(UserResourceTrackingError);
    });
  });

  describe('UserResourceTrackingError', () => {
    it('should carry code and statusCode properties', () => {
      const error = new UserResourceTrackingError('test message', 'USER_NOT_FOUND', 404);

      expect(error.message).toBe('test message');
      expect(error.code).toBe('USER_NOT_FOUND');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('UserResourceTrackingError');
      expect(error).toBeInstanceOf(Error);
    });
  });
});
