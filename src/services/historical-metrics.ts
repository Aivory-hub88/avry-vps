/**
 * Historical Metrics Service
 *
 * Manages time-series data storage and retrieval for system metrics
 * in the `monitoring` PostgreSQL schema. Supports resolution-based
 * aggregation, time range filtering, automatic purging of old records,
 * and partition management for weekly time partitions.
 *
 * V2 extensions add tiered resolution support (30s/5m/1h), per-container
 * filtering, and auto-resolution selection based on time range.
 *
 * @module services/historical-metrics
 * @validates Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 18.1, 18.2, 18.3, 18.4, 18.5, 4.3
 */
import type { PgClient } from '../database/pg-client.js';
import { ensureFuturePartitions } from '../database/migrations.js';
import type { SystemMetricsResponse } from './metrics-collector.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HistoryQueryParams {
  start: string;       // ISO 8601
  end: string;         // ISO 8601
  resolution?: '1m' | '5m' | '15m' | '1h';
}

export interface TimeSeriesDataPoint {
  timestamp: string;
  cpu: { usagePercent: number };
  memory: { usedBytes: number; totalBytes: number };
  disk: { usedBytes: number; totalBytes: number };
  network: { rxBytesPerSec: number; txBytesPerSec: number };
}

// ─── V2 Types (Tiered Resolution Support) ────────────────────────────────────

export type ResolutionV2 = '30s' | '5m' | '1h';

export interface HistoryQueryParamsV2 {
  start: string;       // ISO 8601
  end: string;         // ISO 8601
  resolution?: ResolutionV2;
  containerId?: string;
}

export interface TimeSeriesDataPointV2 {
  timestamp: string;
  cpu: { usagePercent: number; maxPercent?: number };
  memory: { usedBytes: number; totalBytes: number; maxUsedBytes?: number };
  disk: { usedBytes: number; totalBytes: number; maxUsedBytes?: number };
  network: { rxBytesPerSec: number; txBytesPerSec: number };
}

export interface HistoricalMetricsService {
  store(metrics: SystemMetricsResponse): Promise<void>;
  query(params: HistoryQueryParams): Promise<TimeSeriesDataPoint[]>;
  queryV2(params: HistoryQueryParamsV2): Promise<TimeSeriesDataPointV2[]>;
  purgeOldRecords(): Promise<number>;
  ensurePartitions(): Promise<void>;
}

// ─── Error class ─────────────────────────────────────────────────────────────

export class HistoricalMetricsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'HistoricalMetricsError';
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum time range (in milliseconds) before auto-downsampling to 5m resolution */
const AUTO_DOWNSAMPLE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Valid resolution values (V1) */
const VALID_RESOLUTIONS = ['1m', '5m', '15m', '1h'] as const;

/** Valid resolution values (V2 - tiered retention) */
const VALID_RESOLUTIONS_V2: ResolutionV2[] = ['30s', '5m', '1h'];

/** 24 hours in milliseconds — boundary between raw and 5m */
const RANGE_24H_MS = 24 * 60 * 60 * 1000;

/** 30 days in milliseconds — boundary between 5m and 1h */
const RANGE_30D_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate that a string is a valid ISO 8601 timestamp.
 * Returns true if valid, false otherwise.
 */
function isValidISO8601(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return !isNaN(parsed);
}

/**
 * Build the time-bucket SQL expression for a given resolution.
 * - 1m: truncate to minute
 * - 5m: truncate to nearest 5-minute boundary
 * - 15m: truncate to nearest 15-minute boundary
 * - 1h: truncate to hour
 */
function buildTimeBucketExpression(resolution: '1m' | '5m' | '15m' | '1h'): string {
  switch (resolution) {
    case '1m':
      return `date_trunc('minute', timestamp)`;
    case '5m':
      return `date_trunc('hour', timestamp) + INTERVAL '5 min' * FLOOR(EXTRACT(MINUTE FROM timestamp) / 5)`;
    case '15m':
      return `date_trunc('hour', timestamp) + INTERVAL '15 min' * FLOOR(EXTRACT(MINUTE FROM timestamp) / 15)`;
    case '1h':
      return `date_trunc('hour', timestamp)`;
  }
}

// ─── V2 Helpers ──────────────────────────────────────────────────────────────

