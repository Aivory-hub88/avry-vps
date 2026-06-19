/**
 * VPS Panel - Application Factory
 *
 * Initializes all modules in correct dependency order, wires cross-cutting concerns
 * (audit logging, alert system, job queue), and implements graceful degradation when
 * system resources are unavailable.
 *
 * Requirements: All (final integration and wiring)
 */
import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';

import { initializeDatabase, checkHealth, closeDatabase, getDbPath } from './database/index.js';
import { createPgClient, type PgClient } from './database/pg-client.js';
import { runPgMigrations } from './database/migrations.js';
import { createAuthModule } from './modules/auth.js';
import { createRateLimiter, type RateLimiter } from './modules/rate-limiter.js';
import { createContainerManager } from './modules/container-manager.js';
import { createFileManager } from './modules/file-manager.js';
import { createTerminalManager, createNodePtySpawner } from './modules/terminal-manager.js';
import { createLogViewer } from './modules/log-viewer.js';
import { createDomainManager } from './modules/domain-manager.js';
import { createSSLManager } from './modules/ssl-manager.js';
import { createCronManager } from './modules/cron-manager.js';
import { createDatabaseManager } from './modules/database-manager.js';
import { createBackupManager } from './modules/backup-manager.js';
import { createResourceWidget } from './modules/resource-widget.js';
import { createAlertSystem } from './modules/alert-system.js';
import { createAuditLogger } from './modules/audit-logger.js';
import { createProjectManager } from './modules/project-manager.js';
import { createJobQueue } from './modules/job-queue.js';
import { createBuildPipeline } from './modules/build-pipeline.js';
import { createWebhookHandler } from './modules/webhook-handler.js';
import { createTunnelManager } from './modules/tunnel-manager.js';
import { createCICDBridge } from './modules/cicd-bridge.js';
import { createSecurityManager } from './modules/security-manager.js';

import { registerRoutes } from './routes/index.js';
import { createMonitoringRouter } from './routes/monitoring.js';
import { setupSocketHandlers, createAlertNotificationCallback } from './socket/index.js';

import { createMetricsCollector } from './services/metrics-collector.js';
import { createProjectRegistry } from './services/project-registry.js';
import { createHistoricalMetricsService } from './services/historical-metrics.js';
import { createUserResourceTracker } from './services/user-resource-tracking.js';
import { createSettingsService, type SettingsService } from './services/settings-service.js';
import { createSettingsRouter } from './routes/settings.js';
import { createDownsamplingEngine, type DownsamplingEngine } from './services/downsampling-engine.js';
import {
  createSettingsHotReload,
  createMetricsCollectionHandle,
  createAlertThresholdHandle,
  createBackupScheduleHandle,
  type HotReloadSubscription,
} from './services/settings-hot-reload.js';
import { createPartitionManager, type PartitionManagerInstance } from './database/partition-manager.js';

import { validateEnv, type EnvConfig } from './config/env.js';

import type Database from 'better-sqlite3';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface AppInstance {
  app: ReturnType<typeof express>;
  io: SocketIOServer;
  httpServer: ReturnType<typeof createServer>;
  config: EnvConfig;
  db: Database.Database;
  pgClient: PgClient | null;
  modules: ModuleInstances;
  degradation: DegradationStatus;
  /** Initialize PostgreSQL connection and run schema migrations */
  initializePostgres(): Promise<void>;
  startBackgroundServices(): void;
  shutdown(): void;
}

