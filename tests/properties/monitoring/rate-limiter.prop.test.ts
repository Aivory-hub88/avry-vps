/**
 * Property-based tests for the Monitoring Rate Limiter.
 *
 * Feature: vps-panel-monitoring-api, Property 3: Rate limit headers present on all responses
 * For any authenticated response from a monitoring endpoint (regardless of HTTP status code),
 * the response SHALL include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`
 * headers, and `X-RateLimit-Remaining` SHALL be a non-negative integer less than or equal to
 * `X-RateLimit-Limit`.
 *
 * Feature: vps-panel-monitoring-api, Property 4: Rate limit enforcement
 * For any client making more than the configured maximum requests (default 60) within a 60-second
 * window, subsequent requests SHALL receive HTTP 429 with a `Retry-After` header containing a
 * positive integer value.
 *
 * **Validates: Requirements 6.1, 6.2, 6.4**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  createMonitoringRateLimiter,
  createRateLimitMiddleware,
  type MonitoringRateLimiter,
  type RateLimitResult,
} from '../../../src/modules/monitoring-rate-limiter.js';
import type { Request, Response } from 'express';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Arbitrary for generating valid client IDs (simulating token hashes or session IDs).
 */
const clientIdArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
  ),
  { minLength: 8, maxLength: 64 }
);

/**
 * Arbitrary for generating a rate limit configuration (1-100 max requests).
 */
const rateLimitArb = fc.integer({ min: 1, max: 100 });

/**
 * Arbitrary for generating a number of requests (1-120).
 */
const requestCountArb = fc.integer({ min: 1, max: 120 });

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a mock Express Request object with a non-loopback IP.
 */
function createMockRequest(clientId: string): Partial<Request> {
  return {
    ip: '192.168.1.100',
    socket: { remoteAddress: '192.168.1.100' } as any,
    headers: {},
    get: ((name: string) => undefined) as any,
    monitoringAuth: { clientId },
  } as any;
}

/**
 * Create a mock Express Response object that captures headers and status.
 */
