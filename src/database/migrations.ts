/**
 * PostgreSQL Schema Migrations
 *
 * Creates and manages the `vps_panel` and `monitoring` schemas in the shared
 * avry-postgres instance. Includes partitioned time-series tables for
 * system_metrics and container_snapshots with automatic weekly partition creation.
 *
 * Auto-runs on startup if schemas don't exist.
 *
 * @module database/migrations
 * @validates Requirements 11.1, 11.2, 11.3, 11.4, 11.5
 */
import type { PgClient } from './pg-client.js';

/**
 * Check if a PostgreSQL schema exists.
 */
async function schemaExists(pgClient: PgClient, schemaName: string): Promise<boolean> {
  const rows = await pgClient.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
    ) AS exists`,
    [schemaName]
  );
  return rows[0]?.exists ?? false;
}

/**
 * Check if a PostgreSQL table exists within a schema.
 */
async function tableExists(pgClient: PgClient, schemaName: string, tableName: string): Promise<boolean> {
  const rows = await pgClient.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) AS exists`,
    [schemaName, tableName]
  );
  return rows[0]?.exists ?? false;
}

/**
 * Generate the start-of-week (Monday 00:00 UTC) for a given date.
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  // Adjust to Monday (day 1). If Sunday (0), go back 6 days.
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
 * Create a weekly partition for a partitioned table if it doesn't already exist.
 */
async function createWeeklyPartition(
  pgClient: PgClient,
  tableName: string,
  weekStart: Date
): Promise<void> {
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  const suffix = formatPartitionSuffix(weekStart);
  const partitionName = `${tableName.replace('.', '_')}_${suffix}`;

  const fromStr = weekStart.toISOString();
  const toStr = weekEnd.toISOString();

  // Use IF NOT EXISTS to make this idempotent
  await pgClient.query(
    `CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF ${tableName}
     FOR VALUES FROM ('${fromStr}') TO ('${toStr}')`,
    []
  );
}

/**
 * Create initial weekly partitions for the current week, the previous week,
 * and the next 2 weeks (4 total partitions for coverage).
 */
async function createInitialPartitions(pgClient: PgClient, tableName: string): Promise<void> {
  const now = new Date();
  const currentWeekStart = getWeekStart(now);

  // Previous week
  const prevWeek = new Date(currentWeekStart);
  prevWeek.setUTCDate(prevWeek.getUTCDate() - 7);

  // Next week
  const nextWeek = new Date(currentWeekStart);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);

  // Two weeks ahead
  const twoWeeksAhead = new Date(currentWeekStart);
  twoWeeksAhead.setUTCDate(twoWeeksAhead.getUTCDate() + 14);

  const partitionStarts = [prevWeek, currentWeekStart, nextWeek, twoWeeksAhead];

  for (const weekStart of partitionStarts) {
    await createWeeklyPartition(pgClient, tableName, weekStart);
  }
}

/**
 * SQL to create the `vps_panel` schema and its tables.
 */
const VPS_PANEL_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS vps_panel;

