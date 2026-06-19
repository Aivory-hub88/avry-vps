/**
 * Downsampling Engine
 *
 * Responsible for tiered data aggregation of raw metrics into coarser
 * time-bucket resolutions as data ages. Runs on a configurable schedule
 * (Tier 1 every hour, Tier 2 every 24 hours) and purges expired data.
 *
 * Process per tier:
 *   1. SELECT raw data in time batches
 *   2. INSERT aggregated buckets (avg + max)
 *   3. DELETE aggregated source data
 *
 * On batch failure: log error, do NOT delete raw data, skip batch, continue.
 *
 * @module services/downsampling-engine
 * @validates Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
 */
import type { PgClient } from '../database/pg-client.js';
import type { SettingsService } from './settings-service.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AggregationResult {
  bucketsCreated: number;
  rawPointsDeleted: number;
  errors: AggregationError[];
}

export interface AggregationError {
  batchStart: string;
  batchEnd: string;
  message: string;
}

export interface DownsamplingEngine {
  /** Run Tier 1 aggregation: raw (30s) → 5-minute buckets for data >24h old */
  aggregateTier1(): Promise<AggregationResult>;
  /** Run Tier 2 aggregation: 5-min → 1-hour buckets for data >30 days old */
  aggregateTier2(): Promise<AggregationResult>;
  /** Purge 1-hour data older than 365 days */
  purgeExpiredHourly(): Promise<number>;
  /** Start the scheduled aggregation loop */
  start(): void;
  /** Stop the scheduled aggregation loop */
  stop(): void;
}

