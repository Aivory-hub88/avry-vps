/**
 * Application Bootstrap Integration Test
 *
 * Verifies that the premium services (Partition Manager, Settings Service,
 * Downsampling Engine, Settings Hot-Reload) are initialized in the correct
 * order during application startup.
 *
 * @validates Requirements 2.4, 7.1, 7.2, 7.3, 7.4, 7.5
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external dependencies before importing app
vi.mock('../../src/database/index.js', () => ({
  initializeDatabase: () => ({
    prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }),
  }),
  checkHealth: () => ({ healthy: true, latencyMs: 1, walMode: true }),
  closeDatabase: vi.fn(),
  getDbPath: () => '/tmp/test.db',
}));

vi.mock('../../src/database/pg-client.js', () => ({
  createPgClient: () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../src/database/migrations.js', () => ({
  runPgMigrations: vi.fn().mockResolvedValue(undefined),
}));

// Track initialization order
const initOrder: string[] = [];

vi.mock('../../src/database/partition-manager.js', () => ({
  createPartitionManager: vi.fn(() => ({
    verifyAndRepair: vi.fn(async () => {
      initOrder.push('partitionManager.verifyAndRepair');
      return { healthy: true, missingPartitions: 0, createdPartitions: [] };
    }),
    ensureFuturePartitions: vi.fn().mockResolvedValue(undefined),
    pruneExpiredPartitions: vi.fn().mockResolvedValue([]),
    listPartitions: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../src/services/settings-service.js', () => ({
  createSettingsService: vi.fn(() => {
    initOrder.push('settingsService.created');
    const { EventEmitter } = require('events');
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      getAll: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue(''),
      getTyped: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue(undefined),
      validate: vi.fn().mockReturnValue({ valid: true }),
      getDefinitions: vi.fn().mockReturnValue([]),
    });
  }),
}));

vi.mock('../../src/services/downsampling-engine.js', () => ({
  createDownsamplingEngine: vi.fn(() => {
    initOrder.push('downsamplingEngine.created');
    return {
      start: vi.fn(() => { initOrder.push('downsamplingEngine.start'); }),
      stop: vi.fn(),
      aggregateTier1: vi.fn().mockResolvedValue({ bucketsCreated: 0, rawPointsDeleted: 0, errors: [] }),
      aggregateTier2: vi.fn().mockResolvedValue({ bucketsCreated: 0, rawPointsDeleted: 0, errors: [] }),
      purgeExpiredHourly: vi.fn().mockResolvedValue(0),
    };
  }),
}));

vi.mock('../../src/services/settings-hot-reload.js', () => ({
  createSettingsHotReload: vi.fn(() => {
    initOrder.push('settingsHotReload.created');
    return { dispose: vi.fn() };
  }),
  createMetricsCollectionHandle: vi.fn(() => {
    initOrder.push('metricsCollectionHandle.created');
    return {
      setInterval: vi.fn(),
      getInterval: vi.fn().mockReturnValue(30000),
      dispose: vi.fn(),
    };
  }),
  createAlertThresholdHandle: vi.fn(() => ({
    updateThreshold: vi.fn(),
    getThreshold: vi.fn(),
  })),
  createBackupScheduleHandle: vi.fn(() => ({
    reschedule: vi.fn(),
    getScheduleConfig: vi.fn().mockReturnValue({
      cronExpression: '0 2 * * *',
      targets: [],
      retentionCount: 7,
      enabled: false,
    }),
  })),
}));

vi.mock('../../src/services/metrics-collector.js', () => ({
  createMetricsCollector: vi.fn(() => ({
    getSystemMetrics: vi.fn().mockResolvedValue({}),
    getContainerMetrics: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../src/services/project-registry.js', () => ({
  createProjectRegistry: vi.fn(() => ({
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../src/services/historical-metrics.js', () => ({
  createHistoricalMetricsService: vi.fn(() => ({
    store: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    purgeOldRecords: vi.fn().mockResolvedValue(0),
    ensurePartitions: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/services/user-resource-tracking.js', () => ({
  createUserResourceTracker: vi.fn(() => ({
    track: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/routes/monitoring.js', () => ({
  createMonitoringRouter: vi.fn(() => {
    const { Router } = require('express');
    return Router();
  }),
}));

vi.mock('../../src/modules/auth.js', () => ({
  createAuthModule: vi.fn(() => ({
    validateSession: vi.fn().mockResolvedValue(false),
    authenticate: vi.fn().mockResolvedValue(null),
    createSession: vi.fn().mockReturnValue(''),
  })),
}));

vi.mock('../../src/modules/rate-limiter.js', () => ({
  createRateLimiter: vi.fn(() => ({
    isLocked: vi.fn().mockReturnValue(false),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  })),
}));

vi.mock('../../src/modules/container-manager.js', () => ({
  createContainerManager: vi.fn(() => ({
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn().mockResolvedValue({ status: 'running', health: 'healthy' }),
    getContainerStats: vi.fn().mockResolvedValue({ cpuUsagePercent: 0, memoryUsageMB: 0 }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    restartContainer: vi.fn().mockResolvedValue(undefined),
    startHealthPolling: vi.fn(),
    stopHealthPolling: vi.fn(),
  })),
}));

vi.mock('../../src/modules/file-manager.js', () => ({
  createFileManager: vi.fn(() => ({})),
}));

vi.mock('../../src/modules/terminal-manager.js', () => ({
  createTerminalManager: vi.fn(() => ({
    closeAllSessions: vi.fn(),
  })),
  createNodePtySpawner: vi.fn(() => { throw new Error('Not available'); }),
}));

vi.mock('../../src/modules/log-viewer.js', () => ({
  createLogViewer: vi.fn(() => ({})),
}));

vi.mock('../../src/modules/domain-manager.js', () => ({
  createDomainManager: vi.fn(() => ({})),
}));

vi.mock('../../src/modules/ssl-manager.js', () => ({
  createSSLManager: vi.fn(() => ({
    startRenewalCron: vi.fn(),
    stopRenewalCron: vi.fn(),
  })),
}));

vi.mock('../../src/modules/cron-manager.js', () => ({
  createCronManager: vi.fn(() => ({})),
}));

vi.mock('../../src/modules/database-manager.js', () => ({
  createDatabaseManager: vi.fn(() => ({})),
}));

vi.mock('../../src/modules/backup-manager.js', () => ({
  createBackupManager: vi.fn(() => ({
    startScheduler: vi.fn(),
    stopScheduler: vi.fn(),
    updateScheduleFromSettings: vi.fn(),
  })),
}));

vi.mock('../../src/modules/resource-widget.js', () => ({
  createResourceWidget: vi.fn(() => ({
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    getLatestUpdate: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../../src/modules/alert-system.js', () => ({
  createAlertSystem: vi.fn(() => ({
    emitAlert: vi.fn().mockResolvedValue('alert-id'),
    getAlertHistory: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../src/modules/audit-logger.js', () => ({
  createAuditLogger: vi.fn(() => ({
    log: vi.fn(),
    startPurgeScheduler: vi.fn(),
    stopPurgeScheduler: vi.fn(),
  })),
}));

vi.mock('../../src/modules/project-manager.js', () => ({
  createProjectManager: vi.fn(() => ({})),
}));

vi.mock('../../src/modules/job-queue.js', () => ({
  createJobQueue: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    submit: vi.fn(),
  })),
}));

vi.mock('../../src/modules/build-pipeline.js', () => ({
  createBuildPipeline: vi.fn(() => ({
    triggerBuild: vi.fn(),
  })),
}));

vi.mock('../../src/modules/webhook-handler.js', () => ({
  createWebhookHandler: vi.fn(() => ({})),
}));

vi.mock('../../src/modules/tunnel-manager.js', () => ({
  createTunnelManager: vi.fn(() => ({})),
}));

vi.mock('../../src/modules/cicd-bridge.js', () => ({
  createCICDBridge: vi.fn(() => ({
    destroy: vi.fn(),
  })),
}));

vi.mock('../../src/modules/security-manager.js', () => ({
  createSecurityManager: vi.fn(() => ({})),
}));

vi.mock('../../src/routes/index.js', () => ({
  registerRoutes: vi.fn(),
}));

vi.mock('../../src/socket/index.js', () => ({
  setupSocketHandlers: vi.fn(),
  createAlertNotificationCallback: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  createAuthMiddleware: vi.fn(() => ((_req: any, _res: any, next: any) => next())),
}));

describe('Application Bootstrap — Premium Services Wiring', () => {
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    initOrder.length = 0;
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it('should initialize premium services in correct order during Postgres init', async () => {
    const { createApp } = await import('../../src/app.js');

    const instance = createApp({
      PORT: 4100,
      SUPABASE_JWT_SECRET: 'test-secret',
      DOCKER_HOST: '/var/run/docker.sock',
      ENVIRONMENT: 'test',
      CORS_ORIGINS: ['*'],
    });

    await instance.initializePostgres();

    // Verify correct initialization order:
    // 1. Partition Manager verifyAndRepair
    // 2. Settings Service created
    // 3. Downsampling Engine created
    // 4. Downsampling Engine started
    // 5. Metrics Collection Handle created (hot-reloadable)
    // 6. Settings Hot-Reload wired
    expect(initOrder).toContain('partitionManager.verifyAndRepair');
    expect(initOrder).toContain('settingsService.created');
    expect(initOrder).toContain('downsamplingEngine.created');
    expect(initOrder).toContain('downsamplingEngine.start');
    expect(initOrder).toContain('metricsCollectionHandle.created');
    expect(initOrder).toContain('settingsHotReload.created');

    // Verify order: partition manager before settings, settings before downsampling
    const pmIdx = initOrder.indexOf('partitionManager.verifyAndRepair');
    const ssIdx = initOrder.indexOf('settingsService.created');
    const deIdx = initOrder.indexOf('downsamplingEngine.created');
    const deStartIdx = initOrder.indexOf('downsamplingEngine.start');
    const hrIdx = initOrder.indexOf('settingsHotReload.created');

    expect(pmIdx).toBeLessThan(ssIdx);
    expect(ssIdx).toBeLessThan(deIdx);
    expect(deIdx).toBeLessThan(deStartIdx);
    expect(deStartIdx).toBeLessThan(hrIdx);

    // Cleanup
    instance.shutdown();
  });

  it('should pass alert callback to Partition Manager', async () => {
    const { createPartitionManager } = await import('../../src/database/partition-manager.js');

    const { createApp } = await import('../../src/app.js');

    const instance = createApp({
      PORT: 4101,
      SUPABASE_JWT_SECRET: 'test-secret',
      DOCKER_HOST: '/var/run/docker.sock',
      ENVIRONMENT: 'test',
      CORS_ORIGINS: ['*'],
    });

    await instance.initializePostgres();

    // Verify createPartitionManager was called with an onAlert callback
    expect(createPartitionManager).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        onAlert: expect.any(Function),
      })
    );

    instance.shutdown();
  });

  it('should create downsampling engine with pgClient and settingsService', async () => {
    const { createDownsamplingEngine } = await import('../../src/services/downsampling-engine.js');

    const { createApp } = await import('../../src/app.js');

    const instance = createApp({
      PORT: 4102,
      SUPABASE_JWT_SECRET: 'test-secret',
      DOCKER_HOST: '/var/run/docker.sock',
      ENVIRONMENT: 'test',
      CORS_ORIGINS: ['*'],
    });

    await instance.initializePostgres();

    // Verify downsampling engine was created with pgClient and settingsService
    expect(createDownsamplingEngine).toHaveBeenCalledWith(
      expect.anything(), // pgClient
      expect.anything(), // settingsService
    );

    instance.shutdown();
  });

  it('should wire settings hot-reload with all service handles', async () => {
    const { createSettingsHotReload } = await import('../../src/services/settings-hot-reload.js');

    const { createApp } = await import('../../src/app.js');

    const instance = createApp({
      PORT: 4103,
      SUPABASE_JWT_SECRET: 'test-secret',
      DOCKER_HOST: '/var/run/docker.sock',
      ENVIRONMENT: 'test',
      CORS_ORIGINS: ['*'],
    });

    await instance.initializePostgres();

    // Verify settings hot-reload was called with all required handles
    expect(createSettingsHotReload).toHaveBeenCalledWith(
      expect.objectContaining({
        settingsService: expect.anything(),
        metricsCollection: expect.anything(),
        alertThresholds: expect.anything(),
        backupSchedule: expect.anything(),
      })
    );

    instance.shutdown();
  });

  it('should stop downsampling engine and dispose hot-reload on shutdown', async () => {
    const { createDownsamplingEngine } = await import('../../src/services/downsampling-engine.js');
    const { createSettingsHotReload } = await import('../../src/services/settings-hot-reload.js');

    const { createApp } = await import('../../src/app.js');

    const instance = createApp({
      PORT: 4104,
      SUPABASE_JWT_SECRET: 'test-secret',
      DOCKER_HOST: '/var/run/docker.sock',
      ENVIRONMENT: 'test',
      CORS_ORIGINS: ['*'],
    });

    await instance.initializePostgres();

    // Get the mocked instances
    const engineMock = (createDownsamplingEngine as any).mock.results[
      (createDownsamplingEngine as any).mock.results.length - 1
    ].value;
    const hotReloadMock = (createSettingsHotReload as any).mock.results[
      (createSettingsHotReload as any).mock.results.length - 1
    ].value;

    // Verify they haven't been stopped yet
    expect(engineMock.stop).not.toHaveBeenCalled();
    expect(hotReloadMock.dispose).not.toHaveBeenCalled();

    // Shutdown
    instance.shutdown();

    // Verify cleanup
    expect(engineMock.stop).toHaveBeenCalled();
    expect(hotReloadMock.dispose).toHaveBeenCalled();
  });
});
