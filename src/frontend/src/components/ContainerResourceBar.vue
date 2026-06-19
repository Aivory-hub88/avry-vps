<script setup lang="ts">
import { computed } from 'vue';
import { getResourceBarColor } from '@/utils/resourceBarColor';

const props = defineProps<{
  label: string;
  percentage: number;
  stopped: boolean;
}>();

const barColor = computed(() => getResourceBarColor(props.percentage));

const barWidth = computed(() => `${Math.min(Math.max(props.percentage, 0), 100)}%`);
</script>

<template>
  <div class="container-resource-bar">
    <div class="bar-header">
      <span class="bar-label">{{ label }}</span>
      <span v-if="!stopped" class="bar-value">{{ Math.round(percentage) }}%</span>
      <span v-else class="bar-stopped-label">stopped</span>
    </div>
    <div class="bar-track">
      <div
        v-if="!stopped"
        :class="['bar-fill', `bar-fill--${barColor}`]"
        :style="{ width: barWidth }"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.container-resource-bar {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.bar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.bar-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-text-muted);
}

.bar-value {
  font-size: 0.75rem;
  font-weight: 600;
}

.bar-stopped-label {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-style: italic;
}

.bar-track {
  height: 6px;
  background: var(--color-border);
  border-radius: 3px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease, background-color 0.3s ease;
}

.bar-fill--green {
  background: var(--color-success, #22c55e);
}

.bar-fill--yellow {
  background: var(--color-warning, #eab308);
}

.bar-fill--red {
  background: var(--color-danger, #ef4444);
}
</style>
