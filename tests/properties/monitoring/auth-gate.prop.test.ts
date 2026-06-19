/**
 * Property 2: Authentication gate
 *
 * Feature: vps-panel-monitoring-api, Property 2: Authentication gate
 *
 * For any request to a `/api/monitoring/*` endpoint that does not include a valid
 * Bearer token or session cookie, the API SHALL return HTTP 401 and SHALL NOT
 * include metric data in the response body.
 *
 * **Validates: Requirements 5.1, 5.4**
 */
import { describe, it, beforeEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createMonitoringAuth } from '../../../src/middleware/monitoring-auth.js';
import type { Session } from '../../../src/modules/auth.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const VALID_API_TOKEN = 'test-valid-api-token-abc123xyz';
const ENV_VAR_NAME = 'VPS_PANEL_API_TOKEN_TEST_PROP';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generate arbitrary monitoring endpoint paths.
 */
const monitoringPathArb = fc.oneof(
  fc.constant('/api/monitoring/system'),
  fc.constant('/api/monitoring/containers'),
  fc.constant('/api/monitoring/projects'),
  fc.constant('/api/monitoring/history'),
  fc.constant('/api/monitoring/projects/some-project'),
  fc.constant('/api/monitoring/projects/some-project/users'),
  fc.constant('/api/monitoring/projects/some-project/users/user1'),
  // Random sub-paths under /api/monitoring/
  fc.stringOf(
    fc.constantFrom(
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
      'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      '-', '_', '/'
    ),
    { minLength: 1, maxLength: 30 }
  )
    .filter((s) => !s.startsWith('/') && !s.endsWith('/') && !s.includes('//'))
    .map((s) => `/api/monitoring/${s}`)
);

/**
 * Generate arbitrary invalid Bearer tokens — strings that are NOT the valid token.
 */
const invalidBearerTokenArb = fc.oneof(
  // Random ASCII strings
  fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s !== VALID_API_TOKEN),
  // Tokens with slight variations
  fc.constant(VALID_API_TOKEN + 'x'),
  fc.constant('x' + VALID_API_TOKEN),
  fc.constant(VALID_API_TOKEN.slice(0, -1)),
  fc.constant(VALID_API_TOKEN.toUpperCase()),
  // UUID-like strings
  fc.uuid().map((u) => u.replace(/-/g, '')),
  // Empty-ish tokens
  fc.constant(''),
  fc.constant(' '),
  fc.constant('null'),
  fc.constant('undefined')
);

/**
 * Generate arbitrary invalid session cookie values — strings that the session
 * validator will reject (returns null).
 */
const invalidSessionCookieArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 64 }),
  fc.uuid(),
  fc.constant('expired-session-token'),
  fc.constant('malformed'),
  fc.hexaString({ minLength: 16, maxLength: 64 })
);

/**
 * Generate arbitrary Authorization header values that are malformed
 * (not valid Bearer format or have invalid tokens).
 */
const malformedAuthHeaderArb = fc.oneof(
  // Missing "Bearer " prefix
  fc.string({ minLength: 1, maxLength: 32 }).map((s) => `Basic ${s}`),
  fc.string({ minLength: 1, maxLength: 32 }).map((s) => `Token ${s}`),
  fc.string({ minLength: 1, maxLength: 32 }),
  // Bearer with invalid token
  invalidBearerTokenArb
    .filter((t) => t.trim().length > 0)
    .map((t) => `Bearer ${t}`)
);

// ─── Test App Setup ────────────────────────────────────────────────────────────

/**
 * Session validator that always returns null (all sessions are invalid).
 * This simulates the scenario where no valid session exists.
 */
function alwaysInvalidSessionValidator(_token: string): Session | null {
  return null;
}

/**
 * Creates an Express app with the monitoring auth middleware applied,
 * plus a catch-all route that returns metric data if auth passes.
 */
