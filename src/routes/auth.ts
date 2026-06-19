/**
 * Auth Routes
 *
 * Handles login and logout.
 * Login is publicly accessible; logout requires authentication.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthModule } from '../modules/auth.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createAuthRouter(authModule: AuthModule, auditLogger: AuditLogger): Router {
  const router = Router();

  /**
   * POST /api/auth/login
   * Public — authenticates user and returns session token.
   */
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

      if (!username || !password) {
        res.status(400).json({ error: 'Username and password are required' });
        return;
      }

      // Check rate limiting
      if (authModule.isRateLimited(ip)) {
        res.status(429).json({
          error: 'Too many failed attempts. Please try again later.',
        });
        return;
      }

      const session = await authModule.login(username, password, ip);

      // Record successful login (resets rate limit counter)
      authModule.recordSuccessfulLogin(ip);

      await auditLogger.log({
        actor: username,
        actionType: 'auth.login',
        targetResource: 'session',
        details: { sessionId: session.id },
        sourceIp: ip,
        result: 'success',
      });

      // Return the JWT token for session validation
      const jwtToken = authModule.getToken(session.id);

      res.json({
        token: jwtToken ?? session.id,
        username: session.username,
        expiresAt: new Date(session.lastActivity.getTime() + 30 * 60 * 1000).toISOString(),
      });
    } catch (error: any) {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const username = req.body?.username ?? 'unknown';

      // Record failed login attempt for rate limiting
      authModule.recordFailedAttempt(ip);

      await auditLogger.log({
        actor: username,
        actionType: 'auth.login',
        targetResource: 'session',
        details: { error: error.message },
        sourceIp: ip,
        result: 'failure',
      });

      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  /**
   * GET /api/auth/session
   * Protected — validates the current session token and returns session info.
   * Used by the frontend on page load to verify the stored token is still valid.
   */
  router.get('/session', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.status(401).json({ error: 'No token provided' });
        return;
      }

      const token = authHeader.replace('Bearer ', '');
      const session = authModule.validateSession(token);

      if (!session) {
        res.status(401).json({ error: 'Invalid or expired session' });
        return;
      }

      res.json({
        session: {
          id: session.id,
          username: session.username,
          createdAt: session.createdAt.toISOString(),
          lastActivity: session.lastActivity.toISOString(),
        },
      });
    } catch (error: any) {
      res.status(401).json({ error: 'Session validation failed' });
    }
  });

  /**
   * POST /api/auth/logout
   * Protected — invalidates the current session.
   */
  router.post('/logout', async (req: Request, res: Response) => {
    try {
      const session = req.session;
      if (!session) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      authModule.logout(session.id);

      await auditLogger.log({
        actor: session.username,
        actionType: 'auth.logout',
        targetResource: 'session',
        details: { sessionId: session.id },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Logged out successfully' });
    } catch (error: any) {
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  return router;
}
