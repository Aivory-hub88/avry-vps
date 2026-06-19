<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { io, Socket } from 'socket.io-client';
import { useContainersStore } from '@/stores/containers';
import { useAuthStore } from '@/stores/auth';
import StatusBadge from '@/components/StatusBadge.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ContainerResourceBar from '@/components/ContainerResourceBar.vue';

const containersStore = useContainersStore();
const authStore = useAuthStore();

let refreshInterval: ReturnType<typeof setInterval> | null = null;
let socket: Socket | null = null;

// Per-container resource usage (updated via Socket.IO resource:update events)
interface ContainerResourceData {
  cpuPercent: number;
  memoryPercent: number;
}

const containerResources = ref<Record<string, ContainerResourceData>>({});

// Detail panel
interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  restartCount: number;
  cpuPercent: number;
  memoryMB: number;
}

const selectedId = ref<string | null>(null);
const detail = ref<ContainerDetail | null>(null);
const detailLoading = ref(false);

// Action states
const actionLoading = ref(false);
const actionError = ref<string | null>(null);

// Confirm dialog
const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmDanger = ref(false);
const confirmLabel = ref('');
let pendingAction: (() => Promise<void>) | null = null;

const selectedContainer = computed(() =>
  containersStore.containers.find((c) => c.id === selectedId.value) ?? null
);

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

async function selectContainer(id: string): Promise<void> {
  if (selectedId.value === id) {
    selectedId.value = null;
    detail.value = null;
    return;
  }

  selectedId.value = id;
  detailLoading.value = true;
  actionError.value = null;

  try {
    const response = await fetch(`/api/containers/${id}`, {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });

    if (!response.ok) throw new Error('Failed to fetch container details');

    detail.value = await response.json();
  } catch (err) {
    detail.value = null;
    actionError.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    detailLoading.value = false;
  }
}

async function executeAction(action: () => Promise<void>): Promise<void> {
  actionLoading.value = true;
  actionError.value = null;

  try {
    await action();
    // Re-fetch detail if still selected
    if (selectedId.value) {
      await selectContainer(selectedId.value);
    }
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : 'Action failed';
  } finally {
    actionLoading.value = false;
  }
}

function handleStart(): void {
  if (!selectedId.value) return;
  const id = selectedId.value;
  executeAction(() => containersStore.startContainer(id));
}

function handleRestart(): void {
  if (!selectedId.value) return;
  const id = selectedId.value;
  executeAction(() => containersStore.restartContainer(id));
}

function requestStop(): void {
  if (!selectedContainer.value) return;
  confirmTitle.value = 'Stop Container';
  confirmMessage.value = `Are you sure you want to stop "${selectedContainer.value.name}"? This will terminate the running service.`;
  confirmLabel.value = 'Stop';
  confirmDanger.value = true;
  const id = selectedId.value!;
  pendingAction = () => containersStore.stopContainer(id);
  confirmOpen.value = true;
}

