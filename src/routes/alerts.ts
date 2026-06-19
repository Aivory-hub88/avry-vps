/**
 * Alert Routes
 *
 * Endpoints for alert system management:
 * configure channels, configure rules, history, acknowledgment, silencing.
 *
 * @validates Requirements 11.2, 11.3, 11.4
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AlertSystem } from '../modules/alert-system.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createAlertsRouter(
  alertSystem: AlertSystem,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/alerts
   * Return alert history (for dashboard compatibility).
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const history = await alertSystem.getAlertHistory();
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/alerts/channels
   * List configured alert channels.
   */
  router.get('/channels', async (req: Request, res: Response) => {
    try {
      const channels = alertSystem.getChannels();
      res.json(channels);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/alerts/channels
   * Configure or update an alert channel.
   */
  router.post('/channels', async (req: Request, res: Response) => {
    try {
      const channelId = await alertSystem.configureChannel(req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.configure-channel',
        targetResource: `alert-channel:${channelId}`,
        details: { type: req.body.type },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ id: channelId, message: 'Channel configured' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.configure-channel',
        targetResource: 'alert-channel',
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/alerts/channels/:id
   * Remove an alert channel.
   */
  router.delete('/channels/:id', async (req: Request, res: Response) => {
    try {
      alertSystem.removeChannel(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.remove-channel',
        targetResource: `alert-channel:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Channel removed' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.remove-channel',
        targetResource: `alert-channel:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/alerts/rules
   * List configured alert rules.
   */
  router.get('/rules', async (req: Request, res: Response) => {
    try {
      const rules = alertSystem.getRules();
      res.json(rules);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/alerts/rules
   * Configure or update an alert rule.
   */
  router.post('/rules', async (req: Request, res: Response) => {
    try {
      const ruleId = await alertSystem.configureRule(req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.configure-rule',
        targetResource: `alert-rule:${ruleId}`,
        details: { resourceType: req.body.resourceType, threshold: req.body.threshold },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ id: ruleId, message: 'Rule configured' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.configure-rule',
        targetResource: 'alert-rule',
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/alerts/rules/:id
   * Remove an alert rule.
   */
  router.delete('/rules/:id', async (req: Request, res: Response) => {
    try {
      alertSystem.removeRule(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.remove-rule',
        targetResource: `alert-rule:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Rule removed' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.remove-rule',
        targetResource: `alert-rule:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/alerts/history
   * Get paginated alert history.
   * Query params: page (default 1), pageSize (default 20)
   * @validates Requirements 11.2
   */
  router.get('/history', async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const parsedPageSize = parseInt(req.query.pageSize as string, 10);
      const pageSize = Math.min(100, Math.max(1, Number.isNaN(parsedPageSize) ? 20 : parsedPageSize));

      const result = await alertSystem.getAlertHistoryPaginated(page, pageSize);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/alerts/:id/acknowledge
   * Acknowledge an alert by ID.
   * Body: { adminId: string }
   * @validates Requirements 11.3
   */
  router.post('/:id/acknowledge', async (req: Request, res: Response) => {
    try {
      const alertId = req.params.id;
      const { adminId } = req.body;

      if (!adminId || typeof adminId !== 'string') {
        res.status(400).json({ error: 'adminId is required and must be a string' });
        return;
      }

      await alertSystem.acknowledgeAlert(alertId, adminId);

      await auditLogger.log({
        actor: req.session?.username ?? adminId,
        actionType: 'alert.acknowledge',
        targetResource: `alert:${alertId}`,
        details: { adminId },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Alert acknowledged', id: alertId });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.acknowledge',
        targetResource: `alert:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/alerts/rules/:id/silence
   * Silence an alert rule for a specified duration.
   * Body: { durationMs: number, adminId: string }
   * @validates Requirements 11.4
   */
  router.post('/rules/:id/silence', async (req: Request, res: Response) => {
    try {
      const ruleId = req.params.id;
      const { durationMs, adminId } = req.body;

      if (!adminId || typeof adminId !== 'string') {
        res.status(400).json({ error: 'adminId is required and must be a string' });
        return;
      }

      if (durationMs === undefined || typeof durationMs !== 'number' || durationMs <= 0) {
        res.status(400).json({ error: 'durationMs is required and must be a positive number' });
        return;
      }

      const silenceId = await alertSystem.silenceRule(ruleId, durationMs, adminId);

      await auditLogger.log({
        actor: req.session?.username ?? adminId,
        actionType: 'alert.silence-rule',
        targetResource: `alert-rule:${ruleId}`,
        details: { durationMs, silenceId },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Rule silenced', silenceId, ruleId });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.silence-rule',
        targetResource: `alert-rule:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/alerts/silences/:id
   * Remove an active silence by ID.
   * @validates Requirements 11.4
   */
  router.delete('/silences/:id', async (req: Request, res: Response) => {
    try {
      const silenceId = req.params.id;

      await alertSystem.removeSilence(silenceId);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.remove-silence',
        targetResource: `alert-silence:${silenceId}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Silence removed', id: silenceId });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'alert.remove-silence',
        targetResource: `alert-silence:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
