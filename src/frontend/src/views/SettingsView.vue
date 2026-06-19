<script setup lang="ts">
import { ref, reactive, onMounted, watch } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import type { SettingCategory, SettingRecord } from '@/stores/settings';

const settingsStore = useSettingsStore();

const activeTab = ref<SettingCategory>('General');
const modifiedValues = reactive<Record<string, string>>({});
const originalValues = reactive<Record<string, string>>({});

function initializeOriginalValues(): void {
  for (const category of settingsStore.categories) {
    for (const setting of settingsStore.settings[category]) {
      originalValues[setting.key] = setting.value;
    }
  }
}

watch(() => settingsStore.settings, () => {
  initializeOriginalValues();
  // Clear modified values since we just refreshed
  Object.keys(modifiedValues).forEach((key) => delete modifiedValues[key]);
}, { deep: true });

function getDisplayValue(setting: SettingRecord): string {
  if (setting.key in modifiedValues) {
    return modifiedValues[setting.key];
  }
  return setting.value;
}

function onFieldChange(key: string, value: string): void {
  settingsStore.clearValidationError(key);

  if (value === originalValues[key]) {
    delete modifiedValues[key];
  } else {
    modifiedValues[key] = value;
  }
}

function onToggleChange(key: string, checked: boolean): void {
  const value = checked ? 'true' : 'false';
  onFieldChange(key, value);
}

function hasChanges(): boolean {
  return Object.keys(modifiedValues).length > 0;
}

async function handleSave(): Promise<void> {
  if (!hasChanges()) return;

  const success = await settingsStore.saveSettings({ ...modifiedValues });
  if (success) {
    // Clear modified values on success
    Object.keys(modifiedValues).forEach((key) => delete modifiedValues[key]);
    // Auto-dismiss success notification after 3 seconds
    setTimeout(() => {
      settingsStore.dismissSuccess();
    }, 3000);
  }
}

function getInputType(dataType: string): string {
  switch (dataType) {
    case 'number':
      return 'number';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    default:
      return 'text';
  }
}

function isTextarea(dataType: string): boolean {
  return dataType === 'json';
}

function isToggle(dataType: string): boolean {
  return dataType === 'boolean';
}

function isCron(dataType: string): boolean {
  return dataType === 'cron';
}

function getBooleanValue(setting: SettingRecord): boolean {
  const val = setting.key in modifiedValues ? modifiedValues[setting.key] : setting.value;
  return val === 'true';
}

onMounted(() => {
  settingsStore.fetchSettings();
});
</script>