export interface DownsamplingEngineOptions {
  /** Tier 1 schedule interval in ms (default: 1 hour) */
  tier1IntervalMs?: number;
  /** Tier 2 schedule interval in ms (default: 24 hours) */
  tier2IntervalMs?: number;
  /** Batch size in minutes for Tier 1 processing (default: 60 minutes per batch) */
  tier1BatchMinutes?: number;
  /** Batch size in hours for Tier 2 processing (default: 24 hours per batch) */
  tier2BatchHours?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TIER1_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_TIER2_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_TIER1_BATCH_MINUTES = 60; // Process 60 minutes per batch
const DEFAULT_TIER2_BATCH_HOURS = 24; // Process 24 hours per batch

const DEFAULT_RETENTION_RAW_HOURS = 24;
const DEFAULT_RETENTION_5M_DAYS = 30;
const DEFAULT_RETENTION_1H_DAYS = 365;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Align a timestamp to the nearest 5-minute bucket boundary (floor).
 * Bucket boundaries: minutes divisible by 5, seconds/ms = 0.
 */
export function alignTo5MinBucket(date: Date): Date {
  const aligned = new Date(date);
  const minutes = aligned.getUTCMinutes();
  const alignedMinutes = Math.floor(minutes / 5) * 5;
  aligned.setUTCMinutes(alignedMinutes, 0, 0);
  return aligned;
}

/**
 * Align a timestamp to the nearest 1-hour bucket boundary (floor).
 * Bucket boundaries: full hours, minutes/seconds/ms = 0.
 */
export function alignTo1HourBucket(date: Date): Date {
  const aligned = new Date(date);
  aligned.setUTCMinutes(0, 0, 0);
  return aligned;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Create a new DownsamplingEngine instance.
 *
 * @param pgClient - Connected PgClient instance for database operations
 * @param settingsService - Optional SettingsService for reading retention settings
 * @param options - Optional scheduling and batching configuration
 */
export function createDownsamplingEngine(
  pgClient: PgClient,
  settingsService?: SettingsService,
  options?: DownsamplingEngineOptions
): DownsamplingEngine {
  const tier1IntervalMs = options?.tier1IntervalMs ?? DEFAULT_TIER1_INTERVAL_MS;
  const tier2IntervalMs = options?.tier2IntervalMs ?? DEFAULT_TIER2_INTERVAL_MS;
  const tier1BatchMinutes = options?.tier1BatchMinutes ?? DEFAULT_TIER1_BATCH_MINUTES;
  const tier2BatchHours = options?.tier2BatchHours ?? DEFAULT_TIER2_BATCH_HOURS;

  let tier1Timer: ReturnType<typeof setInterval> | null = null;
  let tier2Timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Read retention settings from the SettingsService, falling back to defaults.
   */
  async function getRetentionRawHours(): Promise<number> {
    if (!settingsService) return DEFAULT_RETENTION_RAW_HOURS;
    try {
      return await settingsService.getTyped<number>('retention_raw_hours');
    } catch {
      return DEFAULT_RETENTION_RAW_HOURS;
    }
  }

  async function getRetention5mDays(): Promise<number> {
    if (!settingsService) return DEFAULT_RETENTION_5M_DAYS;
    try {
      return await settingsService.getTyped<number>('retention_5m_days');
    } catch {
      return DEFAULT_RETENTION_5M_DAYS;
    }
  }

  async function getRetention1hDays(): Promise<number> {
    if (!settingsService) return DEFAULT_RETENTION_1H_DAYS;
    try {
      return await settingsService.getTyped<number>('retention_1h_days');
    } catch {
      return DEFAULT_RETENTION_1H_DAYS;
    }
  }

  /**
   * Tier 1 Aggregation: raw (30s) → 5-minute buckets for data older than 24h.
   *
   * Process:
   * 1. Determine the time boundary (now - retention_raw_hours)
   * 2. Find the oldest raw data timestamp
   * 3. Process in batches (default 60 minutes per batch)
   * 4. For each batch: aggregate into 5-min buckets, then delete source data
   */
  async function aggregateTier1(): Promise<AggregationResult> {
    const retentionHours = await getRetentionRawHours();
    const result: AggregationResult = { bucketsCreated: 0, rawPointsDeleted: 0, errors: [] };

    // Cutoff: data older than this should be aggregated
    const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);

    // Find the oldest raw data point that hasn't been aggregated yet
    const oldestRows = await pgClient.query<{ oldest: Date | string }>(
      `SELECT MIN(timestamp) AS oldest FROM monitoring.system_metrics WHERE timestamp < $1`,
      [cutoff.toISOString()]
    );

    const oldestTimestamp = oldestRows[0]?.oldest;
    if (!oldestTimestamp) {
      // No data to aggregate
      return result;
    }

    const batchStart = alignTo5MinBucket(new Date(oldestTimestamp));
    const batchEndLimit = alignTo5MinBucket(cutoff);

    // Process in batches
    let currentBatchStart = new Date(batchStart);
    const batchSizeMs = tier1BatchMinutes * 60 * 1000;

    while (currentBatchStart < batchEndLimit) {
      const currentBatchEnd = new Date(
        Math.min(currentBatchStart.getTime() + batchSizeMs, batchEndLimit.getTime())
      );

      try {
        const batchResult = await aggregateTier1Batch(
          currentBatchStart.toISOString(),
          currentBatchEnd.toISOString()
        );
        result.bucketsCreated += batchResult.bucketsCreated;
        result.rawPointsDeleted += batchResult.rawPointsDeleted;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `[DownsamplingEngine] Tier 1 batch failed [${currentBatchStart.toISOString()} - ${currentBatchEnd.toISOString()}]: ${errorMessage}`
        );
        result.errors.push({
          batchStart: currentBatchStart.toISOString(),
          batchEnd: currentBatchEnd.toISOString(),
          message: errorMessage,
        });
        // Skip batch, continue with next (no data loss — raw data NOT deleted)
      }

      currentBatchStart = currentBatchEnd;
    }

    return result;
  }

