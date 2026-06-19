/**
 * Backup Manager Module
 *
 * Provides scheduled and on-demand backups of Docker volumes and compose files,
 * with support for local filesystem and S3-compatible storage, configurable
 * retention policy, backup history tracking, and restore functionality.
 *
 * Extended with container image snapshot, export, and restore capabilities
 * using Dockerode commit/save operations.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 15.1, 15.2, 15.3, 15.4, 15.5,
 *              17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import Dockerode from 'dockerode';
import type { SettingsService } from '../services/settings-service.js';

const execAsync = promisify(exec);

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface BackupScheduleConfig {
  /** Cron expression for frequency */
  frequency: string;
  /** Targets to back up: Docker volume names and compose file paths */
  targets: string[];
  /** Storage destination type */
  storageType: 'local' | 's3';
  /** Storage configuration (local path or S3 config) */
  storageConfig: LocalStorageConfig | S3StorageConfig;
  /** Number of backups to retain. Default: 7 */
  retentionCount?: number;
  /** Whether the schedule is active */
  enabled?: boolean;
}

export interface LocalStorageConfig {
  path: string;
}

export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  prefix?: string;
}

export interface BackupEntry {
  id: string;
  scheduleId?: string;
  timestamp: Date;
  size: number;
  targets: string[];
  storage: 'local' | 's3';
  storagePath: string;
  status: 'completed' | 'failed' | 'in-progress';
}

export interface BackupManager {
  configureSchedule(config: BackupScheduleConfig): Promise<string>;
  triggerBackup(targets?: string[]): Promise<string>;
  restoreBackup(backupId: string): Promise<string>;
  listBackups(): Promise<BackupEntry[]>;
  deleteBackup(backupId: string): Promise<void>;
  /** Start the cron-based scheduler */
  startScheduler(): void;
  /** Stop the scheduler */
  stopScheduler(): void;
}

// ─── Extended Interfaces (Premium Upgrade) ──────────────────────────────────

export interface SnapshotResult {
  backupId: string;
  imageTag: string;
  containerId: string;
  timestamp: string;
}

export interface ExportResult {
  backupId: string;
  archivePath: string;
  size: number;
  s3Uploaded: boolean;
}

export interface RestoreResult {
  success: boolean;
  safetySnapshotId: string;
  newContainerId: string;
  previousContainerId: string;
}

export interface SnapshotScheduleConfig {
  targets: string[];
  cronExpression: string;
  retentionCount: number;
  enabled: boolean;
}

export interface BackupManagerExtended extends BackupManager {
  /** Create a snapshot of a running container (docker commit) */
  snapshotContainer(containerId: string, commitMessage?: string): Promise<SnapshotResult>;
  /** Export a Docker image as a tar archive */
  exportImage(imageName: string): Promise<ExportResult>;
  /** Restore a container from a backup snapshot */
  restoreContainer(backupId: string, targetContainerName: string): Promise<RestoreResult>;
  /** Configure snapshot schedule via settings */
  updateScheduleFromSettings(scheduleConfig: SnapshotScheduleConfig): void;
}

export interface AlertCallback {
  onBackupFailure(backupId: string, error: string, targets: string[]): void;
}

export interface BackupManagerConfig {
  /** Working directory for temporary archives. Default: /tmp/vps-panel-backups */
  workDir?: string;
  /** Alert callback for failure notifications */
  alertCallback?: AlertCallback;
  /** Dockerode instance (optional, created with defaults if not provided) */
  docker?: Dockerode;
  /** Settings service for reading backup configuration */
  settingsService?: SettingsService;
}

// ─── Internal Types ────────────────────────────────────────────────────────────

interface RawBackupRow {
  id: string;
  schedule_id: string | null;
  timestamp: string;
  size: number | null;
  targets: string;
  storage_type: string;
  storage_path: string;
  status: string;
}

interface RawScheduleRow {
  id: string;
  frequency: string;
  targets: string;
  storage_type: string;
  storage_config: string | null;
  retention_count: number;
  enabled: number;
  created_at: string;
}

interface RawSnapshotBackupRow {
  id: string;
  schedule_id: string | null;
  timestamp: string;
  size: number | null;
  targets: string | null;
  storage_type: string | null;
  storage_path: string | null;
  status: string;
  type: string;
  container_id: string | null;
  container_name: string | null;
  image_tag: string | null;
  commit_message: string | null;
}

// ─── Implementation ────────────────────────────────────────────────────────────

/**
 * Generate a snapshot tag in the format: {container_name}-snapshot-{YYYYMMDD-HHmmss}
 * @param containerName - The Docker container name
 * @param date - The timestamp for the tag
 * @returns Formatted snapshot tag string
 */
