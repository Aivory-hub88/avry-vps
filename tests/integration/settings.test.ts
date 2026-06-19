/**
 * Integration Tests: Settings API Routes
 *
 * Tests the full request/response flow through the settings Express router
 * with a mocked SettingsService dependency. Verifies:
 * - GET /api/settings returns all settings grouped by category
 * - PUT /api/settings accepts batch key-value updates
 * - 400 response on validation errors
 * - 404 response for unknown setting keys
 * - 400 response for invalid request body shapes
 *
 * Requirements: 6.3, 6.4, 6.5, 6.6
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings.js';
import type { SettingsService } from '../../src/services/settings-service.js';
import { SettingsServiceError } from '../../src/services/settings-service.js';

// ─── Mock Service Factory ────────────────────────────────────────────────────

function createMockSettingsService(): SettingsService {
  const mockService = {
    getAll: vi.fn().mockResolvedValue({
      General: [],
      Monitoring: [
        {
          key: 'collection_interval_ms',
          value: '30000',
          category: 'Monitoring',
          dataType: 'number',
          updatedAt: '2024-01-15T10:00:00.000Z',
          description: 'Metrics collection interval in ms',
        },
      ],
      Alerts: [
        {
          key: 'alert_cpu_warning',
          value: '80',
          category: 'Alerts',
          dataType: 'number',
          updatedAt: '2024-01-15T10:00:00.000Z',
          description: 'CPU warning threshold %',
        },
      ],
      Backups: [],
      Security: [],
      Network: [],
    }),
    get: vi.fn().mockResolvedValue('30000'),
    getTyped: vi.fn().mockResolvedValue(30000),
    update: vi.fn().mockResolvedValue(undefined),
    validate: vi.fn().mockReturnValue({ valid: true }),
    getDefinitions: vi.fn().mockReturnValue([]),
    // EventEmitter methods (minimal mock)
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    emit: vi.fn().mockReturnValue(true),
    off: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    addListener: vi.fn().mockReturnThis(),
    listeners: vi.fn().mockReturnValue([]),
    rawListeners: vi.fn().mockReturnValue([]),
    listenerCount: vi.fn().mockReturnValue(0),
    prependListener: vi.fn().mockReturnThis(),
    prependOnceListener: vi.fn().mockReturnThis(),
    eventNames: vi.fn().mockReturnValue([]),
    setMaxListeners: vi.fn().mockReturnThis(),
    getMaxListeners: vi.fn().mockReturnValue(10),
  } as unknown as SettingsService;

  return mockService;
}

// ─── Test App Factory ────────────────────────────────────────────────────────

function createTestApp(settingsService?: SettingsService) {
  const service = settingsService ?? createMockSettingsService();
  const router = createSettingsRouter(service);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', router);
  return { app, service };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Integration: Settings API Routes', () => {
  // ─── GET /api/settings ─────────────────────────────────────────────────

  describe('GET /api/settings', () => {
    it('returns all settings grouped by category', async () => {
      const { app } = createTestApp();
      const res = await request(app).get('/api/settings');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('General');
      expect(res.body).toHaveProperty('Monitoring');
      expect(res.body).toHaveProperty('Alerts');
      expect(res.body).toHaveProperty('Backups');
      expect(res.body).toHaveProperty('Security');
      expect(res.body).toHaveProperty('Network');
    });

    it('returns settings with correct structure', async () => {
      const { app } = createTestApp();
      const res = await request(app).get('/api/settings');

      expect(res.status).toBe(200);
      const monitoringSettings = res.body.Monitoring;
      expect(monitoringSettings).toHaveLength(1);
      expect(monitoringSettings[0]).toEqual({
        key: 'collection_interval_ms',
        value: '30000',
        category: 'Monitoring',
        dataType: 'number',
        updatedAt: '2024-01-15T10:00:00.000Z',
        description: 'Metrics collection interval in ms',
      });
    });

    it('calls settingsService.getAll()', async () => {
      const { app, service } = createTestApp();
      await request(app).get('/api/settings');

      expect(service.getAll).toHaveBeenCalledOnce();
    });

    it('returns 500 when service throws unexpected error', async () => {
      const service = createMockSettingsService();
      (service.getAll as any).mockRejectedValue(new Error('Database connection failed'));
      const { app } = createTestApp(service);

      const res = await request(app).get('/api/settings');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Database connection failed');
    });
  });

  // ─── PUT /api/settings ─────────────────────────────────────────────────

  describe('PUT /api/settings', () => {
    it('returns 200 on successful batch update', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .put('/api/settings')
        .send({ collection_interval_ms: '60000', alert_cpu_warning: '85' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Settings updated successfully');
    });

    it('calls settingsService.update() with the provided body', async () => {
      const { app, service } = createTestApp();
      const body = { collection_interval_ms: '60000', alert_cpu_warning: '85' };

      await request(app).put('/api/settings').send(body);

      expect(service.update).toHaveBeenCalledWith(body);
    });

    it('returns 400 with validation error description on invalid values', async () => {
      const service = createMockSettingsService();
      (service.update as any).mockRejectedValue(
        new SettingsServiceError(
          'Validation failed for "collection_interval_ms": Value must be at least 1000',
          'VALIDATION_FAILED',
          400
        )
      );
      const { app } = createTestApp(service);

      const res = await request(app)
        .put('/api/settings')
        .send({ collection_interval_ms: '500' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Validation failed');
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('returns 404 for unknown setting keys', async () => {
      const service = createMockSettingsService();
      (service.update as any).mockRejectedValue(
        new SettingsServiceError(
          'Setting not found: unknown_setting',
          'SETTING_NOT_FOUND',
          404
        )
      );
      const { app } = createTestApp(service);

      const res = await request(app)
        .put('/api/settings')
        .send({ unknown_setting: 'value' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Setting not found');
      expect(res.body.code).toBe('SETTING_NOT_FOUND');
    });

    it('returns 400 when body is not an object (number)', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .put('/api/settings')
        .set('Content-Type', 'application/json')
        .send('42');

      expect(res.status).toBe(400);
    });

    it('returns 400 when body is an array', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .put('/api/settings')
        .send([{ key: 'value' }]);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('must be a JSON object');
    });

    it('returns 400 when body is empty object', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .put('/api/settings')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at least one setting');
    });

    it('returns 400 when value is not a string', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .put('/api/settings')
        .send({ collection_interval_ms: 60000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('must be a string');
      expect(res.body.field).toBe('collection_interval_ms');
    });

    it('returns 500 when service throws unexpected error', async () => {
      const service = createMockSettingsService();
      (service.update as any).mockRejectedValue(new Error('Unexpected failure'));
      const { app } = createTestApp(service);

      const res = await request(app)
        .put('/api/settings')
        .send({ collection_interval_ms: '60000' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Unexpected failure');
    });
  });
});
