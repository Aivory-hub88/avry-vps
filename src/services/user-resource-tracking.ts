/**
 * Per-User Resource Tracking Service
 *
 * Handles user-container attribution within a project scope.
 * Stores user-resource associations in `monitoring.user_resource_allocations`
 * and provides aggregated queries per user within a project.
 *
 * @module services/user-resource-tracking
 */
import { PgClient } from '../database/pg-client.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResourceAllocationInput {
  containerName: string;
  cpuAllocation: number;
  memoryAllocation: number;
}

export interface UserResourceAllocation {
  userId: string;
  projectId: string;
  containerName: string;
  cpuAllocation: number;
  memoryAllocation: number;
  trackedAt: string;
}

export interface UserResourceSummary {
  userId: string;
  totalCpuPercent: number;
  totalMemoryBytes: number;
  containers: { name: string; cpu: number; memory: number }[];
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class UserResourceTrackingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'UserResourceTrackingError';
  }
}

// ─── Database row shape ──────────────────────────────────────────────────────

interface AllocationRow {
  id: string;
  project_id: string;
  user_id: string;
  container_name: string;
  cpu_allocation: number;
  memory_allocation: number;
  tracked_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Enforce project scope isolation. If the auth token has a projectScope
 * and it doesn't match the requested projectId, throw a 403 error.
 */
function enforceProjectScope(projectId: string, projectScope?: string): void {
  if (projectScope !== undefined && projectScope !== projectId) {
    throw new UserResourceTrackingError(
      `Token does not have access to project "${projectId}"`,
      'PROJECT_SCOPE_DENIED',
      403
    );
  }
}

/**
 * Aggregate allocation rows into a UserResourceSummary.
 */
function aggregateRows(userId: string, rows: AllocationRow[]): UserResourceSummary {
  let totalCpuPercent = 0;
  let totalMemoryBytes = 0;
  const containers: { name: string; cpu: number; memory: number }[] = [];

  for (const row of rows) {
    const cpu = Number(row.cpu_allocation);
    const memory = Number(row.memory_allocation);
    totalCpuPercent += cpu;
    totalMemoryBytes += memory;
    containers.push({
      name: row.container_name,
      cpu,
      memory,
    });
  }

  return {
    userId,
    totalCpuPercent,
    totalMemoryBytes,
    containers,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface UserResourceTracker {
  track(projectId: string, userId: string, allocation: ResourceAllocationInput, projectScope?: string): Promise<void>;
  untrack(projectId: string, userId: string, projectScope?: string): Promise<void>;
  getUserMetrics(projectId: string, userId: string, projectScope?: string): Promise<UserResourceSummary>;
  listProjectUsers(projectId: string, projectScope?: string): Promise<UserResourceSummary[]>;
}

export function createUserResourceTracker(db: PgClient): UserResourceTracker {
  return {
    async track(
      projectId: string,
      userId: string,
      allocation: ResourceAllocationInput,
      projectScope?: string
    ): Promise<void> {
      enforceProjectScope(projectId, projectScope);

      await db.query(
        `INSERT INTO monitoring.user_resource_allocations
           (project_id, user_id, container_name, cpu_allocation, memory_allocation)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, user_id, container_name)
         DO UPDATE SET
           cpu_allocation = EXCLUDED.cpu_allocation,
           memory_allocation = EXCLUDED.memory_allocation,
           tracked_at = NOW()`,
        [projectId, userId, allocation.containerName, allocation.cpuAllocation, allocation.memoryAllocation]
      );
    },

    async untrack(projectId: string, userId: string, projectScope?: string): Promise<void> {
      enforceProjectScope(projectId, projectScope);

      await db.query(
        `DELETE FROM monitoring.user_resource_allocations
         WHERE project_id = $1 AND user_id = $2`,
        [projectId, userId]
      );
    },

    async getUserMetrics(
      projectId: string,
      userId: string,
      projectScope?: string
    ): Promise<UserResourceSummary> {
      enforceProjectScope(projectId, projectScope);

      const rows = await db.query<AllocationRow>(
        `SELECT id, project_id, user_id, container_name, cpu_allocation, memory_allocation, tracked_at
         FROM monitoring.user_resource_allocations
         WHERE project_id = $1 AND user_id = $2
         ORDER BY tracked_at ASC`,
        [projectId, userId]
      );

      if (rows.length === 0) {
        throw new UserResourceTrackingError(
          `No tracked resources found for user "${userId}" in project "${projectId}"`,
          'USER_NOT_FOUND',
          404
        );
      }

      return aggregateRows(userId, rows);
    },

    async listProjectUsers(projectId: string, projectScope?: string): Promise<UserResourceSummary[]> {
      enforceProjectScope(projectId, projectScope);

      const rows = await db.query<AllocationRow>(
        `SELECT id, project_id, user_id, container_name, cpu_allocation, memory_allocation, tracked_at
         FROM monitoring.user_resource_allocations
         WHERE project_id = $1
         ORDER BY user_id ASC, tracked_at ASC`,
        [projectId]
      );

      // Group rows by user_id
      const userMap = new Map<string, AllocationRow[]>();
      for (const row of rows) {
        const existing = userMap.get(row.user_id);
        if (existing) {
          existing.push(row);
        } else {
          userMap.set(row.user_id, [row]);
        }
      }

      // Aggregate per user
      const summaries: UserResourceSummary[] = [];
      for (const [userId, userRows] of userMap) {
        summaries.push(aggregateRows(userId, userRows));
      }

      return summaries;
    },
  };
}