  /**
   * Process a single Tier 1 batch: aggregate raw data into 5-min buckets.
   */
  async function aggregateTier1Batch(
    batchStartIso: string,
    batchEndIso: string
  ): Promise<{ bucketsCreated: number; rawPointsDeleted: number }> {
    // Aggregate raw data into 5-minute buckets within the batch range
    interface AggRow {
      bucket_start: Date | string;
      cpu_usage_percent_avg: number;
      cpu_usage_percent_max: number;
      memory_used_bytes_avg: string | number;
      memory_used_bytes_max: string | number;
      memory_total_bytes: string | number;
      disk_used_bytes_avg: string | number;
      disk_used_bytes_max: string | number;
      disk_total_bytes: string | number;
      network_rx_bytes_per_sec_avg: string | number;
      network_tx_bytes_per_sec_avg: string | number;
      sample_count: number;
    }

    const aggregated = await pgClient.query<AggRow>(
      `SELECT
        date_trunc('hour', timestamp) + INTERVAL '5 min' * FLOOR(EXTRACT(MINUTE FROM timestamp) / 5) AS bucket_start,
        AVG(cpu_usage_percent)::REAL AS cpu_usage_percent_avg,
        MAX(cpu_usage_percent)::REAL AS cpu_usage_percent_max,
        AVG(memory_used_bytes)::BIGINT AS memory_used_bytes_avg,
        MAX(memory_used_bytes)::BIGINT AS memory_used_bytes_max,
        MAX(memory_total_bytes)::BIGINT AS memory_total_bytes,
        AVG(disk_used_bytes)::BIGINT AS disk_used_bytes_avg,
        MAX(disk_used_bytes)::BIGINT AS disk_used_bytes_max,
        MAX(disk_total_bytes)::BIGINT AS disk_total_bytes,
        AVG(network_rx_bytes_per_sec)::BIGINT AS network_rx_bytes_per_sec_avg,
        AVG(network_tx_bytes_per_sec)::BIGINT AS network_tx_bytes_per_sec_avg,
        COUNT(*)::INTEGER AS sample_count
      FROM monitoring.system_metrics
      WHERE timestamp >= $1 AND timestamp < $2
      GROUP BY bucket_start
      ORDER BY bucket_start ASC`,
      [batchStartIso, batchEndIso]
    );

    if (aggregated.length === 0) {
      // No data in this batch — still delete any stragglers
      const deleteResult = await pgClient.query<{ count: string }>(
        `WITH deleted AS (
          DELETE FROM monitoring.system_metrics
          WHERE timestamp >= $1 AND timestamp < $2
          RETURNING 1
        ) SELECT COUNT(*)::TEXT AS count FROM deleted`,
        [batchStartIso, batchEndIso]
      );
      return { bucketsCreated: 0, rawPointsDeleted: parseInt(deleteResult[0]?.count ?? '0', 10) };
    }

    // Insert aggregated buckets
    for (const row of aggregated) {
      const bucketStart = row.bucket_start instanceof Date
        ? row.bucket_start.toISOString()
        : new Date(row.bucket_start).toISOString();

      await pgClient.query(
        `INSERT INTO monitoring.system_metrics_5m (
          bucket_start, cpu_usage_percent_avg, cpu_usage_percent_max,
          memory_used_bytes_avg, memory_used_bytes_max, memory_total_bytes,
          disk_used_bytes_avg, disk_used_bytes_max, disk_total_bytes,
          network_rx_bytes_per_sec_avg, network_tx_bytes_per_sec_avg, sample_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          bucketStart,
          row.cpu_usage_percent_avg,
          row.cpu_usage_percent_max,
          Number(row.memory_used_bytes_avg),
          Number(row.memory_used_bytes_max),
          Number(row.memory_total_bytes),
          Number(row.disk_used_bytes_avg),
          Number(row.disk_used_bytes_max),
          Number(row.disk_total_bytes),
          Number(row.network_rx_bytes_per_sec_avg),
          Number(row.network_tx_bytes_per_sec_avg),
          row.sample_count,
        ]
      );
    }

    // Delete aggregated raw data
    const deleteResult = await pgClient.query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM monitoring.system_metrics
        WHERE timestamp >= $1 AND timestamp < $2
        RETURNING 1
      ) SELECT COUNT(*)::TEXT AS count FROM deleted`,
      [batchStartIso, batchEndIso]
    );

    return {
      bucketsCreated: aggregated.length,
      rawPointsDeleted: parseInt(deleteResult[0]?.count ?? '0', 10),
    };
  }

  /**
   * Tier 2 Aggregation: 5-min → 1-hour buckets for data older than 30 days.
   *
   * Process:
   * 1. Determine the time boundary (now - retention_5m_days)
   * 2. Find the oldest 5-min data timestamp
   * 3. Process in batches (default 24 hours per batch)
   * 4. For each batch: aggregate into 1-hour buckets, then delete source 5-min data
   */
  async function aggregateTier2(): Promise<AggregationResult> {
    const retentionDays = await getRetention5mDays();
    const result: AggregationResult = { bucketsCreated: 0, rawPointsDeleted: 0, errors: [] };

    // Cutoff: 5-min data older than this should be aggregated
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Find the oldest 5-min data point
    const oldestRows = await pgClient.query<{ oldest: Date | string }>(
      `SELECT MIN(bucket_start) AS oldest FROM monitoring.system_metrics_5m WHERE bucket_start < $1`,
      [cutoff.toISOString()]
    );

    const oldestTimestamp = oldestRows[0]?.oldest;
    if (!oldestTimestamp) {
      return result;
    }

    const batchStart = alignTo1HourBucket(new Date(oldestTimestamp));
    const batchEndLimit = alignTo1HourBucket(cutoff);

    // Process in batches
    let currentBatchStart = new Date(batchStart);
    const batchSizeMs = tier2BatchHours * 60 * 60 * 1000;

    while (currentBatchStart < batchEndLimit) {
      const currentBatchEnd = new Date(
        Math.min(currentBatchStart.getTime() + batchSizeMs, batchEndLimit.getTime())
      );

      try {
        const batchResult = await aggregateTier2Batch(
          currentBatchStart.toISOString(),
          currentBatchEnd.toISOString()
        );
        result.bucketsCreated += batchResult.bucketsCreated;
        result.rawPointsDeleted += batchResult.rawPointsDeleted;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `[DownsamplingEngine] Tier 2 batch failed [${currentBatchStart.toISOString()} - ${currentBatchEnd.toISOString()}]: ${errorMessage}`
        );
        result.errors.push({
          batchStart: currentBatchStart.toISOString(),
          batchEnd: currentBatchEnd.toISOString(),
          message: errorMessage,
        });
      }

      currentBatchStart = currentBatchEnd;
    }

    return result;
  }

