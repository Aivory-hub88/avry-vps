import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export type SettingCategory = 'General' | 'Monitoring' | 'Alerts' | 'Backups' | 'Security' | 'Network';
export type SettingDataType = 'string' | 'number' | 'boolean' | 'json' | 'email' | 'url' | 'cron';

export interface SettingRecord {
  key: string;
  value: string;
  category: SettingCategory;
  dataType: SettingDataType;
  updatedAt: string;
  description: string;
}

export type SettingsGrouped = Record<SettingCategory, SettingRecord[]>;

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<SettingsGrouped>({
    General: [],
    Monitoring: [],
    Alerts: [],
    Backups: [],
    Security: [],
    Network: [],
  });

  const isLoading = ref(false);
  const isSaving = ref(false);
  const error = ref<string | null>(null);
  const saveError = ref<string | null>(null);
  const validationErrors = ref<Record<string, string>>({});
  const saveSuccess = ref(false);

  const categories = computed<SettingCategory[]>(() => [
    'General',
    'Monitoring',
    'Alerts',
    'Backups',
    'Security',
    'Network',
  ]);

  async function fetchSettings(): Promise<void> {
    isLoading.value = true;
    error.value = null;

    try {
      const token = localStorage.getItem('vps_token');
      const response = await fetch('/api/settings', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          error.value = 'Access denied. Admin authentication required.';
          return;
        }
        throw new Error(`Failed to fetch settings: ${response.statusText}`);
      }

      const data: SettingsGrouped = await response.json();
      settings.value = data;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load settings';
    } finally {
      isLoading.value = false;
    }
  }

  async function saveSettings(updates: Record<string, string>): Promise<boolean> {
    isSaving.value = true;
    saveError.value = null;
    validationErrors.value = {};
    saveSuccess.value = false;

    try {
      const token = localStorage.getItem('vps_token');
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const data = await response.json();

        if (response.status === 400 && data.code === 'VALIDATION_FAILED') {
          // Parse validation error and assign to the affected field
          if (data.field) {
            validationErrors.value[data.field] = data.error || 'Validation failed';
          } else {
            saveError.value = data.error || 'Validation failed';
          }
          return false;
        }

        saveError.value = data.error || `Failed to save settings: ${response.statusText}`;
        return false;
      }

      saveSuccess.value = true;
      // Refresh settings after successful save
      await fetchSettings();
      return true;
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : 'Failed to save settings';
      return false;
    } finally {
      isSaving.value = false;
    }
  }

  function clearValidationError(key: string): void {
    delete validationErrors.value[key];
  }

  function dismissSuccess(): void {
    saveSuccess.value = false;
  }

  return {
    settings,
    isLoading,
    isSaving,
    error,
    saveError,
    validationErrors,
    saveSuccess,
    categories,
    fetchSettings,
    saveSettings,
    clearValidationError,
    dismissSuccess,
  };
});
