/**
 * Routes Index
 *
 * Registers all API routers on the Express application.
 * All routes are prefixed with /api.
 * Auth middleware is applied globally to protected routes.
 * Webhook receive endpoint is excluded from auth.
 */
import type { Express } from 'express';
import type { AuthModule } from '../modules/auth.js';
import type { AuditLogger } from '../modules/audit-logger.js';
import type { ContainerManager } from '../modules/container-manager.js';
import type { FileManager } from '../modules/file-manager.js';
import type { DomainManager } from '../modules/domain-manager.js';
import type { SSLManager } from '../modules/ssl-manager.js';
import type { CronManager } from '../modules/cron-manager.js';
import type { DatabaseManager } from '../modules/database-manager.js';
import type { BackupManagerExtended } from '../modules/backup-manager.js';
import type { ProjectManager } from '../modules/project-manager.js';
import type { BuildPipeline } from '../modules/build-pipeline.js';
import type { WebhookHandler } from '../modules/webhook-handler.js';
import type { TunnelManager } from '../modules/tunnel-manager.js';
import type { CICDBridge } from '../modules/cicd-bridge.js';
import type { SecurityManager } from '../modules/security-manager.js';
import type { JobQueue } from '../modules/job-queue.js';
import type { AlertSystem } from '../modules/alert-system.js';
import type { SettingsService } from '../services/settings-service.js';

import { createAuthRouter } from './auth.js';
import { createContainersRouter } from './containers.js';
import { createFilesRouter } from './files.js';
import { createDomainsRouter } from './domains.js';
import { createSslRouter } from './ssl.js';
import { createCronRouter } from './cron.js';
import { createDatabasesRouter } from './databases.js';
import { createBackupsRouter } from './backups.js';
import { createProjectsRouter } from './projects.js';
import { createPipelinesRouter } from './pipelines.js';
import { createWebhooksRouter } from './webhooks.js';
import { createTunnelsRouter } from './tunnels.js';
import { createCicdRouter } from './cicd.js';
import { createSecurityRouter } from './security.js';
import { createAuditRouter } from './audit.js';
import { createJobsRouter } from './jobs.js';
import { createAlertsRouter } from './alerts.js';
import { createSettingsRouter } from './settings.js';

import { createAuthMiddleware } from '../middleware/auth.js';

export interface ModuleRegistry {
  authModule: AuthModule;
  auditLogger: AuditLogger;
  containerManager: ContainerManager;
  fileManager: FileManager;
  domainManager: DomainManager;
  sslManager: SSLManager;
  cronManager: CronManager;
  databaseManager: DatabaseManager;
  backupManager: BackupManagerExtended;
  projectManager: ProjectManager;
  buildPipeline: BuildPipeline;
  webhookHandler: WebhookHandler;
  tunnelManager: TunnelManager;
  cicdBridge: CICDBridge;
  securityManager: SecurityManager;
  jobQueue: JobQueue;
  alertSystem: AlertSystem;
  settingsService?: SettingsService;
}

/**
 * Register all API routes on the Express app.
 */
export function registerRoutes(app: Express, modules: ModuleRegistry): void {
  const { authModule, auditLogger } = modules;

  // Auth middleware for protected routes
  // Paths are relative to the /api mount point (Express strips the prefix)
  const authMiddleware = createAuthMiddleware(authModule, {
    publicPaths: [
      '/health',
      '/login',
      '/auth/login',
      '/auth/session',
      '/webhooks',
    ],
  });

  // Apply auth middleware globally
  app.use('/api', authMiddleware);

  // Register route modules
  app.use('/api/auth', createAuthRouter(authModule, auditLogger));
  app.use('/api/containers', createContainersRouter(modules.containerManager, auditLogger));
  app.use('/api/files', createFilesRouter(modules.fileManager, auditLogger));
  app.use('/api/domains', createDomainsRouter(modules.domainManager, auditLogger));
  app.use('/api/ssl', createSslRouter(modules.sslManager, auditLogger));
  app.use('/api/cron', createCronRouter(modules.cronManager, auditLogger));
  app.use('/api/databases', createDatabasesRouter(modules.databaseManager, auditLogger));
  app.use('/api/backups', createBackupsRouter(modules.backupManager, auditLogger));
  app.use('/api/projects', createProjectsRouter(modules.projectManager, auditLogger));
  app.use('/api/pipelines', createPipelinesRouter(modules.buildPipeline, auditLogger));
  app.use('/api/webhooks', createWebhooksRouter(modules.webhookHandler, auditLogger));
  app.use('/api/tunnels', createTunnelsRouter(modules.tunnelManager, auditLogger));
  app.use('/api/cicd', createCicdRouter(modules.cicdBridge, auditLogger));
  app.use('/api/security', createSecurityRouter(modules.securityManager, auditLogger));
  app.use('/api/audit', createAuditRouter(auditLogger));
  app.use('/api/jobs', createJobsRouter(modules.jobQueue, auditLogger));
  app.use('/api/alerts', createAlertsRouter(modules.alertSystem, auditLogger));
  if (modules.settingsService) {
    app.use('/api/settings', createSettingsRouter(modules.settingsService));
  }
}
