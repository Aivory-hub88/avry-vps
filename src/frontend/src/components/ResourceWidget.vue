<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useAuthStore } from '@/stores/auth';

interface SystemMetrics {
  cpu: { usagePercent: number };
  memory: { usedGB: number; totalGB: number };
  disk: { usedGB: number; totalGB: number; usagePercent: number };
  network: { inBytesPerSec: number; outBytesPerSec: number };
}

const authStore = useAuthStore();
const metrics = ref<SystemMetrics | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);

let refreshInterval: ReturnType<typeof setInterval> | null = null;

const WARNING_THRESHOLD = 90;

const cpuWarning = computed(() => (metrics.value?.cpu.usagePercent ?? 0) >= WARNING_THRESHOLD);
const memoryPercent = computed(() => {
  if (!metrics.value) return 0;
  return Math.round((metrics.value.memory.usedGB / metrics.value.memory.totalGB) * 100);
});
const memoryWarning = computed(() => memoryPercent.value >= WARNING_THRESHOLD);
const diskWarning = computed(() => (metrics.value?.disk.usagePercent ?? 0) >= WARNING_THRESHOLD);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
}

async function fetchMetrics(): Promise<void> {
  isLoading.value = true;
  error.value = null;

  try {
    const response = await fetch('/api/system/metrics', {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });

    if (!response.ok) throw new Error('Failed to fetch metrics');

    metrics.value = await response.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  fetchMetrics();
  refreshInterval = setInterval(fetchMetrics, 5000);
});

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<template>
  <div class="resource-widget">
    <h3 class="widget-title">System Resources</h3>

    <div v-if="isLoading && !metrics" class="loading">Loading metrics...</div>
    <div v-else-if="error && !metrics" class="error">{{ error }}</div>

    <div v-else-if="metrics" class="metrics-grid">
      <div :class="['metric', { warning: cpuWarning }]">
        <div class="metric-header">
          <span class="metric-label">CPU</span>
          <span class="metric-value">{{ metrics.cpu.usagePercent.toFixed(1) }}%</span>
        </div>
        <div class="progress-bar">
          <div
            class="progress-fill"
            :style="{ width: `${metrics.cpu.usagePercent}%` }"
          ></div>
        </div>
      </div>

      <div :class="['metric', { warning: memoryWarning }]">
        <div class="metric-header">
          <span class="metric-label">RAM</span>
          <span class="metric-value">
            {{ metrics.memory.usedGB.toFixed(1) }} / {{ metrics.memory.totalGB.toFixed(1) }} GB
          </span>
        </div>
        <div class="progress-bar">
          <div
            class="progress-fill"
            :style="{ width: `${memoryPercent}%` }"
          ></div>
        </div>
      </div>

      <div :class="['metric', { warning: diskWarning }]">
        <div class="metric-header">
          <span class="metric-label">Disk</span>
          <span class="metric-value">
            {{ metrics.disk.usedGB.toFixed(1) }} / {{ metrics.disk.totalGB.toFixed(1) }} GB
          </span>
        </div>
        <div class="progress-bar">
          <div
            class="progress-fill"
            :style="{ width: `${metrics.disk.usagePercent}%` }"
          ></div>
        </div>
      </div>

      <div class="metric">
        <div class="metric-header">
          <span class="metric-label">Network I/O</span>
        </div>
        <div class="network-stats">
          <span class="net-in">↓ {{ formatBytes(metrics.network.inBytesPerSec) }}</span>
          <span class="net-out">↑ {{ formatBytes(metrics.network.outBytesPerSec) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.resource-widget {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
}

.widget-title {
  font-size: 0.875rem;
  color: var(--color-text-muted);
  margin-bottom: 1rem;
}

.loading,
.error {
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.error {
  color: var(--color-danger);
}

.metrics-grid {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.metric {
  padding: 0.5rem 0;
}

.metric.warning .metric-value {
  color: var(--color-warning);
  font-weight: 600;
}

.metric.warning .progress-fill {
  background: var(--color-warning) !important;
}

.metric-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.375rem;
}

.metric-label {
  font-size: 0.8125rem;
  font-weight: 500;
}

.metric-value {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

.progress-bar {
  height: 6px;
  background: var(--color-border);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--color-primary);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.network-stats {
  display: flex;
  gap: 1rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

.net-in {
  color: var(--color-success);
}

.net-out {
  color: var(--color-primary);
}
</style>