CREATE TABLE IF NOT EXISTS vps_panel.project_registry (
    id VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(255) NOT NULL,
    patterns JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/**
 * SQL to create the `vps_panel.settings` table for persistent runtime-configurable settings.
 * Stores all settings with category and data_type CHECK constraints.
 *
 * @validates Requirements 6.1, 6.2
 */
const VPS_PANEL_SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS vps_panel.settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    category VARCHAR(50) NOT NULL CHECK (category IN ('General', 'Monitoring', 'Alerts', 'Backups', 'Security', 'Network')),
    data_type VARCHAR(20) NOT NULL CHECK (data_type IN ('string', 'number', 'boolean', 'json', 'email', 'url', 'cron')),
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settings_category ON vps_panel.settings (category);
`;

/**
 * SQL to create the `monitoring` schema and its tables.
 * Note: Partitioned tables use CREATE TABLE IF NOT EXISTS for idempotency.
 */
const MONITORING_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS monitoring;

-- System metrics time-series (partitioned by week)
CREATE TABLE IF NOT EXISTS monitoring.system_metrics (
    id BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL,
    cpu_usage_percent REAL NOT NULL,
    memory_used_bytes BIGINT NOT NULL,
    memory_total_bytes BIGINT NOT NULL,
    disk_used_bytes BIGINT NOT NULL,
    disk_total_bytes BIGINT NOT NULL,
    network_rx_bytes_per_sec BIGINT NOT NULL,
    network_tx_bytes_per_sec BIGINT NOT NULL,
    PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Container snapshots (partitioned by week)
CREATE TABLE IF NOT EXISTS monitoring.container_snapshots (
    id BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    container_id VARCHAR(12) NOT NULL,
    container_name VARCHAR(255) NOT NULL,
    cpu_usage_percent REAL NOT NULL,
    memory_used_bytes BIGINT NOT NULL,
    memory_limit_bytes BIGINT NOT NULL,
    network_rx_bytes BIGINT NOT NULL,
    network_tx_bytes BIGINT NOT NULL,
    block_read_bytes BIGINT NOT NULL,
    block_write_bytes BIGINT NOT NULL,
    PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Per-user resource tracking
CREATE TABLE IF NOT EXISTS monitoring.user_resource_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    container_name VARCHAR(255) NOT NULL,
    cpu_allocation REAL NOT NULL,
    memory_allocation BIGINT NOT NULL,
    tracked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, user_id, container_name)
);
`;

/**
 * SQL to create aggregated metrics tables for tiered data retention.
 * These tables store downsampled metrics at 5-minute and 1-hour resolutions.
 *
 * @validates Requirements 1.2, 1.3, 2.1
 */
const MONITORING_AGGREGATED_TABLES_SQL = `
-- System metrics aggregated at 5-minute resolution (Tier 1)
CREATE TABLE IF NOT EXISTS monitoring.system_metrics_5m (
    id BIGSERIAL,
    bucket_start TIMESTAMPTZ NOT NULL,
    cpu_usage_percent_avg REAL NOT NULL,
    cpu_usage_percent_max REAL NOT NULL,
    memory_used_bytes_avg BIGINT NOT NULL,
    memory_used_bytes_max BIGINT NOT NULL,
    memory_total_bytes BIGINT NOT NULL,
    disk_used_bytes_avg BIGINT NOT NULL,
    disk_used_bytes_max BIGINT NOT NULL,
    disk_total_bytes BIGINT NOT NULL,
    network_rx_bytes_per_sec_avg BIGINT NOT NULL,
    network_tx_bytes_per_sec_avg BIGINT NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (id, bucket_start)
) PARTITION BY RANGE (bucket_start);

-- System metrics aggregated at 1-hour resolution (Tier 2)
CREATE TABLE IF NOT EXISTS monitoring.system_metrics_1h (
    id BIGSERIAL,
    bucket_start TIMESTAMPTZ NOT NULL,
    cpu_usage_percent_avg REAL NOT NULL,
    cpu_usage_percent_max REAL NOT NULL,
    memory_used_bytes_avg BIGINT NOT NULL,
    memory_used_bytes_max BIGINT NOT NULL,
    memory_total_bytes BIGINT NOT NULL,
    disk_used_bytes_avg BIGINT NOT NULL,
    disk_used_bytes_max BIGINT NOT NULL,
    disk_total_bytes BIGINT NOT NULL,
    network_rx_bytes_per_sec_avg BIGINT NOT NULL,
    network_tx_bytes_per_sec_avg BIGINT NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (id, bucket_start)
) PARTITION BY RANGE (bucket_start);

-- Per-container metrics aggregated at 5-minute resolution
CREATE TABLE IF NOT EXISTS monitoring.container_metrics_5m (
    id BIGSERIAL,
    bucket_start TIMESTAMPTZ NOT NULL,
    container_id VARCHAR(12) NOT NULL,
    container_name VARCHAR(255) NOT NULL,
    cpu_usage_percent_avg REAL NOT NULL,
    cpu_usage_percent_max REAL NOT NULL,
    memory_used_bytes_avg BIGINT NOT NULL,
    memory_used_bytes_max BIGINT NOT NULL,
    memory_limit_bytes BIGINT NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (id, bucket_start)
) PARTITION BY RANGE (bucket_start);
`;

/**
 * SQL for indexes on aggregated metrics tables.
 */
const MONITORING_AGGREGATED_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_container_metrics_5m_container
    ON monitoring.container_metrics_5m (container_id, bucket_start DESC);
`;

/**
 * SQL for indexes on monitoring tables.
 */
const MONITORING_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_container_snapshots_project
    ON monitoring.container_snapshots (project_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_user_allocations_project_user
    ON monitoring.user_resource_allocations (project_id, user_id);
`;

/**
 * Run PostgreSQL schema migrations for the VPS Panel monitoring feature.
 *
 * This function is idempotent — it checks if schemas already exist before
 * creating them, and uses IF NOT EXISTS clauses throughout.
 *
 * @param pgClient - The connected PgClient instance
 * @returns true if migrations were applied, false if schemas already existed
 */
export async function runPgMigrations(pgClient: PgClient): Promise<boolean> {
  const vpsPanelExists = await schemaExists(pgClient, 'vps_panel');
  const monitoringExists = await schemaExists(pgClient, 'monitoring');

  // If both schemas exist, check for new tables and apply incremental migrations
  if (vpsPanelExists && monitoringExists) {
    console.log('[PG Migrations] Schemas already exist — checking for new tables...');
    await applyIncrementalMigrations(pgClient);
    return false;
  }

  console.log('[PG Migrations] Running schema migrations...');

  // Create vps_panel schema and tables
  if (!vpsPanelExists) {
    console.log('[PG Migrations] Creating vps_panel schema...');
    await pgClient.query(VPS_PANEL_SCHEMA_SQL);
    console.log('[PG Migrations] vps_panel schema created');
  }

  // Create vps_panel.settings table
  console.log('[PG Migrations] Creating vps_panel.settings table...');
  await pgClient.query(VPS_PANEL_SETTINGS_SQL);
  console.log('[PG Migrations] vps_panel.settings table created');

  // Create monitoring schema and tables
  if (!monitoringExists) {
    console.log('[PG Migrations] Creating monitoring schema...');
    await pgClient.query(MONITORING_SCHEMA_SQL);
    console.log('[PG Migrations] monitoring schema created');

    // Create indexes
    console.log('[PG Migrations] Creating indexes...');
    await pgClient.query(MONITORING_INDEXES_SQL);
    console.log('[PG Migrations] Indexes created');

    // Create initial weekly partitions for time-series tables
    console.log('[PG Migrations] Creating initial weekly partitions...');
    await createInitialPartitions(pgClient, 'monitoring.system_metrics');
    await createInitialPartitions(pgClient, 'monitoring.container_snapshots');
    console.log('[PG Migrations] Initial partitions created');
  }

  // Create aggregated metrics tables
  console.log('[PG Migrations] Creating aggregated metrics tables...');
  await pgClient.query(MONITORING_AGGREGATED_TABLES_SQL);
  await pgClient.query(MONITORING_AGGREGATED_INDEXES_SQL);
  console.log('[PG Migrations] Aggregated metrics tables created');

  // Create initial partitions for aggregated tables
  console.log('[PG Migrations] Creating initial partitions for aggregated tables...');
  await createInitialPartitions(pgClient, 'monitoring.system_metrics_5m');
  await createInitialPartitions(pgClient, 'monitoring.system_metrics_1h');
  await createInitialPartitions(pgClient, 'monitoring.container_metrics_5m');
  console.log('[PG Migrations] Aggregated table partitions created');

  console.log('[PG Migrations] Schema migrations complete');
  return true;
}

/**
 * Apply incremental migrations for new tables when schemas already exist.
 * This ensures new tables (settings, aggregated metrics) are created even
 * on systems that already had the base schemas.
 *
 * @param pgClient - The connected PgClient instance
 */
async function applyIncrementalMigrations(pgClient: PgClient): Promise<void> {
  // Check and create vps_panel.settings if it doesn't exist
  const settingsExists = await tableExists(pgClient, 'vps_panel', 'settings');
  if (!settingsExists) {
    console.log('[PG Migrations] Creating vps_panel.settings table...');
    await pgClient.query(VPS_PANEL_SETTINGS_SQL);
    console.log('[PG Migrations] vps_panel.settings table created');
  }

  // Check and create aggregated metrics tables if they don't exist
  const metrics5mExists = await tableExists(pgClient, 'monitoring', 'system_metrics_5m');
  if (!metrics5mExists) {
    console.log('[PG Migrations] Creating aggregated metrics tables...');
    await pgClient.query(MONITORING_AGGREGATED_TABLES_SQL);
    await pgClient.query(MONITORING_AGGREGATED_INDEXES_SQL);
    console.log('[PG Migrations] Aggregated metrics tables created');

    // Create initial partitions for aggregated tables
    console.log('[PG Migrations] Creating initial partitions for aggregated tables...');
    await createInitialPartitions(pgClient, 'monitoring.system_metrics_5m');
    await createInitialPartitions(pgClient, 'monitoring.system_metrics_1h');
    await createInitialPartitions(pgClient, 'monitoring.container_metrics_5m');
    console.log('[PG Migrations] Aggregated table partitions created');
  }
}

/**
 * Ensure future partitions exist for the next 2 weeks.
 * Call this periodically (e.g., daily) to maintain partition coverage.
 *
 * @param pgClient - The connected PgClient instance
 */
export async function ensureFuturePartitions(pgClient: PgClient): Promise<void> {
  const now = new Date();
  const currentWeekStart = getWeekStart(now);

  // Create partitions for the next 2 weeks
  const nextWeek = new Date(currentWeekStart);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);

  const twoWeeksAhead = new Date(currentWeekStart);
  twoWeeksAhead.setUTCDate(twoWeeksAhead.getUTCDate() + 14);

  // Three weeks ahead
  const threeWeeksAhead = new Date(currentWeekStart);
  threeWeeksAhead.setUTCDate(threeWeeksAhead.getUTCDate() + 21);

  // Four weeks ahead (Requirement 2.2: maintain at least 4 weeks of future partitions)
  const fourWeeksAhead = new Date(currentWeekStart);
  fourWeeksAhead.setUTCDate(fourWeeksAhead.getUTCDate() + 28);

  const futureWeeks = [nextWeek, twoWeeksAhead, threeWeeksAhead, fourWeeksAhead];

  // All partitioned tables that need future partition management
  const partitionedTables = [
    'monitoring.system_metrics',
    'monitoring.container_snapshots',
    'monitoring.system_metrics_5m',
    'monitoring.system_metrics_1h',
    'monitoring.container_metrics_5m',
  ];

  for (const table of partitionedTables) {
    for (const weekStart of futureWeeks) {
      await createWeeklyPartition(pgClient, table, weekStart);
    }
  }
}

// Export internals for testing
export const _internals = {
  schemaExists,
  tableExists,
  getWeekStart,
  formatPartitionSuffix,
  createWeeklyPartition,
  createInitialPartitions,
  applyIncrementalMigrations,
};

// Export SQL constants for verification/testing
export const _sql = {
  VPS_PANEL_SCHEMA_SQL,
  VPS_PANEL_SETTINGS_SQL,
  MONITORING_SCHEMA_SQL,
  MONITORING_AGGREGATED_TABLES_SQL,
  MONITORING_AGGREGATED_INDEXES_SQL,
  MONITORING_INDEXES_SQL,
};
