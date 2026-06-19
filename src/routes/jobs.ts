/**
 * Job Routes
 *
 * Endpoints for job queue management:
 * list, status, cancel.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { JobQueue } from '../modules/job-queue.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createJobsRouter(
  jobQueue: JobQueue,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/jobs/concurrency
   * Return concurrency limits for the job queue.
   */
  router.get('/concurrency', async (_req: Request, res: Response) => {
    try {
      res.json({ build: 2, deploy: 3, backup: 1, restore: 1, 'db-import': 1, 'db-export': 1, 'tunnel-transfer': 2 });
    } catch (error: any) {
      res.json({ build: 2, deploy: 3, backup: 1, restore: 1 });
    }
  });

  /**
   * GET /api/jobs
   * List jobs with optional filtering.
   * Query params: type, projectId, status, limit, offset
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const filter: Record<string, any> = {};

      if (req.query.type) {
        filter.type = req.query.type as string;
      }
      if (req.query.projectId) {
        filter.projectId = req.query.projectId as string;
      }
      if (req.query.status) {
        filter.status = req.query.status as string;
      }
      if (req.query.limit) {
        filter.limit = parseInt(req.query.limit as string, 10);
      }
      if (req.query.offset) {
        filter.offset = parseInt(req.query.offset as string, 10);
      }

      const jobs = await jobQueue.listJobs(filter);
      res.json(jobs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/jobs/:id
   * Get status of a specific job.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const job = await jobQueue.getStatus(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      res.json(job);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/jobs/:id/cancel
   * Cancel a queued or running job.
   */
  router.post('/:id/cancel', async (req: Request, res: Response) => {
    try {
      await jobQueue.cancel(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'job.cancel',
        targetResource: `job:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Job cancelled' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'job.cancel',
        targetResource: `job:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  return router;
}