/**
 * Determine the effective resolution for a V2 query based on time range.
 *
 * Auto-resolution logic:
 * - Range ≤ 24h, no explicit resolution → '30s' (raw data)
 * - Range > 24h and ≤ 30 days, no explicit resolution → '5m' (aggregated)
 * - Range > 30 days, no explicit resolution → '1h' (aggregated)
 * - An explicitly provided resolution always overrides auto-selection
 *
 * @validates Requirements 18.2, 18.3
 */
export function selectResolutionV2(rangeMs: number, explicit?: ResolutionV2): ResolutionV2 {
  if (explicit) {
    return explicit;
  }

  if (rangeMs <= RANGE_24H_MS) {
    return '30s';
  }

  if (rangeMs <= RANGE_30D_MS) {
    return '5m';
  }

  return '1h';
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Create a new HistoricalMetricsService instance.
 *
 * @param pgClient - Connected PgClient instance for database operations
 */
export function createHistoricalMetricsService(pgClient: PgClient): HistoricalMetricsService {

  /**
   * Store a system metrics snapshot into monitoring.system_metrics.
   */
  async function store(metrics: SystemMetricsResponse): Promise<void> {
    await pgClient.query(
      `INSERT INTO monitoring.system_metrics (
        timestamp,
        cpu_usage_percent,
        memory_used_bytes,
        memory_total_bytes,
        disk_used_bytes,
        disk_total_bytes,
        network_rx_bytes_per_sec,
        network_tx_bytes_per_sec
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        metrics.timestamp,
        metrics.cpu.usagePercent,
        metrics.memory.usedBytes,
        metrics.memory.totalBytes,
        metrics.disk.usedBytes,
        metrics.disk.totalBytes,
        metrics.network.rxBytesPerSec,
        metrics.network.txBytesPerSec,
      ]
    );
  }

  /**
   * Query historical metrics with time range filtering and optional resolution aggregation.
   *
   * - Validates start/end as ISO 8601 (returns 400 on invalid)
   * - When range > 24h and no resolution specified, defaults to '5m'
   * - Aggregates using PostgreSQL time bucket grouping with AVG
   */
  async function query(params: HistoryQueryParams): Promise<TimeSeriesDataPoint[]> {
    const { start, end, resolution } = params;

    // Validate start parameter
    if (!isValidISO8601(start)) {
      throw new HistoricalMetricsError(
        'Invalid "start" parameter: must be a valid ISO 8601 timestamp',
        'INVALID_PARAMS',
        400
      );
    }

    // Validate end parameter
    if (!isValidISO8601(end)) {
      throw new HistoricalMetricsError(
        'Invalid "end" parameter: must be a valid ISO 8601 timestamp',
        'INVALID_PARAMS',
        400
      );
    }

    // Validate resolution if provided
    if (resolution && !VALID_RESOLUTIONS.includes(resolution)) {
      throw new HistoricalMetricsError(
        `Invalid "resolution" parameter: must be one of ${VALID_RESOLUTIONS.join(', ')}`,
        'INVALID_PARAMS',
        400
      );
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    const rangeMs = endDate.getTime() - startDate.getTime();

    // Determine effective resolution
    let effectiveResolution = resolution;
    if (!effectiveResolution && rangeMs > AUTO_DOWNSAMPLE_THRESHOLD_MS) {
      effectiveResolution = '5m';
    }

    // Build query based on whether aggregation is needed
    let sql: string;
    const queryParams = [startDate.toISOString(), endDate.toISOString()];

    if (effectiveResolution) {
      const bucketExpr = buildTimeBucketExpression(effectiveResolution);

      sql = `
        SELECT
          ${bucketExpr} AS bucket,
          AVG(cpu_usage_percent) AS cpu_usage_percent,
          AVG(memory_used_bytes)::BIGINT AS memory_used_bytes,
          AVG(memory_total_bytes)::BIGINT AS memory_total_bytes,
          AVG(disk_used_bytes)::BIGINT AS disk_used_bytes,
          AVG(disk_total_bytes)::BIGINT AS disk_total_bytes,
          AVG(network_rx_bytes_per_sec)::BIGINT AS network_rx_bytes_per_sec,
          AVG(network_tx_bytes_per_sec)::BIGINT AS network_tx_bytes_per_sec
        FROM monitoring.system_metrics
        WHERE timestamp >= $1 AND timestamp <= $2
        GROUP BY bucket
        ORDER BY bucket ASC
      `;
    } else {
      // No aggregation — return raw data points
      sql = `
        SELECT
          timestamp AS bucket,
          cpu_usage_percent,
          memory_used_bytes,
          memory_total_bytes,
          disk_used_bytes,
          disk_total_bytes,
          network_rx_bytes_per_sec,
          network_tx_bytes_per_sec
        FROM monitoring.system_metrics
        WHERE timestamp >= $1 AND timestamp <= $2
        ORDER BY timestamp ASC
      `;
    }

    interface MetricsRow {
      bucket: Date | string;
      cpu_usage_percent: number;
      memory_used_bytes: number | string;
      memory_total_bytes: number | string;
      disk_used_bytes: number | string;
      disk_total_bytes: number | string;
      network_rx_bytes_per_sec: number | string;
      network_tx_bytes_per_sec: number | string;
    }

    const rows = await pgClient.query<MetricsRow>(sql, queryParams);

    return rows.map((row) => ({
      timestamp: row.bucket instanceof Date
        ? row.bucket.toISOString()
        : new Date(row.bucket).toISOString(),
      cpu: { usagePercent: Math.round(Number(row.cpu_usage_percent) * 100) / 100 },
      memory: {
        usedBytes: Number(row.memory_used_bytes),
        totalBytes: Number(row.memory_total_bytes),
      },
      disk: {
        usedBytes: Number(row.disk_used_bytes),
        totalBytes: Number(row.disk_total_bytes),
      },
      network: {
        rxBytesPerSec: Number(row.network_rx_bytes_per_sec),
        txBytesPerSec: Number(row.network_tx_bytes_per_sec),
      },
    }));
  }

  /**
   * Purge records older than 7 days from monitoring.system_metrics.
   * Returns the number of deleted records.
   */
  async function purgeOldRecords(): Promise<number> {
    interface DeleteResult {
      count: string;
    }

    const rows = await pgClient.query<DeleteResult>(
      `WITH deleted AS (
        DELETE FROM monitoring.system_metrics
        WHERE timestamp < NOW() - INTERVAL '7 days'
        RETURNING 1
      )
      SELECT COUNT(*)::TEXT AS count FROM deleted`
    );

    return parseInt(rows[0]?.count ?? '0', 10);
  }

  /**
   * Ensure future weekly partitions exist.
   * Delegates to the migrations module's ensureFuturePartitions function.
   */
  async function ensurePartitionsHandler(): Promise<void> {
    await ensureFuturePartitions(pgClient);
  }

  // ─── V2 Query Implementation ────────────────────────────────────────────────

  /**
   * Query historical metrics with V2 tiered resolution support.
   *
   * - Validates start/end as ISO 8601
   * - Supports resolution values: '30s', '5m', '1h'
   * - Auto-selects resolution based on time range if not specified
   * - Queries the correct table based on effective resolution
   * - Supports container_id filtering across all tiers
   * - Returns avg + max values for aggregated tiers (5m, 1h)
   *
   * @validates Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 4.3
   */
  async function queryV2(params: HistoryQueryParamsV2): Promise<TimeSeriesDataPointV2[]> {
    const { start, end, resolution, containerId } = params;

    // Validate start parameter
    if (!isValidISO8601(start)) {
      throw new HistoricalMetricsError(
        'Invalid "start" parameter: must be a valid ISO 8601 timestamp',
        'INVALID_PARAMS',
        400
      );
    }

    // Validate end parameter
    if (!isValidISO8601(end)) {
      throw new HistoricalMetricsError(
        'Invalid "end" parameter: must be a valid ISO 8601 timestamp',
        'INVALID_PARAMS',
        400
      );
    }

    // Validate resolution if provided
    if (resolution && !VALID_RESOLUTIONS_V2.includes(resolution)) {
      throw new HistoricalMetricsError(
        `Invalid "resolution" parameter: must be one of ${VALID_RESOLUTIONS_V2.join(', ')}`,
        'INVALID_PARAMS',
        400
      );
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    const rangeMs = endDate.getTime() - startDate.getTime();

    // Determine effective resolution using auto-selection logic
    const effectiveResolution = selectResolutionV2(rangeMs, resolution);

    // Route to the appropriate query based on resolution and container filter
    if (containerId) {
      return queryContainerV2(startDate, endDate, effectiveResolution, containerId);
    }

    return querySystemV2(startDate, endDate, effectiveResolution);
  }

  /**
   * Query system-level metrics from the appropriate table.
   */
  async function querySystemV2(
    startDate: Date,
    endDate: Date,
    resolution: ResolutionV2
  ): Promise<TimeSeriesDataPointV2[]> {
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    if (resolution === '30s') {
      // Raw data from monitoring.system_metrics
      interface RawRow {
        timestamp: Date | string;
        cpu_usage_percent: number;
        memory_used_bytes: number | string;
        memory_total_bytes: number | string;
        disk_used_bytes: number | string;
        disk_total_bytes: number | string;
        network_rx_bytes_per_sec: number | string;
        network_tx_bytes_per_sec: number | string;
      }

      const rows = await pgClient.query<RawRow>(
        `SELECT
          timestamp,
          cpu_usage_percent,
          memory_used_bytes,
          memory_total_bytes,
          disk_used_bytes,
          disk_total_bytes,
          network_rx_bytes_per_sec,
          network_tx_bytes_per_sec
        FROM monitoring.system_metrics
        WHERE timestamp >= $1 AND timestamp <= $2
        ORDER BY timestamp ASC`,
        [startIso, endIso]
      );

      return rows.map((row) => ({
        timestamp: row.timestamp instanceof Date
          ? row.timestamp.toISOString()
          : new Date(row.timestamp).toISOString(),
        cpu: { usagePercent: Math.round(Number(row.cpu_usage_percent) * 100) / 100 },
        memory: {
          usedBytes: Number(row.memory_used_bytes),
          totalBytes: Number(row.memory_total_bytes),
        },
        disk: {
          usedBytes: Number(row.disk_used_bytes),
          totalBytes: Number(row.disk_total_bytes),
        },
        network: {
          rxBytesPerSec: Number(row.network_rx_bytes_per_sec),
          txBytesPerSec: Number(row.network_tx_bytes_per_sec),
        },
      }));
    }

    // Aggregated data from system_metrics_5m or system_metrics_1h
    const table = resolution === '5m'
      ? 'monitoring.system_metrics_5m'
      : 'monitoring.system_metrics_1h';

    interface AggRow {
      bucket_start: Date | string;
      cpu_usage_percent_avg: number;
      cpu_usage_percent_max: number;
      memory_used_bytes_avg: number | string;
      memory_used_bytes_max: number | string;
      memory_total_bytes: number | string;
      disk_used_bytes_avg: number | string;
      disk_used_bytes_max: number | string;
      disk_total_bytes: number | string;
      network_rx_bytes_per_sec_avg: number | string;
      network_tx_bytes_per_sec_avg: number | string;
    }

    const rows = await pgClient.query<AggRow>(
      `SELECT
        bucket_start,
        cpu_usage_percent_avg,
        cpu_usage_percent_max,
        memory_used_bytes_avg,
        memory_used_bytes_max,
        memory_total_bytes,
        disk_used_bytes_avg,
        disk_used_bytes_max,
        disk_total_bytes,
        network_rx_bytes_per_sec_avg,
        network_tx_bytes_per_sec_avg
      FROM ${table}
      WHERE bucket_start >= $1 AND bucket_start <= $2
      ORDER BY bucket_start ASC`,
      [startIso, endIso]
    );

    return rows.map((row) => ({
      timestamp: row.bucket_start instanceof Date
        ? row.bucket_start.toISOString()
        : new Date(row.bucket_start).toISOString(),
      cpu: {
        usagePercent: Math.round(Number(row.cpu_usage_percent_avg) * 100) / 100,
        maxPercent: Math.round(Number(row.cpu_usage_percent_max) * 100) / 100,
      },
      memory: {
        usedBytes: Number(row.memory_used_bytes_avg),
        totalBytes: Number(row.memory_total_bytes),
        maxUsedBytes: Number(row.memory_used_bytes_max),
      },
      disk: {
        usedBytes: Number(row.disk_used_bytes_avg),
        totalBytes: Number(row.disk_total_bytes),
        maxUsedBytes: Number(row.disk_used_bytes_max),
      },
      network: {
        rxBytesPerSec: Number(row.network_rx_bytes_per_sec_avg),
        txBytesPerSec: Number(row.network_tx_bytes_per_sec_avg),
      },
    }));
  }

  /**
   * Query per-container metrics from the appropriate table.
   *
   * - '30s': queries monitoring.container_snapshots
   * - '5m': queries monitoring.container_metrics_5m
   * - '1h': not available for containers (falls back to 5m with wider range)
   *
   * @validates Requirements 4.3, 18.4
   */
  async function queryContainerV2(
    startDate: Date,
    endDate: Date,
    resolution: ResolutionV2,
    containerId: string
  ): Promise<TimeSeriesDataPointV2[]> {
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    if (resolution === '30s') {
      // Raw container data from monitoring.container_snapshots
      interface ContainerRawRow {
        timestamp: Date | string;
        cpu_usage_percent: number;
        memory_used_bytes: number | string;
        memory_limit_bytes: number | string;
        network_rx_bytes: number | string;
        network_tx_bytes: number | string;
      }

      const rows = await pgClient.query<ContainerRawRow>(
        `SELECT
          timestamp,
          cpu_usage_percent,
          memory_used_bytes,
          memory_limit_bytes,
          network_rx_bytes,
          network_tx_bytes
        FROM monitoring.container_snapshots
        WHERE timestamp >= $1 AND timestamp <= $2
          AND container_id = $3
        ORDER BY timestamp ASC`,
        [startIso, endIso, containerId]
      );

      return rows.map((row) => ({
        timestamp: row.timestamp instanceof Date
          ? row.timestamp.toISOString()
          : new Date(row.timestamp).toISOString(),
        cpu: { usagePercent: Math.round(Number(row.cpu_usage_percent) * 100) / 100 },
        memory: {
          usedBytes: Number(row.memory_used_bytes),
          totalBytes: Number(row.memory_limit_bytes),
        },
        disk: {
          usedBytes: 0,
          totalBytes: 0,
        },
        network: {
          rxBytesPerSec: Number(row.network_rx_bytes),
          txBytesPerSec: Number(row.network_tx_bytes),
        },
      }));
    }

    // Aggregated container data from container_metrics_5m
    // For '1h' resolution, we still use container_metrics_5m (no 1h container table)
    interface ContainerAggRow {
      bucket_start: Date | string;
      cpu_usage_percent_avg: number;
      cpu_usage_percent_max: number;
      memory_used_bytes_avg: number | string;
      memory_used_bytes_max: number | string;
      memory_limit_bytes: number | string;
    }

    const rows = await pgClient.query<ContainerAggRow>(
      `SELECT
        bucket_start,
        cpu_usage_percent_avg,
        cpu_usage_percent_max,
        memory_used_bytes_avg,
        memory_used_bytes_max,
        memory_limit_bytes
      FROM monitoring.container_metrics_5m
      WHERE bucket_start >= $1 AND bucket_start <= $2
        AND container_id = $3
      ORDER BY bucket_start ASC`,
      [startIso, endIso, containerId]
    );

    return rows.map((row) => ({
      timestamp: row.bucket_start instanceof Date
        ? row.bucket_start.toISOString()
        : new Date(row.bucket_start).toISOString(),
      cpu: {
        usagePercent: Math.round(Number(row.cpu_usage_percent_avg) * 100) / 100,
        maxPercent: Math.round(Number(row.cpu_usage_percent_max) * 100) / 100,
      },
      memory: {
        usedBytes: Number(row.memory_used_bytes_avg),
        totalBytes: Number(row.memory_limit_bytes),
        maxUsedBytes: Number(row.memory_used_bytes_max),
      },
      disk: {
        usedBytes: 0,
        totalBytes: 0,
      },
      network: {
        rxBytesPerSec: 0,
        txBytesPerSec: 0,
      },
    }));
  }

  // ─── Return the public API ─────────────────────────────────────────────────

  return {
    store,
    query,
    queryV2,
    purgeOldRecords,
    ensurePartitions: ensurePartitionsHandler,
  };
}
