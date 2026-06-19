/**
 * Integration Tests: Premium API Round-Trips
 *
 * Tests full API round-trip flows for premium features:
 * - Settings: GET → PUT → GET verifies update persisted
 * - Monitoring: history endpoint with mock data across tiers
 * - Alerts: pagination correctness
 * - Backups: snapshot → export → restore → list → delete lifecycle
 *
 * Requirements: 6.3, 6.4, 11.2, 17.1
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings.js';
import { createAlertsRouter } from '../../src/routes/alerts.js';
import { createBackupsRouter } from '../../src/routes/backups.js';
import { createMonitoringRouter } from '../../src/routes/monitoring.js';
import type { SettingsService } from '../../src/services/settings-service.js';
import type { AlertSystem, AlertRecord, PaginatedAlerts } from '../../src/modules/alert-system.js';
import type { AuditLogger } from '../../src/modules/audit-logger.js';
import type { BackupManagerExtended, SnapshotResult, ExportResult, RestoreResult, BackupEntry } from '../../src/modules/backup-manager.js';
import type { MonitoringRouterDependencies } from '../../src/routes/monitoring.js';
import type { MetricsCollector } from '../../src/services/metrics-collector.js';
import type { ProjectRegistry } from '../../src/services/project-registry.js';
import type { HistoricalMetricsService } from '../../src/services/historical-metrics.js';
import type { UserResourceTracker } from '../../src/services/user-resource-tracking.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_API_TOKEN = 'test-premium-round-trip-token-12345';
const TEST_ENV_VAR = 'VPS_PANEL_API_TOKEN_PREMIUM_TEST';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockAuditLogger(): AuditLogger {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({}),
    exportCsv: vi.fn().mockResolvedValue(''),
  } as unknown as AuditLogger;
}

/**
 * Settings service that simulates in-memory storage so we can verify
 * that GET → PUT → GET returns the updated values.
 */
function createStatefulSettingsService(): SettingsService {
  const store: Record<string, string> = {
    collection_interval_ms: '30000',
    alert_cpu_warning: '80',
  };

  const mockService = {
    getAll: vi.fn().mockImplementation(async () => ({
      General: [],
      Monitoring: [
        {
          key: 'collection_interval_ms',
          value: store['collection_interval_ms'],
          category: 'Monitoring',
          dataType: 'number',
          updatedAt: new Date().toISOString(),
          description: 'Metrics collection interval in ms',
        },
      ],
      Alerts: [
        {
          key: 'alert_cpu_warning',
          value: store['alert_cpu_warning'],
          category: 'Alerts',
          dataType: 'number',
          updatedAt: new Date().toISOString(),
          description: 'CPU warning threshold %',
        },
      ],
      Backups: [],
      Security: [],
      Network: [],
    })),
    get: vi.fn().mockImplementation(async (key: string) => store[key] ?? ''),
    getTyped: vi.fn().mockImplementation(async (key: string) => Number(store[key])),
    update: vi.fn().mockImplementation(async (updates: Record<string, string>) => {
      for (const [key, value] of Object.entries(updates)) {
        store[key] = value;
      }
    }),
    validate: vi.fn().mockReturnValue({ valid: true }),
    getDefinitions: vi.fn().mockReturnValue([]),
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    emit: vi.fn().mockReturnValue(true),
    off: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    addListener: vi.fn().mockReturnThis(),
    listeners: vi.fn().mockReturnValue([]),
    rawListeners: vi.fn().mockReturnValue([]),
    listenerCount: vi.fn().mockReturnValue(0),
    prependListener: vi.fn().mockReturnThis(),
    prependOnceListener: vi.fn().mockReturnThis(),
    eventNames: vi.fn().mockReturnValue([]),
    setMaxListeners: vi.fn().mockReturnThis(),
    getMaxListeners: vi.fn().mockReturnValue(10),
  } as unknown as SettingsService;

  return mockService;
}

function createMockAlertRecord(overrides?: Partial<AlertRecord>): AlertRecord {
  return {
    id: 'alert-001',
    timestamp: '2024-01-15T10:00:00.000Z',
    eventType: 'threshold_breach',
    affectedResource: 'system',
    severity: 'high',
    deliveryStatus: { webhook: 'delivered' },
    message: 'CPU usage exceeded threshold',
    resolutionStatus: 'active',
    ...overrides,
  };
}

