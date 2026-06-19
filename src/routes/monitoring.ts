/**
 * Monitoring Routes
 *
 * Express router registering all monitoring endpoints for the VPS Panel
 * Monitoring API. Uses a factory pattern accepting service dependencies
 * as parameters.
 *
 * - Applies monitoring-specific auth middleware (Bearer token / session cookie)
 * - Applies sliding-window rate limiter middleware
 * - Adds X-API-Version: 1.0 header to all responses
 * - Wraps all responses in standard envelope format
 *
 * Requirements: 1.1, 2.1, 3.1, 3.4, 4.2, 4.3, 4.4, 7.3, 10.1, 10.2, 10.3, 10.4, 10.5, 12.1, 12.2, 12.3, 12.5
 *
 * @module routes/monitoring
 */
import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

import type { MetricsCollector, ContainerFilters } from '../services/metrics-collector.js';
import type { ProjectRegistry } from '../services/project-registry.js';
import type { HistoricalMetricsService } from '../services/historical-metrics.js';
import type { UserResourceTracker, ResourceAllocationInput } from '../services/user-resource-tracking.js';
import { createMonitoringAuth } from '../middleware/monitoring-auth.js';
import type { MonitoringAuthOptions } from '../middleware/monitoring-auth.js';
import { createRateLimitMiddleware } from '../modules/monitoring-rate-limiter.js';
import type { RateLimitMiddlewareOptions } from '../modules/monitoring-rate-limiter.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MonitoringRouterDependencies {
  metricsCollector: MetricsCollector;
  projectRegistry: ProjectRegistry;
  historicalMetrics: HistoricalMetricsService;
  userResourceTracker: UserResourceTracker;
  authOptions: MonitoringAuthOptions;
  rateLimitOptions?: RateLimitMiddlewareOptions;
}

// ─── Response Envelope Helpers ───────────────────────────────────────────────

function successResponse<T>(data: T) {
  return {
    success: true as const,
    data,
    timestamp: new Date().toISOString(),
  };
}

