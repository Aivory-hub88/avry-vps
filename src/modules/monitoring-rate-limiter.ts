/**
 * Monitoring Rate Limiter Module
 *
 * Implements sliding-window rate limiting for the Monitoring API endpoints.
 * Uses in-memory Map storage (resets on restart). Designed to be used both
 * as a standalone check and as Express middleware.
 *
 * - Default: 60 requests/minute per client, configurable via VPS_PANEL_RATE_LIMIT
 * - Identifies clients by token hash or session ID
 * - Exempts localhost/loopback requests from rate limiting
 * - Adds X-RateLimit-* headers to all responses
 * - Returns HTTP 429 with Retry-After header when limit exceeded
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum requests allowed per window. Default 60, override via VPS_PANEL_RATE_LIMIT */
  maxRequestsPerMinute: number;
  /** Sliding window duration in milliseconds. Default 60_000 (1 minute) */
  windowMs: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** The configured limit (max requests per window) */
  limit: number;
  /** Remaining requests in the current window */
  remaining: number;
  /** Unix timestamp (seconds) when the window resets */
  resetAt: number;
  /** Only set when blocked — seconds until the client can retry */
  retryAfterSeconds?: number;
}

export interface MonitoringRateLimiter {
  /** Check rate limit for a given client and record the request */
  check(clientId: string): RateLimitResult;
  /** Determine if a request is exempt from rate limiting (localhost/loopback) */
  isExempt(req: Request): boolean;
  /** Get current state without recording a request (for inspection/testing) */
  getClientRequestCount(clientId: string): number;
  /** Clear all stored data (useful for testing) */
  reset(): void;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;
const DEFAULT_WINDOW_MS = 60_000;

/** IP addresses considered localhost/loopback */
const LOOPBACK_ADDRESSES = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost',
]);

// ─── Rate Limiter Factory ──────────────────────────────────────────────────────

/**
 * Resolve the rate limit configuration.
 * Reads VPS_PANEL_RATE_LIMIT env var to override the default 60 req/min.
 */
export function resolveConfig(config?: Partial<RateLimitConfig>): RateLimitConfig {
  const envLimit = process.env.VPS_PANEL_RATE_LIMIT;
  let maxRequestsPerMinute = config?.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;

  if (envLimit !== undefined && envLimit !== '') {
    const parsed = parseInt(envLimit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      maxRequestsPerMinute = parsed;
    }
  }

  return {
    maxRequestsPerMinute,
    windowMs: config?.windowMs ?? DEFAULT_WINDOW_MS,
  };
}

/**
 * Create a monitoring rate limiter instance with in-memory Map storage.
 * The sliding window tracks individual request timestamps per client and
 * counts those within the last `windowMs` milliseconds.
 */
export function createMonitoringRateLimiter(config?: Partial<RateLimitConfig>): MonitoringRateLimiter {
  const resolvedConfig = resolveConfig(config);
  const { maxRequestsPerMinute, windowMs } = resolvedConfig;

  // Map<clientId, timestamp[]> — stores request timestamps per client
  const clientRequests = new Map<string, number[]>();

  /**
   * Remove expired timestamps from a client's request list.
   * Returns only timestamps within the current sliding window.
   */
  function pruneExpired(timestamps: number[], now: number): number[] {
    const windowStart = now - windowMs;
    return timestamps.filter((ts) => ts > windowStart);
  }

  function check(clientId: string): RateLimitResult {
    const now = Date.now();
    const windowEnd = now + windowMs;
    const resetAt = Math.ceil(windowEnd / 1000); // Unix timestamp in seconds

    // Get existing timestamps and prune expired ones
    let timestamps = clientRequests.get(clientId) ?? [];
    timestamps = pruneExpired(timestamps, now);

    const currentCount = timestamps.length;

    if (currentCount >= maxRequestsPerMinute) {
      // Rate limit exceeded — do NOT record this request
      // Calculate retry-after based on the oldest request in the window
      const oldestTimestamp = timestamps[0];
      const retryAfterMs = (oldestTimestamp + windowMs) - now;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

      // Update stored timestamps (just the pruned list, no new entry)
      clientRequests.set(clientId, timestamps);

      return {
        allowed: false,
        limit: maxRequestsPerMinute,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
      };
    }

    // Record this request
    timestamps.push(now);
    clientRequests.set(clientId, timestamps);

    return {
      allowed: true,
      limit: maxRequestsPerMinute,
      remaining: maxRequestsPerMinute - timestamps.length,
      resetAt,
    };
  }

  function isExempt(req: Request): boolean {
    const ip = req.ip || req.socket?.remoteAddress || '';
    return LOOPBACK_ADDRESSES.has(ip);
  }

  function getClientRequestCount(clientId: string): number {
    const now = Date.now();
    const timestamps = clientRequests.get(clientId) ?? [];
    return pruneExpired(timestamps, now).length;
  }

  function reset(): void {
    clientRequests.clear();
  }

  return {
    check,
    isExempt,
    getClientRequestCount,
    reset,
  };
}

// ─── Express Middleware ────────────────────────────────────────────────────────

/**
 * Options for the rate limiter middleware.
 */
export interface RateLimitMiddlewareOptions {
  /** Function to extract the client identifier from the request */
  getClientId?: (req: Request) => string;
  /** Custom rate limiter instance (useful for testing or sharing across routes) */
  limiter?: MonitoringRateLimiter;
  /** Rate limit configuration (used if no custom limiter is provided) */
  config?: Partial<RateLimitConfig>;
}

/**
 * Extract client ID from the request.
 * Uses token hash from auth result or session ID, falling back to IP.
 */
function defaultGetClientId(req: Request): string {
  // Check for auth result attached by monitoring auth middleware
  const authResult = (req as any).monitoringAuth;
  if (authResult?.clientId) {
    return authResult.clientId;
  }

  // Fallback: use IP address
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Set rate limit headers on the response.
 */
function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', result.limit.toString());
  res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
  res.setHeader('X-RateLimit-Reset', result.resetAt.toString());
}

/**
 * Create Express middleware that applies the monitoring rate limiter.
 *
 * - Exempts localhost/loopback requests
 * - Adds X-RateLimit-* headers to ALL responses (success and error)
 * - Returns HTTP 429 with Retry-After header when limit is exceeded
 */
export function createRateLimitMiddleware(options?: RateLimitMiddlewareOptions): RequestHandler {
  const limiter = options?.limiter ?? createMonitoringRateLimiter(options?.config);
  const getClientId = options?.getClientId ?? defaultGetClientId;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Check if request is exempt (localhost/loopback)
    if (limiter.isExempt(req)) {
      // Still add headers showing full allowance for exempt requests
      const now = Date.now();
      const config = resolveConfig(options?.config);
      const resetAt = Math.ceil((now + config.windowMs) / 1000);
      res.setHeader('X-RateLimit-Limit', config.maxRequestsPerMinute.toString());
      res.setHeader('X-RateLimit-Remaining', config.maxRequestsPerMinute.toString());
      res.setHeader('X-RateLimit-Reset', resetAt.toString());
      next();
      return;
    }

    const clientId = getClientId(req);
    const result = limiter.check(clientId);

    // Always set rate limit headers
    setRateLimitHeaders(res, result);

    if (!result.allowed) {
      // Set Retry-After header (seconds)
      res.setHeader('Retry-After', (result.retryAfterSeconds ?? 1).toString());

      res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please wait before making more requests.',
        code: 'RATE_LIMITED',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}
