<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const authStore = useAuthStore();

interface BackupEntry {
  id: string;
  timestamp: string;
  size: number;
  targets: string[];
  storage: 'local' | 's3';
  storagePath?: string;
  status: 'completed' | 'failed' | 'in-progress';
}

interface PaginatedResponse {
  items: BackupEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const backups = ref<BackupEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const successMessage = ref<string | null>(null);
const actionLoading = ref(false);

// Pagination
const currentPage = ref(1);
const pageSize = ref(20);
const totalItems = ref(0);
const totalPages = ref(0);

// Snapshot dialog
const showSnapshotDialog = ref(false);
const snapshotContainerId = ref('');
const snapshotCommitMessage = ref('');

// Export dialog
const showExportDialog = ref(false);
const exportImageName = ref('');
const exportBackupId = ref<string | null>(null);

// Restore dialog
const showRestoreDialog = ref(false);
const restoreBackupId = ref('');
const restoreTargetContainer = ref('');

// Confirm delete dialog
const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmLabel = ref('');
const confirmDanger = ref(false);
let pendingAction: (() => Promise<void>) | null = null;

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function statusClass(status: string): string {
  if (status === 'completed') return 'status-completed';
  if (status === 'failed') return 'status-failed';
  return 'status-progress';
}

const hasPrevPage = computed(() => currentPage.value > 1);
const hasNextPage = computed(() => currentPage.value < totalPages.value);

async function fetchBackups(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch(
      `/api/backups?page=${currentPage.value}&pageSize=${pageSize.value}`,
      { headers: headers() }
    );
    if (!res.ok) throw new Error('Failed to fetch backups');
    const data: PaginatedResponse = await res.json();
    backups.value = data.items;
    totalItems.value = data.total;
    totalPages.value = data.totalPages;
    currentPage.value = data.page;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

function goToPage(page: number): void {
  if (page < 1 || page > totalPages.value) return;
  currentPage.value = page;
  fetchBackups();
}

// Snapshot
function openSnapshotDialog(): void {
  snapshotContainerId.value = '';
  snapshotCommitMessage.value = '';
  showSnapshotDialog.value = true;
}

async function triggerSnapshot(): Promise<void> {
  if (!snapshotContainerId.value.trim()) return;
  actionLoading.value = true;
  error.value = null;
  successMessage.value = null;

  try {
    const res = await fetch('/api/backups/snapshot', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        container_id: snapshotContainerId.value.trim(),
        commit_message: snapshotCommitMessage.value.trim() || undefined,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to create snapshot');
    }
    successMessage.value = 'Snapshot created successfully.';
    showSnapshotDialog.value = false;
    await fetchBackups();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    actionLoading.value = false;
  }
}

// Export
function openExportDialog(backup?: BackupEntry): void {
  exportImageName.value = '';
  exportBackupId.value = backup?.id ?? null;
  showExportDialog.value = true;
}

async function triggerExport(): Promise<void> {
  if (!exportImageName.value.trim()) return;
  actionLoading.value = true;
  error.value = null;
  successMessage.value = null;

  try {
    const res = await fetch('/api/backups/export', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        image_name: exportImageName.value.trim(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to export image');
    }
    successMessage.value = 'Image exported successfully.';
    showExportDialog.value = false;
    await fetchBackups();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    actionLoading.value = false;
  }
}

// Restore
function openRestoreDialog(backup: BackupEntry): void {
  restoreBackupId.value = backup.id;
  restoreTargetContainer.value = '';
  showRestoreDialog.value = true;
}

async function triggerRestore(): Promise<void> {
  if (!restoreTargetContainer.value.trim()) return;

  // Show confirmation before proceeding
  showRestoreDialog.value = false;
  confirmTitle.value = 'Confirm Restore';
  confirmMessage.value = `Are you sure you want to restore backup to container "${restoreTargetContainer.value.trim()}"? A safety snapshot will be created before the restore, but this operation will replace the current container state.`;
  confirmLabel.value = 'Restore';
  confirmDanger.value = true;
  pendingAction = async () => {
    const res = await fetch('/api/backups/restore', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        backup_id: restoreBackupId.value,
        target_container: restoreTargetContainer.value.trim(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to restore backup');
    }
    successMessage.value = 'Restore completed successfully.';
    await fetchBackups();
  };
  confirmOpen.value = true;
}

// Delete
function requestDelete(backup: BackupEntry): void {
  confirmTitle.value = 'Delete Backup';
  confirmMessage.value = `Are you sure you want to delete the backup from ${formatTimestamp(backup.timestamp)}? This will remove the archive from local and S3 storage. This action cannot be undone.`;
  confirmLabel.value = 'Delete';
  confirmDanger.value = true;
  pendingAction = async () => {
    const res = await fetch(`/api/backups/${backup.id}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete backup');
    }
    successMessage.value = 'Backup deleted successfully.';
    await fetchBackups();
  };
  confirmOpen.value = true;
}

async function handleConfirm(): Promise<void> {
  confirmOpen.value = false;
  if (!pendingAction) return;

  actionLoading.value = true;
  error.value = null;
  successMessage.value = null;

  try {
    await pendingAction();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    actionLoading.value = false;
    pendingAction = null;
  }
}

onMounted(() => {
  fetchBackups();
});
</script>

<template>
  <div class="backups-view">
    <div class="view-header">
      <h2>Backup Registry</h2>
      <div class="header-actions">
        <button class="btn btn-primary" :disabled="actionLoading" @click="openSnapshotDialog">
          Create Snapshot
        </button>
      </div>
    </div>

    <!-- Success message -->
    <div v-if="successMessage" class="success-banner" role="status">
      <span>{{ successMessage }}</span>
      <button class="dismiss-btn" aria-label="Dismiss" @click="successMessage = null">×</button>
    </div>

    <!-- Error -->
    <div v-if="error" class="error-banner" role="alert">
      <span>{{ error }}</span>
      <button class="dismiss-btn" aria-label="Dismiss" @click="error = null">×</button>
    </div>

    <!-- Loading -->
    <div v-if="loading && backups.length === 0" class="loading-skeleton">
      <div class="skeleton-row" v-for="i in 5" :key="i"></div>
    </div>

    <!-- Empty state -->
    <div v-else-if="backups.length === 0 && !loading" class="empty-state">
      <p>No backups found.</p>
      <p class="muted">Create a snapshot to get started.</p>
    </div>

    <!-- Backup registry table -->
    <div v-else class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Size</th>
            <th>Target</th>
            <th>Storage Location</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="backup in backups" :key="backup.id">
            <td class="col-timestamp">{{ formatTimestamp(backup.timestamp) }}</td>
            <td>{{ formatSize(backup.size) }}</td>
            <td>{{ backup.targets.join(', ') }}</td>
            <td>
              <span class="storage-badge">{{ backup.storage === 's3' ? 'S3' : 'Local' }}</span>
              <span v-if="backup.storagePath" class="storage-path">{{ backup.storagePath }}</span>
            </td>
            <td>
              <span :class="['status-badge', statusClass(backup.status)]">
                {{ backup.status }}
              </span>
            </td>
            <td class="actions-cell">
              <button
                v-if="backup.status === 'completed'"
                class="btn btn-sm btn-secondary"
                title="Export image as tar archive"
                @click="openExportDialog(backup)"
              >
                Export
              </button>
              <button
                v-if="backup.status === 'completed'"
                class="btn btn-sm btn-secondary"
                title="Restore container from this snapshot"
                @click="openRestoreDialog(backup)"
              >
                Restore
              </button>
              <button
                class="btn btn-sm btn-danger-outline"
                title="Delete backup"
                @click="requestDelete(backup)"
              >
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="pagination">
        <button
          class="btn btn-sm btn-secondary"
          :disabled="!hasPrevPage"
          @click="goToPage(currentPage - 1)"
        >
          ← Prev
        </button>
        <span class="page-info">
          Page {{ currentPage }} of {{ totalPages }}
          <span class="total-info">({{ totalItems }} total)</span>
        </span>
        <button
          class="btn btn-sm btn-secondary"
          :disabled="!hasNextPage"
          @click="goToPage(currentPage + 1)"
        >
          Next →
        </button>
      </div>
    </div>

    <!-- Snapshot Dialog -->
    <Teleport to="body">
      <div v-if="showSnapshotDialog" class="dialog-overlay" @click.self="showSnapshotDialog = false">
        <div class="dialog" role="dialog" aria-modal="true" aria-label="Create Snapshot">
          <h3 class="dialog-title">Create Container Snapshot</h3>
          <p class="dialog-description">
            Create a Docker image snapshot of a running container.
          </p>
          <form @submit.prevent="triggerSnapshot">
            <div class="form-group">
              <label for="snapshot-container-id">Container ID or Name</label>
              <input
                id="snapshot-container-id"
                v-model="snapshotContainerId"
                type="text"
                placeholder="e.g. my-app-container"
                required
                class="form-input"
              />
            </div>
            <div class="form-group">
              <label for="snapshot-commit-message">Commit Message (optional)</label>
              <input
                id="snapshot-commit-message"
                v-model="snapshotCommitMessage"
                type="text"
                placeholder="e.g. Pre-deployment backup"
                class="form-input"
              />
            </div>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" @click="showSnapshotDialog = false">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="actionLoading || !snapshotContainerId.trim()">
                {{ actionLoading ? 'Creating...' : 'Create Snapshot' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- Export Dialog -->
    <Teleport to="body">
      <div v-if="showExportDialog" class="dialog-overlay" @click.self="showExportDialog = false">
        <div class="dialog" role="dialog" aria-modal="true" aria-label="Export Image">
          <h3 class="dialog-title">Export Image</h3>
          <p class="dialog-description">
            Export a Docker image as a tar archive to the configured backup storage location.
          </p>
          <form @submit.prevent="triggerExport">
            <div class="form-group">
              <label for="export-image-name">Image Name</label>
              <input
                id="export-image-name"
                v-model="exportImageName"
                type="text"
                placeholder="e.g. my-app-snapshot-20240101-120000"
                required
                class="form-input"
              />
            </div>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" @click="showExportDialog = false">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="actionLoading || !exportImageName.trim()">
                {{ actionLoading ? 'Exporting...' : 'Export' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- Restore Dialog -->
    <Teleport to="body">
      <div v-if="showRestoreDialog" class="dialog-overlay" @click.self="showRestoreDialog = false">
        <div class="dialog" role="dialog" aria-modal="true" aria-label="Restore Backup">
          <h3 class="dialog-title">Restore from Backup</h3>
          <p class="dialog-description">
            Restore a container from this snapshot. A safety snapshot of the current state will be created automatically before the restore.
          </p>
          <form @submit.prevent="triggerRestore">
            <div class="form-group">
              <label for="restore-target">Target Container Name</label>
              <input
                id="restore-target"
                v-model="restoreTargetContainer"
                type="text"
                placeholder="e.g. my-app-container"
                required
                class="form-input"
              />
            </div>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" @click="showRestoreDialog = false">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="actionLoading || !restoreTargetContainer.trim()">
                Continue
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- Confirm Dialog for destructive actions -->
    <ConfirmDialog
      :open="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-label="confirmLabel"
      :danger="confirmDanger"
      @confirm="handleConfirm"
      @cancel="confirmOpen = false"
    />
  </div>
</template>

<style scoped>
.backups-view h2 {
  margin: 0;
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
}

/* Banners */
.success-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  color: #16a34a;
}

.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  color: var(--color-danger);
}

.dismiss-btn {
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  color: inherit;
  padding: 0 0.25rem;
}

/* Loading skeleton */
.loading-skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.skeleton-row {
  height: 2.5rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Table */
.table-wrapper {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow: hidden;
}

.data-table th,
.data-table td {
  padding: 0.75rem 1rem;
  text-align: left;
  font-size: 0.8125rem;
  border-bottom: 1px solid var(--color-border);
}

.data-table th {
  background: var(--color-bg);
  font-weight: 600;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.data-table tbody tr:last-child td {
  border-bottom: none;
}

.data-table tbody tr:hover {
  background: var(--color-surface-hover);
}

.col-timestamp {
  font-family: monospace;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.actions-cell {
  white-space: nowrap;
  display: flex;
  gap: 0.375rem;
  align-items: center;
}

/* Badges */
.storage-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
  background: rgba(99, 102, 241, 0.15);
  color: var(--color-primary);
}

.storage-path {
  display: block;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  margin-top: 0.25rem;
  font-family: monospace;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: capitalize;
}

.status-completed {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}

.status-failed {
  background: rgba(239, 68, 68, 0.15);
  color: #dc2626;
}

.status-progress {
  background: rgba(234, 179, 8, 0.15);
  color: #a16207;
}

/* Pagination */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 1rem;
  padding: 0.75rem 0;
}

.page-info {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

.total-info {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  opacity: 0.7;
}

/* Buttons */
.btn {
  padding: 0.5rem 0.875rem;
  border: none;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.btn-secondary {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-border);
}

.btn-danger-outline {
  background: transparent;
  border: 1px solid var(--color-danger);
  color: var(--color-danger);
}

.btn-danger-outline:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
}

/* Dialog */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.5rem;
  width: 100%;
  max-width: 460px;
}

.dialog-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.375rem;
}

.dialog-description {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  margin-bottom: 1.25rem;
  line-height: 1.5;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.25rem;
}

/* Forms in dialogs */
.form-group {
  margin-bottom: 0.875rem;
}

.form-group label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  margin-bottom: 0.375rem;
  color: var(--color-text-muted);
}

.form-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: var(--color-text);
}

.form-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

/* Misc */
.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.empty-state {
  background: var(--color-surface);
  border: 1px dashed var(--color-border);
  border-radius: 0.5rem;
  padding: 3rem;
  text-align: center;
}

.empty-state p:first-child {
  font-weight: 500;
  margin-bottom: 0.25rem;
}
</style>
