/**
 * Backup Routes
 *
 * Endpoints for backup management:
 * - POST /api/backups/snapshot — Create container snapshot (admin auth)
 * - POST /api/backups/export — Export image as tar archive (admin auth)
 * - POST /api/backups/restore — Restore container from backup (admin auth)
 * - GET /api/backups — List backup registry with pagination (admin auth)
 * - DELETE /api/backups/:id — Delete a backup entry (admin auth)
 * - POST /api/backups/configure — Configure backup schedule
 * - POST /api/backups/trigger — Trigger an immediate backup
 * - POST /api/backups/:id/restore — Restore from a volume backup (legacy)
 *
 * All endpoints require admin authentication (session-based, applied globally).
 *
 * @module routes/backups
 * @validates Requirements 13.4, 13.5, 16.1, 17.1, 17.4
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BackupManagerExtended } from '../modules/backup-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createBackupsRouter(
  backupManager: BackupManagerExtended,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  // ─── Premium Backup Endpoints ──────────────────────────────────────────────

  /**
   * POST /api/backups/snapshot
   * Create a container snapshot (docker commit).
   * Body: { container_id: string, commit_message?: string }
   *
   * @validates Requirements 13.4
   */
  router.post('/snapshot', async (req: Request, res: Response) => {
    try {
      const { container_id, commit_message } = req.body;

      // Validate required fields
      if (!container_id || typeof container_id !== 'string') {
        res.status(400).json({ error: 'container_id is required and must be a string' });
        return;
      }

      if (commit_message !== undefined && typeof commit_message !== 'string') {
        res.status(400).json({ error: 'commit_message must be a string if provided' });
        return;
      }

      const result = await backupManager.snapshotContainer(container_id, commit_message);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.snapshot',
        targetResource: `container:${container_id}`,
        details: { backupId: result.backupId, imageTag: result.imageTag },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.status(201).json(result);
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.snapshot',
        targetResource: `container:${req.body?.container_id ?? 'unknown'}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/backups/export
   * Export a Docker image as a tar archive.
   * Body: { image_name: string }
   *
   * @validates Requirements 13.5
   */
  router.post('/export', async (req: Request, res: Response) => {
    try {
      const { image_name } = req.body;

      // Validate required fields
      if (!image_name || typeof image_name !== 'string') {
        res.status(400).json({ error: 'image_name is required and must be a string' });
        return;
      }

      const result = await backupManager.exportImage(image_name);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.export',
        targetResource: `image:${image_name}`,
        details: { backupId: result.backupId, archivePath: result.archivePath, size: result.size },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.status(201).json(result);
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.export',
        targetResource: `image:${req.body?.image_name ?? 'unknown'}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/backups/restore
   * Restore a container from a backup snapshot.
   * Body: { backup_id: string, target_container: string }
   *
   * @validates Requirements 16.1
   */
  router.post('/restore', async (req: Request, res: Response) => {
    try {
      const { backup_id, target_container } = req.body;

      // Validate required fields
      if (!backup_id || typeof backup_id !== 'string') {
        res.status(400).json({ error: 'backup_id is required and must be a string' });
        return;
      }

      if (!target_container || typeof target_container !== 'string') {
        res.status(400).json({ error: 'target_container is required and must be a string' });
        return;
      }

      const result = await backupManager.restoreContainer(backup_id, target_container);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.restore-container',
        targetResource: `container:${target_container}`,
        details: {
          backupId: backup_id,
          safetySnapshotId: result.safetySnapshotId,
          newContainerId: result.newContainerId,
        },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.status(200).json(result);
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.restore-container',
        targetResource: `container:${req.body?.target_container ?? 'unknown'}`,
        details: { error: error.message, backupId: req.body?.backup_id },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  // ─── Paginated Backup List ─────────────────────────────────────────────────

  /**
   * GET /api/backups
   * List backup registry with pagination.
   * Query params: page (default: 1), pageSize (default: 20)
   *
   * @validates Requirements 17.1
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string, 10) || 20));

      const allBackups = await backupManager.listBackups();
      const total = allBackups.length;
      const totalPages = Math.ceil(total / pageSize);
      const offset = (page - 1) * pageSize;
      const items = allBackups.slice(offset, offset + pageSize);

      res.json({
        items,
        total,
        page,
        pageSize,
        totalPages,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Delete Backup ─────────────────────────────────────────────────────────

  /**
   * DELETE /api/backups/:id
   * Delete a backup entry (removes archive from local/S3 and registry record).
   *
   * @validates Requirements 17.4
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await backupManager.deleteBackup(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.delete',
        targetResource: `backup:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Backup deleted' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.delete',
        targetResource: `backup:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  // ─── Legacy Backup Endpoints ───────────────────────────────────────────────

  /**
   * POST /api/backups/configure
   * Configure backup schedule.
   */
  router.post('/configure', async (req: Request, res: Response) => {
    try {
      const scheduleId = await backupManager.configureSchedule(req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.configure',
        targetResource: `backup-schedule:${scheduleId}`,
        details: req.body,
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ scheduleId, message: 'Backup schedule configured' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.configure',
        targetResource: 'backup-schedule',
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  /**
   * POST /api/backups/trigger
   * Trigger an immediate backup.
   */
  router.post('/trigger', async (req: Request, res: Response) => {
    try {
      const targets = req.body.targets as string[] | undefined;
      const jobId = await backupManager.triggerBackup(targets);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.trigger',
        targetResource: 'backup',
        details: { jobId, targets },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ jobId, message: 'Backup triggered' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.trigger',
        targetResource: 'backup',
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/backups/:id/restore
   * Restore from a volume backup (legacy endpoint).
   */
  router.post('/:id/restore', async (req: Request, res: Response) => {
    try {
      const jobId = await backupManager.restoreBackup(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.restore',
        targetResource: `backup:${req.params.id}`,
        details: { jobId },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ jobId, message: 'Restore initiated' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.restore',
        targetResource: `backup:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
