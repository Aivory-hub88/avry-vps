/**
 * Unit tests for the Metrics Collector Service
 *
 * Tests CPU calculation from /proc/stat, empty container list handling,
 * zero CPU usage edge case, disk at 100% capacity, and container filter
 * with no matches.
 *
 * Requirements: 1.1, 1.4, 2.1, 2.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMetricsCollector, MetricsCollectorError } from '../../../src/services/metrics-collector.js';
import type { ProjectRegistry } from '../../../src/services/project-registry.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  access: vi.fn(),
  constants: { R_OK: 4 },
  statfs: vi.fn(),
}));

vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      ping: vi.fn().mockResolvedValue('OK'),
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn(),
    })),
  };
});

import { readFile, access, statfs } from 'fs/promises';
import Dockerode from 'dockerode';

const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);
const mockStatfs = vi.mocked(statfs);

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

/**
 * Sample /proc/stat content.
 * Format: cpu user nice system idle iowait irq softirq steal guest guest_nice
 */
const PROC_STAT_SNAPSHOT_1 = `cpu  10000 200 3000 50000 1000 100 50 0 0 0
cpu0 5000 100 1500 25000 500 50 25 0 0 0
cpu1 5000 100 1500 25000 500 50 25 0 0 0
`;

const PROC_STAT_SNAPSHOT_2 = `cpu  11000 220 3200 51000 1020 110 55 0 0 0
cpu0 5500 110 1600 25500 510 55 28 0 0 0
cpu1 5500 110 1600 25500 510 55 27 0 0 0
`;

// Zero-delta scenario: both snapshots are identical → 0% CPU usage
const PROC_STAT_ZERO_DELTA = `cpu  10000 200 3000 50000 1000 100 50 0 0 0
cpu0 5000 100 1500 25000 500 50 25 0 0 0
`;

const PROC_MEMINFO = `MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    4096000 kB
Buffers:          512000 kB
Cached:          2048000 kB
`;

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000  10000    0    0    0     0          0         0  1000000  10000    0    0    0     0       0          0
  eth0: 5000000  50000    0    0    0     0          0         0  3000000  30000    0    0    0     0       0          0
