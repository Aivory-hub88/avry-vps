import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useAuthStore } from './auth';

export type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d' | '1y';

export interface TimeSeriesDataPointV2 {
  timestamp: string;
  cpu: { usagePercent: number; maxPercent?: number };
  memory: { usedBytes: number; totalBytes: number; maxUsedBytes?: number };
  disk: { usedBytes: number; totalBytes: number; maxUsedBytes?: number };
  network: { rxBytesPerSec: number; txBytesPerSec: number };
}

/**
 * Convert a TimeRange to start/end ISO timestamps and appropriate resolution.
 */
function resolveTimeRange(range: TimeRange): { start: string; end: string; resolution: string } {
  const end = new Date();
  const start = new Date(end);

  switch (range) {
    case '1h':
      start.setHours(start.getHours() - 1);
      break;
    case '6h':
      start.setHours(start.getHours() - 6);
      break;
    case '24h':
      start.setHours(start.getHours() - 24);
      break;
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
    case '1y':
      start.setFullYear(start.getFullYear() - 1);
      break;
  }

  // Auto-resolution logic per design spec
  const durationMs = end.getTime() - start.getTime();
  const hours24 = 24 * 60 * 60 * 1000;
  const days30 = 30 * 24 * 60 * 60 * 1000;

  let resolution: string;
  if (durationMs <= hours24) {
    resolution = '30s';
  } else if (durationMs <= days30) {
    resolution = '5m';
  } else {
    resolution = '1h';
  }

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    resolution,
  };
}

export const useMonitoringStore = defineStore('monitoring', () => {
  const timeRange = ref<TimeRange>('1h');
  const selectedContainer = ref<string | null>(null);
  const systemData = ref<TimeSeriesDataPointV2[]>([]);
  const containerData = ref<TimeSeriesDataPointV2[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  function setTimeRange(range: TimeRange): void {
    timeRange.value = range;
  }

  function selectContainer(containerId: string | null): void {
    selectedContainer.value = containerId;
  }

  async function fetchHistory(): Promise<void> {
    const authStore = useAuthStore();
    loading.value = true;
    error.value = null;

    try {
      const { start, end, resolution } = resolveTimeRange(timeRange.value);

      const params = new URLSearchParams({ start, end, resolution });
      if (selectedContainer.value) {
        params.set('containerId', selectedContainer.value);
      }

      const response = await fetch(`/api/monitoring/history?${params.toString()}`, {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch monitoring history: ${response.statusText}`);
      }

      const data: TimeSeriesDataPointV2[] = await response.json();

      if (selectedContainer.value) {
        containerData.value = data;
      } else {
        systemData.value = data;
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      loading.value = false;
    }
  }

  function appendRealTimePoint(point: TimeSeriesDataPointV2): void {
    systemData.value = [...systemData.value, point];

    // If a container is selected and the point contains container-specific data,
    // also append to containerData (the Socket.IO event may include per-container info)
    if (selectedContainer.value) {
      containerData.value = [...containerData.value, point];
    }
  }

  return {
    timeRange,
    selectedContainer,
    systemData,
    containerData,
    loading,
    error,
    setTimeRange,
    selectContainer,
    fetchHistory,
    appendRealTimePoint,
  };
});