function createTestApp() {
  // Set the env var for the middleware
  process.env[ENV_VAR_NAME] = VALID_API_TOKEN;

  const app = express();
  app.use(express.json());

  const authMiddleware = createMonitoringAuth({
    apiTokenEnvVar: ENV_VAR_NAME,
    sessionValidator: alwaysInvalidSessionValidator,
  });

  // Apply auth middleware to all /api/monitoring/* routes
  app.use('/api/monitoring', authMiddleware);

  // Protected catch-all route that returns metric data (simulating a real endpoint)
  app.use('/api/monitoring', (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        cpu: { usagePercent: 42.5 },
        memory: { usedBytes: 1024000, totalBytes: 2048000 },
      },
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Feature: vps-panel-monitoring-api, Property 2: Authentication gate', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  it('requests with no credentials to any monitoring endpoint return 401 without metric data', async () => {
    await fc.assert(
      fc.asyncProperty(monitoringPathArb, async (path) => {
        const response = await request(app)
          .get(path)
          .set('Accept', 'application/json');

        // Must return 401
        if (response.status !== 401) {
          throw new Error(
            `Expected 401 for unauthenticated request to ${path}, got ${response.status}`
          );
        }

        // Must have success: false
        if (response.body.success !== false) {
          throw new Error(
            `Expected success: false in response body, got ${JSON.stringify(response.body)}`
          );
        }

        // Must NOT contain a 'data' field (no metric data leaked)
        if ('data' in response.body) {
          throw new Error(
            `Expected no 'data' field in 401 response, but found: ${JSON.stringify(response.body.data)}`
          );
        }
      }),
      { numRuns: 100 }
    );
  });

  it('requests with invalid Bearer tokens return 401 without metric data', async () => {
    await fc.assert(
      fc.asyncProperty(
        monitoringPathArb,
        invalidBearerTokenArb.filter((t) => t.trim().length > 0),
        async (path, invalidToken) => {
          const response = await request(app)
            .get(path)
            .set('Accept', 'application/json')
            .set('Authorization', `Bearer ${invalidToken}`);

          // Must return 401
          if (response.status !== 401) {
            throw new Error(
              `Expected 401 for invalid Bearer token on ${path}, got ${response.status}`
            );
          }

          // Must have success: false
          if (response.body.success !== false) {
            throw new Error(
              `Expected success: false, got ${JSON.stringify(response.body)}`
            );
          }

          // Must NOT contain a 'data' field
          if ('data' in response.body) {
            throw new Error(
              `Expected no 'data' field in 401 response, but found: ${JSON.stringify(response.body.data)}`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('requests with invalid session cookies return 401 without metric data', async () => {
    await fc.assert(
      fc.asyncProperty(
        monitoringPathArb,
        invalidSessionCookieArb,
        async (path, invalidSession) => {
          const response = await request(app)
            .get(path)
            .set('Accept', 'application/json')
            .set('Cookie', `session_token=${invalidSession}`);

          // Must return 401
          if (response.status !== 401) {
            throw new Error(
              `Expected 401 for invalid session cookie on ${path}, got ${response.status}`
            );
          }

          // Must have success: false
          if (response.body.success !== false) {
            throw new Error(
              `Expected success: false, got ${JSON.stringify(response.body)}`
            );
          }

          // Must NOT contain a 'data' field
          if ('data' in response.body) {
            throw new Error(
              `Expected no 'data' field in 401 response, but found: ${JSON.stringify(response.body.data)}`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('requests with malformed Authorization headers return 401 without metric data', async () => {
    await fc.assert(
      fc.asyncProperty(
        monitoringPathArb,
        malformedAuthHeaderArb,
        async (path, authHeader) => {
          const response = await request(app)
            .get(path)
            .set('Accept', 'application/json')
            .set('Authorization', authHeader);

          // Must return 401
          if (response.status !== 401) {
            throw new Error(
              `Expected 401 for malformed auth header "${authHeader}" on ${path}, got ${response.status}`
            );
          }

          // Must have success: false
          if (response.body.success !== false) {
            throw new Error(
              `Expected success: false, got ${JSON.stringify(response.body)}`
            );
          }

          // Must NOT contain a 'data' field
          if ('data' in response.body) {
            throw new Error(
              `Expected no 'data' field in 401 response, but found: ${JSON.stringify(response.body.data)}`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('valid Bearer token DOES pass through (sanity check - proves middleware works)', async () => {
    const response = await request(app)
      .get('/api/monitoring/system')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${VALID_API_TOKEN}`);

    // Valid token should reach the protected route
    if (response.status !== 200) {
      throw new Error(
        `Expected 200 for valid token, got ${response.status}: ${JSON.stringify(response.body)}`
      );
    }
    if (response.body.success !== true) {
      throw new Error(
        `Expected success: true for valid token, got ${JSON.stringify(response.body)}`
      );
    }
    if (!response.body.data) {
      throw new Error(
        `Expected 'data' field for valid token response, got ${JSON.stringify(response.body)}`
      );
    }
  });
});
