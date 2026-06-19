/**
 * Unit tests for the Monitoring Auth Middleware
 *
 * Tests constant-time comparison, Bearer token validation, session cookie fallback,
 * error envelope format, and startup validation.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  createMonitoringAuth,
  constantTimeEqual,
  hashToken,
} from '../../src/middleware/monitoring-auth.js';
import type { Session } from '../../src/modules/auth.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

const TEST_TOKEN = 'test-api-token-secure-value-12345';

function createMockRequest(options: {
  authorization?: string;
  cookie?: string;
} = {}): Partial<Request> {
  return {
    headers: {
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
  };
}

function createMockResponse() {
  const state = { statusCode: null as number | null, jsonBody: null as any };

  const res: Partial<Response> = {
    status(code: number) {
      state.statusCode = code;
      return res as Response;
    },
    json(body: any) {
      state.jsonBody = body;
      return res as Response;
    },
  };

  return { res, state };
}

function createMockSession(id: string = 'session-123'): Session {
  return {
    id,
    username: 'admin',
    createdAt: new Date(),
    lastActivity: new Date(),
    ip: '127.0.0.1',
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Monitoring Auth Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VPS_PANEL_API_TOKEN: TEST_TOKEN };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createMonitoringAuth - startup validation', () => {
    it('throws if API token env var is not set (Requirement 5.6)', () => {
      delete process.env.VPS_PANEL_API_TOKEN;

      expect(() =>
        createMonitoringAuth({
          apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
          sessionValidator: () => null,
        })
      ).toThrow(/VPS_PANEL_API_TOKEN.*not set/);
    });

    it('throws if API token env var is empty string', () => {
      process.env.VPS_PANEL_API_TOKEN = '';

      expect(() =>
        createMonitoringAuth({
          apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
          sessionValidator: () => null,
        })
      ).toThrow(/VPS_PANEL_API_TOKEN.*not set/);
    });

    it('creates middleware successfully when token is set', () => {
      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator: () => null,
      });

      expect(middleware).toBeTypeOf('function');
    });
  });

  describe('Bearer token authentication (Requirement 5.2)', () => {
    it('authenticates with valid Bearer token', () => {
      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator: () => null,
      });

      const req = createMockRequest({ authorization: `Bearer ${TEST_TOKEN}` });
      const { res, state } = createMockResponse();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledOnce();
      expect(state.statusCode).toBeNull();
      expect((req as any).monitoringAuth).toMatchObject({
        authenticated: true,
        authMethod: 'api_token',
        clientId: hashToken(TEST_TOKEN),
      });
    });

    it('returns 401 AUTH_INVALID for wrong Bearer token (Requirement 5.4)', () => {
      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator: () => null,
      });

      const req = createMockRequest({ authorization: 'Bearer wrong-token' });
      const { res, state } = createMockResponse();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
      expect(state.jsonBody).toMatchObject({
        success: false,
        error: 'Invalid API token',
        code: 'AUTH_INVALID',
      });
      expect(state.jsonBody.timestamp).toBeDefined();
    });

    it('returns 401 for Bearer header with empty token', () => {
      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator: () => null,
      });

      // "Bearer " with nothing after it
      const req = createMockRequest({ authorization: 'Bearer ' });
      const { res, state } = createMockResponse();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      // Empty bearer token is treated as "no credentials"
      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
      expect(state.jsonBody.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('Session cookie authentication (Requirement 5.3)', () => {
    it('authenticates with valid session cookie', () => {
      const mockSession = createMockSession('sess-abc');
      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator: (token) => (token === 'valid-session-jwt' ? mockSession : null),
      });

      const req = createMockRequest({ cookie: 'session_token=valid-session-jwt' });
      const { res, state } = createMockResponse();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledOnce();
      expect(state.statusCode).toBeNull();
      expect((req as any).monitoringAuth).toMatchObject({
        authenticated: true,
        authMethod: 'session',
        clientId: 'sess-abc',
      });
    });

    it('returns 401 AUTH_INVALID for expired/invalid session cookie (Requirement 5.4)', () => {
      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator: () => null, // All sessions are "invalid"
      });

      const req = createMockRequest({ cookie: 'session_token=expired-token' });
      const { res, state } = createMockResponse();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
      expect(state.jsonBody).toMatchObject({
        success: false,
        error: 'Invalid or expired session',
        code: 'AUTH_INVALID',
      });
    });

    it('ignores session cookie if Bearer token is present (Bearer takes priority)', () => {
      const mockSession = createMockSession();
      const sessionValidator = vi.fn(() => mockSession);

      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator,
      });

      const req = createMockRequest({
        authorization: `Bearer ${TEST_TOKEN}`,
        cookie: 'session_token=some-session',
      });
      const { res, state } = createMockResponse();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledOnce();
      expect((req as any).monitoringAuth.authMethod).toBe('api_token');
      // Session validator should not have been called
      expect(sessionValidator).not.toHaveBeenCalled();
    });
  });

  describe('No credentials (Requirement 5.1)', () => {
    it('returns 401 AUTH_REQUIRED when no auth is provided', () => {
      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator: () => null,
      });

      const req = createMockRequest();
      const { res, state } = createMockResponse();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
      expect(state.jsonBody).toMatchObject({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      expect(state.jsonBody.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('Error envelope format (Requirement 10.4)', () => {
    it('all 401 responses follow the MonitoringErrorResponse shape', () => {
      const middleware = createMonitoringAuth({
        apiTokenEnvVar: 'VPS_PANEL_API_TOKEN',
        sessionValidator: () => null,
      });

      const req = createMockRequest();
      const { res, state } = createMockResponse();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      // Validate all required fields
      expect(state.jsonBody).toHaveProperty('success', false);
      expect(state.jsonBody).toHaveProperty('error');
      expect(state.jsonBody).toHaveProperty('code');
      expect(state.jsonBody).toHaveProperty('timestamp');
      expect(typeof state.jsonBody.error).toBe('string');
      expect(typeof state.jsonBody.code).toBe('string');
      expect(typeof state.jsonBody.timestamp).toBe('string');

      // Should not contain metric data
      expect(state.jsonBody).not.toHaveProperty('data');
    });
  });
});

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('hello', 'hello')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a'.repeat(100), 'a'.repeat(100))).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(constantTimeEqual('hello', 'world')).toBe(false);
    expect(constantTimeEqual('aaaaa', 'aaaab')).toBe(false);
  });

  it('returns false for strings of different length (Requirement 5.5)', () => {
    expect(constantTimeEqual('short', 'longer-string')).toBe(false);
    expect(constantTimeEqual('a', 'ab')).toBe(false);
    expect(constantTimeEqual('', 'something')).toBe(false);
  });

  it('handles varying token lengths correctly (Requirement 5.5)', () => {
    // Very short tokens
    expect(constantTimeEqual('a', 'a')).toBe(true);
    expect(constantTimeEqual('a', 'b')).toBe(false);

    // Medium-length tokens (typical API key sizes)
    const token32 = 'abcdefghijklmnopqrstuvwxyz123456';
    expect(constantTimeEqual(token32, token32)).toBe(true);
    expect(constantTimeEqual(token32, token32.slice(0, -1) + 'X')).toBe(false);

    // Long tokens (64 chars, hex-like)
    const token64 = 'a'.repeat(64);
    const token64diff = 'a'.repeat(63) + 'b';
    expect(constantTimeEqual(token64, token64)).toBe(true);
    expect(constantTimeEqual(token64, token64diff)).toBe(false);

    // Mismatched lengths: short vs long
    expect(constantTimeEqual('short', 'a-much-longer-token-value')).toBe(false);
    expect(constantTimeEqual('a-much-longer-token-value', 'short')).toBe(false);

    // Mismatched lengths: one char difference
    expect(constantTimeEqual('token-123', 'token-1234')).toBe(false);
    expect(constantTimeEqual('token-1234', 'token-123')).toBe(false);

    // Very long vs very short
    expect(constantTimeEqual('x'.repeat(256), 'x')).toBe(false);
    expect(constantTimeEqual('x', 'x'.repeat(256))).toBe(false);
  });
});

describe('hashToken', () => {
  it('produces a consistent SHA-256 hex hash', () => {
    const hash1 = hashToken('my-token');
    const hash2 = hashToken('my-token');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it('produces different hashes for different tokens', () => {
    const hash1 = hashToken('token-a');
    const hash2 = hashToken('token-b');
    expect(hash1).not.toBe(hash2);
  });
});