`;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function setupProcMocks(options: {
  stat1?: string;
  stat2?: string;
  meminfo?: string;
  netdev?: string;
} = {}) {
  const stat1 = options.stat1 ?? PROC_STAT_SNAPSHOT_1;
  const stat2 = options.stat2 ?? PROC_STAT_SNAPSHOT_2;
  const meminfo = options.meminfo ?? PROC_MEMINFO;
  const netdev = options.netdev ?? PROC_NET_DEV;

  // access() succeeds for all proc files
  mockAccess.mockResolvedValue(undefined);

  // readFile returns data based on call count for /proc/stat (called twice for CPU sampling)
  let statCallCount = 0;
  mockReadFile.mockImplementation(async (path: any) => {
    const pathStr = String(path);
    if (pathStr.includes('/stat')) {
      statCallCount++;
      return statCallCount === 1 ? stat1 : stat2;
    }
    if (pathStr.includes('/meminfo')) return meminfo;
    if (pathStr.includes('/net/dev')) return netdev;
    throw new Error(`Unexpected readFile path: ${pathStr}`);
  });
}

function createMockDockerode(containers: any[] = []) {
  const mockDocker = {
    ping: vi.fn().mockResolvedValue('OK'),
    listContainers: vi.fn().mockResolvedValue(containers),
    getContainer: vi.fn().mockImplementation((id: string) => ({
      stats: vi.fn().mockResolvedValue({
        cpu_stats: {
          cpu_usage: { total_usage: 200000000 },
          system_cpu_usage: 10000000000,
          online_cpus: 2,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 100000000 },
          system_cpu_usage: 9000000000,
        },
        memory_stats: { usage: 104857600, limit: 536870912 },
        networks: { eth0: { rx_bytes: 1024, tx_bytes: 2048 } },
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: 'Read', value: 4096 },
            { op: 'Write', value: 8192 },
          ],
        },
      }),
    })),
  };

  // Replace the Dockerode constructor mock
  vi.mocked(Dockerode).mockImplementation(() => mockDocker as any);
  return mockDocker;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Metrics Collector Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('CPU calculation with mock /proc/stat data (Requirement 1.4)', () => {
    it('calculates CPU percentage from two /proc/stat snapshots', async () => {
      setupProcMocks();
      // Mock statfs for disk metrics
      mockStatfs.mockResolvedValue({
        blocks: 1000000,
        bsize: 4096,
        bfree: 500000,
      } as any);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10, // short interval for testing
      });

      // Advance timers when sleep is called
      const metricsPromise = collector.getSystemMetrics();
      await vi.advanceTimersByTimeAsync(10);
      const metrics = await metricsPromise;

      // Calculate expected:
      // Snapshot 1: idle = 50000 + 1000 = 51000, total = 10000+200+3000+50000+1000+100+50+0+0+0 = 64350
      // Snapshot 2: idle = 51000 + 1020 = 52020, total = 11000+220+3200+51000+1020+110+55+0+0+0 = 66605
      // idleDelta = 52020 - 51000 = 1020
      // totalDelta = 66605 - 64350 = 2255
      // CPU% = (2255 - 1020) / 2255 * 100 = 54.79%
      const expectedCpu = Math.round(((2255 - 1020) / 2255) * 100 * 100) / 100;

      expect(metrics.cpu.usagePercent).toBe(expectedCpu);
      expect(metrics.cpu.usagePercent).toBeGreaterThan(0);
      expect(metrics.cpu.usagePercent).toBeLessThan(100);
    });

    it('reads /proc/stat twice with a sampling interval between reads', async () => {
      setupProcMocks();
      mockStatfs.mockResolvedValue({
        blocks: 1000000,
        bsize: 4096,
        bfree: 500000,
      } as any);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 1000,
      });

      const metricsPromise = collector.getSystemMetrics();
      await vi.advanceTimersByTimeAsync(1000);
      await metricsPromise;

      // readFile should have been called for /proc/stat twice (before and after interval)
      const statCalls = mockReadFile.mock.calls.filter(
        (call) => String(call[0]).includes('/stat')
      );
      expect(statCalls).toHaveLength(2);
    });

    it('includes ISO 8601 timestamp in the response (Requirement 1.5)', async () => {
      setupProcMocks();
      mockStatfs.mockResolvedValue({
        blocks: 1000000,
        bsize: 4096,
        bfree: 500000,
      } as any);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      const metricsPromise = collector.getSystemMetrics();
      await vi.advanceTimersByTimeAsync(10);
      const metrics = await metricsPromise;

      expect(metrics.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('Zero CPU usage edge case (Requirement 1.4)', () => {
    it('returns 0% CPU when both /proc/stat snapshots are identical', async () => {
      // Both snapshots are the same → totalDelta = 0 → cpuUsagePercent = 0
      setupProcMocks({ stat1: PROC_STAT_ZERO_DELTA, stat2: PROC_STAT_ZERO_DELTA });
      mockStatfs.mockResolvedValue({
        blocks: 1000000,
        bsize: 4096,
        bfree: 500000,
      } as any);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      const metricsPromise = collector.getSystemMetrics();
      await vi.advanceTimersByTimeAsync(10);
      const metrics = await metricsPromise;

      expect(metrics.cpu.usagePercent).toBe(0);
    });
  });

  describe('Disk at 100% capacity', () => {
    it('returns disk usage equal to total when filesystem is full', async () => {
      setupProcMocks();
      // Disk full: bfree = 0
      mockStatfs.mockResolvedValue({
        blocks: 1000000,
        bsize: 4096,
        bfree: 0,
      } as any);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      const metricsPromise = collector.getSystemMetrics();
      await vi.advanceTimersByTimeAsync(10);
      const metrics = await metricsPromise;

      const expectedTotal = 1000000 * 4096;
      expect(metrics.disk.totalBytes).toBe(expectedTotal);
      expect(metrics.disk.usedBytes).toBe(expectedTotal);
      // usedBytes should equal totalBytes when disk is full
      expect(metrics.disk.usedBytes).toBe(metrics.disk.totalBytes);
    });
  });

  describe('Empty container list (Requirement 2.1)', () => {
    it('returns empty array when Docker has no containers', async () => {
      const mockDocker = createMockDockerode([]);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      const containers = await collector.getContainerMetrics();

      expect(containers).toEqual([]);
      expect(mockDocker.listContainers).toHaveBeenCalledOnce();
    });

    it('returns empty array when Docker has no containers with filters applied', async () => {
      const mockDocker = createMockDockerode([]);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      const containers = await collector.getContainerMetrics({ status: 'running' });

      expect(containers).toEqual([]);
    });
  });

  describe('Container filter with no matches (Requirement 2.3)', () => {
    it('returns empty array when name filter matches no containers', async () => {
      const mockContainers = [
        {
          Id: 'abc123def45678',
          Names: ['/my-web-app'],
          State: 'running',
        },
        {
          Id: 'xyz789ghi01234',
          Names: ['/my-database'],
          State: 'running',
        },
      ];

      const mockDocker = createMockDockerode(mockContainers);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      // Filter for a name that doesn't exist in any container
      const containers = await collector.getContainerMetrics({
        name: 'nonexistent-service',
      });

      expect(containers).toEqual([]);
    });

    it('name filter is case-insensitive (Requirement 2.3)', async () => {
      const mockContainers = [
        {
          Id: 'abc123def45678',
          Names: ['/MyWebApp'],
          State: 'running',
        },
      ];

      const mockDocker = createMockDockerode(mockContainers);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      // Uppercase filter should match lowercase container name
      const containers = await collector.getContainerMetrics({
        name: 'MYWEBAPP',
      });

      expect(containers).toHaveLength(1);
      expect(containers[0].name).toBe('MyWebApp');
    });

    it('returns only matching containers when some match the name filter', async () => {
      const mockContainers = [
        {
          Id: 'abc123def45678',
          Names: ['/avry-frontend'],
          State: 'running',
        },
        {
          Id: 'xyz789ghi01234',
          Names: ['/avry-backend'],
          State: 'running',
        },
        {
          Id: 'mno456pqr78901',
          Names: ['/redis-cache'],
          State: 'running',
        },
      ];

      const mockDocker = createMockDockerode(mockContainers);

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      // Filter for "avry" — should match 2 of 3 containers
      const containers = await collector.getContainerMetrics({
        name: 'avry',
      });

      expect(containers).toHaveLength(2);
      expect(containers.map((c) => c.name).sort()).toEqual(['avry-backend', 'avry-frontend']);
    });
  });

  describe('/proc unavailability (Requirement 1.6)', () => {
    it('throws MetricsCollectorError with SYSTEM_UNAVAILABLE when /proc is not accessible', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const collector = createMetricsCollector({
        procPath: '/proc',
        cpuSampleIntervalMs: 10,
      });

      await expect(collector.getSystemMetrics()).rejects.toThrow(MetricsCollectorError);
      await expect(collector.getSystemMetrics()).rejects.toMatchObject({
        code: 'SYSTEM_UNAVAILABLE',
        statusCode: 503,
      });
    });
  });
});
