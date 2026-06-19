/**
 * Property 1: Response envelope consistency
 *
 * Feature: vps-panel-monitoring-api, Property 1: Response envelope consistency
 *
 * For any monitoring API request (whether successful or failed), the JSON response body
 * SHALL contain a `success` boolean field and a `timestamp` field, and if `success` is
 * true it SHALL contain a `data` field, and if `success` is false it SHALL contain an
 * `error` field and a `code` field.
 *
 * **Validates: Requirements 10.2, 10.4**
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createMonitoringRouter } from '../../../src/routes/monitoring.js';
import type { MonitoringRouterDependencies } from '../../../src/routes/monitoring.js';
import type { MetricsCollector, ContainerFilters } from '../../../src/services/metrics-collector.js';
import type { ProjectRegistry } from '../../../src/services/project-registry.js';
import type { HistoricalMetricsService } from '../../../src/services/historical-metrics.js';
import type { UserResourceTracker, ResourceAllocationInput } from '../../../src/services/user-resource-tracking.js';
import { createMonitoringRateLimiter } from '../../../src/modules/monitoring-rate-limiter.js';
import type { Session } from '../../../src/modules/auth.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const VALID_API_TOKEN = 'test-envelope-property-token-xyz789';
const ENV_VAR_NAME = 'VPS_PANEL_API_TOKEN_ENVELOPE_TEST';

// ─── ISO 8601 validation ───────────────────────────────────────────────────────

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isValidISO8601(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ISO_8601_REGEX.test(value) && !isNaN(Date.parse(value));
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate arbitrary monitoring endpoints that return success responses.
 * These are GET endpoints that the mocked services will handle successfully.
 */
const successEndpointArb = fc.oneof(
  fc.constant({ method: 'get' as const, path: '/api/monitoring/system' }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/containers' }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/projects' }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/projects/test-project' }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/projects/test-project/users' }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/projects/test-project/users/user1' }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/history?start=2024-01-01T00:00:00Z&end=2024-01-02T00:00:00Z' })
);

/**
 * Generate arbitrary monitoring endpoints that return error responses.
 * These include auth failures and bad requests.
 */
const errorEndpointArb = fc.oneof(
  // No auth → 401
  fc.constant({ method: 'get' as const, path: '/api/monitoring/system', noAuth: true }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/containers', noAuth: true }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/projects', noAuth: true }),
  // Invalid auth → 401
  fc.constant({ method: 'get' as const, path: '/api/monitoring/system', invalidAuth: true }),
  fc.constant({ method: 'get' as const, path: '/api/monitoring/containers', invalidAuth: true })
);

/**
 * Generate service errors that handlers will throw to produce error envelopes.
 */
const serviceErrorArb = fc.record({
  message: fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e', ' ', '.'), { minLength: 5, maxLength: 50 }),
  code: fc.constantFrom('SYSTEM_UNAVAILABLE', 'DOCKER_UNAVAILABLE', 'DB_UNAVAILABLE', 'PROJECT_NOT_FOUND', 'USER_NOT_FOUND'),
  statusCode: fc.constantFrom(404, 500, 503),
});

/**
 * Generate arbitrary endpoints where the service will throw an error (producing error envelope).
 * Only includes endpoints backed by metricsCollector, since that's what we configure to throw.
 */
const serviceErrorEndpointArb = fc.constantFrom(
  '/api/monitoring/system',
  '/api/monitoring/containers',
  '/api/monitoring/projects',
  '/api/monitoring/projects/nonexistent-project'
);

// ─── Mock Services ─────────────────────────────────────────────────────────────

