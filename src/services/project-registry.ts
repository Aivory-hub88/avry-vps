/**
 * Project Registry Service
 *
 * Manages project-to-container mappings stored in the `vps_panel.project_registry` table.
 * Supports CRUD operations and glob-style pattern matching for container names.
 *
 * @module services/project-registry
 */
import { PgClient } from '../database/pg-client.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectRegistration {
  id: string;
  displayName: string;
  patterns: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  id: string;
  displayName: string;
  patterns: string[];
}

export interface UpdateProjectInput {
  displayName?: string;
  patterns?: string[];
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ProjectRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'ProjectRegistryError';
  }
}

// ─── Database row shape ──────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  display_name: string;
  patterns: string[];
  created_at: string;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a database row into a ProjectRegistration domain object.
 */
function rowToProject(row: ProjectRow): ProjectRegistration {
  return {
    id: row.id,
    displayName: row.display_name,
    patterns: row.patterns,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert a glob pattern (with `*` wildcard) into a RegExp.
 * `*` matches any sequence of characters.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`);
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface ProjectRegistry {
  create(input: CreateProjectInput): Promise<ProjectRegistration>;
  update(projectId: string, input: UpdateProjectInput): Promise<ProjectRegistration>;
  delete(projectId: string, confirmation: boolean): Promise<void>;
  get(projectId: string): Promise<ProjectRegistration | null>;
  list(): Promise<ProjectRegistration[]>;
  matchContainers(projectId: string, containerNames: string[]): Promise<string[]>;
}

export function createProjectRegistry(db: PgClient): ProjectRegistry {
  return {
    async create(input: CreateProjectInput): Promise<ProjectRegistration> {
      // Check for duplicate
      const existing = await db.query<ProjectRow>(
        'SELECT id FROM vps_panel.project_registry WHERE id = $1',
        [input.id]
      );

      if (existing.length > 0) {
        throw new ProjectRegistryError(
          `Project with identifier "${input.id}" is already registered`,
          'PROJECT_EXISTS',
          409
        );
      }

      const rows = await db.query<ProjectRow>(
        `INSERT INTO vps_panel.project_registry (id, display_name, patterns)
         VALUES ($1, $2, $3)
         RETURNING id, display_name, patterns, created_at, updated_at`,
        [input.id, input.displayName, JSON.stringify(input.patterns)]
      );

      return rowToProject(rows[0]);
    },

    async update(projectId: string, input: UpdateProjectInput): Promise<ProjectRegistration> {
      // Verify project exists
      const existing = await db.query<ProjectRow>(
        'SELECT id FROM vps_panel.project_registry WHERE id = $1',
        [projectId]
      );

      if (existing.length === 0) {
        throw new ProjectRegistryError(
          `Project "${projectId}" not found`,
          'PROJECT_NOT_FOUND',
          404
        );
      }

      // Build dynamic SET clause
      const setClauses: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (input.displayName !== undefined) {
        setClauses.push(`display_name = $${paramIndex}`);
        params.push(input.displayName);
        paramIndex++;
      }

      if (input.patterns !== undefined) {
        setClauses.push(`patterns = $${paramIndex}`);
        params.push(JSON.stringify(input.patterns));
        paramIndex++;
      }

      params.push(projectId);

      const rows = await db.query<ProjectRow>(
        `UPDATE vps_panel.project_registry
         SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, display_name, patterns, created_at, updated_at`,
        params
      );

      return rowToProject(rows[0]);
    },

    async delete(projectId: string, confirmation: boolean): Promise<void> {
      if (!confirmation) {
        throw new ProjectRegistryError(
          'Deletion requires confirmation. Set confirmation to true to proceed.',
          'CONFIRMATION_REQUIRED',
          400
        );
      }

      const result = await db.query<ProjectRow>(
        'DELETE FROM vps_panel.project_registry WHERE id = $1 RETURNING id',
        [projectId]
      );

      if (result.length === 0) {
        throw new ProjectRegistryError(
          `Project "${projectId}" not found`,
          'PROJECT_NOT_FOUND',
          404
        );
      }
    },

    async get(projectId: string): Promise<ProjectRegistration | null> {
      const rows = await db.query<ProjectRow>(
        'SELECT id, display_name, patterns, created_at, updated_at FROM vps_panel.project_registry WHERE id = $1',
        [projectId]
      );

      if (rows.length === 0) {
        return null;
      }

      return rowToProject(rows[0]);
    },

    async list(): Promise<ProjectRegistration[]> {
      const rows = await db.query<ProjectRow>(
        'SELECT id, display_name, patterns, created_at, updated_at FROM vps_panel.project_registry ORDER BY created_at ASC'
      );

      return rows.map(rowToProject);
    },

    async matchContainers(projectId: string, containerNames: string[]): Promise<string[]> {
      const project = await db.query<ProjectRow>(
        'SELECT patterns FROM vps_panel.project_registry WHERE id = $1',
        [projectId]
      );

      if (project.length === 0) {
        throw new ProjectRegistryError(
          `Project "${projectId}" not found`,
          'PROJECT_NOT_FOUND',
          404
        );
      }

      const patterns = project[0].patterns;
      const regexes = patterns.map(globToRegex);

      return containerNames.filter((name) =>
        regexes.some((regex) => regex.test(name))
      );
    },
  };
}
