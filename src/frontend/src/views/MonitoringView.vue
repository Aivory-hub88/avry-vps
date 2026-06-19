<script setup lang="ts">
import { onMounted, onUnmounted, computed, watch, ref } from 'vue';
import { Line } from 'vue-chartjs';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { io, Socket } from 'socket.io-client';
import { useMonitoringStore, type TimeRange, type TimeSeriesDataPointV2 } from '@/stores/monitoring';
import { useContainersStore } from '@/stores/containers';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Title,
  Tooltip,
  Legend
);

const store = useMonitoringStore();
const containersStore = useContainersStore();

const timeRanges: { label: string; value: TimeRange }[] = [
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: '1y', value: '1y' },
];

let socket: Socket | null = null;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const chartLabels = computed(() =>
  store.systemData.map((p) => formatTimestamp(p.timestamp))
);

// CPU Line Chart
const cpuChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [
    {
      label: 'CPU Usage (%)',
      data: store.systemData.map((p) => p.cpu.usagePercent),
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      tension: 0.3,
      pointRadius: 0,
      fill: false,
    },
  ],
}));

// Memory Area Chart (filled)
const memoryChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [
    {
      label: 'Memory Used (MB)',
      data: store.systemData.map((p) => Math.round(p.memory.usedBytes / (1024 * 1024))),
      borderColor: '#8b5cf6',
      backgroundColor: 'rgba(139, 92, 246, 0.2)',
      tension: 0.3,
      pointRadius: 0,
      fill: true,
    },
  ],
}));

// Disk Area Chart (filled)
const diskChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [
    {
      label: 'Disk Used (GB)',
      data: store.systemData.map((p) => +(p.disk.usedBytes / (1024 * 1024 * 1024)).toFixed(2)),
      borderColor: '#f59e0b',
      backgroundColor: 'rgba(245, 158, 11, 0.2)',
      tension: 0.3,
      pointRadius: 0,
      fill: true,
    },
  ],
}));

// Network Line Chart
const networkChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [
    {
      label: 'RX (KB/s)',
      data: store.systemData.map((p) => +(p.network.rxBytesPerSec / 1024).toFixed(2)),
      borderColor: '#10b981',
      backgroundColor: 'rgba(16, 185, 129, 0.1)',
      tension: 0.3,
      pointRadius: 0,
      fill: false,
    },
    {
      label: 'TX (KB/s)',
      data: store.systemData.map((p) => +(p.network.txBytesPerSec / 1024).toFixed(2)),
      borderColor: '#ef4444',
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
      tension: 0.3,
      pointRadius: 0,
      fill: false,
    },
  ],
}));

const lineChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: 'index' as const,
    intersect: false,
  },
  plugins: {
    legend: {
      display: true,
      position: 'top' as const,
      labels: { color: '#94a3b8', boxWidth: 12 },
    },
    tooltip: {
      mode: 'index' as const,
      intersect: false,
    },
  },
  scales: {
    x: {
      ticks: { color: '#94a3b8', maxTicksLimit: 10 },
      grid: { color: 'rgba(148, 163, 184, 0.1)' },
    },
    y: {
      ticks: { color: '#94a3b8' },
      grid: { color: 'rgba(148, 163, 184, 0.1)' },
      beginAtZero: true,
    },
  },
};

const cpuChartOptions = {
  ...lineChartOptions,
  scales: {
    ...lineChartOptions.scales,
    y: { ...lineChartOptions.scales.y, max: 100 },
  },
};

// Container selector
const selectedContainerId = ref<string | null>(null);

const containerChartLabels = computed(() =>
  store.containerData.map((p) => formatTimestamp(p.timestamp))
);

// Container CPU Line Chart
const containerCpuChartData = computed(() => ({
  labels: containerChartLabels.value,
  datasets: [
    {
      label: 'Container CPU Usage (%)',
      data: store.containerData.map((p) => p.cpu.usagePercent),
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      tension: 0.3,
      pointRadius: 0,
      fill: false,
    },
  ],
}));

// Container Memory Area Chart (filled)
const containerMemoryChartData = computed(() => ({
  labels: containerChartLabels.value,
  datasets: [
    {
      label: 'Container Memory Used (MB)',
      data: store.containerData.map((p) => Math.round(p.memory.usedBytes / (1024 * 1024))),
      borderColor: '#8b5cf6',
      backgroundColor: 'rgba(139, 92, 246, 0.2)',
      tension: 0.3,
      pointRadius: 0,
      fill: true,
    },
  ],
}));

const containerHasData = computed(() => store.containerData.length > 0);

function onContainerSelect(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  selectedContainerId.value = value || null;
  store.selectContainer(value || null);
  if (value) {
    store.fetchHistory();
  }
}

function selectTimeRange(range: TimeRange): void {
  store.setTimeRange(range);
  // Always fetch system-level data
  store.selectContainer(null);
  store.fetchHistory().then(() => {
    // After system data is fetched, also fetch container data if selected
    if (selectedContainerId.value) {
      store.selectContainer(selectedContainerId.value);
      store.fetchHistory();
    }
  });
}

function retry(): void {
  store.fetchHistory();
}

function connectSocket(): void {
  socket = io(window.location.origin, {
    transports: ['websocket'],
  });

  socket.on('resource:update', (point: TimeSeriesDataPointV2) => {
    store.appendRealTimePoint(point);
  });
}

function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// Fetch history on mount, load containers, and connect to real-time updates
onMounted(() => {
  store.fetchHistory();
  containersStore.fetchContainers();
  connectSocket();
});

onUnmounted(() => {
  disconnectSocket();
});

