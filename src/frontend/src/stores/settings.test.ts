import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSettingsStore } from './settings';
import type { SettingsGrouped } from './settings';

const mockSettingsResponse: SettingsGrouped = {
  General: [],
  Monitoring: [
    {
      key: 'collection_interval_ms',
      value: '30000',
      category: 'Monitoring',
      dataType: 'number',
      updatedAt: '2024-01-01T00:00:00Z',
      description: 'Metrics collection interval in ms',
    },
  ],
  Alerts: [
    {
      key: 'webhook_url',
      value: '',
      category: 'Alerts',
      dataType: 'url',
      updatedAt: '2024-01-01T00:00:00Z',
      description: 'Webhook URL for alert delivery',
    },
    {
      key: 'smtp_host',
      value: '',
      category: 'Alerts',
      dataType: 'string',
      updatedAt: '2024-01-01T00:00:00Z',
      description: 'SMTP server host',
    },
  ],
  Backups: [
    {
      key: 'snapshot_schedule_enabled',
      value: 'false',
      category: 'Backups',
      dataType: 'boolean',
      updatedAt: '2024-01-01T00:00:00Z',
      description: 'Enable scheduled snapshots',
    },
    {
      key: 'snapshot_schedule_cron',
      value: '0 2 * * *',
      category: 'Backups',
      dataType: 'cron',
      updatedAt: '2024-01-01T00:00:00Z',
      description: 'Snapshot schedule cron expression',
    },
  ],
  Security: [],
  Network: [],
};

describe('useSettingsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'test-token'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with empty settings and correct categories', () => {
    const store = useSettingsStore();

    expect(store.categories).toEqual([
      'General',
      'Monitoring',
      'Alerts',
      'Backups',
      'Security',
      'Network',
    ]);
    expect(store.isLoading).toBe(false);
    expect(store.isSaving).toBe(false);
    expect(store.error).toBeNull();
  });

  it('fetches settings successfully', async () => {
    const store = useSettingsStore();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSettingsResponse),
    }));

    await store.fetchSettings();

    expect(store.isLoading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.settings.Monitoring).toHaveLength(1);
    expect(store.settings.Monitoring[0].key).toBe('collection_interval_ms');
    expect(store.settings.Alerts).toHaveLength(2);
    expect(store.settings.Backups).toHaveLength(2);
  });

  it('handles fetch error with auth failure', async () => {
    const store = useSettingsStore();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'Forbidden' }),
    }));

    await store.fetchSettings();

    expect(store.error).toBe('Access denied. Admin authentication required.');
  });

  it('handles network error on fetch', async () => {
    const store = useSettingsStore();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    await store.fetchSettings();

    expect(store.error).toBe('Network error');
  });

  it('saves settings successfully', async () => {
    const store = useSettingsStore();

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // PUT request
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      // GET request (refresh after save)
      return Promise.resolve({ ok: true, json: () => Promise.resolve(mockSettingsResponse) });
    }));

    const result = await store.saveSettings({ collection_interval_ms: '60000' });

    expect(result).toBe(true);
    expect(store.saveSuccess).toBe(true);
    expect(store.isSaving).toBe(false);
  });

  it('handles validation error on save', async () => {
    const store = useSettingsStore();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: 'Must be a valid number',
        code: 'VALIDATION_FAILED',
        field: 'collection_interval_ms',
      }),
    }));

    const result = await store.saveSettings({ collection_interval_ms: 'not-a-number' });

    expect(result).toBe(false);
    expect(store.validationErrors['collection_interval_ms']).toBe('Must be a valid number');
  });

  it('clears validation error for a specific key', async () => {
    const store = useSettingsStore();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: 'Invalid value',
        code: 'VALIDATION_FAILED',
        field: 'smtp_host',
      }),
    }));

    await store.saveSettings({ smtp_host: '' });
    expect(store.validationErrors['smtp_host']).toBe('Invalid value');

    store.clearValidationError('smtp_host');
    expect(store.validationErrors['smtp_host']).toBeUndefined();
  });

  it('sends auth token in request headers', async () => {
    const store = useSettingsStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSettingsResponse),
    });
    vi.stubGlobal('fetch', fetchMock);

    await store.fetchSettings();

    expect(fetchMock).toHaveBeenCalledWith('/api/settings', {
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it('dismisses success notification', async () => {
    const store = useSettingsStore();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSettingsResponse),
    }));

    await store.saveSettings({ key: 'val' });
    expect(store.saveSuccess).toBe(true);

    store.dismissSuccess();
    expect(store.saveSuccess).toBe(false);
  });
});