function requestPullRedeploy(): void {
  if (!selectedContainer.value) return;
  confirmTitle.value = 'Pull & Redeploy';
  confirmMessage.value = `This will pull the latest image and redeploy "${selectedContainer.value.name}". The service will experience brief downtime.`;
  confirmLabel.value = 'Redeploy';
  confirmDanger.value = true;
  const id = selectedId.value!;
  pendingAction = async () => {
    const response = await fetch(`/api/containers/${id}/pull-redeploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    if (!response.ok) throw new Error('Pull & redeploy failed');
    await containersStore.fetchContainers();
  };
  confirmOpen.value = true;
}

function handleConfirm(): void {
  confirmOpen.value = false;
  if (pendingAction) {
    executeAction(pendingAction);
    pendingAction = null;
  }
}

function handleCancel(): void {
  confirmOpen.value = false;
  pendingAction = null;
}

onMounted(() => {
  containersStore.fetchContainers();
  refreshInterval = setInterval(() => containersStore.fetchContainers(), 15000);

  // Connect Socket.IO for real-time resource updates
  socket = io({ transports: ['websocket'] });
  socket.on('resource:update', (data: { containers?: Array<{ id: string; name: string; cpuPercent: number; memoryUsageMB: number; memoryLimitMB: number }> }) => {
    if (data.containers) {
      for (const c of data.containers) {
        const memoryPercent = c.memoryLimitMB > 0
          ? (c.memoryUsageMB / c.memoryLimitMB) * 100
          : 0;
        containerResources.value[c.id] = {
          cpuPercent: c.cpuPercent,
          memoryPercent,
        };
      }
    }
  });
});

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
});
</script>

<template>
  <div class="containers-view">
    <h2>Containers</h2>

    <!-- Loading -->
    <p v-if="containersStore.isLoading && containersStore.containers.length === 0" class="muted">
      Loading containers...
    </p>

    <!-- Error -->
    <p v-else-if="containersStore.error && containersStore.containers.length === 0" class="error-msg">
      {{ containersStore.error }}
    </p>

    <!-- Empty state -->
    <div v-else-if="containersStore.containers.length === 0" class="empty-state">
      <p>No containers found.</p>
      <p class="muted">Deploy a Docker service to see it listed here.</p>
    </div>

    <!-- Container list + detail -->
    <div v-else class="containers-layout">
      <div class="container-list">
        <div
          v-for="container in containersStore.containers"
          :key="container.id"
          :class="['container-row', { active: container.id === selectedId }]"
          @click="selectContainer(container.id)"
        >
          <div class="row-main">
            <span class="container-name">{{ container.name }}</span>
            <StatusBadge :status="container.health" />
          </div>
          <div class="row-meta">
            <span>Port: {{ container.port || '—' }}</span>
            <span>Uptime: {{ formatUptime(container.uptime) }}</span>
          </div>
          <div class="row-resources">
            <ContainerResourceBar
              label="CPU"
              :percentage="containerResources[container.id]?.cpuPercent ?? 0"
              :stopped="container.status !== 'running'"
            />
            <ContainerResourceBar
              label="Memory"
              :percentage="containerResources[container.id]?.memoryPercent ?? 0"
              :stopped="container.status !== 'running'"
            />
          </div>
        </div>
      </div>

      <!-- Detail panel -->
      <div v-if="selectedId" class="detail-panel">
        <div v-if="detailLoading" class="detail-loading">Loading details...</div>

        <template v-else-if="detail">
          <h3 class="detail-title">{{ selectedContainer?.name }}</h3>

          <!-- Action error -->
          <div v-if="actionError" class="action-error">
            <span>{{ actionError }}</span>
            <button class="dismiss-btn" @click="actionError = null">×</button>
          </div>

          <div class="detail-info">
            <div class="info-row">
              <span class="info-label">ID</span>
              <span class="info-value monospace">{{ detail.id.substring(0, 12) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Image</span>
              <span class="info-value">{{ detail.image }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Restart Count</span>
              <span class="info-value">{{ detail.restartCount }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">CPU</span>
              <span class="info-value">{{ detail.cpuPercent.toFixed(1) }}%</span>
            </div>
            <div class="info-row">
              <span class="info-label">Memory</span>
              <span class="info-value">{{ detail.memoryMB.toFixed(1) }} MB</span>
            </div>
          </div>

          <!-- Actions -->
          <div class="detail-actions">
            <button
              class="btn btn-success"
              :disabled="actionLoading || selectedContainer?.status === 'running'"
              @click="handleStart"
            >
              Start
            </button>
            <button
              class="btn btn-warning"
              :disabled="actionLoading"
              @click="handleRestart"
            >
              Restart
            </button>
            <button
              class="btn btn-danger"
              :disabled="actionLoading || selectedContainer?.status === 'stopped'"
              @click="requestStop"
            >
              Stop
            </button>
            <button
              class="btn btn-primary"
              :disabled="actionLoading"
              @click="requestPullRedeploy"
            >
              Pull &amp; Redeploy
            </button>
          </div>

          <p v-if="actionLoading" class="muted action-loading-msg">Processing action...</p>
        </template>

        <div v-else-if="actionError" class="detail-error">
          <p class="error-msg">{{ actionError }}</p>
        </div>
      </div>
    </div>

    <!-- Confirmation dialog -->
    <ConfirmDialog
      :open="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-label="confirmLabel"
      :danger="confirmDanger"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    />
  </div>
</template>

<style scoped>
.containers-view h2 {
  margin-bottom: 1.5rem;
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.error-msg {
  color: var(--color-danger);
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

/* Layout */
.containers-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: start;
}

@media (max-width: 900px) {
  .containers-layout {
    grid-template-columns: 1fr;
  }
}

/* Container list */
.container-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.container-row {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  padding: 0.875rem 1rem;
  cursor: pointer;
  transition: border-color 0.2s, background-color 0.2s;
}

.container-row:hover {
  background: var(--color-surface-hover);
}

.container-row.active {
  border-color: var(--color-primary);
  background: rgba(99, 102, 241, 0.05);
}

.row-main {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
}

.container-name {
  font-weight: 500;
  font-size: 0.875rem;
}

.row-meta {
  display: flex;
  gap: 1rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.row-resources {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

/* Detail panel */
.detail-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
  position: sticky;
  top: 1.5rem;
}

.detail-loading {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.detail-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

.action-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 0.375rem;
  padding: 0.625rem 0.875rem;
  margin-bottom: 1rem;
  font-size: 0.8125rem;
  color: var(--color-danger);
}

.dismiss-btn {
  background: none;
  border: none;
  color: var(--color-danger);
  font-size: 1.125rem;
  cursor: pointer;
  padding: 0 0.25rem;
}

.detail-info {
  margin-bottom: 1.25rem;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 0.8125rem;
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  color: var(--color-text-muted);
}

.info-value {
  font-weight: 500;
}

.monospace {
  font-family: 'Courier New', Courier, monospace;
}

/* Action buttons */
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.btn {
  padding: 0.5rem 0.875rem;
  border: none;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s, background-color 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-success {
  background: var(--color-success);
  color: white;
}

.btn-success:hover:not(:disabled) {
  background: #16a34a;
}

.btn-warning {
  background: var(--color-warning);
  color: white;
}

.btn-warning:hover:not(:disabled) {
  background: #d97706;
}

.btn-danger {
  background: var(--color-danger);
  color: white;
}

.btn-danger:hover:not(:disabled) {
  background: #dc2626;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.action-loading-msg {
  margin-top: 0.75rem;
}

.detail-error {
  padding: 1rem;
}
</style>