// Re-fetch container data when time range changes externally
watch(
  () => store.timeRange,
  () => {
    if (selectedContainerId.value) {
      store.selectContainer(selectedContainerId.value);
      store.fetchHistory();
    }
  }
);
</script>

<template>
  <div class="monitoring-view">
    <div class="monitoring-header">
      <h2>Monitoring</h2>
      <div class="time-range-selector">
        <button
          v-for="range in timeRanges"
          :key="range.value"
          :class="['range-btn', { active: store.timeRange === range.value }]"
          @click="selectTimeRange(range.value)"
        >
          {{ range.label }}
        </button>
      </div>
    </div>

    <!-- Loading skeleton -->
    <div v-if="store.loading" class="loading-container">
      <div class="skeleton-grid">
        <div class="skeleton-card" v-for="i in 4" :key="i">
          <div class="skeleton-title"></div>
          <div class="skeleton-chart"></div>
        </div>
      </div>
    </div>

    <!-- Error state -->
    <div v-else-if="store.error" class="error-container">
      <div class="error-card">
        <span class="error-icon">⚠️</span>
        <p class="error-message">{{ store.error }}</p>
        <button class="retry-btn" @click="retry">Retry</button>
      </div>
    </div>

    <!-- Charts grid -->
    <div v-else class="charts-grid">
      <!-- CPU Chart (Line) -->
      <section class="chart-card">
        <h3>CPU Usage</h3>
        <div class="chart-wrapper">
          <Line :data="cpuChartData" :options="cpuChartOptions" />
        </div>
      </section>

      <!-- Memory Chart (Area / filled) -->
      <section class="chart-card">
        <h3>Memory Usage</h3>
        <div class="chart-wrapper">
          <Line :data="memoryChartData" :options="lineChartOptions" />
        </div>
      </section>

      <!-- Disk Chart (Area / filled) -->
      <section class="chart-card">
        <h3>Disk Usage</h3>
        <div class="chart-wrapper">
          <Line :data="diskChartData" :options="lineChartOptions" />
        </div>
      </section>

      <!-- Network Chart (Line) -->
      <section class="chart-card">
        <h3>Network Throughput</h3>
        <div class="chart-wrapper">
          <Line :data="networkChartData" :options="lineChartOptions" />
        </div>
      </section>
    </div>

    <!-- Container Drill-Down Section -->
    <div class="container-drilldown-section" v-if="!store.loading && !store.error">
      <div class="container-selector-header">
        <h3>Container Metrics</h3>
        <select
          class="container-selector"
          :value="selectedContainerId ?? ''"
          @change="onContainerSelect"
          aria-label="Select container for drill-down metrics"
        >
          <option value="">Select a container...</option>
          <option
            v-for="container in containersStore.containers"
            :key="container.id"
            :value="container.id"
          >
            {{ container.name }}
          </option>
        </select>
      </div>

      <!-- Container charts when a container is selected -->
      <div v-if="selectedContainerId" class="container-charts">
        <!-- No data available message -->
        <div v-if="!containerHasData && !store.loading" class="no-data-message">
          <span class="no-data-icon">📊</span>
          <p>No data available for the selected period</p>
        </div>

        <!-- Container CPU and Memory charts -->
        <div v-else class="charts-grid">
          <section class="chart-card">
            <h3>Container CPU Usage</h3>
            <div class="chart-wrapper">
              <Line :data="containerCpuChartData" :options="cpuChartOptions" />
            </div>
          </section>

          <section class="chart-card">
            <h3>Container Memory Usage</h3>
            <div class="chart-wrapper">
              <Line :data="containerMemoryChartData" :options="lineChartOptions" />
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monitoring-view h2 {
  margin-bottom: 0;
}

.monitoring-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.time-range-selector {
  display: flex;
  gap: 0.25rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 0.25rem;
}

.range-btn {
  padding: 0.375rem 0.75rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.range-btn:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

.range-btn.active {
  background: var(--color-primary, #3b82f6);
  color: #fff;
}

/* Loading skeleton */
.loading-container {
  width: 100%;
}

.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 1rem;
}

.skeleton-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
}

.skeleton-title {
  width: 120px;
  height: 16px;
  background: var(--color-surface-hover);
  border-radius: 0.25rem;
  margin-bottom: 1rem;
  animation: pulse 1.5s ease-in-out infinite;
}

.skeleton-chart {
  width: 100%;
  height: 200px;
  background: var(--color-surface-hover);
  border-radius: 0.375rem;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Error state */
.error-container {
  display: flex;
  justify-content: center;
  padding: 3rem 1rem;
}

.error-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 2rem 3rem;
  text-align: center;
  max-width: 400px;
}

.error-icon {
  font-size: 2rem;
  display: block;
  margin-bottom: 0.75rem;
}

.error-message {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  margin-bottom: 1.25rem;
}

.retry-btn {
  padding: 0.5rem 1.25rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.15s ease;
}

.retry-btn:hover {
  background: var(--color-surface-hover);
}

/* Charts grid */
.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 1rem;
}

.chart-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
}

.chart-card h3 {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-text-muted);
  margin-bottom: 1rem;
}

.chart-wrapper {
  position: relative;
  height: 220px;
}

/* Container drill-down section */
.container-drilldown-section {
  margin-top: 2rem;
}

.container-selector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.container-selector-header h3 {
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.container-selector {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 0.875rem;
  min-width: 200px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.container-selector:hover {
  border-color: var(--color-primary, #3b82f6);
}

.container-selector:focus {
  outline: none;
  border-color: var(--color-primary, #3b82f6);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.container-charts {
  margin-top: 1rem;
}

.no-data-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  text-align: center;
}

.no-data-icon {
  font-size: 2rem;
  display: block;
  margin-bottom: 0.75rem;
}

.no-data-message p {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  margin: 0;
}
</style>