<template>
  <div class="settings-view">
    <div class="settings-header">
      <h2>Settings</h2>
      <button
        class="btn-save"
        :disabled="!hasChanges() || settingsStore.isSaving"
        @click="handleSave"
      >
        {{ settingsStore.isSaving ? 'Saving...' : 'Save Changes' }}
      </button>
    </div>

    <!-- Success notification -->
    <div v-if="settingsStore.saveSuccess" class="notification success">
      <span>Settings saved successfully.</span>
      <button class="notification-dismiss" @click="settingsStore.dismissSuccess">×</button>
    </div>

    <!-- General save error -->
    <div v-if="settingsStore.saveError" class="notification error">
      <span>{{ settingsStore.saveError }}</span>
    </div>

    <!-- Loading state -->
    <p v-if="settingsStore.isLoading" class="muted">Loading settings...</p>

    <!-- Error state -->
    <div v-else-if="settingsStore.error" class="error-state">
      <p>{{ settingsStore.error }}</p>
      <button class="btn-retry" @click="settingsStore.fetchSettings()">Retry</button>
    </div>

    <!-- Settings content -->
    <template v-else>
      <!-- Category Tabs -->
      <div class="tabs">
        <button
          v-for="category in settingsStore.categories"
          :key="category"
          :class="['tab', { active: activeTab === category }]"
          @click="activeTab = category"
        >
          {{ category }}
        </button>
      </div>

      <!-- Tab content -->
      <div class="tab-content">
        <div
          v-if="settingsStore.settings[activeTab].length === 0"
          class="empty-state"
        >
          No settings configured for this category.
        </div>

        <div v-else class="settings-form">
          <div
            v-for="setting in settingsStore.settings[activeTab]"
            :key="setting.key"
            class="form-group"
          >
            <label :for="`setting-${setting.key}`" class="form-label">
              {{ setting.key }}
              <span v-if="setting.key in modifiedValues" class="modified-badge">modified</span>
            </label>

            <!-- Boolean toggle -->
            <template v-if="isToggle(setting.dataType)">
              <label class="toggle-label" :for="`setting-${setting.key}`">
                <input
                  :id="`setting-${setting.key}`"
                  type="checkbox"
                  class="toggle-input"
                  :checked="getBooleanValue(setting)"
                  @change="onToggleChange(setting.key, ($event.target as HTMLInputElement).checked)"
                />
                <span class="toggle-switch"></span>
                <span class="toggle-text">{{ getBooleanValue(setting) ? 'Enabled' : 'Disabled' }}</span>
              </label>
            </template>

            <!-- JSON textarea -->
            <template v-else-if="isTextarea(setting.dataType)">
              <textarea
                :id="`setting-${setting.key}`"
                class="form-input form-textarea"
                :value="getDisplayValue(setting)"
                rows="4"
                @input="onFieldChange(setting.key, ($event.target as HTMLTextAreaElement).value)"
              />
            </template>

            <!-- Cron input with hint -->
            <template v-else-if="isCron(setting.dataType)">
              <input
                :id="`setting-${setting.key}`"
                type="text"
                class="form-input"
                :value="getDisplayValue(setting)"
                placeholder="* * * * *"
                @input="onFieldChange(setting.key, ($event.target as HTMLInputElement).value)"
              />
              <span class="form-hint cron-hint">Format: minute hour day-of-month month day-of-week (e.g., 0 2 * * *)</span>
            </template>

            <!-- Standard inputs (text, number, email, url) -->
            <template v-else>
              <input
                :id="`setting-${setting.key}`"
                :type="getInputType(setting.dataType)"
                class="form-input"
                :value="getDisplayValue(setting)"
                @input="onFieldChange(setting.key, ($event.target as HTMLInputElement).value)"
              />
            </template>

            <!-- Description as helper text -->
            <span v-if="setting.description && !isCron(setting.dataType)" class="form-hint">
              {{ setting.description }}
            </span>

            <!-- Validation error -->
            <span
              v-if="settingsStore.validationErrors[setting.key]"
              class="form-error"
            >
              {{ settingsStore.validationErrors[setting.key] }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings-view h2 {
  margin-bottom: 0;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.btn-save {
  padding: 0.5rem 1.25rem;
  font-size: 0.875rem;
  font-weight: 500;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.btn-save:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.btn-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Notifications */
.notification {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
}

.notification.success {
  background: var(--color-success-light);
  color: var(--color-success);
  border: 1px solid var(--color-success);
}

.notification.error {
  background: var(--color-danger-light);
  color: var(--color-danger);
  border: 1px solid var(--color-danger);
}

.notification-dismiss {
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  color: inherit;
  padding: 0 0.25rem;
  line-height: 1;
}

/* Tabs */
.tabs {
  display: flex;
  gap: 0;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--color-border);
  overflow-x: auto;
}

.tab {
  padding: 0.625rem 1.25rem;
  font-size: 0.875rem;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.tab:hover {
  color: var(--color-text);
}

.tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

/* Tab content */
.tab-content {
  min-height: 200px;
}

.empty-state {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  background: var(--color-surface);
  padding: 2rem;
  border-radius: 0.5rem;
  border: 1px dashed var(--color-border);
  text-align: center;
}

.error-state {
  background: var(--color-danger-light);
  padding: 1.5rem;
  border-radius: 0.5rem;
  border: 1px solid var(--color-danger);
  text-align: center;
}

.error-state p {
  color: var(--color-danger);
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}

.btn-retry {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background: var(--color-danger);
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
}

.btn-retry:hover {
  opacity: 0.9;
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

/* Settings form */
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.5rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.form-label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.modified-badge {
  font-size: 0.6875rem;
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  background: var(--color-warning-light);
  color: var(--color-warning);
  font-weight: 600;
}

.form-input {
  width: 100%;
  max-width: 480px;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  color: var(--color-text);
  font-size: 0.875rem;
  transition: border-color 0.15s;
}

.form-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-light);
}

.form-textarea {
  resize: vertical;
  font-family: monospace;
  font-size: 0.8125rem;
}

.form-hint {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin-top: 0.125rem;
}

.cron-hint {
  font-style: italic;
}

.form-error {
  font-size: 0.75rem;
  color: var(--color-danger);
  margin-top: 0.125rem;
}

/* Toggle switch */
.toggle-label {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  cursor: pointer;
  width: fit-content;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  background: var(--color-border);
  border-radius: 9999px;
  transition: background-color 0.2s;
}

.toggle-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: white;
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}

.toggle-input:checked + .toggle-switch {
  background: var(--color-primary);
}

.toggle-input:checked + .toggle-switch::after {
  transform: translateX(16px);
}

.toggle-input:focus-visible + .toggle-switch {
  box-shadow: 0 0 0 2px var(--color-primary-light);
}

.toggle-text {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}
</style>
