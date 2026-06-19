/**
 * Unit tests for the PostgreSQL Connection Manager (pg-client.ts)
 *
 * Tests cover: configuration resolution, connection retry behavior,
 * query/transaction/health check methods, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPgClient, resolvePgConfig } from '../../src/database/pg-client.js';

// Mock the 'pg' module
vi.mock('pg', () => {
  const mockRelease = vi.fn();
  const mockQuery = vi.fn();
  const mockConnect = vi.fn();
  const mockEnd = vi.fn();

  const MockPool = vi.fn(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
  }));

  return {
    Pool: MockPool,
    __mockConnect: mockConnect,
    __mockQuery: mockQuery,
    __mockEnd: mockEnd,
    __mockRelease: mockRelease,
    __MockPool: MockPool,
  };
});

// Access mocked internals
async function getMocks() {
  const pgModule = await import('pg') as any;
  return {
    MockPool: pgModule.__MockPool,
    mockConnect: pgModule.__mockConnect,
    mockQuery: pgModule.__mockQuery,
    mockEnd: pgModule.__mockEnd,
    mockRelease: pgModule.__mockRelease,
  };
}

describe('resolvePgConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should resolve config from DATABASE_URL environment variable', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb';

    const config = resolvePgConfig();

    expect(config.connectionString).toBe('postgresql://user:pass@localhost:5432/testdb');
    expect(config.maxRetries).toBe(5);
    expect(config.retryDelayMs).toBe(3000);
  });

  it('should throw if DATABASE_URL is not set and no override provided', () => {
    delete process.env.DATABASE_URL;

    expect(() => resolvePgConfig()).toThrow(
      'DATABASE_URL environment variable is not set'
    );
  });

  it('should use overrides when provided', () => {
    const config = resolvePgConfig({
      connectionString: 'postgresql://override@host/db',
      maxRetries: 3,
      retryDelayMs: 1000,
    });

    expect(config.connectionString).toBe('postgresql://override@host/db');
    expect(config.maxRetries).toBe(3);
    expect(config.retryDelayMs).toBe(1000);
  });

  it('should use override connectionString over environment variable', () => {
    process.env.DATABASE_URL = 'postgresql://env@host/db';

    const config = resolvePgConfig({
      connectionString: 'postgresql://override@host/db',
    });

    expect(config.connectionString).toBe('postgresql://override@host/db');
  });

  it('should use default retry values when not overridden', () => {
    const config = resolvePgConfig({
      connectionString: 'postgresql://test@host/db',
    });

    expect(config.maxRetries).toBe(5);
    expect(config.retryDelayMs).toBe(3000);
  });
});

describe('createPgClient', () => {
  let mocks: Awaited<ReturnType<typeof getMocks>>;

  beforeEach(async () => {
    mocks = await getMocks();
    vi.clearAllMocks();
  });

  describe('connect()', () => {
    it('should connect successfully on first attempt', async () => {
      const mockClient = { release: mocks.mockRelease };
      mocks.mockConnect.mockResolvedValueOnce(mockClient);

      const client = createPgClient({ connectionString: 'postgresql://test@host/db' });
      await client.connect();

      expect(mocks.mockConnect).toHaveBeenCalledTimes(1);
      expect(mocks.mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should retry on connection failure and succeed', async () => {
      const mockClient = { release: mocks.mockRelease };
      mocks.mockConnect
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce(mockClient);

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        retryDelayMs: 10, // Fast retries for testing
      });
      await client.connect();

      expect(mocks.mockConnect).toHaveBeenCalledTimes(3);
      expect(mocks.mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should throw after exhausting all retry attempts', async () => {
      mocks.mockConnect.mockRejectedValue(new Error('Connection refused'));
      mocks.mockEnd.mockResolvedValue(undefined);

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        maxRetries: 3,
        retryDelayMs: 10,
      });

      await expect(client.connect()).rejects.toThrow(
        'Failed to connect to PostgreSQL after 3 attempts: Connection refused'
      );
      expect(mocks.mockConnect).toHaveBeenCalledTimes(3);
    });

    it('should clean up pool after all retries fail', async () => {
      mocks.mockConnect.mockRejectedValue(new Error('Connection refused'));
      mocks.mockEnd.mockResolvedValue(undefined);

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        maxRetries: 2,
        retryDelayMs: 10,
      });

      await expect(client.connect()).rejects.toThrow();
      expect(mocks.mockEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe('query()', () => {
    it('should throw if not connected', async () => {
      const client = createPgClient({ connectionString: 'postgresql://test@host/db' });

      await expect(client.query('SELECT 1')).rejects.toThrow(
        'PgClient is not connected. Call connect() first.'
      );
    });

    it('should execute a query and return rows', async () => {
      const mockClient = { release: mocks.mockRelease };
      mocks.mockConnect.mockResolvedValueOnce(mockClient);
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', name: 'test' }],
      });

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        retryDelayMs: 10,
      });
      await client.connect();

      const results = await client.query<{ id: string; name: string }>('SELECT * FROM test');
      expect(results).toEqual([{ id: '1', name: 'test' }]);
    });

    it('should pass parameters to the query', async () => {
      const mockClient = { release: mocks.mockRelease };
      mocks.mockConnect.mockResolvedValueOnce(mockClient);
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        retryDelayMs: 10,
      });
      await client.connect();

      await client.query('SELECT * FROM test WHERE id = $1', ['123']);
      expect(mocks.mockQuery).toHaveBeenCalledWith('SELECT * FROM test WHERE id = $1', ['123']);
    });
  });

  describe('transaction()', () => {
    it('should throw if not connected', async () => {
      const client = createPgClient({ connectionString: 'postgresql://test@host/db' });

      await expect(client.transaction(async () => 'result')).rejects.toThrow(
        'PgClient is not connected. Call connect() first.'
      );
    });

    it('should execute BEGIN, function, and COMMIT on success', async () => {
      const txClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      // First connect call for pool.connect() in connect()
      mocks.mockConnect.mockResolvedValueOnce({ release: mocks.mockRelease });
      // Second connect call for pool.connect() in transaction()
      mocks.mockConnect.mockResolvedValueOnce(txClient);

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        retryDelayMs: 10,
      });
      await client.connect();

      const result = await client.transaction(async (c) => {
        await c.query('INSERT INTO test VALUES ($1)', ['hello']);
        return 'done';
      });

      expect(result).toBe('done');
      expect(txClient.query).toHaveBeenCalledWith('BEGIN');
      expect(txClient.query).toHaveBeenCalledWith('INSERT INTO test VALUES ($1)', ['hello']);
      expect(txClient.query).toHaveBeenCalledWith('COMMIT');
      expect(txClient.release).toHaveBeenCalled();
    });

    it('should ROLLBACK on error and release client', async () => {
      const txClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      mocks.mockConnect.mockResolvedValueOnce({ release: mocks.mockRelease });
      mocks.mockConnect.mockResolvedValueOnce(txClient);

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        retryDelayMs: 10,
      });
      await client.connect();

      txClient.query.mockImplementation(async (sql: string) => {
        if (sql === 'INSERT INTO fail') throw new Error('Insert failed');
        return { rows: [] };
      });

      await expect(
        client.transaction(async (c) => {
          await c.query('INSERT INTO fail');
        })
      ).rejects.toThrow('Insert failed');

      expect(txClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(txClient.release).toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('should end the pool when connected', async () => {
      const mockClient = { release: mocks.mockRelease };
      mocks.mockConnect.mockResolvedValueOnce(mockClient);
      mocks.mockEnd.mockResolvedValueOnce(undefined);

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        retryDelayMs: 10,
      });
      await client.connect();
      await client.close();

      expect(mocks.mockEnd).toHaveBeenCalledTimes(1);
    });

    it('should be safe to call close() without connecting', async () => {
      const client = createPgClient({ connectionString: 'postgresql://test@host/db' });

      // Should not throw
      await client.close();
    });
  });

  describe('isHealthy()', () => {
    it('should return false if not connected', async () => {
      const client = createPgClient({ connectionString: 'postgresql://test@host/db' });

      const healthy = await client.isHealthy();
      expect(healthy).toBe(false);
    });

    it('should return true when query succeeds', async () => {
      const mockClient = { release: mocks.mockRelease };
      mocks.mockConnect.mockResolvedValueOnce(mockClient);
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        retryDelayMs: 10,
      });
      await client.connect();

      const healthy = await client.isHealthy();
      expect(healthy).toBe(true);
    });

    it('should return false when query fails', async () => {
      const mockClient = { release: mocks.mockRelease };
      mocks.mockConnect.mockResolvedValueOnce(mockClient);
      mocks.mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      const client = createPgClient({
        connectionString: 'postgresql://test@host/db',
        retryDelayMs: 10,
      });
      await client.connect();

      const healthy = await client.isHealthy();
      expect(healthy).toBe(false);
    });
  });
});