/**
 * Creates a mock alert system that returns paginated results
 * based on actual page/pageSize parameters (simulates real pagination).
 */
function createPaginatingAlertSystem(totalAlerts: number): AlertSystem {
  const alerts: AlertRecord[] = Array.from({ length: totalAlerts }, (_, i) =>
    createMockAlertRecord({
      id: `alert-${String(i + 1).padStart(3, '0')}`,
      timestamp: new Date(2024, 0, 15, 10, i).toISOString(),
      message: `Alert ${i + 1}`,
    })
  );

  return {
    configureChannel: vi.fn(),
    configureRule: vi.fn(),
    emitAlert: vi.fn(),
    getAlertHistory: vi.fn().mockResolvedValue(alerts),
    getAlertHistoryPaginated: vi.fn().mockImplementation(
      async (page: number, pageSize: number): Promise<PaginatedAlerts> => {
        const start = (page - 1) * pageSize;
        const items = alerts.slice(start, start + pageSize);
        return { items, total: alerts.length, page, pageSize };
      }
    ),
    recordMetric: vi.fn(),
    getChannels: vi.fn().mockReturnValue([]),
    getRules: vi.fn().mockReturnValue([]),
    removeChannel: vi.fn(),
    removeRule: vi.fn(),
    evaluateThreshold: vi.fn(),
    getBreachCount: vi.fn().mockReturnValue(0),
    getActiveThresholdAlerts: vi.fn().mockReturnValue([]),
    recordHealthTransition: vi.fn(),
    acknowledgeAlert: vi.fn(),
    silenceRule: vi.fn().mockResolvedValue('silence-001'),
    removeSilence: vi.fn(),
    getActiveSilences: vi.fn().mockResolvedValue([]),
    resolveAlert: vi.fn(),
  } as unknown as AlertSystem;
}

