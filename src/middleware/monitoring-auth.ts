/**
 * Monitoring Authentication Middleware
 *
 * Express middleware specifically for `/api/monitoring/*` routes that supports
 * dual authentication:
 * - Bearer token validation with constant-time comparison
 * - VPS Panel session cookie validation as alternate auth method
 *
 * Returns a standardized error envelope on auth failure.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Session } from '../modules/auth.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface MonitoringAuthOptions {
  /** Environment variable name containing the API token (default: 'VPS_PANEL_API_TOKEN') */
  apiTokenEnvVar: string;
  /** Function to validate a session token (from the existing VPS Panel auth) */
  sessionValidator: (token: string) => Session | null;
}

export interface MonitoringAuthResult {
  authenticated: boolean;
  authMethod: 'api_token' | 'session';
  clientId: string;
  projectScope?: string;
}

export interface MonitoringErrorResponse {
  success: false;
  error: string;
  code: string;
  timestamp: string;
}

// ─── Extend Express Request ────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      monitoringAuth?: MonitoringAuthResult;
    }
  }
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Perform constant-time comparison of two strings.
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * Returns false if lengths differ (no timing info leaked about content).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  // If lengths differ, we still perform a comparison to avoid
  // leaking length information through timing, but return false.
  if (a.length !== b.length) {
    // Compare against itself to consume time, then return false
    const bufA = Buffer.from(a, 'utf-8');
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Compute a SHA-256 hash of the token for use as a client identifier.
 * This avoids storing raw tokens in rate limiter state.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

/**
 * Extract the Bearer token from the Authorization header.
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

/**
 * Extract the session token from the session cookie.
 */
function extractSessionCookie(req: Request): string | null {
  const cookies = req.headers.cookie;
  if (!cookies) return null;

  const tokenCookie = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('session_token='));

  if (tokenCookie) {
    const value = tokenCookie.split('=')[1];
    return value && value.length > 0 ? value : null;
  }

  return null;
}

/**
 * Create a standardized 401 error response.
 */
function sendAuthError(res: Response, message: string, code: string): void {
  const body: MonitoringErrorResponse = {
    success: false,
    error: message,
    code,
    timestamp: new Date().toISOString(),
  };
  res.status(401).json(body);
}

// ─── Factory Function ──────────────────────────────────────────────────────────

/**
 * Create the monitoring authentication middleware.
 *
 * This factory validates that the required API token environment variable is set
 * at creation time (refusing to proceed if not configured), then returns an
 * Express middleware that authenticates requests via Bearer token or session cookie.
 *
 * @throws Error if the API token env var is not set (startup failure)
 */
export function createMonitoringAuth(options: MonitoringAuthOptions): RequestHandler {
  const { apiTokenEnvVar, sessionValidator } = options;

  // Startup validation: refuse to start if the API token is not configured
  const apiToken = process.env[apiTokenEnvVar];
  if (!apiToken) {
    throw new Error(
      `[Monitoring Auth] Required environment variable '${apiTokenEnvVar}' is not set. ` +
      `The monitoring API cannot start without a configured authentication token.`
    );
  }

  return function monitoringAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Strategy 1: Check Bearer token in Authorization header
    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      if (constantTimeEqual(bearerToken, apiToken)) {
        // Valid API token
        const result: MonitoringAuthResult = {
          authenticated: true,
          authMethod: 'api_token',
          clientId: hashToken(bearerToken),
        };
        req.monitoringAuth = result;
        next();
        return;
      }

      // Bearer token was provided but is invalid
      sendAuthError(res, 'Invalid API token', 'AUTH_INVALID');
      return;
    }

    // Strategy 2: Check session cookie (VPS Panel browser UI)
    const sessionToken = extractSessionCookie(req);
    if (sessionToken) {
      const session = sessionValidator(sessionToken);
      if (session) {
        // Valid session
        const result: MonitoringAuthResult = {
          authenticated: true,
          authMethod: 'session',
          clientId: session.id,
        };
        req.monitoringAuth = result;
        next();
        return;
      }

      // Session cookie was provided but is invalid/expired
      sendAuthError(res, 'Invalid or expired session', 'AUTH_INVALID');
      return;
    }

    // No credentials provided at all
    sendAuthError(res, 'Authentication required', 'AUTH_REQUIRED');
  };
}
