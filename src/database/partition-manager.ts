/**
 * Enhanced Partition Manager
 *
 * Dedicated service for PostgreSQL partition lifecycle management.
 * Extends the basic partition creation logic from migrations.ts with:
 * - Ensuring at least 4 weeks of future partitions
 * - Pruning expired partitions older than retention period
 * - Verify-and-repair to check coverage and create missing partitions on startup
 * - Partition inventory listing
 * - Error handling with critical alerts via the Alert System
 *
 * @module database/partition-manager
 * @validates Requirements 2.1, 2.2, 2.3, 2.4, 2.5
 */
import type { PgClient } from './pg-client.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface PartitionInfo {
  name: string;
  rangeStart: Date;
  rangeEnd: Date;
  estimatedRows: number;
}

export interface PartitionStatus {
  healthy: boolean;
  missingPartitions: number;
  createdPartitions: string[];
}

export interface PartitionManagerInstance {
  /** Ensure at least 4 weeks of future partitions exist */
  ensureFuturePartitions(): Promise<void>;
  /** Drop partitions containing only data older than retention period */
  pruneExpiredPartitions(retentionDays: number): Promise<string[]>;
  /** Verify partition coverage and create missing partitions */
  verifyAndRepair(): Promise<PartitionStatus>;
  /** Get current partition inventory */
  listPartitions(tableName: string): Promise<PartitionInfo[]>;
}

/**
 * Callback type for emitting alerts on partition failures.
 * Accepts the same shape as AlertSystem.emitAlert.
 */
export interface AlertCallback {
  (event: {
    eventType: string;
    affectedResource: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    message: string;
  }): Promise<string> | void;
}

