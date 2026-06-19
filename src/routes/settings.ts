/**
 * Settings Routes
 *
 * Endpoints for managing panel settings:
 * - GET /api/settings — returns all settings grouped by category
 * - PUT /api/settings — batch update settings by key-value pairs
 *
 * All endpoints require admin authentication (session-based).
 *
 * @module routes/settings
 * @validates Requirements 6.3, 6.4, 6.5, 6.6
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SettingsService } from '../services/settings-service.js';
import { SettingsServiceError } from '../services/settings-service.js';

/**
 * Create the settings API router.
 *
 * @param settingsService - The settings service instance
 */
export function createSettingsRouter(settingsService: SettingsService): Router {
  const router = Router();

  /**
   * GET /api/settings
   * Returns all settings grouped by category.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const settings = await settingsService.getAll();
      res.json(settings);
    } catch (error: any) {
      res.status(500).json({ error: error.message ?? 'Internal server error' });
    }
  });

  /**
   * PUT /api/settings
   * Batch update settings.
   * Body: { "key1": "value1", "key2": "value2", ... }
   * Returns 200 on success, 400 on validation error, 404 on unknown key.
   */
  router.put('/', async (req: Request, res: Response) => {
    try {
      const updates = req.body;

      // Validate body is a non-null object with at least one key
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        res.status(400).json({ error: 'Request body must be a JSON object with key-value pairs' });
        return;
      }

      const keys = Object.keys(updates);
      if (keys.length === 0) {
        res.status(400).json({ error: 'Request body must contain at least one setting to update' });
        return;
      }

      // Ensure all values are strings
      for (const key of keys) {
        if (typeof updates[key] !== 'string') {
          res.status(400).json({
            error: `Value for "${key}" must be a string`,
            field: key,
          });
          return;
        }
      }

      await settingsService.update(updates);
      res.json({ message: 'Settings updated successfully' });
    } catch (error: any) {
      if (error instanceof SettingsServiceError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      res.status(500).json({ error: error.message ?? 'Internal server error' });
    }
  });

  return router;
}