function createMockHistoricalMetrics(): HistoricalMetricsService {
  const basePoint = {
    timestamp: '2024-01-15T09:00:00.000Z',
    cpu: { usagePercent: 42.5 },
    memory: { usedBytes: 3_500_000_000, totalBytes: 8_000_000_000 },
    disk: { usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
    network: { rxBytesPerSec: 900, txBytesPerSec: 1800 },
  };

  return {
    store: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([basePoint]),
    queryV2: vi.fn().mockImplementation(async (params: any) => {
      if (params?.containerId) {
        return [{ ...basePoint, containerId: params.containerId }];
      }
      return [basePoint];
    }),
    purgeOldRecords: vi.fn().mockResolvedValue(0),
    ensurePartitions: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockMetricsCollector(): MetricsCollector {
  return {
    getSystemMetrics: vi.fn().mockResolvedValue({
      cpu: { usagePercent: 45.2 },
      memory: { usedBytes: 4_000_000_000, totalBytes: 8_000_000_000 },
      disk: { usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
      network: { rxBytesPerSec: 1024, txBytesPerSec: 2048 },
      timestamp: '2024-01-15T10:00:00.000Z',
    }),
    getContainerMetrics: vi.fn().mockResolvedValue([]),
    getProjectMetrics: vi.fn().mockResolvedValue({}),
    getAllProjectsSummary: vi.fn().mockResolvedValue([]),
  };
}

function createMockProjectRegistry(): ProjectRegistry {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    matchContainers: vi.fn().mockResolvedValue([]),
  };
}

function createMockUserResourceTracker(): UserResourceTracker {
  return {
    track: vi.fn(),
    untrack: vi.fn(),
    getUserMetrics: vi.fn().mockResolvedValue({}),
    listProjectUsers: vi.fn().mockResolvedValue([]),
  };
}

function createMockBackupManager(): BackupManagerExtended {
  const backupRegistry: BackupEntry[] = [];
  let snapshotCount = 0;
  let exportCount = 0;

  return {
    configureSchedule: vi.fn(),
    triggerBackup: vi.fn(),
    restoreBackup: vi.fn(),
    listBackups: vi.fn().mockImplementation(async () => backupRegistry),
    deleteBackup: vi.fn().mockImplementation(async (id: string) => {
      const idx = backupRegistry.findIndex((b) => b.id === id);
      if (idx === -1) throw new Error(`Backup not found: ${id}`);
      backupRegistry.splice(idx, 1);
    }),
    startScheduler: vi.fn(),
    stopScheduler: vi.fn(),
    snapshotContainer: vi.fn().mockImplementation(
      async (containerId: string, commitMessage?: string): Promise<SnapshotResult> => {
        snapshotCount++;
        const result: SnapshotResult = {
          backupId: `snap-${String(snapshotCount).padStart(3, '0')}`,
          imageTag: `container-snapshot-20240601-10000${snapshotCount}`,
          containerId,
          timestamp: new Date().toISOString(),
        };
        backupRegistry.push({
          id: result.backupId,
          timestamp: new Date(),
          size: 1024000,
          targets: [containerId],
          storage: 'local',
          storagePath: `/data/backups/${result.backupId}.tar`,
          status: 'completed',
        } as BackupEntry);
        return result;
      }
    ),
    exportImage: vi.fn().mockImplementation(
      async (imageName: string): Promise<ExportResult> => {
        exportCount++;
        const result: ExportResult = {
          backupId: `export-${String(exportCount).padStart(3, '0')}`,
          archivePath: `/data/backups/${imageName.replace(':', '-')}.tar`,
          size: 5120000,
          s3Uploaded: false,
        };
        backupRegistry.push({
          id: result.backupId,
          timestamp: new Date(),
          size: result.size,
          targets: [imageName],
          storage: 'local',
          storagePath: result.archivePath,
          status: 'completed',
        } as BackupEntry);
        return result;
      }
    ),
    restoreContainer: vi.fn().mockImplementation(
      async (backupId: string, targetContainer: string): Promise<RestoreResult> => {
        return {
          success: true,
          safetySnapshotId: 'safety-snap-001',
          newContainerId: 'new-container-id-123',
          previousContainerId: 'old-container-id-456',
        };
      }
    ),
    updateScheduleFromSettings: vi.fn(),
  };
}

// ─── App Factories ───────────────────────────────────────────────────────────

function createSettingsApp(service?: SettingsService) {
  const settingsService = service ?? createStatefulSettingsService();
  const router = createSettingsRouter(settingsService);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', router);
  return { app, settingsService };
}

function createAlertsApp(alertSystem?: AlertSystem) {
  const system = alertSystem ?? createPaginatingAlertSystem(12);
  const auditLogger = createMockAuditLogger();
  const router = createAlertsRouter(system, auditLogger);
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', router);
  return { app, alertSystem: system };
}

function createMonitoringApp(historicalMetrics?: HistoricalMetricsService) {
  process.env[TEST_ENV_VAR] = TEST_API_TOKEN;
  const deps: MonitoringRouterDependencies = {
    metricsCollector: createMockMetricsCollector(),
    projectRegistry: createMockProjectRegistry(),
    historicalMetrics: historicalMetrics ?? createMockHistoricalMetrics(),
    userResourceTracker: createMockUserResourceTracker(),
    authOptions: {
      apiTokenEnvVar: TEST_ENV_VAR,
      sessionValidator: () => null,
    },
    rateLimitOptions: {
      config: { maxRequestsPerMinute: 100, windowMs: 60_000 },
    },
  };
  const router = createMonitoringRouter(deps);
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/monitoring', router);
  return { app, deps };
}

function createBackupsApp(backupManager?: BackupManagerExtended) {
  const mgr = backupManager ?? createMockBackupManager();
  const auditLogger = createMockAuditLogger();
  const router = createBackupsRouter(mgr, auditLogger);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).session = { username: 'admin', id: 'session-abc' };
    next();
  });
  app.use('/api/backups', router);
  return { app, backupManager: mgr };
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe('Integration: Premium API Round-Trips', () => {
  // ─── Settings Round-Trip: GET → PUT → GET ────────────────────────────────

  describe('Settings API round-trip (Req 6.3, 6.4)', () => {
    it('GET → PUT → GET: update persists and is reflected in subsequent GET', async () => {
      const { app } = createSettingsApp();

      // Step 1: GET initial settings
      const initial = await request(app).get('/api/settings');
      expect(initial.status).toBe(200);
      expect(initial.body.Monitoring[0].value).toBe('30000');
      expect(initial.body.Alerts[0].value).toBe('80');

      // Step 2: PUT to update a setting
      const update = await request(app)
        .put('/api/settings')
        .send({ collection_interval_ms: '60000', alert_cpu_warning: '85' });
      expect(update.status).toBe(200);
      expect(update.body.message).toBe('Settings updated successfully');

      // Step 3: GET again to verify update persisted
      const updated = await request(app).get('/api/settings');
      expect(updated.status).toBe(200);
      expect(updated.body.Monitoring[0].value).toBe('60000');
      expect(updated.body.Alerts[0].value).toBe('85');
    });

    it('PUT with invalid body does not mutate settings', async () => {
      const { app } = createSettingsApp();

      // GET initial
      const initial = await request(app).get('/api/settings');
      expect(initial.body.Monitoring[0].value).toBe('30000');

      // PUT with empty body (should fail)
      const badUpdate = await request(app)
        .put('/api/settings')
        .send({});
      expect(badUpdate.status).toBe(400);

      // GET should still show original value
      const afterBad = await request(app).get('/api/settings');
      expect(afterBad.body.Monitoring[0].value).toBe('30000');
    });
  });

  // ─── Monitoring History with Mock Data Across Tiers ────────────────────────

  describe('Monitoring history endpoint with mock data across tiers (Req 6.3)', () => {
    afterEach(() => {
      delete process.env[TEST_ENV_VAR];
    });

    it('GET /api/monitoring/history with short range returns data (auto 30s resolution)', async () => {
      const { app } = createMonitoringApp();
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      const res = await request(app)
        .get('/api/monitoring/history')
        .query({ start: twoHoursAgo.toISOString(), end: now.toISOString() })
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('GET /api/monitoring/history with explicit 5m resolution', async () => {
      const { app, deps } = createMonitoringApp();
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      const res = await request(app)
        .get('/api/monitoring/history')
        .query({
          start: twoDaysAgo.toISOString(),
          end: now.toISOString(),
          resolution: '5m',
        })
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // V2 resolutions (5m) use queryV2
      expect((deps.historicalMetrics as any).queryV2).toHaveBeenCalled();
    });

    it('GET /api/monitoring/history with containerId filter returns container data', async () => {
      const { app, deps } = createMonitoringApp();
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const res = await request(app)
        .get('/api/monitoring/history')
        .query({
          start: oneHourAgo.toISOString(),
          end: now.toISOString(),
          containerId: 'abc123def456',
        })
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // containerId triggers V2 path
      expect((deps.historicalMetrics as any).queryV2).toHaveBeenCalled();
    });

    it('GET /api/monitoring/history returns 400 without start/end params', async () => {
      const { app } = createMonitoringApp();

      const res = await request(app)
        .get('/api/monitoring/history')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_PARAMS');
    });
  });

  // ─── Alert Pagination Correctness ──────────────────────────────────────────

  describe('Alert endpoint pagination correctness (Req 11.2)', () => {
    it('page 1 with pageSize 5 returns exactly 5 items and correct total', async () => {
      const { app } = createAlertsApp(createPaginatingAlertSystem(12));

      const res = await request(app)
        .get('/api/alerts/history')
        .query({ page: 1, pageSize: 5 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(5);
      expect(res.body.total).toBe(12);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(5);
    });

    it('page 2 with pageSize 5 returns next 5 items', async () => {
      const { app } = createAlertsApp(createPaginatingAlertSystem(12));

      const res = await request(app)
        .get('/api/alerts/history')
        .query({ page: 2, pageSize: 5 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(5);
      expect(res.body.total).toBe(12);
      expect(res.body.page).toBe(2);
      expect(res.body.pageSize).toBe(5);
    });

    it('page 3 with pageSize 5 returns remaining 2 items', async () => {
      const { app } = createAlertsApp(createPaginatingAlertSystem(12));

      const res = await request(app)
        .get('/api/alerts/history')
        .query({ page: 3, pageSize: 5 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(12);
      expect(res.body.page).toBe(3);
      expect(res.body.pageSize).toBe(5);
    });

    it('pages are disjoint: no item ID appears on both page 1 and page 2', async () => {
      const { app } = createAlertsApp(createPaginatingAlertSystem(12));

      const page1 = await request(app)
        .get('/api/alerts/history')
        .query({ page: 1, pageSize: 5 });
      const page2 = await request(app)
        .get('/api/alerts/history')
        .query({ page: 2, pageSize: 5 });

      const page1Ids = page1.body.items.map((a: AlertRecord) => a.id);
      const page2Ids = page2.body.items.map((a: AlertRecord) => a.id);

      const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
      expect(overlap).toHaveLength(0);
    });

    it('page beyond total returns empty items array', async () => {
      const { app } = createAlertsApp(createPaginatingAlertSystem(12));

      const res = await request(app)
        .get('/api/alerts/history')
        .query({ page: 10, pageSize: 5 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
      expect(res.body.total).toBe(12);
    });
  });

  // ─── Backup Lifecycle: snapshot → export → restore → list → delete ─────────

  describe('Backup lifecycle round-trip (Req 17.1)', () => {
    it('full lifecycle: snapshot → export → restore → list → delete', async () => {
      const { app } = createBackupsApp();

      // Step 1: Create a container snapshot
      const snapshotRes = await request(app)
        .post('/api/backups/snapshot')
        .send({ container_id: 'web-app-container' });

      expect(snapshotRes.status).toBe(201);
      expect(snapshotRes.body.backupId).toBeDefined();
      expect(snapshotRes.body.imageTag).toBeDefined();
      expect(snapshotRes.body.containerId).toBe('web-app-container');
      const snapshotBackupId = snapshotRes.body.backupId;

      // Step 2: Export the image
      const exportRes = await request(app)
        .post('/api/backups/export')
        .send({ image_name: 'web-app:latest' });

      expect(exportRes.status).toBe(201);
      expect(exportRes.body.backupId).toBeDefined();
      expect(exportRes.body.archivePath).toBeDefined();
      expect(exportRes.body.size).toBeGreaterThan(0);
      const exportBackupId = exportRes.body.backupId;

      // Step 3: Restore from the snapshot
      const restoreRes = await request(app)
        .post('/api/backups/restore')
        .send({ backup_id: snapshotBackupId, target_container: 'web-app-container' });

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.success).toBe(true);
      expect(restoreRes.body.safetySnapshotId).toBeDefined();
      expect(restoreRes.body.newContainerId).toBeDefined();

      // Step 4: List backups — should contain the snapshot and export entries
      const listRes = await request(app).get('/api/backups');

      expect(listRes.status).toBe(200);
      expect(listRes.body.items.length).toBeGreaterThanOrEqual(2);
      const ids = listRes.body.items.map((b: any) => b.id);
      expect(ids).toContain(snapshotBackupId);
      expect(ids).toContain(exportBackupId);

      // Step 5: Delete the snapshot backup
      const deleteRes = await request(app).delete(`/api/backups/${snapshotBackupId}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.message).toBe('Backup deleted');

      // Verify it's gone from the list
      const listAfterDelete = await request(app).get('/api/backups');
      const remainingIds = listAfterDelete.body.items.map((b: any) => b.id);
      expect(remainingIds).not.toContain(snapshotBackupId);
      expect(remainingIds).toContain(exportBackupId);
    });

    it('snapshot with commit message passes message to backup manager', async () => {
      const backupManager = createMockBackupManager();
      const { app } = createBackupsApp(backupManager);

      const res = await request(app)
        .post('/api/backups/snapshot')
        .send({
          container_id: 'my-service',
          commit_message: 'Pre-deploy v3.0 backup',
        });

      expect(res.status).toBe(201);
      expect(backupManager.snapshotContainer).toHaveBeenCalledWith(
        'my-service',
        'Pre-deploy v3.0 backup'
      );
    });

    it('delete non-existent backup returns 500', async () => {
      const { app } = createBackupsApp();

      const res = await request(app).delete('/api/backups/nonexistent-id');

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Backup not found');
    });

    it('restore with missing backup_id returns 400', async () => {
      const { app } = createBackupsApp();

      const res = await request(app)
        .post('/api/backups/restore')
        .send({ target_container: 'my-container' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('backup_id');
    });
  });
});