export interface PartitionManagerConfig {
  /** Number of future weeks to maintain. Default: 4 */
  futureWeeks?: number;
  /** Alert callback for critical partition failures */
  onAlert?: AlertCallback;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** All partitioned tables managed by the partition manager */
const PARTITIONED_TABLES = [
  'monitoring.system_metrics',
  'monitoring.container_snapshots',
  'monitoring.system_metrics_5m',
  'monitoring.system_metrics_1h',
  'monitoring.container_metrics_5m',
] as const;

const DEFAULT_FUTURE_WEEKS = 4;

// ─── Utility Functions ─────────────────────────────────────────────────────────

/**
 * Generate the start-of-week (Monday 00:00 UTC) for a given date.
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Format a date as YYYY_MM_DD for partition naming.
 */
function formatPartitionSuffix(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}_${m}_${d}`;
}

/**
 * Generate the expected partition name for a table and week start.
 */
function getPartitionName(tableName: string, weekStart: Date): string {
  const suffix = formatPartitionSuffix(weekStart);
  return `${tableName.replace('.', '_')}_${suffix}`;
}

// ─── Implementation ────────────────────────────────────────────────────────────

/**
 * Create a PartitionManager instance.
 *
 * @param pgClient - Connected PgClient instance
 * @param config - Optional configuration (future weeks count, alert callback)
 */
export function createPartitionManager(
  pgClient: PgClient,
  config?: PartitionManagerConfig
): PartitionManagerInstance {
  const futureWeeks = config?.futureWeeks ?? DEFAULT_FUTURE_WEEKS;
  const onAlert = config?.onAlert;

  /**
   * Emit a critical alert for partition failures.
   */
  async function emitPartitionAlert(
    tableName: string,
    operation: string,
    error: Error
  ): Promise<void> {
    console.error(
      `[Partition Manager] CRITICAL: ${operation} failed for ${tableName}: ${error.message}`
    );

    if (onAlert) {
      try {
        await onAlert({
          eventType: 'partition_management_failure',
          affectedResource: tableName,
          severity: 'critical',
          message: `Partition ${operation} failed for ${tableName}: ${error.message}`,
        });
      } catch (alertError) {
        console.error(
          `[Partition Manager] Failed to emit alert: ${alertError instanceof Error ? alertError.message : String(alertError)}`
        );
      }
    }
  }

  /**
   * Create a single weekly partition for a table, if it doesn't already exist.
   */
  async function createWeeklyPartition(
    tableName: string,
    weekStart: Date
  ): Promise<string | null> {
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    const partitionName = getPartitionName(tableName, weekStart);
    const fromStr = weekStart.toISOString();
    const toStr = weekEnd.toISOString();

    try {
      await pgClient.query(
        `CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF ${tableName}
         FOR VALUES FROM ('${fromStr}') TO ('${toStr}')`,
        []
      );
      return partitionName;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await emitPartitionAlert(tableName, 'creation', err);
      return null;
    }
  }

  /**
   * Ensure at least 4 weeks of future partitions exist for all partitioned tables.
   * Also creates a partition for the current week if missing.
   */
  async function ensureFuturePartitions(): Promise<void> {
    const now = new Date();
    const currentWeekStart = getWeekStart(now);

    // Generate week starts: current week + N future weeks
    const weekStarts: Date[] = [currentWeekStart];
    for (let i = 1; i <= futureWeeks; i++) {
      const futureWeek = new Date(currentWeekStart);
      futureWeek.setUTCDate(futureWeek.getUTCDate() + i * 7);
      weekStarts.push(futureWeek);
    }

    for (const tableName of PARTITIONED_TABLES) {
      for (const weekStart of weekStarts) {
        await createWeeklyPartition(tableName, weekStart);
      }
    }

    console.log(
      `[Partition Manager] Ensured future partitions: ${futureWeeks} weeks ahead for ${PARTITIONED_TABLES.length} tables`
    );
  }

  /**
   * Drop partitions containing only data older than the retention period.
   * Returns the list of dropped partition names.
   */
  async function pruneExpiredPartitions(retentionDays: number): Promise<string[]> {
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retentionDays);
    cutoffDate.setUTCHours(0, 0, 0, 0);

    const droppedPartitions: string[] = [];

    for (const tableName of PARTITIONED_TABLES) {
      const partitions = await listPartitions(tableName);

      for (const partition of partitions) {
        // Only drop if the partition's range end is before the cutoff
        // (meaning ALL data in the partition is older than retention)
        if (partition.rangeEnd <= cutoffDate) {
          try {
            await pgClient.query(`DROP TABLE IF EXISTS ${partition.name}`, []);
            droppedPartitions.push(partition.name);
            console.log(
              `[Partition Manager] Dropped expired partition: ${partition.name} (range ended ${partition.rangeEnd.toISOString()})`
            );
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.warn(
              `[Partition Manager] Warning: Failed to drop partition ${partition.name}: ${err.message}`
            );
            // Log warning but continue with remaining partitions
          }
        }
      }
    }

    if (droppedPartitions.length > 0) {
      console.log(
        `[Partition Manager] Pruned ${droppedPartitions.length} expired partition(s)`
      );
    }

    return droppedPartitions;
  }

  /**
   * Verify partition coverage and create any missing partitions.
   * Checks from 1 week in the past through futureWeeks into the future.
   */
  async function verifyAndRepair(): Promise<PartitionStatus> {
    const now = new Date();
    const currentWeekStart = getWeekStart(now);

    // Check from 1 week ago to futureWeeks ahead
    const weekStarts: Date[] = [];
    const pastWeek = new Date(currentWeekStart);
    pastWeek.setUTCDate(pastWeek.getUTCDate() - 7);
    weekStarts.push(pastWeek);
    weekStarts.push(currentWeekStart);
    for (let i = 1; i <= futureWeeks; i++) {
      const futureWeek = new Date(currentWeekStart);
      futureWeek.setUTCDate(futureWeek.getUTCDate() + i * 7);
      weekStarts.push(futureWeek);
    }

    let missingPartitions = 0;
    const createdPartitions: string[] = [];

    for (const tableName of PARTITIONED_TABLES) {
      const existingPartitions = await listPartitions(tableName);
      const existingNames = new Set(existingPartitions.map((p) => p.name));

      for (const weekStart of weekStarts) {
        const expectedName = getPartitionName(tableName, weekStart);

        if (!existingNames.has(expectedName)) {
          missingPartitions++;
          const created = await createWeeklyPartition(tableName, weekStart);
          if (created) {
            createdPartitions.push(created);
          }
        }
      }
    }

    const healthy = missingPartitions === 0 || createdPartitions.length === missingPartitions;

    console.log(
      `[Partition Manager] Verify & Repair: healthy=${healthy}, missing=${missingPartitions}, created=${createdPartitions.length}`
    );

    return {
      healthy,
      missingPartitions,
      createdPartitions,
    };
  }

  /**
   * List all partitions for a given parent table with metadata.
   */
  async function listPartitions(tableName: string): Promise<PartitionInfo[]> {
    // Query pg_inherits and pg_class to find child partitions
    // and parse their range bounds from pg_catalog
    const rows = await pgClient.query<{
      partition_name: string;
      range_start: string;
      range_end: string;
      estimated_rows: string;
    }>(
      `SELECT
        c.relname AS partition_name,
        pg_get_expr(c.relpartbound, c.oid) AS partition_bounds,
        c.reltuples::bigint AS estimated_rows
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = parent.relnamespace
      WHERE n.nspname || '.' || parent.relname = $1
      ORDER BY c.relname`,
      [tableName]
    );

    return rows.map((row) => {
      const bounds = parseBounds((row as any).partition_bounds ?? '');
      return {
        name: row.partition_name,
        rangeStart: bounds.start,
        rangeEnd: bounds.end,
        estimatedRows: Math.max(0, Number((row as any).estimated_rows) || 0),
      };
    });
  }

  /**
   * Parse the partition bound expression from PostgreSQL.
   * Format: "FOR VALUES FROM ('2024-01-01T00:00:00.000Z') TO ('2024-01-08T00:00:00.000Z')"
   */
  function parseBounds(expr: string): { start: Date; end: Date } {
    const defaultBounds = { start: new Date(0), end: new Date(0) };

    if (!expr) return defaultBounds;

    // Match the FROM/TO timestamps in the partition bound expression
    const match = expr.match(
      /FROM \('([^']+)'\) TO \('([^']+)'\)/i
    );

    if (!match) return defaultBounds;

    const start = new Date(match[1]);
    const end = new Date(match[2]);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return defaultBounds;
    }

    return { start, end };
  }

  return {
    ensureFuturePartitions,
    pruneExpiredPartitions,
    verifyAndRepair,
    listPartitions,
  };
}

// Export internals for testing
export const _internals = {
  getWeekStart,
  formatPartitionSuffix,
  getPartitionName,
  PARTITIONED_TABLES,
};
