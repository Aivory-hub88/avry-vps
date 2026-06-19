/**
 * Integration Tests: Alert API Routes
 *
 * Tests the full request/response flow through the alerts Express router
 * with mocked AlertSystem and AuditLogger dependencies. Verifies:
 * - GET /api/alerts/history returns paginated alert records
 * - POST /api/alerts/:id/acknowledge acknowledges an alert
 * - POST /api/alerts/rules/:id/silence silences a rule
 * - DELETE /api/alerts/silences/:id removes a silence
 *
 * Requirements: 11.2, 11.3, 11.4
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAlertsRouter } from '../../src/routes/alerts.js';
import type { AlertSystem, AlertRecord, PaginatedAlerts } from '../../src/modules/alert-system.js';
import type { AuditLogger } from '../../src/modules/audit-logger.js';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockAuditLogger(): AuditLogger {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({}),
    exportCsv: vi.fn().mockResolvedValue(''),
  } as unknown as AuditLogger;
}

function createMockAlertRecord(overrides?: Partial<AlertRecord>): AlertRecord {
  return {
    id: 'alert-001',
    timestamp: '2024-01-15T10:00:00.000Z',
    eventType: 'threshold_breach',
    affectedResource: 'system',
    severity: 'high',
    deliveryStatus: { webhook: 'delivered' },
    message: 'CPU usage exceeded 80%',
    resolutionStatus: 'active',
    ...overrides,
  };
}

function createMockAlertSystem(): AlertSystem {
  const paginatedResult: PaginatedAlerts = {
    items: [createMockAlertRecord()],
    total: 1,
    page: 1,
    pageSize: 20,
  };

  return {
    configureChannel: vi.fn().mockResolvedValue('channel-1'),
    configureRule: vi.fn().mockResolvedValue('rule-1'),
    emitAlert: vi.fn().mockResolvedValue('alert-1'),
    getAlertHistory: vi.fn().mockResolvedValue([createMockAlertRecord()]),
    getAlertHistoryPaginated: vi.fn().mockResolvedValue(paginatedResult),
    recordMetric: vi.fn().mockResolvedValue(undefined),
    getChannels: vi.fn().mockReturnValue([]),
    getRules: vi.fn().mockReturnValue([]),
    removeChannel: vi.fn(),
    removeRule: vi.fn(),
    evaluateThreshold: vi.fn().mockResolvedValue({ alertEmitted: false, resolved: false, consecutiveBreaches: 0 }),
    getBreachCount: vi.fn().mockReturnValue(0),
    getActiveThresholdAlerts: vi.fn().mockReturnValue([]),
    recordHealthTransition: vi.fn().mockResolvedValue(undefined),
    acknowledgeAlert: vi.fn().mockResolvedValue(undefined),
    silenceRule: vi.fn().mockResolvedValue('silence-001'),
    removeSilence: vi.fn().mockResolvedValue(undefined),
    getActiveSilences: vi.fn().mockResolvedValue([]),
    resolveAlert: vi.fn().mockResolvedValue(undefined),
  } as unknown as AlertSystem;
}

// ─── Test App Factory ────────────────────────────────────────────────────────

function createTestApp(alertSystem?: AlertSystem, auditLogger?: AuditLogger) {
  const system = alertSystem ?? createMockAlertSystem();
  const logger = auditLogger ?? createMockAuditLogger();
  const router = createAlertsRouter(system, logger);
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', router);
  return { app, alertSystem: system, auditLogger: logger };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Integration: Alert API Routes', () => {
  // ─── GET /api/alerts/history ───────────────────────────────────────────

  describe('GET /api/alerts/history', () => {
    it('returns paginated alert history with default params', async () => {
      const { app } = createTestApp();
      const res = await request(app).get('/api/alerts/history');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('pageSize');
      expect(res.body.items).toHaveLength(1);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(20);
    });

    it('passes page and pageSize to the alert system', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app).get('/api/alerts/history?page=3&pageSize=10');

      expect(alertSystem.getAlertHistoryPaginated).toHaveBeenCalledWith(3, 10);
    });

    it('defaults page to 1 when not provided', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app).get('/api/alerts/history?pageSize=15');

      expect(alertSystem.getAlertHistoryPaginated).toHaveBeenCalledWith(1, 15);
    });

    it('defaults pageSize to 20 when not provided', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app).get('/api/alerts/history?page=2');

      expect(alertSystem.getAlertHistoryPaginated).toHaveBeenCalledWith(2, 20);
    });

    it('clamps page to minimum of 1', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app).get('/api/alerts/history?page=0');

      expect(alertSystem.getAlertHistoryPaginated).toHaveBeenCalledWith(1, 20);
    });

    it('clamps pageSize to maximum of 100', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app).get('/api/alerts/history?pageSize=500');

      expect(alertSystem.getAlertHistoryPaginated).toHaveBeenCalledWith(1, 100);
    });

    it('clamps pageSize to minimum of 1', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app).get('/api/alerts/history?pageSize=0');

      expect(alertSystem.getAlertHistoryPaginated).toHaveBeenCalledWith(1, 1);
    });

    it('returns 500 when alert system throws an error', async () => {
      const system = createMockAlertSystem();
      (system.getAlertHistoryPaginated as any).mockRejectedValue(new Error('Database error'));
      const { app } = createTestApp(system);

      const res = await request(app).get('/api/alerts/history');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Database error');
    });
  });

  // ─── POST /api/alerts/:id/acknowledge ──────────────────────────────────

  describe('POST /api/alerts/:id/acknowledge', () => {
    it('acknowledges an alert and returns success', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/alerts/alert-001/acknowledge')
        .send({ adminId: 'admin-user' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Alert acknowledged');
      expect(res.body.id).toBe('alert-001');
    });

    it('calls alertSystem.acknowledgeAlert with correct params', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app)
        .post('/api/alerts/alert-001/acknowledge')
        .send({ adminId: 'admin-user' });

      expect(alertSystem.acknowledgeAlert).toHaveBeenCalledWith('alert-001', 'admin-user');
    });

    it('logs an audit entry on success', async () => {
      const { app, auditLogger } = createTestApp();
      await request(app)
        .post('/api/alerts/alert-001/acknowledge')
        .send({ adminId: 'admin-user' });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'alert.acknowledge',
          targetResource: 'alert:alert-001',
          result: 'success',
        })
      );
    });

    it('returns 400 when adminId is missing', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/alerts/alert-001/acknowledge')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('adminId');
    });

    it('returns 400 when adminId is not a string', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/alerts/alert-001/acknowledge')
        .send({ adminId: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('adminId');
    });

    it('returns 500 when alert system throws an error', async () => {
      const system = createMockAlertSystem();
      (system.acknowledgeAlert as any).mockRejectedValue(new Error('Alert not found'));
      const { app } = createTestApp(system);

      const res = await request(app)
        .post('/api/alerts/alert-001/acknowledge')
        .send({ adminId: 'admin-user' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Alert not found');
    });

    it('logs an audit entry on failure', async () => {
      const system = createMockAlertSystem();
      (system.acknowledgeAlert as any).mockRejectedValue(new Error('Alert not found'));
      const { app, auditLogger } = createTestApp(system);

      await request(app)
        .post('/api/alerts/alert-001/acknowledge')
        .send({ adminId: 'admin-user' });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'alert.acknowledge',
          result: 'failure',
        })
      );
    });
  });

  // ─── POST /api/alerts/rules/:id/silence ────────────────────────────────

  describe('POST /api/alerts/rules/:id/silence', () => {
    it('silences a rule and returns the silence ID', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ durationMs: 3600000, adminId: 'admin-user' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Rule silenced');
      expect(res.body.silenceId).toBe('silence-001');
      expect(res.body.ruleId).toBe('rule-001');
    });

    it('calls alertSystem.silenceRule with correct params', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ durationMs: 3600000, adminId: 'admin-user' });

      expect(alertSystem.silenceRule).toHaveBeenCalledWith('rule-001', 3600000, 'admin-user');
    });

    it('logs an audit entry on success', async () => {
      const { app, auditLogger } = createTestApp();
      await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ durationMs: 3600000, adminId: 'admin-user' });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'alert.silence-rule',
          targetResource: 'alert-rule:rule-001',
          result: 'success',
        })
      );
    });

    it('returns 400 when adminId is missing', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ durationMs: 3600000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('adminId');
    });

    it('returns 400 when durationMs is missing', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ adminId: 'admin-user' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('durationMs');
    });

    it('returns 400 when durationMs is not a number', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ durationMs: 'invalid', adminId: 'admin-user' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('durationMs');
    });

    it('returns 400 when durationMs is zero or negative', async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ durationMs: 0, adminId: 'admin-user' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('durationMs');
    });

    it('returns 500 when alert system throws an error', async () => {
      const system = createMockAlertSystem();
      (system.silenceRule as any).mockRejectedValue(new Error('Rule not found'));
      const { app } = createTestApp(system);

      const res = await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ durationMs: 3600000, adminId: 'admin-user' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Rule not found');
    });

    it('logs an audit entry on failure', async () => {
      const system = createMockAlertSystem();
      (system.silenceRule as any).mockRejectedValue(new Error('Rule not found'));
      const { app, auditLogger } = createTestApp(system);

      await request(app)
        .post('/api/alerts/rules/rule-001/silence')
        .send({ durationMs: 3600000, adminId: 'admin-user' });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'alert.silence-rule',
          result: 'failure',
        })
      );
    });
  });

  // ─── DELETE /api/alerts/silences/:id ───────────────────────────────────

  describe('DELETE /api/alerts/silences/:id', () => {
    it('removes a silence and returns success', async () => {
      const { app } = createTestApp();
      const res = await request(app).delete('/api/alerts/silences/silence-001');

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Silence removed');
      expect(res.body.id).toBe('silence-001');
    });

    it('calls alertSystem.removeSilence with the correct ID', async () => {
      const { app, alertSystem } = createTestApp();
      await request(app).delete('/api/alerts/silences/silence-001');

      expect(alertSystem.removeSilence).toHaveBeenCalledWith('silence-001');
    });

    it('logs an audit entry on success', async () => {
      const { app, auditLogger } = createTestApp();
      await request(app).delete('/api/alerts/silences/silence-001');

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'alert.remove-silence',
          targetResource: 'alert-silence:silence-001',
          result: 'success',
        })
      );
    });

    it('returns 500 when alert system throws an error', async () => {
      const system = createMockAlertSystem();
      (system.removeSilence as any).mockRejectedValue(new Error('Silence not found'));
      const { app } = createTestApp(system);

      const res = await request(app).delete('/api/alerts/silences/silence-001');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Silence not found');
    });

    it('logs an audit entry on failure', async () => {
      const system = createMockAlertSystem();
      (system.removeSilence as any).mockRejectedValue(new Error('Silence not found'));
      const { app, auditLogger } = createTestApp(system);

      await request(app).delete('/api/alerts/silences/silence-001');

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'alert.remove-silence',
          result: 'failure',
        })
      );
    });
  });
});