  /**
   * Process a single Tier 2 batch: aggregate 5-min data into 1-hour buckets.
   */
  async function aggregateTier2Batch(
    batchStartIso: string,
    batchEndIso: string
  ): Promise<{ bucketsCreated: number; rawPointsDeleted: number }> {
    interface AggRow {
      bucket_start: Date | string;
      cpu_usage_percent_avg: number;
      cpu_usage_percent_max: number;
      memory_used_bytes_avg: string | number;
      memory_used_bytes_max: string | number;
      memory_total_bytes: string | number;
      disk_used_bytes_avg: string | number;
      disk_used_bytes_max: string | number;
      disk_total_bytes: string | number;
      network_rx_bytes_per_sec_avg: string | number;
      network_tx_bytes_per_sec_avg: string | number;
      total_sample_count: number;
    }

    // Aggregate 5-min data into 1-hour buckets using weighted average
    const aggregated = await pgClient.query<AggRow>(
      `SELECT
        date_trunc('hour', bucket_start) AS bucket_start,
        (SUM(cpu_usage_percent_avg * sample_count) / SUM(sample_count))::REAL AS cpu_usage_percent_avg,
        MAX(cpu_usage_percent_max)::REAL AS cpu_usage_percent_max,
        (SUM(memory_used_bytes_avg * sample_count) / SUM(sample_count))::BIGINT AS memory_used_bytes_avg,
        MAX(memory_used_bytes_max)::BIGINT AS memory_used_bytes_max,
        MAX(memory_total_bytes)::BIGINT AS memory_total_bytes,
        (SUM(disk_used_bytes_avg * sample_count) / SUM(sample_count))::BIGINT AS disk_used_bytes_avg,
        MAX(disk_used_bytes_max)::BIGINT AS disk_used_bytes_max,
        MAX(disk_total_bytes)::BIGINT AS disk_total_bytes,
        (SUM(network_rx_bytes_per_sec_avg * sample_count) / SUM(sample_count))::BIGINT AS network_rx_bytes_per_sec_avg,
        (SUM(network_tx_bytes_per_sec_avg * sample_count) / SUM(sample_count))::BIGINT AS network_tx_bytes_per_sec_avg,
        SUM(sample_count)::INTEGER AS total_sample_count
      FROM monitoring.system_metrics_5m
      WHERE bucket_start >= $1 AND bucket_start < $2
      GROUP BY date_trunc('hour', bucket_start)
      ORDER BY bucket_start ASC`,
      [batchStartIso, batchEndIso]
    );

    if (aggregated.length === 0) {
      const deleteResult = await pgClient.query<{ count: string }>(
        `WITH deleted AS (
          DELETE FROM monitoring.system_metrics_5m
          WHERE bucket_start >= $1 AND bucket_start < $2
          RETURNING 1
        ) SELECT COUNT(*)::TEXT AS count FROM deleted`,
        [batchStartIso, batchEndIso]
      );
      return { bucketsCreated: 0, rawPointsDeleted: parseInt(deleteResult[0]?.count ?? '0', 10) };
    }

    // Insert aggregated 1-hour buckets
    for (const row of aggregated) {
      const bucketStart = row.bucket_start instanceof Date
        ? row.bucket_start.toISOString()
        : new Date(row.bucket_start).toISOString();

      await pgClient.query(
        `INSERT INTO monitoring.system_metrics_1h (
          bucket_start, cpu_usage_percent_avg, cpu_usage_percent_max,
          memory_used_bytes_avg, memory_used_bytes_max, memory_total_bytes,
          disk_used_bytes_avg, disk_used_bytes_max, disk_total_bytes,
          network_rx_bytes_per_sec_avg, network_tx_bytes_per_sec_avg, sample_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          bucketStart,
          row.cpu_usage_percent_avg,
          row.cpu_usage_percent_max,
          Number(row.memory_used_bytes_avg),
          Number(row.memory_used_bytes_max),
          Number(row.memory_total_bytes),
          Number(row.disk_used_bytes_avg),
          Number(row.disk_used_bytes_max),
          Number(row.disk_total_bytes),
          Number(row.network_rx_bytes_per_sec_avg),
          Number(row.network_tx_bytes_per_sec_avg),
          row.total_sample_count,
        ]
      );
    }

    // Delete aggregated 5-min data
    const deleteResult = await pgClient.query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM monitoring.system_metrics_5m
        WHERE bucket_start >= $1 AND bucket_start < $2
        RETURNING 1
      ) SELECT COUNT(*)::TEXT AS count FROM deleted`,
      [batchStartIso, batchEndIso]
    );

    return {
      bucketsCreated: aggregated.length,
      rawPointsDeleted: parseInt(deleteResult[0]?.count ?? '0', 10),
    };
  }

  /**
   * Purge 1-hour data older than the configured retention (default 365 days).
   * Returns the number of deleted records.
   */
  async function purgeExpiredHourly(): Promise<number> {
    const retentionDays = await getRetention1hDays();

    const deleteResult = await pgClient.query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM monitoring.system_metrics_1h
        WHERE bucket_start < NOW() - ($1 || ' days')::INTERVAL
        RETURNING 1
      ) SELECT COUNT(*)::TEXT AS count FROM deleted`,
      [String(retentionDays)]
    );

    return parseInt(deleteResult[0]?.count ?? '0', 10);
  }

  /**
   * Start the scheduled aggregation loops.
   * - Tier 1 runs every hour (default)
   * - Tier 2 runs every 24 hours (default)
   */
  function start(): void {
    if (tier1Timer || tier2Timer) {
      console.warn('[DownsamplingEngine] Already running. Call stop() first.');
      return;
    }

    console.log(
      `[DownsamplingEngine] Starting scheduled aggregation (Tier 1: ${tier1IntervalMs}ms, Tier 2: ${tier2IntervalMs}ms)`
    );

    tier1Timer = setInterval(async () => {
      try {
        const result = await aggregateTier1();
        if (result.bucketsCreated > 0 || result.errors.length > 0) {
          console.log(
            `[DownsamplingEngine] Tier 1 complete: ${result.bucketsCreated} buckets created, ${result.rawPointsDeleted} raw points deleted, ${result.errors.length} errors`
          );
        }
      } catch (error) {
        console.error('[DownsamplingEngine] Tier 1 aggregation failed:', error);
      }
    }, tier1IntervalMs);

    tier2Timer = setInterval(async () => {
      try {
        const result = await aggregateTier2();
        if (result.bucketsCreated > 0 || result.errors.length > 0) {
          console.log(
            `[DownsamplingEngine] Tier 2 complete: ${result.bucketsCreated} buckets created, ${result.rawPointsDeleted} 5-min points deleted, ${result.errors.length} errors`
          );
        }

        // Also purge expired hourly data
        const purged = await purgeExpiredHourly();
        if (purged > 0) {
          console.log(`[DownsamplingEngine] Purged ${purged} expired 1-hour records`);
        }
      } catch (error) {
        console.error('[DownsamplingEngine] Tier 2 aggregation failed:', error);
      }
    }, tier2IntervalMs);
  }

  /**
   * Stop the scheduled aggregation loops.
   */
  function stop(): void {
    if (tier1Timer) {
      clearInterval(tier1Timer);
      tier1Timer = null;
    }
    if (tier2Timer) {
      clearInterval(tier2Timer);
      tier2Timer = null;
    }
    console.log('[DownsamplingEngine] Stopped');
  }

  return {
    aggregateTier1,
    aggregateTier2,
    purgeExpiredHourly,
    start,
    stop,
  };
}