export function generateSnapshotTag(containerName: string, date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${containerName}-snapshot-${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Format a date as YYYYMMDD-HHmmss string for file naming.
 */
export function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function createBackupManager(
  db: Database.Database,
  config?: BackupManagerConfig
): BackupManagerExtended {
  const workDir = config?.workDir ?? '/tmp/vps-panel-backups';
  const alertCallback = config?.alertCallback;
  const docker = config?.docker ?? new Dockerode();
  const settingsService = config?.settingsService;
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;

  // Ensure work directory exists
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  // Prepared statements
  const insertScheduleStmt = db.prepare(`
    INSERT INTO backup_schedules (id, frequency, targets, storage_type, storage_config, retention_count, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertBackupStmt = db.prepare(`
    INSERT INTO backups (id, schedule_id, timestamp, size, targets, storage_type, storage_path, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateBackupStmt = db.prepare(`
    UPDATE backups SET size = ?, storage_path = ?, status = ? WHERE id = ?
  `);

  const getBackupStmt = db.prepare(`SELECT * FROM backups WHERE id = ?`);

  const listBackupsStmt = db.prepare(
    `SELECT * FROM backups ORDER BY timestamp DESC`
  );

  const deleteBackupStmt = db.prepare(`DELETE FROM backups WHERE id = ?`);

  const getSchedulesStmt = db.prepare(
    `SELECT * FROM backup_schedules WHERE enabled = 1`
  );

  const getScheduleStmt = db.prepare(`SELECT * FROM backup_schedules WHERE id = ?`);

  // ─── Premium Snapshot/Export Prepared Statements ────────────────────────────

  const insertSnapshotBackupStmt = db.prepare(`
    INSERT INTO backups (id, timestamp, type, container_id, container_name, image_tag, commit_message, status, targets, storage_type, storage_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'local', '')
  `);

  const insertExportBackupStmt = db.prepare(`
    INSERT INTO backups (id, timestamp, size, type, targets, storage_path, storage_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getSnapshotBackupStmt = db.prepare(`SELECT * FROM backups WHERE id = ?`);

  const insertRestoreHistoryStmt = db.prepare(`
    INSERT INTO restore_history (id, backup_id, target_container, safety_snapshot_id, outcome, error_message, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ─── configureSchedule ───────────────────────────────────────────────────

  async function configureSchedule(scheduleConfig: BackupScheduleConfig): Promise<string> {
    const id = uuidv4();
    const targets = JSON.stringify(scheduleConfig.targets);
    const storageConfig = JSON.stringify(scheduleConfig.storageConfig);
    const retentionCount = scheduleConfig.retentionCount ?? 7;
    const enabled = scheduleConfig.enabled !== false ? 1 : 0;

    insertScheduleStmt.run(
      id,
      scheduleConfig.frequency,
      targets,
      scheduleConfig.storageType,
      storageConfig,
      retentionCount,
      enabled
    );

    return id;
  }

  // ─── triggerBackup ─────────────────────────────────────────────────────────

  async function triggerBackup(targets?: string[]): Promise<string> {
    // Get configuration from first enabled schedule or use provided targets
    let scheduleId: string | null = null;
    let backupTargets: string[];
    let storageType: 'local' | 's3';
    let storageConfig: LocalStorageConfig | S3StorageConfig;
    let retentionCount = 7;

    if (targets && targets.length > 0) {
      // Manual backup with specific targets - use first schedule's storage config or defaults
      backupTargets = targets;
      const schedule = getSchedulesStmt.get() as RawScheduleRow | undefined;
      if (schedule) {
        scheduleId = schedule.id;
        storageType = schedule.storage_type as 'local' | 's3';
        storageConfig = JSON.parse(schedule.storage_config ?? '{}');
        retentionCount = schedule.retention_count;
      } else {
        // Default to local storage in workDir
        storageType = 'local';
        storageConfig = { path: workDir } as LocalStorageConfig;
      }
    } else {
      // Use the first enabled schedule's full configuration
      const schedule = getSchedulesStmt.get() as RawScheduleRow | undefined;
      if (!schedule) {
        throw new Error('No backup schedule configured. Please configure a schedule first.');
      }
      scheduleId = schedule.id;
      backupTargets = JSON.parse(schedule.targets);
      storageType = schedule.storage_type as 'local' | 's3';
      storageConfig = JSON.parse(schedule.storage_config ?? '{}');
      retentionCount = schedule.retention_count;
    }

    // Create backup record as in-progress
    const backupId = uuidv4();
    const timestamp = new Date().toISOString();

    insertBackupStmt.run(
      backupId,
      scheduleId,
      timestamp,
      0,
      JSON.stringify(backupTargets),
      storageType,
      '',
      'in-progress'
    );

    // Execute backup asynchronously
    executeBackup(backupId, backupTargets, storageType, storageConfig, retentionCount, scheduleId)
      .catch(() => {
        // Error handling is done inside executeBackup
      });

    return backupId;
  }

  // ─── executeBackup (internal) ──────────────────────────────────────────────

  async function executeBackup(
    backupId: string,
    targets: string[],
    storageType: 'local' | 's3',
    storageConfig: LocalStorageConfig | S3StorageConfig,
    retentionCount: number,
    scheduleId: string | null
  ): Promise<void> {
    const archiveName = `backup-${backupId}.tar.gz`;
    const tempArchivePath = path.join(workDir, archiveName);

    try {
      // Step 1: Collect backup data into temp directory
      const tempDir = path.join(workDir, `backup-${backupId}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      for (const target of targets) {
        await backupTarget(target, tempDir);
      }

      // Step 2: Create tar.gz archive
      await execAsync(`tar -czf "${tempArchivePath}" -C "${tempDir}" .`);

      // Get archive size
      const stat = fs.statSync(tempArchivePath);
      const archiveSize = stat.size;

      // Step 3: Move to storage destination
      let finalPath: string;
      if (storageType === 's3') {
        finalPath = await uploadToS3(tempArchivePath, archiveName, storageConfig as S3StorageConfig);
      } else {
        finalPath = moveToLocalStorage(tempArchivePath, archiveName, storageConfig as LocalStorageConfig);
      }

      // Step 4: Update backup record as completed
      updateBackupStmt.run(archiveSize, finalPath, 'completed', backupId);

      // Step 5: Enforce retention policy (delete excess after success)
      enforceRetention(scheduleId, retentionCount, storageType);

      // Step 6: Clean up temp directory
      cleanupTempDir(tempDir);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Mark backup as failed
      updateBackupStmt.run(0, '', 'failed', backupId);

      // Generate alert on failure
      if (alertCallback) {
        const backup = getBackupStmt.get(backupId) as RawBackupRow | undefined;
        const failedTargets = backup ? JSON.parse(backup.targets) : targets;
        alertCallback.onBackupFailure(backupId, errorMessage, failedTargets);
      }

      // Clean up temp files
      try {
        if (fs.existsSync(tempArchivePath)) fs.unlinkSync(tempArchivePath);
        const tempDir = path.join(workDir, `backup-${backupId}`);
        if (fs.existsSync(tempDir)) cleanupTempDir(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // ─── backupTarget (internal) ───────────────────────────────────────────────

  async function backupTarget(target: string, destDir: string): Promise<void> {
    // Determine if target is a Docker volume or a filesystem path (compose file)
    if (await isDockerVolume(target)) {
      // Backup Docker volume via docker cp using a temporary container
      await backupDockerVolume(target, destDir);
    } else {
      // Backup filesystem path (compose file or config)
      backupFilesystemPath(target, destDir);
    }
  }

  async function isDockerVolume(target: string): Promise<boolean> {
    try {
      await execAsync(`docker volume inspect "${target}" 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  async function backupDockerVolume(volumeName: string, destDir: string): Promise<void> {
    const volumeDir = path.join(destDir, 'volumes', volumeName);
    if (!fs.existsSync(volumeDir)) {
      fs.mkdirSync(volumeDir, { recursive: true });
    }

    // Use a temporary alpine container to copy volume data out
    const containerName = `backup-helper-${uuidv4().slice(0, 8)}`;
    try {
      await execAsync(
        `docker run --rm --name "${containerName}" -v "${volumeName}:/source:ro" -v "${volumeDir}:/dest" alpine sh -c "cp -a /source/. /dest/"`
      );
    } catch (error) {
      throw new Error(
        `Failed to backup Docker volume "${volumeName}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function backupFilesystemPath(targetPath: string, destDir: string): void {
    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Backup target path does not exist: ${resolvedPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    const relativeName = path.basename(resolvedPath);
    const destPath = path.join(destDir, 'files', relativeName);

    if (stat.isDirectory()) {
      copyDirectorySync(resolvedPath, destPath);
    } else {
      const destFileDir = path.dirname(destPath);
      if (!fs.existsSync(destFileDir)) {
        fs.mkdirSync(destFileDir, { recursive: true });
      }
      fs.copyFileSync(resolvedPath, destPath);
    }
  }

  // ─── S3 Upload ────────────────────────────────────────────────────────────

  async function uploadToS3(
    filePath: string,
    fileName: string,
    s3Config: S3StorageConfig
  ): Promise<string> {
    // TODO: S3 storage support is work-in-progress. Install @aws-sdk/client-s3 to enable.
    // Currently marked as optionalDependency — will gracefully fail if not installed.
    let S3Client: any;
    let PutObjectCommand: any;
    try {
      const s3Module = await import('@aws-sdk/client-s3');
      S3Client = s3Module.S3Client;
      PutObjectCommand = s3Module.PutObjectCommand;
    } catch {
      throw new Error(
        'S3 storage is not available. Install @aws-sdk/client-s3 to enable S3 backup support: npm install @aws-sdk/client-s3'
      );
    }

    const client = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: true, // Required for many S3-compatible services
    });

    const fileContent = fs.readFileSync(filePath);
    const key = s3Config.prefix ? `${s3Config.prefix}/${fileName}` : fileName;

    await client.send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: fileContent,
        ContentType: 'application/gzip',
      })
    );

    // Clean up local temp file after upload
    fs.unlinkSync(filePath);

    return `s3://${s3Config.bucket}/${key}`;
  }

  // ─── Local Storage ─────────────────────────────────────────────────────────

  function moveToLocalStorage(
    archivePath: string,
    archiveName: string,
    localConfig: LocalStorageConfig
  ): string {
    const destDir = path.resolve(localConfig.path);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const destPath = path.join(destDir, archiveName);
    fs.renameSync(archivePath, destPath);
    return destPath;
  }

  // ─── Retention Policy ──────────────────────────────────────────────────────

  function enforceRetention(
    scheduleId: string | null,
    retentionCount: number,
    storageType: 'local' | 's3'
  ): void {
    // Get all completed backups for this schedule, ordered by timestamp desc
    let completedBackups: RawBackupRow[];
    if (scheduleId) {
      completedBackups = db
        .prepare(
          `SELECT * FROM backups WHERE schedule_id = ? AND status = 'completed' ORDER BY timestamp DESC`
        )
        .all(scheduleId) as RawBackupRow[];
    } else {
      completedBackups = db
        .prepare(
          `SELECT * FROM backups WHERE status = 'completed' ORDER BY timestamp DESC`
        )
        .all() as RawBackupRow[];
    }

    // Delete excess backups (those beyond retention count)
    if (completedBackups.length > retentionCount) {
      const excessBackups = completedBackups.slice(retentionCount);

      for (const backup of excessBackups) {
        // Delete the archive file if local
        if (backup.storage_type === 'local' && backup.storage_path) {
          try {
            if (fs.existsSync(backup.storage_path)) {
              fs.unlinkSync(backup.storage_path);
            }
          } catch {
            // Continue even if file deletion fails
          }
        }
        // For S3, we'd need to delete the object - handled separately if needed

        // Remove from database
        deleteBackupStmt.run(backup.id);
      }
    }
  }

  // ─── restoreBackup ─────────────────────────────────────────────────────────

  async function restoreBackup(backupId: string): Promise<string> {
    const backup = getBackupStmt.get(backupId) as RawBackupRow | undefined;
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    if (backup.status !== 'completed') {
      throw new Error(`Cannot restore backup with status: ${backup.status}`);
    }

    const restoreJobId = uuidv4();
    const targets = JSON.parse(backup.targets) as string[];

    // Execute restore asynchronously
    executeRestore(restoreJobId, backup, targets).catch(() => {
      // Error handling is done inside executeRestore
    });

    return restoreJobId;
  }

  async function executeRestore(
    jobId: string,
    backup: RawBackupRow,
    targets: string[]
  ): Promise<void> {
    const tempDir = path.join(workDir, `restore-${jobId}`);

    try {
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Step 1: Get the archive to the temp directory
      const archivePath = path.join(tempDir, 'archive.tar.gz');

      if (backup.storage_type === 's3') {
        await downloadFromS3(backup.storage_path, archivePath, backup);
      } else {
        // Local: copy the archive to temp
        if (!fs.existsSync(backup.storage_path)) {
          throw new Error(`Backup archive not found at: ${backup.storage_path}`);
        }
        fs.copyFileSync(backup.storage_path, archivePath);
      }

      // Step 2: Extract the archive
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      await execAsync(`tar -xzf "${archivePath}" -C "${extractDir}"`);

      // Step 3: Restore each target (abort on failure, preserve current state)
      for (const target of targets) {
        await restoreTarget(target, extractDir);
      }

      // Step 4: Clean up
      cleanupTempDir(tempDir);
    } catch (error) {
      // Abort restore on failure, preserve current state
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Clean up temp files
      try {
        cleanupTempDir(tempDir);
      } catch {
        // Ignore cleanup errors
      }

      // Alert on restore failure
      if (alertCallback) {
        alertCallback.onBackupFailure(
          backup.id,
          `Restore failed: ${errorMessage}`,
          targets
        );
      }

      throw new Error(`Restore aborted: ${errorMessage}. Current state preserved.`);
    }
  }

  async function downloadFromS3(
    s3Path: string,
    destPath: string,
    backup: RawBackupRow
  ): Promise<void> {
    // Parse s3://bucket/key format
    const match = s3Path.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid S3 path: ${s3Path}`);
    }

    const bucket = match[1];
    const key = match[2];

    // Get S3 config from the backup's schedule
    const schedule = backup.schedule_id
      ? (getScheduleStmt.get(backup.schedule_id) as RawScheduleRow | undefined)
      : undefined;

    if (!schedule?.storage_config) {
      throw new Error('S3 configuration not found for this backup');
    }

    const s3Config = JSON.parse(schedule.storage_config) as S3StorageConfig;

    // TODO: S3 storage support is work-in-progress
    let S3Client: any;
    let GetObjectCommand: any;
    try {
      const s3Module = await import('@aws-sdk/client-s3');
      S3Client = s3Module.S3Client;
      GetObjectCommand = s3Module.GetObjectCommand;
    } catch {
      throw new Error(
        'S3 storage is not available. Install @aws-sdk/client-s3 to enable S3 backup support: npm install @aws-sdk/client-s3'
      );
    }

    const client = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: true,
    });

    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    if (!response.Body) {
      throw new Error(`Empty response body for S3 object: ${s3Path}`);
    }

    // Write the stream to disk
    const bodyBytes = await response.Body.transformToByteArray();
    fs.writeFileSync(destPath, Buffer.from(bodyBytes));
  }

  async function restoreTarget(target: string, extractDir: string): Promise<void> {
    if (await isDockerVolume(target)) {
      await restoreDockerVolume(target, extractDir);
    } else {
      restoreFilesystemPath(target, extractDir);
    }
  }

  async function restoreDockerVolume(volumeName: string, extractDir: string): Promise<void> {
    const volumeDataDir = path.join(extractDir, 'volumes', volumeName);
    if (!fs.existsSync(volumeDataDir)) {
      throw new Error(`Volume data not found in backup for: ${volumeName}`);
    }

    const containerName = `restore-helper-${uuidv4().slice(0, 8)}`;
    try {
      await execAsync(
        `docker run --rm --name "${containerName}" -v "${volumeName}:/dest" -v "${volumeDataDir}:/source:ro" alpine sh -c "rm -rf /dest/* && cp -a /source/. /dest/"`
      );
    } catch (error) {
      throw new Error(
        `Failed to restore Docker volume "${volumeName}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function restoreFilesystemPath(targetPath: string, extractDir: string): void {
    const relativeName = path.basename(targetPath);
    const sourcePath = path.join(extractDir, 'files', relativeName);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`File/directory not found in backup for: ${targetPath}`);
    }

    const resolvedTarget = path.resolve(targetPath);
    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
      // Remove existing directory and copy from backup
      if (fs.existsSync(resolvedTarget)) {
        fs.rmSync(resolvedTarget, { recursive: true, force: true });
      }
      copyDirectorySync(sourcePath, resolvedTarget);
    } else {
      // Copy file from backup
      const destDir = path.dirname(resolvedTarget);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(sourcePath, resolvedTarget);
    }
  }

  // ─── listBackups ──────────────────────────────────────────────────────────

  async function listBackups(): Promise<BackupEntry[]> {
    const rows = listBackupsStmt.all() as RawBackupRow[];
    return rows.map(rowToBackupEntry);
  }

  // ─── deleteBackup ─────────────────────────────────────────────────────────

  async function deleteBackup(backupId: string): Promise<void> {
    const backup = getBackupStmt.get(backupId) as RawBackupRow | undefined;
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    // Delete the archive file if local
    if (backup.storage_type === 'local' && backup.storage_path) {
      try {
        if (fs.existsSync(backup.storage_path)) {
          fs.unlinkSync(backup.storage_path);
        }
      } catch {
        // Continue even if file deletion fails
      }
    }

    // For S3 storage, delete from S3
    if (backup.storage_type === 's3' && backup.storage_path) {
      try {
        await deleteFromS3(backup);
      } catch {
        // Continue even if S3 deletion fails
      }
    }

    // Remove from database
    deleteBackupStmt.run(backupId);
  }

  async function deleteFromS3(backup: RawBackupRow): Promise<void> {
    const match = backup.storage_path.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) return;

    const bucket = match[1];
    const key = match[2];

    const schedule = backup.schedule_id
      ? (getScheduleStmt.get(backup.schedule_id) as RawScheduleRow | undefined)
      : undefined;

    if (!schedule?.storage_config) return;

    const s3Config = JSON.parse(schedule.storage_config) as S3StorageConfig;

    // TODO: S3 storage support is work-in-progress
    let S3Client: any;
    let DeleteObjectCommand: any;
    try {
      const s3Module = await import('@aws-sdk/client-s3');
      S3Client = s3Module.S3Client;
      DeleteObjectCommand = s3Module.DeleteObjectCommand;
    } catch {
      // S3 SDK not installed — skip deletion silently
      return;
    }

    const client = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: true,
    });

    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
  }

  // ─── Scheduler ─────────────────────────────────────────────────────────────

  function startScheduler(): void {
    if (schedulerTimer) return;

    // Check every minute if any schedule should run
    schedulerTimer = setInterval(() => {
      checkSchedules();
    }, 60_000);

    // Don't prevent Node.js from exiting
    if (schedulerTimer.unref) {
      schedulerTimer.unref();
    }
  }

  function stopScheduler(): void {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  function checkSchedules(): void {
    const schedules = getSchedulesStmt.all() as RawScheduleRow[];
    const now = new Date();

    for (const schedule of schedules) {
      if (shouldRunSchedule(schedule.frequency, now)) {
        const targets = JSON.parse(schedule.targets) as string[];
        const storageType = schedule.storage_type as 'local' | 's3';
        const storageConfig = JSON.parse(schedule.storage_config ?? '{}');

        const backupId = uuidv4();
        const timestamp = now.toISOString();

        insertBackupStmt.run(
          backupId,
          schedule.id,
          timestamp,
          0,
          schedule.targets,
          storageType,
          '',
          'in-progress'
        );

        executeBackup(
          backupId,
          targets,
          storageType,
          storageConfig,
          schedule.retention_count,
          schedule.id
        ).catch(() => {
          // Error handling done inside executeBackup
        });
      }
    }
  }

  function shouldRunSchedule(cronExpression: string, now: Date): boolean {
    // Simple cron matching: check if the current minute matches the schedule
    // Format: minute hour day-of-month month day-of-week
    try {
      const parts = cronExpression.trim().split(/\s+/);
      if (parts.length !== 5) return false;

      const [minuteExpr, hourExpr, dayExpr, monthExpr, dowExpr] = parts;

      return (
        matchesCronField(minuteExpr, now.getMinutes()) &&
        matchesCronField(hourExpr, now.getHours()) &&
        matchesCronField(dayExpr, now.getDate()) &&
        matchesCronField(monthExpr, now.getMonth() + 1) &&
        matchesCronField(dowExpr, now.getDay())
      );
    } catch {
      return false;
    }
  }

  function matchesCronField(expression: string, value: number): boolean {
    if (expression === '*') return true;

    // Handle */N (every N)
    if (expression.startsWith('*/')) {
      const interval = parseInt(expression.slice(2), 10);
      if (isNaN(interval) || interval <= 0) return false;
      return value % interval === 0;
    }

    // Handle comma-separated values
    if (expression.includes(',')) {
      const values = expression.split(',').map((v) => parseInt(v.trim(), 10));
      return values.includes(value);
    }

    // Handle ranges (e.g., 1-5)
    if (expression.includes('-')) {
      const [start, end] = expression.split('-').map((v) => parseInt(v.trim(), 10));
      return value >= start && value <= end;
    }

    // Exact match
    const exact = parseInt(expression, 10);
    return !isNaN(exact) && exact === value;
  }

  // ─── Helper Functions ──────────────────────────────────────────────────────

  function rowToBackupEntry(row: RawBackupRow): BackupEntry {
    return {
      id: row.id,
      scheduleId: row.schedule_id ?? undefined,
      timestamp: new Date(row.timestamp),
      size: row.size ?? 0,
      targets: JSON.parse(row.targets),
      storage: row.storage_type as 'local' | 's3',
      storagePath: row.storage_path,
      status: row.status as 'completed' | 'failed' | 'in-progress',
    };
  }

  function copyDirectorySync(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        copyDirectorySync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  function cleanupTempDir(dirPath: string): void {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }

  // ─── Container Snapshot (Premium) ───────────────────────────────────────────

  /**
   * Create a snapshot of a running container via Docker commit.
   * Tags the resulting image with format: {container_name}-snapshot-{YYYYMMDD-HHmmss}
   *
   * @param containerId - The Docker container ID to snapshot
   * @param commitMessage - Optional commit message for the snapshot
   * @returns SnapshotResult with backup ID, image tag, container ID, and timestamp
   */
  async function snapshotContainer(containerId: string, commitMessage?: string): Promise<SnapshotResult> {
    const timestamp = new Date();
    const backupId = uuidv4();

    try {
      // Get container info to determine name
      const container = docker.getContainer(containerId);
      const containerInfo = await container.inspect();
      const containerName = containerInfo.Name.replace(/^\//, ''); // Remove leading slash

      // Generate the snapshot tag: {container_name}-snapshot-{YYYYMMDD-HHmmss}
      const imageTag = generateSnapshotTag(containerName, timestamp);

      // Docker commit: create an image from the container state
      const commitResult = await container.commit({
        repo: imageTag,
        tag: 'latest',
        comment: commitMessage ?? `Snapshot of ${containerName}`,
        author: 'VPS Panel Backup Manager',
      });

      // Track in backup registry
      const timestampStr = timestamp.toISOString();
      insertSnapshotBackupStmt.run(
        backupId,
        timestampStr,
        'snapshot',
        containerId,
        containerName,
        imageTag,
        commitMessage ?? null,
        'completed'
      );

      return {
        backupId,
        imageTag,
        containerId,
        timestamp: timestampStr,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Track the failed snapshot in registry
      insertSnapshotBackupStmt.run(
        backupId,
        timestamp.toISOString(),
        'snapshot',
        containerId,
        '',
        '',
        commitMessage ?? null,
        'failed'
      );

      throw new Error(`Docker commit failed for container ${containerId}: ${errorMessage}`);
    }
  }

  // ─── Image Export (Premium) ────────────────────────────────────────────────

  /**
   * Export a Docker image as a tar archive to the configured backup path.
   * Optionally uploads to S3 when backup_s3_enabled is true.
   *
   * @param imageName - The Docker image name/tag to export
   * @returns ExportResult with backup ID, archive path, size, and S3 upload status
   */
  async function exportImage(imageName: string): Promise<ExportResult> {
    const backupId = uuidv4();
    const timestamp = new Date();
    let archivePath = '';
    let s3Uploaded = false;

    try {
      // Determine local backup path from settings or default
      const backupLocalPath = settingsService
        ? await settingsService.get('backup_local_path')
        : '/data/backups';

      // Ensure backup directory exists
      if (!fs.existsSync(backupLocalPath)) {
        fs.mkdirSync(backupLocalPath, { recursive: true });
      }

      // Generate archive filename
      const safeImageName = imageName.replace(/[/:]/g, '-');
      const archiveName = `${safeImageName}-${formatTimestamp(timestamp)}.tar`;
      archivePath = path.join(backupLocalPath, archiveName);

      // Get the Docker image and save as tar
      const image = docker.getImage(imageName);
      const stream = await image.get();

      // Write stream to file
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(archivePath);
        stream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        stream.on('error', reject);
      });

      // Get file size
      const stat = fs.statSync(archivePath);
      const archiveSize = stat.size;

      // Attempt S3 upload if enabled
      if (settingsService) {
        const s3Enabled = await settingsService.get('backup_s3_enabled');
        if (s3Enabled === 'true') {
          try {
            await uploadExportToS3(archivePath, archiveName);
            s3Uploaded = true;
          } catch (s3Error) {
            // S3 upload failed: retain local copy, log failure, emit alert
            const s3ErrorMsg = s3Error instanceof Error ? s3Error.message : String(s3Error);
            console.error(`S3 upload failed for ${archiveName}: ${s3ErrorMsg}`);

            if (alertCallback) {
              alertCallback.onBackupFailure(backupId, `S3 upload failed: ${s3ErrorMsg}`, [imageName]);
            }
            // Local copy is retained — s3Uploaded remains false
          }
        }
      }

      // Track in backup registry
      const storageLocation = s3Uploaded ? `s3+local:${archivePath}` : `local:${archivePath}`;
      insertExportBackupStmt.run(
        backupId,
        timestamp.toISOString(),
        archiveSize,
        'export',
        imageName,
        archivePath,
        storageLocation,
        'completed'
      );

      return {
        backupId,
        archivePath,
        size: archiveSize,
        s3Uploaded,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Clean up partial tar file if it exists
      if (archivePath && fs.existsSync(archivePath)) {
        try {
          fs.unlinkSync(archivePath);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Track the failed export in registry
      insertExportBackupStmt.run(
        backupId,
        timestamp.toISOString(),
        0,
        'export',
        imageName,
        '',
        '',
        'failed'
      );

      throw new Error(`Docker save failed for image ${imageName}: ${errorMessage}`);
    }
  }

  // ─── S3 Upload for Exports (Premium) ──────────────────────────────────────

  async function uploadExportToS3(localFilePath: string, fileName: string): Promise<string> {
    if (!settingsService) {
      throw new Error('Settings service not available for S3 configuration');
    }

    const endpoint = await settingsService.get('backup_s3_endpoint');
    const bucket = await settingsService.get('backup_s3_bucket');
    const accessKey = await settingsService.get('backup_s3_access_key');
    const secretKey = await settingsService.get('backup_s3_secret_key');
    const region = await settingsService.get('backup_s3_region');
    const prefix = await settingsService.get('backup_s3_prefix');

    if (!bucket) {
      throw new Error('S3 bucket not configured');
    }

    let S3Client: any;
    let PutObjectCommand: any;
    try {
      const s3Module = await import('@aws-sdk/client-s3');
      S3Client = s3Module.S3Client;
      PutObjectCommand = s3Module.PutObjectCommand;
    } catch {
      throw new Error(
        'S3 storage is not available. Install @aws-sdk/client-s3 to enable S3 backup support.'
      );
    }

    const client = new S3Client({
      endpoint: endpoint || undefined,
      region: region || 'us-east-1',
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true,
    });

    const fileContent = fs.readFileSync(localFilePath);
    const key = prefix ? `${prefix}/${fileName}` : fileName;

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileContent,
        ContentType: 'application/x-tar',
      })
    );

    return `s3://${bucket}/${key}`;
  }

  // ─── Container Restore (Premium) ──────────────────────────────────────────

  /**
   * Restore a container from a backup snapshot.
   * Creates safety snapshot first, stops target, creates new container from image.
   */
  async function restoreContainer(backupId: string, targetContainerName: string): Promise<RestoreResult> {
    // Look up the backup entry
    const backupRow = getSnapshotBackupStmt.get(backupId) as RawSnapshotBackupRow | undefined;
    if (!backupRow) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    if (backupRow.status !== 'completed') {
      throw new Error(`Cannot restore from backup with status: ${backupRow.status}`);
    }

    if (backupRow.type !== 'snapshot') {
      throw new Error(`Cannot restore from backup type: ${backupRow.type}. Only snapshot backups support restore.`);
    }

    // Find the target container
    const containers = await docker.listContainers({ all: true });
    const targetContainer = containers.find(
      (c) => c.Names.some((n) => n.replace(/^\//, '') === targetContainerName)
    );

    if (!targetContainer) {
      throw new Error(`Target container not found: ${targetContainerName}`);
    }

    const previousContainerId = targetContainer.Id;
    let safetySnapshotId = '';
    let newContainerId = '';

    try {
      // Step 1: Create safety snapshot of the current state
      const safetyResult = await snapshotContainer(
        previousContainerId,
        `Safety snapshot before restore from backup ${backupId}`
      );
      safetySnapshotId = safetyResult.backupId;

      // Step 2: Stop the target container
      const container = docker.getContainer(previousContainerId);
      const containerInfo = await container.inspect();
      await container.stop();

      // Step 3: Create new container from the snapshot image with same configuration
      const imageTag = backupRow.image_tag;
      const newContainer = await docker.createContainer({
        name: targetContainerName + '-restored',
        Image: `${imageTag}:latest`,
        Env: containerInfo.Config.Env ?? [],
        ExposedPorts: containerInfo.Config.ExposedPorts ?? {},
        HostConfig: {
          PortBindings: containerInfo.HostConfig?.PortBindings ?? {},
          Binds: containerInfo.HostConfig?.Binds ?? [],
          RestartPolicy: containerInfo.HostConfig?.RestartPolicy ?? { Name: 'no' },
          NetworkMode: containerInfo.HostConfig?.NetworkMode ?? 'bridge',
        },
      });

      // Step 4: Start the new container
      await newContainer.start();
      const newContainerInfo = await newContainer.inspect();
      newContainerId = newContainerInfo.Id;

      // Step 5: Remove old container
      await container.remove();

      // Rename restored container to original name
      await newContainer.rename({ name: targetContainerName });

      // Record restore in history
      insertRestoreHistoryStmt.run(
        uuidv4(),
        backupId,
        targetContainerName,
        safetySnapshotId,
        'success',
        null,
        new Date().toISOString(),
        new Date().toISOString()
      );

      return {
        success: true,
        safetySnapshotId,
        newContainerId,
        previousContainerId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Attempt to restart the original container
      try {
        const originalContainer = docker.getContainer(previousContainerId);
        await originalContainer.start();
      } catch {
        // Original container restart may also fail
      }

      // Record failed restore in history
      insertRestoreHistoryStmt.run(
        uuidv4(),
        backupId,
        targetContainerName,
        safetySnapshotId,
        'failed',
        errorMessage,
        new Date().toISOString(),
        new Date().toISOString()
      );

      throw new Error(`Restore failed for container ${targetContainerName}: ${errorMessage}`);
    }
  }

  // ─── Schedule from Settings (Premium) ─────────────────────────────────────

  let snapshotScheduleTimer: ReturnType<typeof setInterval> | null = null;
  let currentScheduleConfig: SnapshotScheduleConfig | null = null;

  function updateScheduleFromSettings(scheduleConfig: SnapshotScheduleConfig): void {
    currentScheduleConfig = scheduleConfig;

    // Clear existing schedule timer
    if (snapshotScheduleTimer) {
      clearInterval(snapshotScheduleTimer);
      snapshotScheduleTimer = null;
    }

    if (!scheduleConfig.enabled) {
      return;
    }

    // Set up scheduled check (every minute, like the existing scheduler)
    snapshotScheduleTimer = setInterval(() => {
      if (currentScheduleConfig?.enabled && shouldRunSchedule(currentScheduleConfig.cronExpression, new Date())) {
        runScheduledSnapshots();
      }
    }, 60_000);

    if (snapshotScheduleTimer.unref) {
      snapshotScheduleTimer.unref();
    }
  }

  async function runScheduledSnapshots(): Promise<void> {
    if (!currentScheduleConfig) return;

    for (const target of currentScheduleConfig.targets) {
      try {
        // Find container by name
        const containers = await docker.listContainers({ all: true });
        const containerMatch = containers.find(
          (c) => c.Names.some((n) => n.replace(/^\//, '') === target)
        );

        if (containerMatch) {
          await snapshotContainer(containerMatch.Id, `Scheduled snapshot`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Emit alert but continue with remaining containers
        if (alertCallback) {
          alertCallback.onBackupFailure('', `Scheduled snapshot failed for ${target}: ${errorMessage}`, [target]);
        }
      }
    }

    // Enforce retention count
    if (currentScheduleConfig.retentionCount > 0) {
      enforceSnapshotRetention(currentScheduleConfig.retentionCount);
    }
  }

  function enforceSnapshotRetention(retentionCount: number): void {
    // Get all completed snapshots per container, enforce retention per container
    const completedSnapshots = db
      .prepare(
        `SELECT * FROM backups WHERE type = 'snapshot' AND status = 'completed' ORDER BY timestamp DESC`
      )
      .all() as RawSnapshotBackupRow[];

    // Group by container_name
    const byContainer = new Map<string, RawSnapshotBackupRow[]>();
    for (const snap of completedSnapshots) {
      const name = snap.container_name || 'unknown';
      if (!byContainer.has(name)) {
        byContainer.set(name, []);
      }
      byContainer.get(name)!.push(snap);
    }

    // For each container, delete excess snapshots
    for (const [, snapshots] of byContainer) {
      if (snapshots.length > retentionCount) {
        const toDelete = snapshots.slice(retentionCount);
        for (const snap of toDelete) {
          // Remove Docker image if possible
          try {
            if (snap.image_tag) {
              const image = docker.getImage(`${snap.image_tag}:latest`);
              image.remove().catch(() => {
                // Image may already be removed or in use
              });
            }
          } catch {
            // Ignore image removal errors
          }
          // Remove from registry
          deleteBackupStmt.run(snap.id);
        }
      }
    }
  }

  // ─── Snapshot Tag Helper ──────────────────────────────────────────────────

  // ─── Return the public API ─────────────────────────────────────────────────

  return {
    configureSchedule,
    triggerBackup,
    restoreBackup,
    listBackups,
    deleteBackup,
    startScheduler,
    stopScheduler,
    // Premium extensions
    snapshotContainer,
    exportImage,
    restoreContainer,
    updateScheduleFromSettings,
  };
}
