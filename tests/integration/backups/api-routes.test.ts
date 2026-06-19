/**
 * Integration Tests: Backup API Routes (Premium)
 *
 * Tests the full request/response flow through the backup Express router
 * with mocked BackupManagerExtended and AuditLogger dependencies. Verifies:
 * - POST /api/backups/snapshot — validates body and calls snapshotContainer
 * - POST /api/backups/export — validates body and calls exportImage
 * - POST /api/backups/restore — validates body and calls restoreContainer
 * - GET /api/backups — returns paginated backup list
 * - DELETE /api/backups/:id — removes backup entry
 *
 * Requirements: 13.4, 13.5, 16.1, 17.1, 17.4
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBackupsRouter } from '../../../src/routes/backups.js';
import type { BackupManagerExtended, BackupEntry, SnapshotResult, ExportResult, RestoreResult } from '../../../src/modules/backup-manager.js';
import type { AuditLogger } from '../../../src/modules/audit-logger.js';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockBackupManager(): BackupManagerExtended {
  return {
    configureSchedule: vi.fn().mockResolvedValue('schedule-001'),
    triggerBackup: vi.fn().mockResolvedValue('job-001'),
    restoreBackup: vi.fn().mockResolvedValue('restore-job-001'),
    listBackups: vi.fn().mockResolvedValue([
      {
        id: 'backup-001',
        timestamp: new Date('2024-06-01T10:00:00Z'),
        size: 1024000,
        targets: ['my-container'],
        storage: 'local',
        storagePath: '/data/backups/backup-001.tar',
        status: 'completed',
      },
      {
        id: 'backup-002',
        timestamp: new Date('2024-06-02T10:00:00Z'),
        size: 2048000,
        targets: ['another-container'],
        storage: 'local',
        storagePath: '/data/backups/backup-002.tar',
        status: 'completed',
      },
      {
        id: 'backup-003',
        timestamp: new Date('2024-06-03T10:00:00Z'),
        size: 512000,
        targets: ['web-app'],
        storage: 's3',
        storagePath: 's3://backups/backup-003.tar',
        status: 'completed',
      },
    ] as BackupEntry[]),
    deleteBackup: vi.fn().mockResolvedValue(undefined),
    startScheduler: vi.fn(),
    stopScheduler: vi.fn(),
    snapshotContainer: vi.fn().mockResolvedValue({
      backupId: 'snap-001',
      imageTag: 'my-container-snapshot-20240601-100000',
      containerId: 'abc123def456',
      timestamp: '2024-06-01T10:00:00.000Z',
    } as SnapshotResult),
    exportImage: vi.fn().mockResolvedValue({
      backupId: 'export-001',
      archivePath: '/data/backups/my-image-20240601-100000.tar',
      size: 5120000,
      s3Uploaded: false,
    } as ExportResult),
    restoreContainer: vi.fn().mockResolvedValue({
      success: true,
      safetySnapshotId: 'safety-snap-001',
      newContainerId: 'new-container-id-123',
      previousContainerId: 'old-container-id-456',
    } as RestoreResult),
    updateScheduleFromSettings: vi.fn(),
  };
}

function createMockAuditLogger(): AuditLogger {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
  } as any;
}

// ─── Test App Factory ────────────────────────────────────────────────────────

function createTestApp(overrides?: {
  backupManager?: BackupManagerExtended;
  auditLogger?: AuditLogger;
}) {
  const backupManager = overrides?.backupManager ?? createMockBackupManager();
  const auditLogger = overrides?.auditLogger ?? createMockAuditLogger();

  const router = createBackupsRouter(backupManager, auditLogger);
  const app = express();
  app.use(express.json());

  // Simulate authenticated session (global auth middleware is applied in production)
  app.use((req, _res, next) => {
    (req as any).session = { username: 'admin', id: 'session-abc' };
    next();
  });

  app.use('/api/backups', router);
  return { app, backupManager, auditLogger };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Integration: Backup API Routes (Premium)', () => {
  // ─── POST /api/backups/snapshot ──────────────────────────────────────────

  describe('POST /api/backups/snapshot', () => {
    it('creates a snapshot successfully with container_id', async () => {
      const { app, backupManager } = createTestApp();
      const res = await request(app)
        .post('/api/backups/snapshot')
        .send({ container_id: 'abc123def456' });

      expect(res.status).toBe(201);
      expect(res.body.backupId).toBe('snap-001');
      expect(res.body.imageTag).toBe('my-container-snapshot-20240601-100000');
      expect(res.body.containerId).toBe('abc123def456');
      expect(res.body.timestamp).toBeDefined();
      expect(backupManager.snapshotContainer).toHaveBeenCalledWith('abc123def456', undefined);
    });

    it('creates a snapshot with optional commit_message', async () => {
      const { app, backupManager } = createTestApp();
      const res = await request(app)
        .post('/api/backups/snapshot')
        .send({ container_id: 'abc123def456', commit_message: 'Before deploy v2.0' });

      expect(res.status).toBe(201);
      expect(backupManager.snapshotContainer).toHaveBeenCalledWith('abc123def456', 'Before deploy v2.0');
    });

    it('returns 400 when container_id is missing', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/snapshot')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('container_id');
    });

    it('returns 400 when container_id is not a string', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/snapshot')
        .send({ container_id: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('container_id');
    });

    it('returns 400 when commit_message is not a string', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/snapshot')
        .send({ container_id: 'abc123', commit_message: 42 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('commit_message');
    });

    it('returns 500 when snapshotContainer fails', async () => {
      const backupManager = createMockBackupManager();
      (backupManager.snapshotContainer as any).mockRejectedValue(
        new Error('Docker commit failed for container abc123: container not running')
      );
      const { app } = createTestApp({ backupManager });

      const res = await request(app)
        .post('/api/backups/snapshot')
        .send({ container_id: 'abc123' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Docker commit failed');
    });

    it('logs audit entry on successful snapshot', async () => {
      const { app, auditLogger } = createTestApp();
      await request(app)
        .post('/api/backups/snapshot')
        .send({ container_id: 'abc123def456' });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'admin',
          actionType: 'backup.snapshot',
          targetResource: 'container:abc123def456',
          result: 'success',
        })
      );
    });
  });

  // ─── POST /api/backups/export ────────────────────────────────────────────

  describe('POST /api/backups/export', () => {
    it('exports an image successfully', async () => {
      const { app, backupManager } = createTestApp();
      const res = await request(app)
        .post('/api/backups/export')
        .send({ image_name: 'my-app:latest' });

      expect(res.status).toBe(201);
      expect(res.body.backupId).toBe('export-001');
      expect(res.body.archivePath).toContain('my-image');
      expect(res.body.size).toBe(5120000);
      expect(res.body.s3Uploaded).toBe(false);
      expect(backupManager.exportImage).toHaveBeenCalledWith('my-app:latest');
    });

    it('returns 400 when image_name is missing', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/export')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('image_name');
    });

    it('returns 400 when image_name is not a string', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/export')
        .send({ image_name: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('image_name');
    });

    it('returns 500 when exportImage fails', async () => {
      const backupManager = createMockBackupManager();
      (backupManager.exportImage as any).mockRejectedValue(
        new Error('Docker save failed for image no-such-image: image not found')
      );
      const { app } = createTestApp({ backupManager });

      const res = await request(app)
        .post('/api/backups/export')
        .send({ image_name: 'no-such-image' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Docker save failed');
    });

    it('logs audit entry on successful export', async () => {
      const { app, auditLogger } = createTestApp();
      await request(app)
        .post('/api/backups/export')
        .send({ image_name: 'my-app:latest' });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'admin',
          actionType: 'backup.export',
          targetResource: 'image:my-app:latest',
          result: 'success',
        })
      );
    });
  });

  // ─── POST /api/backups/restore ───────────────────────────────────────────

  describe('POST /api/backups/restore', () => {
    it('restores a container successfully', async () => {
      const { app, backupManager } = createTestApp();
      const res = await request(app)
        .post('/api/backups/restore')
        .send({ backup_id: 'snap-001', target_container: 'my-container' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.safetySnapshotId).toBe('safety-snap-001');
      expect(res.body.newContainerId).toBe('new-container-id-123');
      expect(res.body.previousContainerId).toBe('old-container-id-456');
      expect(backupManager.restoreContainer).toHaveBeenCalledWith('snap-001', 'my-container');
    });

    it('returns 400 when backup_id is missing', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/restore')
        .send({ target_container: 'my-container' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('backup_id');
    });

    it('returns 400 when target_container is missing', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/restore')
        .send({ backup_id: 'snap-001' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('target_container');
    });

    it('returns 400 when backup_id is not a string', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/restore')
        .send({ backup_id: 123, target_container: 'my-container' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('backup_id');
    });

    it('returns 400 when target_container is not a string', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/backups/restore')
        .send({ backup_id: 'snap-001', target_container: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('target_container');
    });

    it('returns 500 when restoreContainer fails', async () => {
      const backupManager = createMockBackupManager();
      (backupManager.restoreContainer as any).mockRejectedValue(
        new Error('Restore failed for container my-container: image not found')
      );
      const { app } = createTestApp({ backupManager });

      const res = await request(app)
        .post('/api/backups/restore')
        .send({ backup_id: 'snap-001', target_container: 'my-container' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Restore failed');
    });

    it('logs audit entry on successful restore', async () => {
      const { app, auditLogger } = createTestApp();
      await request(app)
        .post('/api/backups/restore')
        .send({ backup_id: 'snap-001', target_container: 'my-container' });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'admin',
          actionType: 'backup.restore-container',
          targetResource: 'container:my-container',
          result: 'success',
        })
      );
    });
  });

  // ─── GET /api/backups ────────────────────────────────────────────────────

  describe('GET /api/backups', () => {
    it('returns paginated backup list with defaults (page=1, pageSize=20)', async () => {
      const { app } = createTestApp();
      const res = await request(app).get('/api/backups');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(3);
      expect(res.body.total).toBe(3);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(20);
      expect(res.body.totalPages).toBe(1);
    });

    it('returns correct page when paginating', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/backups')
        .query({ page: 1, pageSize: 2 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(3);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(2);
      expect(res.body.totalPages).toBe(2);
    });

    it('returns second page correctly', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/backups')
        .query({ page: 2, pageSize: 2 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.page).toBe(2);
    });

    it('returns empty items for page beyond total', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/backups')
        .query({ page: 5, pageSize: 20 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
      expect(res.body.total).toBe(3);
    });

    it('clamps pageSize to max 100', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/backups')
        .query({ pageSize: 500 });

      expect(res.status).toBe(200);
      expect(res.body.pageSize).toBe(100);
    });

    it('clamps page to min 1', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get('/api/backups')
        .query({ page: -1 });

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
    });

    it('returns 500 when listBackups fails', async () => {
      const backupManager = createMockBackupManager();
      (backupManager.listBackups as any).mockRejectedValue(new Error('Database error'));
      const { app } = createTestApp({ backupManager });

      const res = await request(app).get('/api/backups');

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Database error');
    });
  });

  // ─── DELETE /api/backups/:id ──────────────────────────────────────────────

  describe('DELETE /api/backups/:id', () => {
    it('deletes a backup entry successfully', async () => {
      const { app, backupManager } = createTestApp();
      const res = await request(app).delete('/api/backups/backup-001');

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Backup deleted');
      expect(backupManager.deleteBackup).toHaveBeenCalledWith('backup-001');
    });

    it('returns 500 when deleteBackup fails (e.g., not found)', async () => {
      const backupManager = createMockBackupManager();
      (backupManager.deleteBackup as any).mockRejectedValue(
        new Error('Backup not found: nonexistent-id')
      );
      const { app } = createTestApp({ backupManager });

      const res = await request(app).delete('/api/backups/nonexistent-id');

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Backup not found');
    });

    it('logs audit entry on successful delete', async () => {
      const { app, auditLogger } = createTestApp();
      await request(app).delete('/api/backups/backup-001');

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'admin',
          actionType: 'backup.delete',
          targetResource: 'backup:backup-001',
          result: 'success',
        })
      );
    });

    it('logs audit entry on failed delete', async () => {
      const backupManager = createMockBackupManager();
      (backupManager.deleteBackup as any).mockRejectedValue(new Error('Not found'));
      const auditLogger = createMockAuditLogger();
      const { app } = createTestApp({ backupManager, auditLogger });

      await request(app).delete('/api/backups/bad-id');

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'admin',
          actionType: 'backup.delete',
          targetResource: 'backup:bad-id',
          result: 'failure',
        })
      );
    });
  });
});
