/**
 * PostgreSQL Connection Manager
 *
 * Manages the connection pool to the shared `avry-postgres` instance.
 * Supports connection retries (5 attempts, 3-second intervals),
 * query execution, transactions, and health checks.
 *
 * @module database/pg-client
 */
import { Pool, PoolClient } from 'pg';

export interface PgClientConfig {
  /** PostgreSQL connection string (DATABASE_URL env var) */
  connectionString: string;
  /** Maximum number of connection retry attempts. Default: 5 */
  maxRetries: number;
  /** Delay between retry attempts in milliseconds. Default: 3000 */
  retryDelayMs: number;
}

export interface PgClient {
  /** Establish connection to PostgreSQL with retry logic */
  connect(): Promise<void>;
  /** Execute a SQL query and return typed rows */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Execute a function within a database transaction */
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Close the connection pool gracefully */
  close(): Promise<void>;
  /** Check if the database connection is healthy */
  isHealthy(): Promise<boolean>;
}

/**
 * Default configuration values for the PostgreSQL client.
 */
const DEFAULT_CONFIG: Omit<PgClientConfig, 'connectionString'> = {
  maxRetries: 5,
  retryDelayMs: 3000,
};

/**
 * Sleep utility for retry delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the PgClient configuration from environment variables and optional overrides.
 */
export function resolvePgConfig(overrides?: Partial<PgClientConfig>): PgClientConfig {
  const connectionString = overrides?.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL environment variable is not set. PostgreSQL connection cannot be established.'
    );
  }

  return {
    connectionString,
    maxRetries: overrides?.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    retryDelayMs: overrides?.retryDelayMs ?? DEFAULT_CONFIG.retryDelayMs,
  };
}

/**
 * Create a new PgClient instance backed by a connection pool.
 *
 * Usage:
 * ```typescript
 * const client = createPgClient();
 * await client.connect();
 * const rows = await client.query<{ id: string }>('SELECT id FROM users');
 * await client.close();
 * ```
 */
export function createPgClient(overrides?: Partial<PgClientConfig>): PgClient {
  const config = resolvePgConfig(overrides);
  let pool: Pool | null = null;

  return {
    async connect(): Promise<void> {
      pool = new Pool({ connectionString: config.connectionString });

      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
          // Test the connection by acquiring and releasing a client
          const client = await pool.connect();
          client.release();
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          if (attempt < config.maxRetries) {
            await sleep(config.retryDelayMs);
          }
        }
      }

      // All retries exhausted — clean up and throw
      await pool.end().catch(() => {});
      pool = null;
      throw new Error(
        `Failed to connect to PostgreSQL after ${config.maxRetries} attempts: ${lastError?.message}`
      );
    },

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (!pool) {
        throw new Error('PgClient is not connected. Call connect() first.');
      }

      const result = await pool.query(sql, params);
      return result.rows as T[];
    },

    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      if (!pool) {
        throw new Error('PgClient is not connected. Call connect() first.');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      if (pool) {
        await pool.end();
        pool = null;
      }
    },

    async isHealthy(): Promise<boolean> {
      if (!pool) {
        return false;
      }

      try {
        const result = await pool.query('SELECT 1 AS ok');
        return result.rows[0]?.ok === 1;
      } catch {
        return false;
      }
    },
  };
}
