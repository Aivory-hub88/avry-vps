/**
 * Integration Tests: Monitoring API Routes
 *
 * Tests the full request/response flow through the monitoring Express router
 * with mocked service dependencies. Verifies:
 * - Full request/response flow with mocked Docker/proc
 * - Rate limiter integration across multiple requests
 * - Error responses for each error code
 * - Startup failure when VPS_PANEL_API_TOKEN is missing
 *
 * Requirements: 5.6, 6.1, 10.2, 10.4
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMonitoringRouter } from '../../../src/routes/monitoring.js';
import type { MonitoringRouterDependencies } from '../../../src/routes/monitoring.js';
import type { MetricsCollector } from '../../../src/services/metrics-collector.js';
import type { ProjectRegistry } from '../../../src/services/project-registry.js';
import type { HistoricalMetricsService } from '../../../src/services/historical-metrics.js';
import type { UserResourceTracker } from '../../../src/services/user-resource-tracking.js';
import { createMonitoringAuth } from '../../../src/middleware/monitoring-auth.js';

// ─── Test Constants ──────────────────────────────────────────────────────────

const TEST_API_TOKEN = 'test-monitoring-api-token-int-12345';
const TEST_ENV_VAR = 'VPS_PANEL_API_TOKEN_INT_TEST';

// ─── Mock Service Factories ──────────────────────────────────────────────────

function createMockMetricsCollector(): MetricsCollector {
  return {
    getSystemMetrics: vi.fn().mockResolvedValue({
      cpu: { usagePercent: 45.2 },
      memory: { usedBytes: 4_000_000_000, totalBytes: 8_000_000_000 },
      disk: { usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
      network: { rxBytesPerSec: 1024, txBytesPerSec: 2048 },
      timestamp: '2024-01-15T10:00:00.000Z',
    }),
    getContainerMetrics: vi.fn().mockResolvedValue([
      {
        id: 'abc123def456',
        name: 'avry-backend',
        status: 'running',
        cpu: { usagePercent: 12.5 },
        memory: { usedBytes: 512_000_000, limitBytes: 1_000_000_000 },
        network: { rxBytes: 100_000, txBytes: 200_000 },
        blockIo: { readBytes: 50_000, writeBytes: 75_000 },
      },
    ]),
    getProjectMetrics: vi.fn().mockResolvedValue({
      projectId: 'avry-v2-main',
      displayName: 'AVRY V2 Main',
      cpu: { usagePercent: 35.0 },
      memory: { usedBytes: 2_000_000_000, limitBytes: 4_000_000_000 },
      network: { rxBytes: 500_000, txBytes: 600_000 },
      blockIo: { readBytes: 100_000, writeBytes: 150_000 },
      containers: [],
    }),
    getAllProjectsSummary: vi.fn().mockResolvedValue([
      {
        projectId: 'avry-v2-main',
        displayName: 'AVRY V2 Main',
        containerCount: 14,
        cpu: { usagePercent: 35.0 },
        memory: { usedBytes: 2_000_000_000, limitBytes: 4_000_000_000 },
      },
    ]),
  };
}

function createMockProjectRegistry(): ProjectRegistry {
  return {
    create: vi.fn().mockResolvedValue({
      id: 'new-project',
      displayName: 'New Project',
      patterns: ['new-*'],
      createdAt: '2024-01-15T10:00:00.000Z',
      updatedAt: '2024-01-15T10:00:00.000Z',
    }),
    update: vi.fn().mockResolvedValue({
      id: 'avry-v2-main',
      displayName: 'Updated Project',
      patterns: ['avry-*'],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-15T10:00:00.000Z',
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      id: 'avry-v2-main',
      displayName: 'AVRY V2 Main',
      patterns: ['avry-*'],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }),
    list: vi.fn().mockResolvedValue([]),
    matchContainers: vi.fn().mockResolvedValue(['avry-backend', 'avry-frontend']),
  };
}

function createMockHistoricalMetrics(): HistoricalMetricsService {
  return {
    store: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([
      {
        timestamp: '2024-01-15T09:00:00.000Z',
        cpu: { usagePercent: 40.0 },
        memory: { usedBytes: 3_500_000_000, totalBytes: 8_000_000_000 },
        disk: { usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
        network: { rxBytesPerSec: 900, txBytesPerSec: 1800 },
      },
    ]),
    purgeOldRecords: vi.fn().mockResolvedValue(0),
    ensurePartitions: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockUserResourceTracker(): UserResourceTracker {
  return {
    track: vi.fn().mockResolvedValue(undefined),
    untrack: vi.fn().mockResolvedValue(undefined),
    getUserMetrics: vi.fn().mockResolvedValue({
      userId: 'user-123',
      totalCpuPercent: 10.5,
      totalMemoryBytes: 256_000_000,
      containers: [{ name: 'avry-backend', cpu: 10.5, memory: 256_000_000 }],
    }),
    listProjectUsers: vi.fn().mockResolvedValue([
      {
        userId: 'user-123',
        totalCpuPercent: 10.5,
        totalMemoryBytes: 256_000_000,
        containers: [{ name: 'avry-backend', cpu: 10.5, memory: 256_000_000 }],
      },
    ]),
  };
}

// ─── Test App Factory ────────────────────────────────────────────────────────

function createTestApp(overrides?: {
  metricsCollector?: MetricsCollector;
  projectRegistry?: ProjectRegistry;
  historicalMetrics?: HistoricalMetricsService;
  userResourceTracker?: UserResourceTracker;
  rateLimitMax?: number;
}) {
  const deps: MonitoringRouterDependencies = {
    metricsCollector: overrides?.metricsCollector ?? createMockMetricsCollector(),
    projectRegistry: overrides?.projectRegistry ?? createMockProjectRegistry(),
    historicalMetrics: overrides?.historicalMetrics ?? createMockHistoricalMetrics(),
    userResourceTracker: overrides?.userResourceTracker ?? createMockUserResourceTracker(),
    authOptions: {
      apiTokenEnvVar: TEST_ENV_VAR,
      sessionValidator: (token: string) => {
        if (token === 'valid-session-token') {
          return {
            id: 'session-abc',
            username: 'admin',
            createdAt: new Date(),
            lastActivity: new Date(),
            ip: '127.0.0.1',
          };
        }
        return null;
      },
    },
    rateLimitOptions: {
      config: {
        maxRequestsPerMinute: overrides?.rateLimitMax ?? 60,
        windowMs: 60_000,
      },
    },
  };

  const router = createMonitoringRouter(deps);
  const app = express();
  // Trust proxy so X-Forwarded-For is used for req.ip (otherwise supertest
  // connects via loopback and the rate limiter exempts it)
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/monitoring', router);
  return { app, deps };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Integration: Monitoring API Routes', () => {
  beforeEach(() => {
    process.env[TEST_ENV_VAR] = TEST_API_TOKEN;
  });

  afterEach(() => {
    delete process.env[TEST_ENV_VAR];
  });

  // ─── Full Request/Response Flow ──────────────────────────────────────────

  describe('Full request/response flow with mocked services', () => {
    it('GET /api/monitoring/system returns success envelope with system metrics', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.cpu.usagePercent).toBe(45.2);
      expect(res.body.data.memory.usedBytes).toBe(4_000_000_000);
      expect(res.body.data.memory.totalBytes).toBe(8_000_000_000);
      expect(res.body.data.disk).toBeDefined();
      expect(res.body.data.network).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('GET /api/monitoring/containers returns container array in envelope', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/containers')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].name).toBe('avry-backend');
      expect(res.body.data[0].id).toBe('abc123def456');
    });

    it('GET /api/monitoring/projects returns project summaries', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/projects')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].projectId).toBe('avry-v2-main');
    });

    it('GET /api/monitoring/projects/:projectId returns single project metrics', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/projects/avry-v2-main')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.projectId).toBe('avry-v2-main');
      expect(res.body.data.displayName).toBe('AVRY V2 Main');
    });

    it('POST /api/monitoring/projects/registry creates a new project', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/monitoring/projects/registry')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .send({ id: 'new-project', displayName: 'New Project', patterns: ['new-*'] });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('new-project');
    });

    it('PUT /api/monitoring/projects/registry/:projectId updates project', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .put('/api/monitoring/projects/registry/avry-v2-main')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .send({ displayName: 'Updated Project' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.displayName).toBe('Updated Project');
    });

    it('DELETE /api/monitoring/projects/registry/:projectId deletes project', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .delete('/api/monitoring/projects/registry/avry-v2-main')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .send({ confirmation: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deleted).toBe(true);
    });

    it('GET /api/monitoring/history returns time-series data', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/history')
        .query({ start: '2024-01-15T08:00:00.000Z', end: '2024-01-15T10:00:00.000Z' })
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /api/monitoring/projects/:projectId/users returns user list', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/projects/avry-v2-main/users')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].userId).toBe('user-123');
    });

    it('GET /api/monitoring/projects/:projectId/users/:userId returns user metrics', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/projects/avry-v2-main/users/user-123')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.userId).toBe('user-123');
      expect(res.body.data.totalCpuPercent).toBe(10.5);
    });

    it('POST /api/monitoring/projects/:projectId/users/:userId/track records allocation', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/monitoring/projects/avry-v2-main/users/user-123/track')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .send({ containerName: 'avry-backend', cpuAllocation: 10.5, memoryAllocation: 256_000_000 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tracked).toBe(true);
    });

    it('DELETE /api/monitoring/projects/:projectId/users/:userId/track removes tracking', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .delete('/api/monitoring/projects/avry-v2-main/users/user-123/track')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.untracked).toBe(true);
    });
  });

  // ─── X-API-Version Header ────────────────────────────────────────────────

  describe('X-API-Version header', () => {
    it('includes X-API-Version: 1.0 on successful responses', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.headers['x-api-version']).toBe('1.0');
    });

    it('includes X-API-Version: 1.0 on error responses from services', async () => {
      const metricsCollector = createMockMetricsCollector();
      (metricsCollector.getSystemMetrics as any).mockRejectedValue(
        Object.assign(new Error('System unavailable'), { code: 'SYSTEM_UNAVAILABLE', statusCode: 503 })
      );
      const { app } = createTestApp({ metricsCollector });
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.headers['x-api-version']).toBe('1.0');
    });
  });

  // ─── Rate Limit Headers ──────────────────────────────────────────────────

  describe('Rate limit headers on responses', () => {
    it('includes X-RateLimit-Limit header', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '192.168.1.100');

      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(Number(res.headers['x-ratelimit-limit'])).toBe(60);
    });

    it('includes X-RateLimit-Remaining header', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '192.168.1.100');

      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThan(60);
    });

    it('includes X-RateLimit-Reset header as unix timestamp', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '192.168.1.100');

      expect(res.headers['x-ratelimit-reset']).toBeDefined();
      const resetTs = Number(res.headers['x-ratelimit-reset']);
      expect(resetTs).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  // ─── Rate Limiter Integration ────────────────────────────────────────────

  describe('Rate limiter integration across multiple requests', () => {
    it('returns 429 after exceeding the configured rate limit', async () => {
      const { app } = createTestApp({ rateLimitMax: 3 });

      // Make requests from a non-loopback IP so rate limiting applies
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .get('/api/monitoring/system')
          .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
          .set('X-Forwarded-For', '10.0.0.1');
        expect(res.status).toBe(200);
      }

      // The 4th request should be rate limited
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '10.0.0.1');

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('rate limit applies per client (different auth methods are separate)', async () => {
      const { app } = createTestApp({ rateLimitMax: 2 });

      // Exhaust rate limit for Bearer token client
      for (let i = 0; i < 2; i++) {
        await request(app)
          .get('/api/monitoring/system')
          .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
          .set('X-Forwarded-For', '10.0.0.1');
      }

      // Bearer token client is now limited
      const blockedRes = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '10.0.0.1');
      expect(blockedRes.status).toBe(429);

      // Session client should still work (different client ID)
      const sessionRes = await request(app)
        .get('/api/monitoring/system')
        .set('Cookie', 'session_token=valid-session-token')
        .set('X-Forwarded-For', '10.0.0.2');
      expect(sessionRes.status).toBe(200);
    });

    it('rate limit decrements remaining count on each request', async () => {
      const { app } = createTestApp({ rateLimitMax: 5 });

      const res1 = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '10.0.0.50');
      const remaining1 = Number(res1.headers['x-ratelimit-remaining']);

      const res2 = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '10.0.0.50');
      const remaining2 = Number(res2.headers['x-ratelimit-remaining']);

      expect(remaining2).toBe(remaining1 - 1);
    });

    it('rate limited response still includes X-RateLimit-* headers', async () => {
      const { app } = createTestApp({ rateLimitMax: 1 });

      // Exhaust limit
      await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '10.0.0.99');

      // Rate limited response
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '10.0.0.99');

      expect(res.status).toBe(429);
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBe('0');
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });
  });

  // ─── Error Responses for Each Error Code ─────────────────────────────────

  describe('Error responses for each error code', () => {
    it('AUTH_REQUIRED (401) when no credentials provided', async () => {
      const { app } = createTestApp();
      const res = await request(app).get('/api/monitoring/system');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('AUTH_REQUIRED');
      expect(res.body.error).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('AUTH_INVALID (401) when invalid Bearer token provided', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', 'Bearer wrong-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('AUTH_INVALID');
      expect(res.body.error).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('AUTH_INVALID (401) when invalid session cookie provided', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Cookie', 'session_token=invalid-session');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('AUTH_INVALID');
    });

    it('RATE_LIMITED (429) when rate limit exceeded', async () => {
      const { app } = createTestApp({ rateLimitMax: 1 });

      // First request succeeds
      await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '10.0.0.1');

      // Second request is rate limited
      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .set('X-Forwarded-For', '10.0.0.1');

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(res.body.error).toContain('Rate limit exceeded');
      expect(res.body.timestamp).toBeDefined();
    });

    it('PROJECT_NOT_FOUND (404) when project does not exist', async () => {
      const metricsCollector = createMockMetricsCollector();
      (metricsCollector.getProjectMetrics as any).mockRejectedValue(
        Object.assign(new Error('Project "unknown" not found'), {
          code: 'PROJECT_NOT_FOUND',
          statusCode: 404,
        })
      );
      const { app } = createTestApp({ metricsCollector });

      const res = await request(app)
        .get('/api/monitoring/projects/unknown')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PROJECT_NOT_FOUND');
      expect(res.body.error).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('USER_NOT_FOUND (404) when user has no tracked resources', async () => {
      const userResourceTracker = createMockUserResourceTracker();
      (userResourceTracker.getUserMetrics as any).mockRejectedValue(
        Object.assign(new Error('No tracked resources found for user'), {
          code: 'USER_NOT_FOUND',
          statusCode: 404,
        })
      );
      const { app } = createTestApp({ userResourceTracker });

      const res = await request(app)
        .get('/api/monitoring/projects/avry-v2-main/users/unknown-user')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('USER_NOT_FOUND');
      expect(res.body.error).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('PROJECT_SCOPE_DENIED (403) when token lacks project access', async () => {
      const userResourceTracker = createMockUserResourceTracker();
      (userResourceTracker.listProjectUsers as any).mockRejectedValue(
        Object.assign(new Error('Token does not have access to project'), {
          code: 'PROJECT_SCOPE_DENIED',
          statusCode: 403,
        })
      );
      const { app } = createTestApp({ userResourceTracker });

      const res = await request(app)
        .get('/api/monitoring/projects/other-project/users')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PROJECT_SCOPE_DENIED');
      expect(res.body.error).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('SYSTEM_UNAVAILABLE (503) when /proc is not accessible', async () => {
      const metricsCollector = createMockMetricsCollector();
      (metricsCollector.getSystemMetrics as any).mockRejectedValue(
        Object.assign(new Error('System metrics unavailable: /proc not accessible'), {
          code: 'SYSTEM_UNAVAILABLE',
          statusCode: 503,
        })
      );
      const { app } = createTestApp({ metricsCollector });

      const res = await request(app)
        .get('/api/monitoring/system')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('SYSTEM_UNAVAILABLE');
      expect(res.body.error).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('DOCKER_UNAVAILABLE (503) when Docker socket is not accessible', async () => {
      const metricsCollector = createMockMetricsCollector();
      (metricsCollector.getContainerMetrics as any).mockRejectedValue(
        Object.assign(new Error('Docker socket unavailable'), {
          code: 'DOCKER_UNAVAILABLE',
          statusCode: 503,
        })
      );
      const { app } = createTestApp({ metricsCollector });

      const res = await request(app)
        .get('/api/monitoring/containers')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('DOCKER_UNAVAILABLE');
      expect(res.body.error).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('INVALID_PARAMS (400) when registry POST is missing required fields', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/monitoring/projects/registry')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .send({ id: 'test' }); // missing displayName and patterns

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_PARAMS');
    });

    it('INVALID_PARAMS (400) when history is missing start/end params', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/monitoring/history')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_PARAMS');
    });

    it('INVALID_PARAMS (400) when track request is missing required body fields', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/monitoring/projects/avry-v2-main/users/user-123/track')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .send({ containerName: 'avry-backend' }); // missing cpuAllocation and memoryAllocation

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_PARAMS');
    });

    it('PROJECT_EXISTS (409) when creating duplicate project', async () => {
      const projectRegistry = createMockProjectRegistry();
      (projectRegistry.create as any).mockRejectedValue(
        Object.assign(new Error('Project already registered'), {
          code: 'PROJECT_EXISTS',
          statusCode: 409,
        })
      );
      const { app } = createTestApp({ projectRegistry });

      const res = await request(app)
        .post('/api/monitoring/projects/registry')
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`)
        .send({ id: 'existing', displayName: 'Existing', patterns: ['ex-*'] });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PROJECT_EXISTS');
    });

    it('DB_UNAVAILABLE (503) when PostgreSQL connection fails', async () => {
      const historicalMetrics = createMockHistoricalMetrics();
      (historicalMetrics.query as any).mockRejectedValue(
        Object.assign(new Error('Database connection failed'), {
          code: 'DB_UNAVAILABLE',
          statusCode: 503,
        })
      );
      const { app } = createTestApp({ historicalMetrics });

      const res = await request(app)
        .get('/api/monitoring/history')
        .query({ start: '2024-01-15T08:00:00.000Z', end: '2024-01-15T10:00:00.000Z' })
        .set('Authorization', `Bearer ${TEST_API_TOKEN}`);

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('DB_UNAVAILABLE');
    });
  });

  // ─── Startup Failure When Token Missing ──────────────────────────────────

  describe('Startup failure when VPS_PANEL_API_TOKEN is missing', () => {
    it('throws error when API token env var is not set', () => {
      // Remove the token from the environment
      delete process.env[TEST_ENV_VAR];

      expect(() => {
        createTestApp();
      }).toThrow(/not set/i);
    });

    it('throws error with descriptive message mentioning the env var name', () => {
      delete process.env[TEST_ENV_VAR];

      expect(() => {
        createTestApp();
      }).toThrow(TEST_ENV_VAR);
    });

    it('createMonitoringAuth throws directly when token env var is missing', () => {
      delete process.env[TEST_ENV_VAR];

      expect(() => {
        createMonitoringAuth({
          apiTokenEnvVar: TEST_ENV_VAR,
          sessionValidator: () => null,
        });
      }).toThrow(/not set/i);
    });
  });
});