function createMockResponse(): {
  res: Partial<Response>;
  getHeaders: () => Record<string, string>;
  getStatus: () => number | undefined;
  getBody: () => any;
} {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body: any;

  const res: Partial<Response> = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this as Response;
    },
    status(code: number) {
      statusCode = code;
      return this as Response;
    },
    json(data: any) {
      body = data;
      return this as Response;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
  } as any;

  return {
    res,
    getHeaders: () => headers,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Monitoring Rate Limiter Property Tests', () => {
  describe('Property 3: Rate limit headers present on all responses', () => {
    it('For any client and any number of requests, all responses SHALL include X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset headers with valid values', () => {
      fc.assert(
        fc.property(
          clientIdArb,
          requestCountArb,
          rateLimitArb,
          (clientId, requestCount, maxRequests) => {
            const limiter = createMonitoringRateLimiter({
              maxRequestsPerMinute: maxRequests,
              windowMs: 60_000,
            });

            for (let i = 0; i < requestCount; i++) {
              const result: RateLimitResult = limiter.check(clientId);

              // Property: X-RateLimit-Limit is always the configured limit
              expect(result.limit).toBe(maxRequests);

              // Property: X-RateLimit-Remaining is a non-negative integer
              expect(result.remaining).toBeGreaterThanOrEqual(0);
              expect(Number.isInteger(result.remaining)).toBe(true);

              // Property: X-RateLimit-Remaining <= X-RateLimit-Limit
              expect(result.remaining).toBeLessThanOrEqual(result.limit);

              // Property: X-RateLimit-Reset is a positive number (Unix timestamp in seconds)
              expect(result.resetAt).toBeGreaterThan(0);
              expect(Number.isInteger(result.resetAt)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any client, the middleware SHALL set rate limit headers on the response regardless of whether the request is allowed or blocked', () => {
      fc.assert(
        fc.property(
          clientIdArb,
          rateLimitArb,
          (clientId, maxRequests) => {
            const limiter = createMonitoringRateLimiter({
              maxRequestsPerMinute: maxRequests,
              windowMs: 60_000,
            });

            const middleware = createRateLimitMiddleware({
              limiter,
              getClientId: () => clientId,
            });

            // Make maxRequests + 1 requests to ensure we get both allowed and blocked states
            for (let i = 0; i <= maxRequests; i++) {
              const req = createMockRequest(clientId);
              const { res, getHeaders } = createMockResponse();
              let nextCalled = false;

              middleware(req as Request, res as Response, () => { nextCalled = true; });

              const headers = getHeaders();

              // Property: Headers are ALWAYS present
              expect(headers['x-ratelimit-limit']).toBeDefined();
              expect(headers['x-ratelimit-remaining']).toBeDefined();
              expect(headers['x-ratelimit-reset']).toBeDefined();

              // Property: Values are valid integers
              const limit = parseInt(headers['x-ratelimit-limit'], 10);
              const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
              const reset = parseInt(headers['x-ratelimit-reset'], 10);

              expect(Number.isNaN(limit)).toBe(false);
              expect(Number.isNaN(remaining)).toBe(false);
              expect(Number.isNaN(reset)).toBe(false);

              // Property: remaining is non-negative and <= limit
              expect(remaining).toBeGreaterThanOrEqual(0);
              expect(remaining).toBeLessThanOrEqual(limit);

              // Property: limit matches configured value
              expect(limit).toBe(maxRequests);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 4: Rate limit enforcement', () => {
    it('For any configured limit, making limit+1 requests SHALL result in the last request being blocked with HTTP 429 and Retry-After > 0', () => {
      fc.assert(
        fc.property(
          clientIdArb,
          rateLimitArb,
          (clientId, maxRequests) => {
            const limiter = createMonitoringRateLimiter({
              maxRequestsPerMinute: maxRequests,
              windowMs: 60_000,
            });

            const middleware = createRateLimitMiddleware({
              limiter,
              getClientId: () => clientId,
            });

            // Make exactly maxRequests allowed requests
            for (let i = 0; i < maxRequests; i++) {
              const req = createMockRequest(clientId);
              const { res } = createMockResponse();
              let nextCalled = false;

              middleware(req as Request, res as Response, () => { nextCalled = true; });

              // First maxRequests requests should be allowed
              expect(nextCalled).toBe(true);
            }

            // The (maxRequests + 1)th request should be blocked
            const req = createMockRequest(clientId);
            const { res, getHeaders, getStatus } = createMockResponse();
            let nextCalled = false;

            middleware(req as Request, res as Response, () => { nextCalled = true; });

            // Property: Request is blocked (next not called)
            expect(nextCalled).toBe(false);

            // Property: HTTP 429 status
            expect(getStatus()).toBe(429);

            // Property: Retry-After header is present with a positive integer value
            const retryAfter = getHeaders()['retry-after'];
            expect(retryAfter).toBeDefined();
            const retryAfterValue = parseInt(retryAfter, 10);
            expect(Number.isNaN(retryAfterValue)).toBe(false);
            expect(retryAfterValue).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any client, requests within the limit SHALL be allowed (next is called)', () => {
      fc.assert(
        fc.property(
          clientIdArb,
          rateLimitArb,
          fc.integer({ min: 1, max: 100 }),
          (clientId, maxRequests, requestsToMake) => {
            // Only test cases where requests are within the limit
            const safeRequests = Math.min(requestsToMake, maxRequests);

            const limiter = createMonitoringRateLimiter({
              maxRequestsPerMinute: maxRequests,
              windowMs: 60_000,
            });

            const middleware = createRateLimitMiddleware({
              limiter,
              getClientId: () => clientId,
            });

            for (let i = 0; i < safeRequests; i++) {
              const req = createMockRequest(clientId);
              const { res } = createMockResponse();
              let nextCalled = false;

              middleware(req as Request, res as Response, () => { nextCalled = true; });

              // Property: All requests within limit are allowed
              expect(nextCalled).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any client exceeding the limit, ALL subsequent requests SHALL be blocked until the window resets', () => {
      fc.assert(
        fc.property(
          clientIdArb,
          rateLimitArb,
          fc.integer({ min: 1, max: 20 }),
          (clientId, maxRequests, extraRequests) => {
            const limiter = createMonitoringRateLimiter({
              maxRequestsPerMinute: maxRequests,
              windowMs: 60_000,
            });

            const middleware = createRateLimitMiddleware({
              limiter,
              getClientId: () => clientId,
            });

            // Exhaust the limit
            for (let i = 0; i < maxRequests; i++) {
              const req = createMockRequest(clientId);
              const { res } = createMockResponse();
              middleware(req as Request, res as Response, () => {});
            }

            // All subsequent requests should be blocked
            for (let i = 0; i < extraRequests; i++) {
              const req = createMockRequest(clientId);
              const { res, getStatus, getHeaders } = createMockResponse();
              let nextCalled = false;

              middleware(req as Request, res as Response, () => { nextCalled = true; });

              // Property: Blocked
              expect(nextCalled).toBe(false);
              expect(getStatus()).toBe(429);

              // Property: Retry-After is a positive integer
              const retryAfter = parseInt(getHeaders()['retry-after'], 10);
              expect(retryAfter).toBeGreaterThan(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
