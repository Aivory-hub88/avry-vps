/**
 * Unit tests for the Monitoring Rate Limiter module.
 * Tests sliding-window logic, exemption, headers, and middleware behavior.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createMonitoringRateLimiter,
  createRateLimitMiddleware,
  resolveConfig,
  type MonitoringRateLimiter,
} from '../../src/modules/monitoring-rate-limiter.js';
import type { Request, Response } from 'express';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function createMockResponse(): Response & { _status: number; _headers: Record<string, string>; _json: any } {
  const res: any = {
    _status: 200,
    _headers: {},
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
      return res;
    },
    json(body: any) {
      res._json = body;
      return res;
    },
  };
  return res;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Monitoring Rate Limiter Module', () => {
  let limiter: MonitoringRateLimiter;

  beforeEach(() => {
    limiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 5, windowMs: 60_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VPS_PANEL_RATE_LIMIT;
  });

  describe('resolveConfig', () => {
    it('should return defaults when no config or env var is set', () => {
      const config = resolveConfig();
      expect(config.maxRequestsPerMinute).toBe(60);
      expect(config.windowMs).toBe(60_000);
    });

    it('should use VPS_PANEL_RATE_LIMIT env var when set', () => {
      process.env.VPS_PANEL_RATE_LIMIT = '120';
      const config = resolveConfig();
      expect(config.maxRequestsPerMinute).toBe(120);
    });

    it('should ignore invalid VPS_PANEL_RATE_LIMIT values', () => {
      process.env.VPS_PANEL_RATE_LIMIT = 'not-a-number';
      const config = resolveConfig();
      expect(config.maxRequestsPerMinute).toBe(60);
    });

    it('should ignore zero or negative VPS_PANEL_RATE_LIMIT', () => {
      process.env.VPS_PANEL_RATE_LIMIT = '0';
      const config = resolveConfig();
      expect(config.maxRequestsPerMinute).toBe(60);

      process.env.VPS_PANEL_RATE_LIMIT = '-5';
      const config2 = resolveConfig();
      expect(config2.maxRequestsPerMinute).toBe(60);
    });

    it('should allow overriding via config parameter', () => {
      const config = resolveConfig({ maxRequestsPerMinute: 100, windowMs: 30_000 });
      expect(config.maxRequestsPerMinute).toBe(100);
      expect(config.windowMs).toBe(30_000);
    });

    it('should let env var take precedence over config parameter', () => {
      process.env.VPS_PANEL_RATE_LIMIT = '200';
      const config = resolveConfig({ maxRequestsPerMinute: 100 });
      expect(config.maxRequestsPerMinute).toBe(200);
    });
  });

  describe('check', () => {
    it('should allow requests under the limit', () => {
      const result = limiter.check('client-1');
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(5);
      expect(result.remaining).toBe(4);
      expect(result.retryAfterSeconds).toBeUndefined();
    });

    it('should decrement remaining with each request', () => {
      limiter.check('client-1');
      limiter.check('client-1');
      const result = limiter.check('client-1');
      expect(result.remaining).toBe(2);
    });

    it('should block requests at the limit', () => {
      for (let i = 0; i < 5; i++) {
        limiter.check('client-1');
      }
      const result = limiter.check('client-1');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('should not count blocked requests against the limit', () => {
      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        limiter.check('client-1');
      }
      // These should all be rejected but not add to the count
      limiter.check('client-1');
      limiter.check('client-1');
      expect(limiter.getClientRequestCount('client-1')).toBe(5);
    });

    it('should track clients independently', () => {
      for (let i = 0; i < 5; i++) {
        limiter.check('client-1');
      }
      const result = limiter.check('client-2');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it('should include a resetAt timestamp in the future', () => {
      const before = Math.floor(Date.now() / 1000);
      const result = limiter.check('client-1');
      expect(result.resetAt).toBeGreaterThan(before);
    });

    it('should allow requests again after the window expires', () => {
      // Use a very short window
      const shortLimiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 2, windowMs: 50 });

      shortLimiter.check('client-1');
      shortLimiter.check('client-1');
      expect(shortLimiter.check('client-1').allowed).toBe(false);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const result = shortLimiter.check('client-1');
          expect(result.allowed).toBe(true);
          resolve();
        }, 100);
      });
    });
  });

  describe('isExempt', () => {
    it('should exempt 127.0.0.1', () => {
      const req = createMockRequest({ ip: '127.0.0.1' });
      expect(limiter.isExempt(req)).toBe(true);
    });

    it('should exempt ::1', () => {
      const req = createMockRequest({ ip: '::1' });
      expect(limiter.isExempt(req)).toBe(true);
    });

    it('should exempt ::ffff:127.0.0.1', () => {
      const req = createMockRequest({ ip: '::ffff:127.0.0.1' });
      expect(limiter.isExempt(req)).toBe(true);
    });

    it('should not exempt external IPs', () => {
      const req = createMockRequest({ ip: '192.168.1.1' });
      expect(limiter.isExempt(req)).toBe(false);
    });

    it('should fall back to socket.remoteAddress when req.ip is undefined', () => {
      const req = createMockRequest({ ip: undefined, socket: { remoteAddress: '::1' } as any });
      expect(limiter.isExempt(req)).toBe(true);
    });
  });

  describe('getClientRequestCount', () => {
    it('should return 0 for unknown clients', () => {
      expect(limiter.getClientRequestCount('unknown')).toBe(0);
    });

    it('should return the correct count', () => {
      limiter.check('client-1');
      limiter.check('client-1');
      limiter.check('client-1');
      expect(limiter.getClientRequestCount('client-1')).toBe(3);
    });
  });

  describe('reset', () => {
    it('should clear all stored data', () => {
      limiter.check('client-1');
      limiter.check('client-2');
      limiter.reset();
      expect(limiter.getClientRequestCount('client-1')).toBe(0);
      expect(limiter.getClientRequestCount('client-2')).toBe(0);
    });
  });
});

describe('Rate Limit Middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VPS_PANEL_RATE_LIMIT;
  });

  it('should call next() when request is allowed', () => {
    const limiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 10, windowMs: 60_000 });
    const middleware = createRateLimitMiddleware({ limiter });

    const req = createMockRequest();
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    middleware(req, res as any, next);

    expect(nextCalled).toBe(true);
    expect(res._headers['X-RateLimit-Limit']).toBe('10');
    expect(res._headers['X-RateLimit-Remaining']).toBe('9');
    expect(res._headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('should return 429 when rate limit is exceeded', () => {
    const limiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 2, windowMs: 60_000 });
    const middleware = createRateLimitMiddleware({ limiter });

    const req = createMockRequest();
    const res = createMockResponse();
    const next = () => {};

    // Exhaust limit
    middleware(req, res as any, next);
    middleware(req, res as any, next);

    // Third request should be blocked
    const res3 = createMockResponse();
    middleware(req, res3 as any, next);

    expect(res3._status).toBe(429);
    expect(res3._json.success).toBe(false);
    expect(res3._json.code).toBe('RATE_LIMITED');
    expect(res3._json.error).toContain('Rate limit exceeded');
    expect(res3._json.timestamp).toBeDefined();
    expect(res3._headers['Retry-After']).toBeDefined();
    expect(parseInt(res3._headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('should set rate limit headers on all responses', () => {
    const limiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 5, windowMs: 60_000 });
    const middleware = createRateLimitMiddleware({ limiter });

    const req = createMockRequest();
    const res = createMockResponse();
    const next = () => {};

    middleware(req, res as any, next);

    expect(res._headers['X-RateLimit-Limit']).toBe('5');
    expect(res._headers['X-RateLimit-Remaining']).toBe('4');
    expect(res._headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('should exempt localhost requests', () => {
    const limiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 1, windowMs: 60_000 });
    const middleware = createRateLimitMiddleware({ limiter });

    const req = createMockRequest({ ip: '127.0.0.1' });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    // First request
    middleware(req, res as any, next);
    expect(nextCalled).toBe(true);

    // Second request (would exceed limit of 1 if not exempt)
    nextCalled = false;
    const res2 = createMockResponse();
    middleware(req, res2 as any, next);
    expect(nextCalled).toBe(true);
    expect(res2._status).toBe(200); // not 429
  });

  it('should exempt ::1 (IPv6 loopback)', () => {
    const limiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 1, windowMs: 60_000 });
    const middleware = createRateLimitMiddleware({ limiter });

    const req = createMockRequest({ ip: '::1' });
    const res = createMockResponse();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    middleware(req, res as any, next);
    middleware(req, res as any, next);
    expect(nextCalled).toBe(true);
  });

  it('should use clientId from monitoringAuth when available', () => {
    const limiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 2, windowMs: 60_000 });
    const middleware = createRateLimitMiddleware({ limiter });

    const req1 = createMockRequest({ ip: '10.0.0.1' });
    (req1 as any).monitoringAuth = { clientId: 'token-hash-abc' };

    const req2 = createMockRequest({ ip: '10.0.0.1' });
    (req2 as any).monitoringAuth = { clientId: 'token-hash-xyz' };

    const res1 = createMockResponse();
    const res2 = createMockResponse();
    const next = () => {};

    // Two requests from different auth clients (same IP)
    middleware(req1, res1 as any, next);
    middleware(req1, res1 as any, next);
    middleware(req2, res2 as any, next);

    // req2 should still be allowed (different clientId)
    expect(res2._headers['X-RateLimit-Remaining']).toBe('1');
  });

  it('should include rate limit headers on exempt requests', () => {
    const limiter = createMonitoringRateLimiter({ maxRequestsPerMinute: 60, windowMs: 60_000 });
    const middleware = createRateLimitMiddleware({ limiter });

    const req = createMockRequest({ ip: '127.0.0.1' });
    const res = createMockResponse();
    const next = () => {};

    middleware(req, res as any, next);

    expect(res._headers['X-RateLimit-Limit']).toBe('60');
    expect(res._headers['X-RateLimit-Remaining']).toBe('60');
    expect(res._headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('should use VPS_PANEL_RATE_LIMIT env var', () => {
    process.env.VPS_PANEL_RATE_LIMIT = '3';
    const middleware = createRateLimitMiddleware();

    const req = createMockRequest();
    const res = createMockResponse();
    const next = () => {};

    middleware(req, res as any, next);

    expect(res._headers['X-RateLimit-Limit']).toBe('3');
    expect(res._headers['X-RateLimit-Remaining']).toBe('2');
  });
});