function errorResponse(error: string, code: string) {
  return {
    success: false as const,
    error,
    code,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Determine HTTP status code from a service error.
 * Service errors expose `statusCode` and `code` properties.
 */
function getErrorStatusCode(err: unknown): number {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const statusCode = (err as { statusCode: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
      return statusCode;
    }
  }
  return 500;
}

function getErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return 'INTERNAL_ERROR';
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return 'An unexpected error occurred';
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the monitoring router with all endpoints wired to their services.
 *
 * @param deps - Service dependencies injected into the router
 * @returns Express Router ready to be mounted at `/api/monitoring`
 */
export function createMonitoringRouter(deps: MonitoringRouterDependencies): Router {
  const {
    metricsCollector,
    projectRegistry,
    historicalMetrics,
    userResourceTracker,
    authOptions,
    rateLimitOptions,
  } = deps;

  const router = Router();

  // ─── Router-level middleware ──────────────────────────────────────────────

  // X-API-Version header on all responses
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-API-Version', '1.0');
    next();
  });

  // Authentication middleware
  const authMiddleware: RequestHandler = createMonitoringAuth(authOptions);
  router.use(authMiddleware);

  // Rate limiting middleware (applied after auth so client ID is available)
  const rateLimitMiddleware: RequestHandler = createRateLimitMiddleware(rateLimitOptions);
  router.use(rateLimitMiddleware);

  // ─── GET /system ─────────────────────────────────────────────────────────

  router.get('/system', async (_req: Request, res: Response) => {
    try {
      const metrics = await metricsCollector.getSystemMetrics();
      res.json(successResponse(metrics));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── GET /containers ─────────────────────────────────────────────────────

  router.get('/containers', async (req: Request, res: Response) => {
    try {
      const filters: ContainerFilters = {};

      if (req.query.name && typeof req.query.name === 'string') {
        filters.name = req.query.name;
      }

      if (req.query.status && typeof req.query.status === 'string') {
        const validStatuses = ['running', 'stopped', 'exited'] as const;
        if (validStatuses.includes(req.query.status as any)) {
          filters.status = req.query.status as ContainerFilters['status'];
        }
      }

      const metrics = await metricsCollector.getContainerMetrics(filters);
      res.json(successResponse(metrics));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── GET /projects ───────────────────────────────────────────────────────

  router.get('/projects', async (_req: Request, res: Response) => {
    try {
      const summary = await metricsCollector.getAllProjectsSummary();
      res.json(successResponse(summary));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── GET /projects/:projectId ────────────────────────────────────────────

  router.get('/projects/:projectId', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const metrics = await metricsCollector.getProjectMetrics(projectId);
      res.json(successResponse(metrics));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── POST /projects/registry ─────────────────────────────────────────────

  router.post('/projects/registry', async (req: Request, res: Response) => {
    try {
      const { id, displayName, patterns } = req.body;

      if (!id || !displayName || !Array.isArray(patterns)) {
        res.status(400).json(errorResponse(
          'Request body must include id, displayName, and patterns (array)',
          'INVALID_PARAMS'
        ));
        return;
      }

      const registration = await projectRegistry.create({ id, displayName, patterns });
      res.status(201).json(successResponse(registration));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── PUT /projects/registry/:projectId ───────────────────────────────────

  router.put('/projects/registry/:projectId', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const { displayName, patterns } = req.body;

      const input: { displayName?: string; patterns?: string[] } = {};
      if (displayName !== undefined) input.displayName = displayName;
      if (patterns !== undefined) input.patterns = patterns;

      const registration = await projectRegistry.update(projectId, input);
      res.json(successResponse(registration));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── DELETE /projects/registry/:projectId ────────────────────────────────

  router.delete('/projects/registry/:projectId', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const { confirmation } = req.body ?? {};

      await projectRegistry.delete(projectId, !!confirmation);
      res.json(successResponse({ deleted: true }));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── GET /history ────────────────────────────────────────────────────────

  router.get('/history', async (req: Request, res: Response) => {
    try {
      const start = req.query.start as string | undefined;
      const end = req.query.end as string | undefined;
      const resolution = req.query.resolution as string | undefined;
      const containerId = req.query.containerId as string | undefined;

      if (!start || !end) {
        res.status(400).json(errorResponse(
          'Query parameters "start" and "end" are required (ISO 8601 timestamps)',
          'INVALID_PARAMS'
        ));
        return;
      }

      // Detect V2 usage: resolution is 30s/5m/1h or containerId is provided
      const v2Resolutions = ['30s', '5m', '1h'];
      const isV2 = containerId || (resolution && v2Resolutions.includes(resolution));

      if (isV2) {
        const paramsV2: { start: string; end: string; resolution?: '30s' | '5m' | '1h'; containerId?: string } = {
          start,
          end,
        };
        if (resolution && v2Resolutions.includes(resolution)) {
          paramsV2.resolution = resolution as '30s' | '5m' | '1h';
        }
        if (containerId) {
          paramsV2.containerId = containerId;
        }
        const dataPoints = await historicalMetrics.queryV2(paramsV2);
        res.json(successResponse(dataPoints));
      } else {
        // Legacy V1 path
        const params: { start: string; end: string; resolution?: '1m' | '5m' | '15m' | '1h' } = {
          start,
          end,
        };
        if (resolution) {
          params.resolution = resolution as '1m' | '5m' | '15m' | '1h';
        }
        const dataPoints = await historicalMetrics.query(params);
        res.json(successResponse(dataPoints));
      }
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── GET /projects/:projectId/users ──────────────────────────────────────

  router.get('/projects/:projectId/users', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const projectScope = req.monitoringAuth?.projectScope;

      const users = await userResourceTracker.listProjectUsers(projectId, projectScope);
      res.json(successResponse(users));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── GET /projects/:projectId/users/:userId ──────────────────────────────

  router.get('/projects/:projectId/users/:userId', async (req: Request, res: Response) => {
    try {
      const { projectId, userId } = req.params;
      const projectScope = req.monitoringAuth?.projectScope;

      const summary = await userResourceTracker.getUserMetrics(projectId, userId, projectScope);
      res.json(successResponse(summary));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── POST /projects/:projectId/users/:userId/track ───────────────────────

  router.post('/projects/:projectId/users/:userId/track', async (req: Request, res: Response) => {
    try {
      const { projectId, userId } = req.params;
      const projectScope = req.monitoringAuth?.projectScope;
      const { containerName, cpuAllocation, memoryAllocation } = req.body;

      if (!containerName || cpuAllocation === undefined || memoryAllocation === undefined) {
        res.status(400).json(errorResponse(
          'Request body must include containerName, cpuAllocation, and memoryAllocation',
          'INVALID_PARAMS'
        ));
        return;
      }

      const allocation: ResourceAllocationInput = {
        containerName,
        cpuAllocation: Number(cpuAllocation),
        memoryAllocation: Number(memoryAllocation),
      };

      await userResourceTracker.track(projectId, userId, allocation, projectScope);
      res.status(201).json(successResponse({ tracked: true }));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  // ─── DELETE /projects/:projectId/users/:userId/track ─────────────────────

  router.delete('/projects/:projectId/users/:userId/track', async (req: Request, res: Response) => {
    try {
      const { projectId, userId } = req.params;
      const projectScope = req.monitoringAuth?.projectScope;

      await userResourceTracker.untrack(projectId, userId, projectScope);
      res.json(successResponse({ untracked: true }));
    } catch (err: unknown) {
      const statusCode = getErrorStatusCode(err);
      const code = getErrorCode(err);
      const message = getErrorMessage(err);
      res.status(statusCode).json(errorResponse(message, code));
    }
  });

  return router;
}