function createMockMetricsCollector(shouldThrow?: { message: string; code: string; statusCode: number }): MetricsCollector {
  const throwIfNeeded = () => {
    if (shouldThrow) {
      const err = new Error(shouldThrow.message) as Error & { code: string; statusCode: number };
      err.code = shouldThrow.code;
      err.statusCode = shouldThrow.statusCode;
      throw err;
    }
  };

  return {
    async getSystemMetrics() {
      throwIfNeeded();
      return {
        cpu: { usagePercent: 45.2 },
        memory: { usedBytes: 4_000_000_000, totalBytes: 8_000_000_000 },
        disk: { usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
        network: { rxBytesPerSec: 1024, txBytesPerSec: 2048 },
        timestamp: new Date().toISOString(),
      };
    },
    async getContainerMetrics(_filters?: ContainerFilters) {
      throwIfNeeded();
      return [
        {
          id: 'abc123def456',
          name: 'test-container',
          status: 'running',
          cpu: { usagePercent: 12.5 },
          memory: { usedBytes: 256_000_000, limitBytes: 512_000_000 },
          network: { rxBytes: 1000, txBytes: 2000 },
          blockIo: { readBytes: 500, writeBytes: 300 },
        },
      ];
    },
    async getProjectMetrics(_projectId: string) {
      throwIfNeeded();
      return {
        projectId: 'test-project',
        displayName: 'Test Project',
        cpu: { usagePercent: 30.0 },
        memory: { usedBytes: 1_000_000_000, limitBytes: 2_000_000_000 },
        network: { rxBytes: 5000, txBytes: 3000 },
        blockIo: { readBytes: 2000, writeBytes: 1000 },
        containers: [],
      };
    },
    async getAllProjectsSummary() {
      throwIfNeeded();
      return [
        {
          projectId: 'test-project',
          displayName: 'Test Project',
          containerCount: 3,
          cpu: { usagePercent: 30.0 },
          memory: { usedBytes: 1_000_000_000, limitBytes: 2_000_000_000 },
        },
      ];
    },
  };
}

function createMockProjectRegistry(): ProjectRegistry {
  return {
    async create(input) {
      return { id: input.id, displayName: input.displayName, patterns: input.patterns, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    },
    async update(projectId, input) {
      return { id: projectId, displayName: input.displayName ?? 'Test', patterns: input.patterns ?? ['*'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    },
    async delete(_projectId, _confirmation) {},
    async get(projectId) {
      return { id: projectId, displayName: 'Test', patterns: ['test-*'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    },
    async list() {
      return [];
    },
    async matchContainers(_projectId, containerNames) {
      return containerNames;
    },
  };
}

function createMockHistoricalMetrics(): HistoricalMetricsService {
  return {
    async store(_metrics) {},
    async query(_params) {
      return [
        {
          timestamp: '2024-01-01T00:00:00Z',
          cpu: { usagePercent: 40 },
          memory: { usedBytes: 2_000_000_000, totalBytes: 8_000_000_000 },
          disk: { usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
          network: { rxBytesPerSec: 1024, txBytesPerSec: 2048 },
        },
      ];
    },
    async purgeOldRecords() { return 0; },
    async ensurePartitions() {},
  };
}

function createMockUserResourceTracker(): UserResourceTracker {
  return {
    async track(_projectId: string, _userId: string, _allocation: ResourceAllocationInput, _projectScope?: string) {},
    async untrack(_projectId: string, _userId: string, _projectScope?: string) {},
    async getUserMetrics(_projectId: string, _userId: string, _projectScope?: string) {
      return { userId: 'user1', totalCpuPercent: 10, totalMemoryBytes: 512_000_000, containers: [] };
    },
    async listProjectUsers(_projectId: string, _projectScope?: string) {
      return [{ userId: 'user1', totalCpuPercent: 10, totalMemoryBytes: 512_000_000, containers: [] }];
    },
  };
}

// ─── Test App Setup ────────────────────────────────────────────────────────────

function createTestApp(serviceError?: { message: string; code: string; statusCode: number }) {
  process.env[ENV_VAR_NAME] = VALID_API_TOKEN;

  const app = express();
  app.use(express.json());

  const deps: MonitoringRouterDependencies = {
    metricsCollector: createMockMetricsCollector(serviceError),
    projectRegistry: createMockProjectRegistry(),
    historicalMetrics: createMockHistoricalMetrics(),
    userResourceTracker: createMockUserResourceTracker(),
    authOptions: {
      apiTokenEnvVar: ENV_VAR_NAME,
      sessionValidator: (_token: string): Session | null => null,
    },
    rateLimitOptions: {
      config: { maxRequestsPerMinute: 1000, windowMs: 60_000 },
    },
  };

  const router = createMonitoringRouter(deps);
  app.use('/api/monitoring', router);

  return app;
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Feature: vps-panel-monitoring-api, Property 1: Response envelope consistency', () => {
  afterEach(() => {
    delete process.env[ENV_VAR_NAME];
  });

  it('successful responses SHALL contain success:true, a data field, and a valid ISO 8601 timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(successEndpointArb, async (endpoint) => {
        const app = createTestApp();

        const response = await request(app)
          [endpoint.method](endpoint.path)
          .set('Authorization', `Bearer ${VALID_API_TOKEN}`)
          .set('Accept', 'application/json');

        const body = response.body;

        // Property: success field is a boolean and is true
        if (typeof body.success !== 'boolean') {
          throw new Error(
            `Expected 'success' to be a boolean, got ${typeof body.success} for ${endpoint.path}. Body: ${JSON.stringify(body)}`
          );
        }
        if (body.success !== true) {
          throw new Error(
            `Expected success: true for authenticated request to ${endpoint.path}, got ${body.success}. Body: ${JSON.stringify(body)}`
          );
        }

        // Property: timestamp field exists and is a valid ISO 8601 string
        if (!isValidISO8601(body.timestamp)) {
          throw new Error(
            `Expected 'timestamp' to be a valid ISO 8601 string, got '${body.timestamp}' for ${endpoint.path}`
          );
        }

        // Property: data field exists when success is true
        if (!('data' in body)) {
          throw new Error(
            `Expected 'data' field when success is true, but it was missing for ${endpoint.path}. Body: ${JSON.stringify(body)}`
          );
        }
      }),
      { numRuns: 100 }
    );
  });

  it('error responses from auth failures SHALL contain success:false, error, code, and timestamp fields, and SHALL NOT have a data field', async () => {
    await fc.assert(
      fc.asyncProperty(errorEndpointArb, async (endpoint) => {
        const app = createTestApp();

        let req = request(app).get(endpoint.path).set('Accept', 'application/json');

        if ((endpoint as any).invalidAuth) {
          req = req.set('Authorization', 'Bearer invalid-token-xyz');
        }
        // If noAuth, don't set any auth headers (default)

        const response = await req;

        const body = response.body;

        // Property: success field is a boolean and is false
        if (typeof body.success !== 'boolean') {
          throw new Error(
            `Expected 'success' to be a boolean, got ${typeof body.success} for ${endpoint.path}. Body: ${JSON.stringify(body)}`
          );
        }
        if (body.success !== false) {
          throw new Error(
            `Expected success: false for unauthenticated/invalid auth on ${endpoint.path}, got ${body.success}`
          );
        }

        // Property: timestamp field exists and is a valid ISO 8601 string
        if (!isValidISO8601(body.timestamp)) {
          throw new Error(
            `Expected 'timestamp' to be a valid ISO 8601 string, got '${body.timestamp}' for ${endpoint.path}`
          );
        }

        // Property: error field exists and is a string
        if (typeof body.error !== 'string' || body.error.length === 0) {
          throw new Error(
            `Expected 'error' to be a non-empty string when success is false, got '${body.error}' for ${endpoint.path}`
          );
        }

        // Property: code field exists and is a string
        if (typeof body.code !== 'string' || body.code.length === 0) {
          throw new Error(
            `Expected 'code' to be a non-empty string when success is false, got '${body.code}' for ${endpoint.path}`
          );
        }

        // Property: data field SHALL NOT be present when success is false
        if ('data' in body) {
          throw new Error(
            `Expected no 'data' field when success is false, but found it for ${endpoint.path}. Body: ${JSON.stringify(body)}`
          );
        }
      }),
      { numRuns: 100 }
    );
  });

  it('error responses from service failures SHALL contain success:false, error, code, and timestamp fields, and SHALL NOT have a data field', async () => {
    await fc.assert(
      fc.asyncProperty(
        serviceErrorEndpointArb,
        serviceErrorArb,
        async (path, serviceError) => {
          const app = createTestApp(serviceError);

          const response = await request(app)
            .get(path)
            .set('Authorization', `Bearer ${VALID_API_TOKEN}`)
            .set('Accept', 'application/json');

          const body = response.body;

          // Property: success field is a boolean and is false
          if (typeof body.success !== 'boolean') {
            throw new Error(
              `Expected 'success' to be a boolean, got ${typeof body.success} for ${path}. Body: ${JSON.stringify(body)}`
            );
          }
          if (body.success !== false) {
            throw new Error(
              `Expected success: false for service error on ${path}, got ${body.success}. Body: ${JSON.stringify(body)}`
            );
          }

          // Property: timestamp field exists and is a valid ISO 8601 string
          if (!isValidISO8601(body.timestamp)) {
            throw new Error(
              `Expected 'timestamp' to be a valid ISO 8601 string, got '${body.timestamp}' for ${path}`
            );
          }

          // Property: error field exists and is a string
          if (typeof body.error !== 'string' || body.error.length === 0) {
            throw new Error(
              `Expected 'error' to be a non-empty string when success is false, got '${body.error}' for ${path}`
            );
          }

          // Property: code field exists and is a string
          if (typeof body.code !== 'string' || body.code.length === 0) {
            throw new Error(
              `Expected 'code' to be a non-empty string when success is false, got '${body.code}' for ${path}`
            );
          }

          // Property: data field SHALL NOT be present when success is false
          if ('data' in body) {
            throw new Error(
              `Expected no 'data' field when success is false, but found it for ${path}. Body: ${JSON.stringify(body)}`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rate limit error responses (429) SHALL also conform to the error envelope format', async () => {
    // Create an app with a very low rate limit to trigger 429
    // Use a custom rate limiter that does NOT exempt loopback (supertest uses 127.0.0.1)
    process.env[ENV_VAR_NAME] = VALID_API_TOKEN;

    const app = express();
    app.use(express.json());

    // Create a rate limiter that never exempts (overrides isExempt to return false)
    const baseLimiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 1, windowMs: 60_000 });
    const nonExemptLimiter = {
      ...baseLimiter,
      isExempt: () => false,
    };

    const deps: MonitoringRouterDependencies = {
      metricsCollector: createMockMetricsCollector(),
      projectRegistry: createMockProjectRegistry(),
      historicalMetrics: createMockHistoricalMetrics(),
      userResourceTracker: createMockUserResourceTracker(),
      authOptions: {
        apiTokenEnvVar: ENV_VAR_NAME,
        sessionValidator: (_token: string): Session | null => null,
      },
      rateLimitOptions: {
        limiter: nonExemptLimiter,
      },
    };

    const router = createMonitoringRouter(deps);
    app.use('/api/monitoring', router);

    // First request consumes the limit
    await request(app)
      .get('/api/monitoring/system')
      .set('Authorization', `Bearer ${VALID_API_TOKEN}`);

    // Second request should be rate-limited (429)
    const response = await request(app)
      .get('/api/monitoring/system')
      .set('Authorization', `Bearer ${VALID_API_TOKEN}`);

    const body = response.body;

    // Property: 429 response has correct envelope
    if (response.status !== 429) {
      throw new Error(`Expected 429 status after exceeding rate limit, got ${response.status}`);
    }
    if (typeof body.success !== 'boolean' || body.success !== false) {
      throw new Error(`Expected success: false for 429 response, got ${body.success}`);
    }
    if (!isValidISO8601(body.timestamp)) {
      throw new Error(`Expected valid ISO 8601 timestamp in 429 response, got '${body.timestamp}'`);
    }
    if (typeof body.error !== 'string' || body.error.length === 0) {
      throw new Error(`Expected non-empty 'error' string in 429 response, got '${body.error}'`);
    }
    if (typeof body.code !== 'string' || body.code.length === 0) {
      throw new Error(`Expected non-empty 'code' string in 429 response, got '${body.code}'`);
    }
    if ('data' in body) {
      throw new Error(`Expected no 'data' field in 429 response, but found it`);
    }
  });

  it('all responses (success or error) SHALL always have success as a boolean and timestamp as ISO 8601', async () => {
    // Combined property: for any endpoint hit with any auth state, the envelope invariants hold
    const anyEndpointArb = fc.oneof(
      fc.constant({ path: '/api/monitoring/system', withAuth: true }),
      fc.constant({ path: '/api/monitoring/containers', withAuth: true }),
      fc.constant({ path: '/api/monitoring/projects', withAuth: true }),
      fc.constant({ path: '/api/monitoring/projects/test-project', withAuth: true }),
      fc.constant({ path: '/api/monitoring/history?start=2024-01-01T00:00:00Z&end=2024-01-02T00:00:00Z', withAuth: true }),
      fc.constant({ path: '/api/monitoring/system', withAuth: false }),
      fc.constant({ path: '/api/monitoring/containers', withAuth: false }),
      fc.constant({ path: '/api/monitoring/projects', withAuth: false }),
      fc.constant({ path: '/api/monitoring/system', withAuth: true, invalidToken: true }),
      fc.constant({ path: '/api/monitoring/containers', withAuth: true, invalidToken: true })
    );

    await fc.assert(
      fc.asyncProperty(anyEndpointArb, async (endpoint) => {
        const app = createTestApp();

        let req = request(app).get(endpoint.path).set('Accept', 'application/json');

        if (endpoint.withAuth && !(endpoint as any).invalidToken) {
          req = req.set('Authorization', `Bearer ${VALID_API_TOKEN}`);
        } else if ((endpoint as any).invalidToken) {
          req = req.set('Authorization', 'Bearer wrong-token');
        }

        const response = await req;
        const body = response.body;

        // Universal property: success is always a boolean
        if (typeof body.success !== 'boolean') {
          throw new Error(
            `'success' must be a boolean for ${endpoint.path} (auth=${endpoint.withAuth}), got ${typeof body.success}. Body: ${JSON.stringify(body)}`
          );
        }

        // Universal property: timestamp is always a valid ISO 8601 string
        if (!isValidISO8601(body.timestamp)) {
          throw new Error(
            `'timestamp' must be a valid ISO 8601 string for ${endpoint.path} (auth=${endpoint.withAuth}), got '${body.timestamp}'`
          );
        }

        // Conditional property: if success is true, data must exist
        if (body.success === true && !('data' in body)) {
          throw new Error(
            `When success is true, 'data' must be present for ${endpoint.path}. Body: ${JSON.stringify(body)}`
          );
        }

        // Conditional property: if success is false, error and code must exist, data must not
        if (body.success === false) {
          if (typeof body.error !== 'string' || body.error.length === 0) {
            throw new Error(
              `When success is false, 'error' must be a non-empty string for ${endpoint.path}. Got: '${body.error}'`
            );
          }
          if (typeof body.code !== 'string' || body.code.length === 0) {
            throw new Error(
              `When success is false, 'code' must be a non-empty string for ${endpoint.path}. Got: '${body.code}'`
            );
          }
          if ('data' in body) {
            throw new Error(
              `When success is false, 'data' must NOT be present for ${endpoint.path}. Body: ${JSON.stringify(body)}`
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