export interface ModuleInstances {
  authModule: ReturnType<typeof createAuthModule>;
  rateLimiter: RateLimiter;
  auditLogger: ReturnType<typeof createAuditLogger>;
  alertSystem: ReturnType<typeof createAlertSystem>;
  containerManager: ReturnType<typeof createContainerManager>;
  fileManager: ReturnType<typeof createFileManager>;
  terminalManager: ReturnType<typeof createTerminalManager>;
  logViewer: ReturnType<typeof createLogViewer>;
  domainManager: ReturnType<typeof createDomainManager>;
  sslManager: ReturnType<typeof createSSLManager>;
  cronManager: ReturnType<typeof createCronManager>;
  databaseManager: ReturnType<typeof createDatabaseManager>;
  jobQueue: ReturnType<typeof createJobQueue>;
  backupManager: ReturnType<typeof createBackupManager>;
  resourceWidget: ReturnType<typeof createResourceWidget>;
  buildPipeline: ReturnType<typeof createBuildPipeline>;
  webhookHandler: ReturnType<typeof createWebhookHandler>;
  tunnelManager: ReturnType<typeof createTunnelManager>;
  cicdBridge: ReturnType<typeof createCICDBridge>;
  securityManager: ReturnType<typeof createSecurityManager>;
  projectManager: ReturnType<typeof createProjectManager>;
}

export interface DegradationStatus {
  /** Docker socket is reachable — false means read-only container operations */
  dockerAvailable: boolean;
  /** /proc filesystem is accessible — false means Docker stats API fallback */
  procAvailable: boolean;
  /** node-pty is available — false means terminal sessions disabled */
  ptyAvailable: boolean;
}

// ─── Graceful Degradation Checks ───────────────────────────────────────────────

/**
 * Check if the Docker socket is reachable for read/write operations.
 */
