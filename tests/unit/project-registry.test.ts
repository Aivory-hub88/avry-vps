/**
 * Unit tests for Project Registry Service
 *
 * Tests cover: CRUD operations, glob pattern matching, duplicate detection,
 * confirmation requirement on delete, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createProjectRegistry,
  globToRegex,
  ProjectRegistryError,
} from '../../src/services/project-registry.js';
import type { PgClient } from '../../src/database/pg-client.js';

function createMockDb(): PgClient {
  return {
    connect: vi.fn(),
    query: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
    isHealthy: vi.fn(),
  };
}

describe('globToRegex', () => {
  it('should match exact strings without wildcards', () => {
    const regex = globToRegex('my-container');
    expect(regex.test('my-container')).toBe(true);
    expect(regex.test('my-container-extra')).toBe(false);
    expect(regex.test('prefix-my-container')).toBe(false);
  });

  it('should match wildcard at end (prefix match)', () => {
    const regex = globToRegex('avry-*');
    expect(regex.test('avry-backend')).toBe(true);
    expect(regex.test('avry-frontend')).toBe(true);
    expect(regex.test('avry-')).toBe(true);
    expect(regex.test('other-service')).toBe(false);
  });

  it('should match wildcard at start (suffix match)', () => {
    const regex = globToRegex('*-service');
    expect(regex.test('auth-service')).toBe(true);
    expect(regex.test('api-service')).toBe(true);
    expect(regex.test('service')).toBe(false);
    expect(regex.test('auth-services')).toBe(false);
  });

  it('should match wildcard in middle', () => {
    const regex = globToRegex('avry-*-worker');
    expect(regex.test('avry-email-worker')).toBe(true);
    expect(regex.test('avry-queue-worker')).toBe(true);
    expect(regex.test('avry--worker')).toBe(true);
    expect(regex.test('avry-worker')).toBe(false);
  });

  it('should match multiple wildcards', () => {
    const regex = globToRegex('*-avry-*');
    expect(regex.test('prod-avry-backend')).toBe(true);
    expect(regex.test('-avry-')).toBe(true);
    expect(regex.test('avry-backend')).toBe(false);
  });

  it('should escape regex special characters', () => {
    const regex = globToRegex('my.container');
    expect(regex.test('my.container')).toBe(true);
    expect(regex.test('myXcontainer')).toBe(false);
  });

  it('should handle lone wildcard matching everything', () => {
    const regex = globToRegex('*');
    expect(regex.test('')).toBe(true);
    expect(regex.test('anything')).toBe(true);
    expect(regex.test('some-long-container-name')).toBe(true);
  });
});

describe('ProjectRegistry', () => {
  let db: ReturnType<typeof createMockDb>;
  let registry: ReturnType<typeof createProjectRegistry>;

  beforeEach(() => {
    db = createMockDb();
    registry = createProjectRegistry(db);
  });

  describe('create()', () => {
    it('should create a project registration', async () => {
      const mockRow = {
        id: 'avry-v2-main',
        display_name: 'AVRY V2 Main',
        patterns: ['avry-*'],
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      (db.query as any)
        .mockResolvedValueOnce([]) // existence check
        .mockResolvedValueOnce([mockRow]); // INSERT RETURNING

      const result = await registry.create({
        id: 'avry-v2-main',
        displayName: 'AVRY V2 Main',
        patterns: ['avry-*'],
      });

      expect(result).toEqual({
        id: 'avry-v2-main',
        displayName: 'AVRY V2 Main',
        patterns: ['avry-*'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
    });

    it('should throw PROJECT_EXISTS (409) on duplicate ID', async () => {
      (db.query as any).mockResolvedValueOnce([{ id: 'existing-project' }]);

      await expect(
        registry.create({
          id: 'existing-project',
          displayName: 'Duplicate',
          patterns: ['*'],
        })
      ).rejects.toThrow(ProjectRegistryError);

      try {
        (db.query as any).mockResolvedValueOnce([{ id: 'existing-project' }]);
        await registry.create({
          id: 'existing-project',
          displayName: 'Duplicate',
          patterns: ['*'],
        });
      } catch (err) {
        const error = err as ProjectRegistryError;
        expect(error.code).toBe('PROJECT_EXISTS');
        expect(error.statusCode).toBe(409);
      }
    });
  });

  describe('update()', () => {
    it('should update display name', async () => {
      const updatedRow = {
        id: 'my-project',
        display_name: 'New Name',
        patterns: ['app-*'],
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      };

      (db.query as any)
        .mockResolvedValueOnce([{ id: 'my-project' }]) // existence check
        .mockResolvedValueOnce([updatedRow]); // UPDATE RETURNING

      const result = await registry.update('my-project', { displayName: 'New Name' });

      expect(result.displayName).toBe('New Name');
    });

    it('should update patterns', async () => {
      const updatedRow = {
        id: 'my-project',
        display_name: 'My Project',
        patterns: ['new-*', 'specific-container'],
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      };

      (db.query as any)
        .mockResolvedValueOnce([{ id: 'my-project' }])
        .mockResolvedValueOnce([updatedRow]);

      const result = await registry.update('my-project', {
        patterns: ['new-*', 'specific-container'],
      });

      expect(result.patterns).toEqual(['new-*', 'specific-container']);
    });

    it('should throw PROJECT_NOT_FOUND (404) when project does not exist', async () => {
      (db.query as any).mockResolvedValueOnce([]); // existence check returns nothing

      try {
        await registry.update('nonexistent', { displayName: 'Test' });
      } catch (err) {
        const error = err as ProjectRegistryError;
        expect(error.code).toBe('PROJECT_NOT_FOUND');
        expect(error.statusCode).toBe(404);
      }
    });
  });

  describe('delete()', () => {
    it('should delete a project when confirmation is true', async () => {
      (db.query as any).mockResolvedValueOnce([{ id: 'my-project' }]);

      await registry.delete('my-project', true);

      expect(db.query).toHaveBeenCalledWith(
        'DELETE FROM vps_panel.project_registry WHERE id = $1 RETURNING id',
        ['my-project']
      );
    });

    it('should reject deletion when confirmation is false', async () => {
      try {
        await registry.delete('my-project', false);
      } catch (err) {
        const error = err as ProjectRegistryError;
        expect(error.code).toBe('CONFIRMATION_REQUIRED');
        expect(error.statusCode).toBe(400);
      }
    });

    it('should throw PROJECT_NOT_FOUND when deleting non-existent project', async () => {
      (db.query as any).mockResolvedValueOnce([]); // DELETE RETURNING returns nothing

      try {
        await registry.delete('nonexistent', true);
      } catch (err) {
        const error = err as ProjectRegistryError;
        expect(error.code).toBe('PROJECT_NOT_FOUND');
        expect(error.statusCode).toBe(404);
      }
    });
  });

  describe('get()', () => {
    it('should return a project registration', async () => {
      const mockRow = {
        id: 'my-project',
        display_name: 'My Project',
        patterns: ['my-*'],
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      (db.query as any).mockResolvedValueOnce([mockRow]);

      const result = await registry.get('my-project');

      expect(result).toEqual({
        id: 'my-project',
        displayName: 'My Project',
        patterns: ['my-*'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
    });

    it('should return null when project does not exist', async () => {
      (db.query as any).mockResolvedValueOnce([]);

      const result = await registry.get('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('list()', () => {
    it('should return all project registrations', async () => {
      const rows = [
        {
          id: 'project-a',
          display_name: 'Project A',
          patterns: ['a-*'],
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'project-b',
          display_name: 'Project B',
          patterns: ['b-*'],
          created_at: '2024-01-02T00:00:00.000Z',
          updated_at: '2024-01-02T00:00:00.000Z',
        },
      ];

      (db.query as any).mockResolvedValueOnce(rows);

      const result = await registry.list();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('project-a');
      expect(result[1].id).toBe('project-b');
    });

    it('should return empty array when no projects exist', async () => {
      (db.query as any).mockResolvedValueOnce([]);

      const result = await registry.list();

      expect(result).toEqual([]);
    });
  });

  describe('matchContainers()', () => {
    it('should match containers using glob patterns', async () => {
      (db.query as any).mockResolvedValueOnce([
        { patterns: ['avry-*', 'specific-container'] },
      ]);

      const containers = [
        'avry-backend',
        'avry-frontend',
        'specific-container',
        'other-service',
        'postgres',
      ];

      const matched = await registry.matchContainers('avry-v2-main', containers);

      expect(matched).toEqual(['avry-backend', 'avry-frontend', 'specific-container']);
    });

    it('should return empty array when no containers match', async () => {
      (db.query as any).mockResolvedValueOnce([{ patterns: ['xyz-*'] }]);

      const matched = await registry.matchContainers('project', [
        'abc-service',
        'def-worker',
      ]);

      expect(matched).toEqual([]);
    });

    it('should throw PROJECT_NOT_FOUND when project does not exist', async () => {
      (db.query as any).mockResolvedValueOnce([]);

      try {
        await registry.matchContainers('nonexistent', ['container-a']);
      } catch (err) {
        const error = err as ProjectRegistryError;
        expect(error.code).toBe('PROJECT_NOT_FOUND');
        expect(error.statusCode).toBe(404);
      }
    });

    it('should handle exact name patterns (no wildcard)', async () => {
      (db.query as any).mockResolvedValueOnce([
        { patterns: ['exact-name'] },
      ]);

      const matched = await registry.matchContainers('project', [
        'exact-name',
        'exact-name-extra',
        'prefix-exact-name',
      ]);

      expect(matched).toEqual(['exact-name']);
    });

    it('should return empty array when project has empty patterns array', async () => {
      (db.query as any).mockResolvedValueOnce([{ patterns: [] }]);

      const matched = await registry.matchContainers('project', [
        'container-a',
        'container-b',
        'anything',
      ]);

      expect(matched).toEqual([]);
    });
  });
});