export function isDockerSocketReachable(dockerHost: string): boolean {
  if (dockerHost.startsWith('tcp://') || dockerHost.startsWith('http://')) {
    return true;
  }
  try {
    accessSync(dockerHost, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if /proc filesystem is accessible for resource metrics.
 */
export function isProcAvailable(): boolean {
  try {
    accessSync('/proc/stat', constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if node-pty module is available.
 */
export function isPtyAvailable(): boolean {
  try {
    createNodePtySpawner();
    return true;
  } catch {
    return false;
  }
}

// ─── Database Adapters ─────────────────────────────────────────────────────────

function createSslDbAdapter(db: Database.Database) {
  return {
    getCertificate(domain: string) {
      return db.prepare(
        'SELECT id, domain, issuer, expiry_date as expiryDate, renewal_status as renewalStatus, cert_path as certPath, key_path as keyPath, created_at as createdAt FROM certificates WHERE domain = ?'
      ).get(domain) as any;
    },
    listCertificates() {
      return db.prepare(
        'SELECT id, domain, issuer, expiry_date as expiryDate, renewal_status as renewalStatus, cert_path as certPath, key_path as keyPath, created_at as createdAt FROM certificates ORDER BY domain'
      ).all() as any[];
    },
    upsertCertificate(record: any) {
      const existing = db.prepare('SELECT id FROM certificates WHERE domain = ?').get(record.domain) as any;
      if (existing) {
        db.prepare(
          'UPDATE certificates SET issuer = ?, expiry_date = ?, renewal_status = ?, cert_path = ?, key_path = ? WHERE domain = ?'
        ).run(record.issuer, record.expiryDate, record.renewalStatus, record.certPath, record.keyPath, record.domain);
      } else {
        db.prepare(
          'INSERT INTO certificates (id, domain, issuer, expiry_date, renewal_status, cert_path, key_path) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(record.id, record.domain, record.issuer, record.expiryDate, record.renewalStatus, record.certPath, record.keyPath);
      }
    },
    deleteCertificate(domain: string) {
      db.prepare('DELETE FROM certificates WHERE domain = ?').run(domain);
    },
    getDomainConfig(domain: string) {
      return db.prepare('SELECT id, domain, ssl_enabled as sslEnabled FROM domains WHERE domain = ?').get(domain) as any;
    },
    updateDomainSsl(domain: string, enabled: boolean) {
      db.prepare('UPDATE domains SET ssl_enabled = ? WHERE domain = ?').run(enabled ? 1 : 0, domain);
    },
  };
}

function createDomainDbAdapter(db: Database.Database) {
  return {
    getAllDomains() {
      const rows = db.prepare(
        'SELECT id, domain, proxy_target, ssl_enabled, headers, websocket_upgrade, active, project_id, created_at, updated_at FROM domains ORDER BY domain'
      ).all() as any[];
      return rows.map((row: any) => ({
        id: row.id,
        domain: row.domain,
        proxyTarget: row.proxy_target,
        sslEnabled: row.ssl_enabled === 1,
        headers: row.headers ? JSON.parse(row.headers) : {},
        websocketUpgrade: row.websocket_upgrade === 1,
        active: row.active === 1,
        projectId: row.project_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    getDomain(id: string) {
      const row = db.prepare(
        'SELECT id, domain, proxy_target, ssl_enabled, headers, websocket_upgrade, active, project_id, created_at, updated_at FROM domains WHERE id = ?'
      ).get(id) as any;
      if (!row) return undefined;
      return {
        id: row.id,
        domain: row.domain,
        proxyTarget: row.proxy_target,
        sslEnabled: row.ssl_enabled === 1,
        headers: row.headers ? JSON.parse(row.headers) : {},
        websocketUpgrade: row.websocket_upgrade === 1,
        active: row.active === 1,
        projectId: row.project_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    getDomainByName(domain: string) {
      const row = db.prepare(
        'SELECT id, domain, proxy_target, ssl_enabled, headers, websocket_upgrade, active, project_id, created_at, updated_at FROM domains WHERE domain = ?'
      ).get(domain) as any;
      if (!row) return undefined;
      return {
        id: row.id,
        domain: row.domain,
        proxyTarget: row.proxy_target,
        sslEnabled: row.ssl_enabled === 1,
        headers: row.headers ? JSON.parse(row.headers) : {},
        websocketUpgrade: row.websocket_upgrade === 1,
        active: row.active === 1,
        projectId: row.project_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    insertDomain(config: any) {
      db.prepare(
        'INSERT INTO domains (id, domain, proxy_target, ssl_enabled, headers, websocket_upgrade, active, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        config.id, config.domain, config.proxyTarget,
        config.sslEnabled ? 1 : 0, JSON.stringify(config.headers ?? {}),
        config.websocketUpgrade ? 1 : 0, config.active ? 1 : 0,
        config.projectId ?? null, config.createdAt, config.updatedAt
      );
    },
    updateDomain(id: string, config: any) {
      db.prepare(
        'UPDATE domains SET domain = ?, proxy_target = ?, ssl_enabled = ?, headers = ?, websocket_upgrade = ?, active = ?, project_id = ?, updated_at = ? WHERE id = ?'
      ).run(
        config.domain, config.proxyTarget,
        config.sslEnabled ? 1 : 0, JSON.stringify(config.headers ?? {}),
        config.websocketUpgrade ? 1 : 0, config.active ? 1 : 0,
        config.projectId ?? null, config.updatedAt, id
      );
    },
    deleteDomain(id: string) {
      db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    },
  };
}

// ─── Application Factory ───────────────────────────────────────────────────────

/**
 * Create and initialize the complete VPS Panel application.
 *
 * Module initialization order:
 * 1. Database (foundation for all persistent state)
 * 2. Audit Logger (needed by all state-changing modules)
 * 3. Alert System (needed by health monitoring, backup, security)
 * 4. Rate Limiter + Auth (gate for all access)
 * 5. Job Queue (needed by build pipeline, backup, tunnel, database ops)
 * 6. Container Manager (core Docker operations)
 * 7. File Manager (filesystem access)
 * 8. Terminal Manager (PTY sessions)
 * 9. Log Viewer (container log streaming)
 * 10. Domain Manager + SSL Manager (reverse proxy)
 * 11. Cron Manager (scheduled tasks)
 * 12. Database Manager (discovered DB containers)
 * 13. Backup Manager (depends on alert system)
 * 14. Resource Widget (system metrics, depends on /proc or Docker stats)
 * 15. Build Pipeline (depends on job queue)
 * 16. Webhook Handler (depends on build pipeline)
 * 17. Tunnel Manager (depends on job queue)
 * 18. CI/CD Bridge (depends on build pipeline)
 * 19. Security Manager (firewall, scanning)
 * 20. Project Manager (depends on container manager)
 */
export function createApp(envConfig?: EnvConfig): AppInstance {
  const config = envConfig ?? validateEnv();

  // ─── Startup Validation ─────────────────────────────────────────────────
  // Only enforce in production/non-test environments; tests provide their own config
  if (!process.env.VITEST && !envConfig) {
    if (!process.env.VPS_PANEL_API_TOKEN) {
      console.warn('[VPS Panel] WARNING: VPS_PANEL_API_TOKEN not set. Monitoring API will require session auth only.');
    }

    if (!process.env.DATABASE_URL) {
      console.warn('[VPS Panel] WARNING: DATABASE_URL not set. PostgreSQL monitoring features will be disabled.');
    }
  }

  // ─── Degradation Status ────────────────────────────────────────────────────
  const degradation: DegradationStatus = {
    dockerAvailable: isDockerSocketReachable(config.DOCKER_HOST),
    procAvailable: isProcAvailable(),
    ptyAvailable: isPtyAvailable(),
  };

  if (!degradation.dockerAvailable) {
    console.warn('[VPS Panel] Docker socket not reachable — container operations will be read-only');
  }
  if (!degradation.procAvailable) {
    console.warn('[VPS Panel] /proc not available — falling back to Docker stats API for metrics');
  }
  if (!degradation.ptyAvailable) {
    console.warn('[VPS Panel] node-pty not available — terminal sessions disabled');
  }

  // ─── Express App ─────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.raw({ type: 'application/octet-stream', limit: '500mb' }));

  // ─── HTTP Server ─────────────────────────────────────────────────────────────
  const httpServer = createServer(app);

  // ─── Socket.IO ───────────────────────────────────────────────────────────────
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // ─── 1. Database ─────────────────────────────────────────────────────────────
  const db = initializeDatabase();
  const dbPath = getDbPath();

  // ─── 1b. PostgreSQL Client (for monitoring schemas) ──────────────────────────
  let pgClient: PgClient | null = null;
  let settingsService: SettingsService | null = null;
  let downsamplingEngine: DownsamplingEngine | null = null;
  let partitionManager: PartitionManagerInstance | null = null;
  let hotReloadSubscription: HotReloadSubscription | null = null;

  // ─── Monitoring Background Job Handles ───────────────────────────────────────
  let purgeJobInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Initialize the PostgreSQL connection and run schema migrations.
   * Called during startup — if DATABASE_URL is set, connects to avry-postgres
   * and creates vps_panel/monitoring schemas if they don't exist.
   */
  async function initializePostgres(): Promise<void> {
    if (!process.env.DATABASE_URL) {
      console.warn('[VPS Panel] DATABASE_URL not set — PostgreSQL features disabled');
      return;
    }

    try {
      pgClient = createPgClient();
      await pgClient.connect();
      console.log('[VPS Panel] PostgreSQL connected');

      // Run schema migrations (idempotent)
      await runPgMigrations(pgClient);
      console.log('[VPS Panel] PostgreSQL migrations complete');

      // ─── Initialize Partition Manager ─────────────────────────────────────────
      partitionManager = createPartitionManager(pgClient, {
        onAlert: (event) => {
          alertSystem.emitAlert(event);
        },
      });
      const partitionStatus = await partitionManager.verifyAndRepair();
      console.log(`[VPS Panel] Partition Manager: healthy=${partitionStatus.healthy}, created=${partitionStatus.createdPartitions.length} partitions`);

      // ─── Initialize Settings Service ──────────────────────────────────────────
      settingsService = createSettingsService(pgClient);
      console.log('[VPS Panel] Settings service initialized');

      // Mount settings route now that service is available
      app.use('/api/settings', createSettingsRouter(settingsService));
      console.log('[VPS Panel] Settings route mounted');

      // ─── Initialize Downsampling Engine ───────────────────────────────────────
      downsamplingEngine = createDownsamplingEngine(pgClient, settingsService);
      downsamplingEngine.start();
      console.log('[VPS Panel] Downsampling engine started');

      // ─── Initialize Monitoring Services ──────────────────────────────────────
      const projectRegistry = createProjectRegistry(pgClient);
      const metricsCollector = createMetricsCollector(
        { dockerHost: config.DOCKER_HOST },
        projectRegistry
      );
      const historicalMetrics = createHistoricalMetricsService(pgClient);
      const userResourceTracker = createUserResourceTracker(pgClient);

      // ─── Create & Mount Monitoring Router ────────────────────────────────────
      const monitoringRouter = createMonitoringRouter({
        metricsCollector,
        projectRegistry,
        historicalMetrics,
        userResourceTracker,
        authOptions: {
          apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
          sessionValidator: (token: string) => modules.authModule.validateSession(token),
        },
      });

      app.use('/api/monitoring', monitoringRouter);
      console.log('[VPS Panel] Monitoring routes mounted at /api/monitoring');

      // ─── Start Historical Metrics Collection (every 30s) ─────────────────────
      // Requirement 7.1: collect and store system-wide metrics at configurable interval
      const collectionIntervalMs = Number(process.env.METRICS_COLLECTION_INTERVAL_MS) || 30_000;

      // Create hot-reloadable metrics collection handle
      const metricsCollectionHandle = createMetricsCollectionHandle(
        collectionIntervalMs,
        async () => {
          try {
            const systemMetrics = await metricsCollector.getSystemMetrics();
            await historicalMetrics.store(systemMetrics);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[VPS Panel] Metrics collection error: ${msg}`);
          }
        }
      );
      console.log(`[VPS Panel] Metrics collection started (every ${collectionIntervalMs / 1000}s)`);

      // ─── Start Purge Job for Retention ───────────────────────────────────────
      const purgeIntervalMs = Number(process.env.METRICS_PURGE_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6 hours default
      purgeJobInterval = setInterval(async () => {
        try {
          const purgedCount = await historicalMetrics.purgeOldRecords();
          if (purgedCount > 0) {
            console.log(`[VPS Panel] Purged ${purgedCount} old metrics records`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[VPS Panel] Metrics purge error: ${msg}`);
        }
      }, purgeIntervalMs);
      console.log(`[VPS Panel] Metrics purge job started (every ${purgeIntervalMs / 1000 / 3600}h)`);

      // ─── Settings Hot-Reload Wiring ──────────────────────────────────────────
      // Connect settings change events to Metrics Collector, Alert System, Backup Manager
      const alertThresholds = createAlertThresholdHandle({
        alert_cpu_warning: 80,
        alert_cpu_critical: 95,
        alert_memory_warning: 80,
        alert_memory_critical: 95,
        alert_disk_warning: 90,
        alert_disk_critical: 95,
        alert_consecutive_checks: 3,
      });

      const backupScheduleHandle = createBackupScheduleHandle(
        {
          cronExpression: '0 2 * * *',
          targets: [],
          retentionCount: 7,
          enabled: false,
        },
        (newConfig) => {
          // When schedule settings change, update the backup manager
          backupManager.updateScheduleFromSettings(newConfig);
        }
      );

      hotReloadSubscription = createSettingsHotReload({
        settingsService,
        metricsCollection: metricsCollectionHandle,
        alertThresholds,
        backupSchedule: backupScheduleHandle,
      });
      console.log('[VPS Panel] Settings hot-reload wired');

      // Also ensure partitions exist for future weeks
      await historicalMetrics.ensurePartitions();
      console.log('[VPS Panel] Monitoring partitions ensured');

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[VPS Panel] PostgreSQL initialization failed: ${msg}`);
      pgClient = null;
      throw error;
    }
  }

  // ─── 2. Audit Logger ─────────────────────────────────────────────────────────
  const auditLogger = createAuditLogger(db, dbPath, {
    onStorageAlert: (usage) => {
      console.warn(`[Audit] Storage alert: ${usage.usedBytes} / ${usage.maxBytes} bytes (${usage.usagePercent.toFixed(1)}%)`);
    },
  });

  // ─── 3. Alert System ─────────────────────────────────────────────────────────
  const alertSystem = createAlertSystem(db, {
    onInAppNotification: createAlertNotificationCallback(io),
  });

  // ─── 4. Rate Limiter + Auth ──────────────────────────────────────────────────
  const rateLimiter = createRateLimiter(db);

  const authModule = createAuthModule(db, {
    jwtSecret: config.SUPABASE_JWT_SECRET,
  });

  // Wire rate limiter into auth module's isRateLimited method
  // The auth module has a stub; we override it by patching the returned object
  (authModule as any).isRateLimited = (ip: string) => rateLimiter.isLocked(ip);
  (authModule as any).recordFailedAttempt = (ip: string) => rateLimiter.recordFailure(ip);
  (authModule as any).recordSuccessfulLogin = (ip: string) => rateLimiter.recordSuccess(ip);

  // ─── 5. Job Queue ────────────────────────────────────────────────────────────
  const jobQueue = createJobQueue(db, { io });

  // ─── 6. Container Manager ────────────────────────────────────────────────────
  // When Docker is unavailable, the circuit breaker will open immediately on first use,
  // effectively making container operations fail gracefully (read-only degradation).
  const containerManager = createContainerManager({
    dockerHost: config.DOCKER_HOST,
  });

  // ─── 7. File Manager ─────────────────────────────────────────────────────────
  const fileManager = createFileManager();

  // ─── 8. Terminal Manager ─────────────────────────────────────────────────────
  let terminalManager: ReturnType<typeof createTerminalManager>;
  if (degradation.ptyAvailable) {
    try {
      const ptySpawner = createNodePtySpawner();
      terminalManager = createTerminalManager(ptySpawner, io);
    } catch (err) {
      console.warn('[VPS Panel] node-pty initialization failed:', (err as Error).message);
      terminalManager = createTerminalManager(
        { spawn: () => { throw new Error('Terminal not available'); } } as any,
        io
      );
    }
  } else {
    terminalManager = createTerminalManager(
      { spawn: () => { throw new Error('Terminal not available — node-pty unavailable'); } } as any,
      io
    );
  }

  // ─── 9. Log Viewer ──────────────────────────────────────────────────────────
  const logViewer = createLogViewer({
    dockerHost: config.DOCKER_HOST,
    io,
  });

  // ─── 10. Domain Manager + SSL Manager ────────────────────────────────────────
  const domainManager = createDomainManager({
    db: createDomainDbAdapter(db),
  });

  const sslManager = createSSLManager({
    db: createSslDbAdapter(db),
  });

  // ─── 11. Cron Manager ────────────────────────────────────────────────────────
  const cronManager = createCronManager(db);

  // ─── 12. Database Manager ────────────────────────────────────────────────────
  const databaseManager = createDatabaseManager({
    dockerHost: config.DOCKER_HOST,
  });

  // ─── 13. Backup Manager (depends on alert system) ───────────────────────────
  const backupManager = createBackupManager(db, {
    alertCallback: {
      onBackupFailure: (backupId: string, error: string, targets: string[]) => {
        alertSystem.emitAlert({
          eventType: 'backup_failure',
          affectedResource: `backup:${backupId}`,
          severity: 'high',
          message: `Backup failed for targets [${targets.join(', ')}]: ${error}`,
        });
      },
    },
  });

  // ─── 14. Resource Widget (uses /proc fallback to Docker stats) ──────────────
  // When /proc is unavailable, the widget uses Docker stats API as fallback.
  // The widget internally checks /proc accessibility and falls back automatically.
  const resourceWidget = createResourceWidget({
    dockerHost: config.DOCKER_HOST,
  });

  // ─── 15. Build Pipeline (depends on job queue) ──────────────────────────────
  const buildPipeline = createBuildPipeline(db, {
    dockerHost: config.DOCKER_HOST,
    jobQueue,
  });

  // ─── 16. Webhook Handler (depends on build pipeline) ────────────────────────
  const webhookHandler = createWebhookHandler({
    db,
    deps: {
      triggerBuild: (projectId: string) => buildPipeline.triggerBuild(projectId),
    },
  });

  // ─── 17. Tunnel Manager (depends on job queue) ──────────────────────────────
  const tunnelManager = createTunnelManager({
    db,
    deps: {
      submitJob: async (job) => {
        return jobQueue.submit({
          type: job.type,
          projectId: job.projectId,
          execute: job.execute,
          onComplete: job.onComplete as any,
          metadata: job.metadata,
        });
      },
    },
  });

  // ─── 18. CI/CD Bridge (depends on build pipeline) ──────────────────────────
  const cicdBridge = createCICDBridge(db, {
    deps: {
      triggerBuild: (projectId: string) => buildPipeline.triggerBuild(projectId),
    },
  });

  // ─── 19. Security Manager ──────────────────────────────────────────────────
  const securityManager = createSecurityManager(db, {
    panelPort: config.PORT,
  });

  // ─── 20. Project Manager (depends on container manager) ────────────────────
  const projectManager = createProjectManager({
    db,
    deps: {
      getContainerStatus: async (containerId: string) => {
        try {
          const container = await containerManager.getContainer(containerId);
          return {
            id: containerId,
            status: container.status,
            health: container.health,
          };
        } catch {
          return null;
        }
      },
      getContainerMetrics: async (containerId: string) => {
        try {
          const stats = await containerManager.getContainerStats(containerId);
          return {
            id: containerId,
            cpuPercent: stats.cpuUsagePercent,
            memoryMB: stats.memoryUsageMB,
          };
        } catch {
          return null;
        }
      },
      startContainer: (id: string) => containerManager.startContainer(id),
      stopContainer: (id: string) => containerManager.stopContainer(id),
      restartContainer: (id: string) => containerManager.restartContainer(id),
      composeUp: async (_filePath: string) => {
        return { success: true };
      },
    },
  });

  // ─── Module Instances Registry ───────────────────────────────────────────────
  const modules: ModuleInstances = {
    authModule,
    rateLimiter,
    auditLogger,
    alertSystem,
    containerManager,
    fileManager,
    terminalManager,
    logViewer,
    domainManager,
    sslManager,
    cronManager,
    databaseManager,
    jobQueue,
    backupManager,
    resourceWidget,
    buildPipeline,
    webhookHandler,
    tunnelManager,
    cicdBridge,
    securityManager,
    projectManager,
  };

  // ─── Health Endpoint ─────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    const dockerReachable = isDockerSocketReachable(config.DOCKER_HOST);
    const dbHealth = checkHealth(db);

    if (!dockerReachable || !dbHealth.healthy) {
      const reasons: string[] = [];
      if (!dockerReachable) reasons.push(`Docker socket unreachable at ${config.DOCKER_HOST}`);
      if (!dbHealth.healthy) reasons.push(`Database unhealthy: ${dbHealth.error ?? 'unknown'}`);

      res.status(503).json({
        status: 'unhealthy',
        reason: reasons[0],
        reasons,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: {
        healthy: dbHealth.healthy,
        latencyMs: dbHealth.latencyMs,
        walMode: dbHealth.walMode,
      },
      degradation: {
        dockerAvailable: dockerReachable,
        procAvailable: degradation.procAvailable,
        ptyAvailable: degradation.ptyAvailable,
      },
    });
  });

  // ─── Register API Routes (all modules, auth middleware applied) ──────────────
  registerRoutes(app, {
    authModule,
    auditLogger,
    containerManager,
    fileManager,
    domainManager,
    sslManager,
    cronManager,
    databaseManager,
    backupManager,
    projectManager,
    buildPipeline,
    webhookHandler,
    tunnelManager,
    cicdBridge,
    securityManager,
    jobQueue,
    alertSystem,
    ...(settingsService ? { settingsService } : {}),
  });

  // ─── Register Socket.IO Event Handlers ───────────────────────────────────────
  setupSocketHandlers(io, {
    authModule,
    terminalManager,
    logViewer,
    jobQueue,
    resourceWidget,
    alertSystem,
    containerManager,
  });

  // ─── Serve Static Frontend ───────────────────────────────────────────────────
  const frontendDistPath = path.resolve(__dirname, '../dist/frontend');
  if (existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath));

    // SPA fallback: serve index.html for any unmatched route
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === '/health') {
        return next();
      }
      const indexPath = path.join(frontendDistPath, 'index.html');
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        next();
      }
    });
  } else {
    console.warn('[VPS Panel] Frontend dist not found at', frontendDistPath);
  }

  // ─── Start Background Services ──────────────────────────────────────────────

  function startBackgroundServices(): void {
    // Job Queue scheduler
    jobQueue.start();
    console.log('[VPS Panel] Job queue scheduler started');

    // Resource Widget monitoring (emits to Socket.IO every 5s)
    resourceWidget.startMonitoring(io);
    console.log('[VPS Panel] Resource widget monitoring started');

    // Backup scheduler
    backupManager.startScheduler();
    console.log('[VPS Panel] Backup scheduler started');

    // SSL renewal cron (daily check)
    sslManager.startRenewalCron();
    console.log('[VPS Panel] SSL renewal scheduler started');

    // Container health polling (only if Docker available)
    if (degradation.dockerAvailable) {
      containerManager.startHealthPolling();
      console.log('[VPS Panel] Container health polling started');
    } else {
      console.warn('[VPS Panel] Container health polling skipped — Docker unavailable');
    }

    // Audit log purge scheduler
    auditLogger.startPurgeScheduler();
    console.log('[VPS Panel] Audit log purge scheduler started');

    console.log('[VPS Panel] All background services started');
  }

  // ─── Graceful Shutdown ───────────────────────────────────────────────────────

  function shutdown(): void {
    console.log('[VPS Panel] Shutting down gracefully...');

    // Stop monitoring background jobs
    if (purgeJobInterval) {
      clearInterval(purgeJobInterval);
      purgeJobInterval = null;
      console.log('[VPS Panel] Metrics purge job stopped');
    }

    // Stop downsampling engine
    if (downsamplingEngine) {
      downsamplingEngine.stop();
      console.log('[VPS Panel] Downsampling engine stopped');
    }

    // Dispose settings hot-reload subscription
    if (hotReloadSubscription) {
      hotReloadSubscription.dispose();
      hotReloadSubscription = null;
      console.log('[VPS Panel] Settings hot-reload disposed');
    }

    // Stop background services
    jobQueue.stop();
    resourceWidget.stopMonitoring();
    backupManager.stopScheduler();
    sslManager.stopRenewalCron();
    containerManager.stopHealthPolling();
    auditLogger.stopPurgeScheduler();

    // Close all terminal sessions
    terminalManager.closeAllSessions('*');

    // Destroy CI/CD filesystem watchers
    cicdBridge.destroy();

    // Close Socket.IO connections
    io.close();

    // Close PostgreSQL connection pool
    if (pgClient) {
      pgClient.close().catch((err) => {
        console.error('[VPS Panel] Error closing PostgreSQL:', err);
      });
    }

    // Close database connection
    closeDatabase(db);

    console.log('[VPS Panel] Shutdown complete');
  }

  return {
    app,
    io,
    httpServer,
    config,
    db,
    pgClient,
    modules,
    degradation,
    initializePostgres,
    startBackgroundServices,
    shutdown,
  };
}
