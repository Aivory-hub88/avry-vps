/**
 * Metrics Collector Service
 *
 * Provides structured system-wide and per-container resource metrics
 * for the Monitoring API. Reads system metrics from /proc and uses
 * dockerode for container stats. Supports project-level aggregation
 * via the ProjectRegistry dependency.
 *
 * @module services/metrics-collector
 */
import Dockerode from 'dockerode';
import { readFile as fsReadFile, access, constants, statfs } from 'fs/promises';

import type { ProjectRegistry } from './project-registry.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SystemMetricsResponse {
  cpu: { usagePercent: number };
  memory: { usedBytes: number; totalBytes: number };
  disk: { usedBytes: number; totalBytes: number };
  network: { rxBytesPerSec: number; txBytesPerSec: number };
  timestamp: string; // ISO 8601
}

export interface ContainerMetricsResponse {
  id: string;         // 12-char short ID
  name: string;
  status: string;
  cpu: { usagePercent: number };
  memory: { usedBytes: number; limitBytes: number };
  network: { rxBytes: number; txBytes: number };
  blockIo: { readBytes: number; writeBytes: number };
}

export interface ContainerFilters {
  name?: string;       // case-insensitive substring
  status?: 'running' | 'stopped' | 'exited';
}

export interface ProjectMetricsResponse {
  projectId: string;
  displayName: string;
  cpu: { usagePercent: number };
  memory: { usedBytes: number; limitBytes: number };
  network: { rxBytes: number; txBytes: number };
  blockIo: { readBytes: number; writeBytes: number };
  containers: ContainerMetricsResponse[];
}

export interface ProjectSummary {
  projectId: string;
  displayName: string;
  containerCount: number;
  cpu: { usagePercent: number };
  memory: { usedBytes: number; limitBytes: number };
}

export interface MetricsCollector {
  getSystemMetrics(): Promise<SystemMetricsResponse>;
  getContainerMetrics(filters?: ContainerFilters): Promise<ContainerMetricsResponse[]>;
  getProjectMetrics(projectId: string): Promise<ProjectMetricsResponse>;
  getAllProjectsSummary(): Promise<ProjectSummary[]>;
}

export interface MetricsCollectorConfig {
  /** Docker host URI. Defaults to DOCKER_HOST env or /var/run/docker.sock */
  dockerHost?: string;
  /** Custom proc path for testing. Default: /proc */
  procPath?: string;
  /** CPU sampling interval in milliseconds. Default: 1000 (1 second) */
  cpuSampleIntervalMs?: number;
}

// ─── Error class ─────────────────────────────────────────────────────────────

export class MetricsCollectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'MetricsCollectorError';
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PROC_PATH = '/proc';
const DEFAULT_CPU_SAMPLE_INTERVAL_MS = 1000;

// ─── Implementation ──────────────────────────────────────────────────────────

export function createMetricsCollector(
  config?: MetricsCollectorConfig,
  projectRegistry?: ProjectRegistry
): MetricsCollector {
  const dockerHost = config?.dockerHost ?? process.env.DOCKER_HOST ?? '/var/run/docker.sock';
  const procPath = config?.procPath ?? DEFAULT_PROC_PATH;
  const cpuSampleIntervalMs = config?.cpuSampleIntervalMs ?? DEFAULT_CPU_SAMPLE_INTERVAL_MS;

  // Initialize Docker client
  const dockerOpts = dockerHost.startsWith('/')
    ? { socketPath: dockerHost }
    : { host: dockerHost };
  const docker = new Dockerode(dockerOpts);

  // ─── /proc Availability ──────────────────────────────────────────────────

  async function assertProcAvailable(): Promise<void> {
    try {
      await access(`${procPath}/stat`, constants.R_OK);
      await access(`${procPath}/meminfo`, constants.R_OK);
      await access(`${procPath}/net/dev`, constants.R_OK);
    } catch {
      throw new MetricsCollectorError(
        'System metrics are unavailable: /proc filesystem is not accessible',
        'SYSTEM_UNAVAILABLE',
        503
      );
    }
  }

  // ─── /proc Readers ─────────────────────────────────────────────────────────

  async function readCpuSnapshot(): Promise<{ idle: number; total: number }> {
    const content = await fsReadFile(`${procPath}/stat`, 'utf-8');
    const cpuLine = content.split('\n').find((line) => line.startsWith('cpu '));
    if (!cpuLine) throw new Error('Could not parse /proc/stat');

    // cpu  user nice system idle iowait irq softirq steal guest guest_nice
    const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((sum, val) => sum + val, 0);

    return { idle, total };
  }

  async function readMemory(): Promise<{ usedBytes: number; totalBytes: number }> {
    const content = await fsReadFile(`${procPath}/meminfo`, 'utf-8');
    const lines = content.split('\n');

    let totalKB = 0;
    let availableKB = 0;

    for (const line of lines) {
      if (line.startsWith('MemTotal:')) {
        totalKB = parseInt(line.split(/\s+/)[1] ?? '0', 10);
      } else if (line.startsWith('MemAvailable:')) {
        availableKB = parseInt(line.split(/\s+/)[1] ?? '0', 10);
      }
    }

    const totalBytes = totalKB * 1024;
    const usedBytes = (totalKB - availableKB) * 1024;

    return { usedBytes, totalBytes };
  }

  async function readDisk(): Promise<{ usedBytes: number; totalBytes: number }> {
    try {
      const stats = await statfs('/');
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bfree * stats.bsize;
      const usedBytes = totalBytes - freeBytes;

      return { usedBytes, totalBytes };
    } catch {
      // Fallback: return zeros if statfs is not available
      return { usedBytes: 0, totalBytes: 0 };
    }
  }

  async function readNetwork(): Promise<{ rxBytes: number; txBytes: number }> {
    const content = await fsReadFile(`${procPath}/net/dev`, 'utf-8');
    const lines = content.split('\n');

    let totalRx = 0;
    let totalTx = 0;

    for (const line of lines) {
      // Skip header lines (contain '|') and empty lines
      if (line.includes('|') || line.trim() === '') continue;

      const parts = line.trim().split(/\s+/);
      const iface = parts[0]?.replace(':', '') ?? '';

      // Skip loopback
      if (iface === 'lo') continue;

      // Format: iface: rx_bytes rx_packets ... tx_bytes tx_packets ...
      totalRx += parseInt(parts[1] ?? '0', 10);
      totalTx += parseInt(parts[9] ?? '0', 10);
    }

    return { rxBytes: totalRx, txBytes: totalTx };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Combined system metrics collection (1-second sampling) ──────────────

  async function collectSystemMetrics(): Promise<SystemMetricsResponse> {
    // Read all initial snapshots
    const cpuSnap1 = await readCpuSnapshot();
    const netSnap1 = await readNetwork();

    // Wait for the sampling interval
    await sleep(cpuSampleIntervalMs);

    // Read second snapshots
    const cpuSnap2 = await readCpuSnapshot();
    const netSnap2 = await readNetwork();

    // Calculate CPU usage
    const idleDelta = cpuSnap2.idle - cpuSnap1.idle;
    const totalDelta = cpuSnap2.total - cpuSnap1.total;
    let cpuUsagePercent = 0;
    if (totalDelta > 0) {
      cpuUsagePercent = ((totalDelta - idleDelta) / totalDelta) * 100;
    }
    cpuUsagePercent = Math.round(cpuUsagePercent * 100) / 100;

    // Calculate network rate
    const elapsedSec = cpuSampleIntervalMs / 1000;
    const rxBytesPerSec = Math.max(0, Math.round((netSnap2.rxBytes - netSnap1.rxBytes) / elapsedSec));
    const txBytesPerSec = Math.max(0, Math.round((netSnap2.txBytes - netSnap1.txBytes) / elapsedSec));

    // Read memory (instantaneous)
    const memory = await readMemory();

    // Read disk (instantaneous)
    const disk = await readDisk();

    return {
      cpu: { usagePercent: cpuUsagePercent },
      memory: { usedBytes: memory.usedBytes, totalBytes: memory.totalBytes },
      disk: { usedBytes: disk.usedBytes, totalBytes: disk.totalBytes },
      network: { rxBytesPerSec, txBytesPerSec },
      timestamp: new Date().toISOString(),
    };
  }

  // ─── getSystemMetrics ────────────────────────────────────────────────────

  async function getSystemMetrics(): Promise<SystemMetricsResponse> {
    await assertProcAvailable();
    return collectSystemMetrics();
  }

  // ─── Docker Availability ─────────────────────────────────────────────────

  async function assertDockerAvailable(): Promise<void> {
    try {
      await docker.ping();
    } catch {
      throw new MetricsCollectorError(
        'Container metrics are unavailable: Docker socket is not accessible',
        'DOCKER_UNAVAILABLE',
        503
      );
    }
  }

  // ─── Container Stats Helper ──────────────────────────────────────────────

  function computeContainerMetrics(
    containerInfo: Dockerode.ContainerInfo,
    stats: any
  ): ContainerMetricsResponse {
    // CPU usage percentage
    const cpuDelta =
      (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
      (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta =
      (stats.cpu_stats?.system_cpu_usage ?? 0) -
      (stats.precpu_stats?.system_cpu_usage ?? 0);
    const numCpus =
      stats.cpu_stats?.online_cpus ??
      stats.cpu_stats?.cpu_usage?.percpu_usage?.length ??
      1;

    let cpuPercent = 0;
    if (systemDelta > 0 && cpuDelta > 0) {
      cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
    }
    cpuPercent = Math.round(cpuPercent * 100) / 100;

    // Memory
    const memoryUsage = stats.memory_stats?.usage ?? 0;
    const memoryLimit = stats.memory_stats?.limit ?? 0;

    // Network
    let networkRxBytes = 0;
    let networkTxBytes = 0;
    const networks = stats.networks ?? {};
    for (const netStats of Object.values(networks) as any[]) {
      networkRxBytes += netStats.rx_bytes ?? 0;
      networkTxBytes += netStats.tx_bytes ?? 0;
    }

    // Block I/O
    let blockReadBytes = 0;
    let blockWriteBytes = 0;
    const blkioStats = stats.blkio_stats?.io_service_bytes_recursive ?? [];
    for (const entry of blkioStats) {
      if (entry.op === 'read' || entry.op === 'Read') blockReadBytes += entry.value ?? 0;
      if (entry.op === 'write' || entry.op === 'Write') blockWriteBytes += entry.value ?? 0;
    }

    // Container name (strip leading /)
    const name = (containerInfo.Names?.[0] ?? '').replace(/^\//, '');

    // Short ID (12 chars)
    const id = containerInfo.Id.substring(0, 12);

    // Status
    const status = containerInfo.State ?? 'unknown';

    return {
      id,
      name,
      status,
      cpu: { usagePercent: cpuPercent },
      memory: { usedBytes: memoryUsage, limitBytes: memoryLimit },
      network: { rxBytes: networkRxBytes, txBytes: networkTxBytes },
      blockIo: { readBytes: blockReadBytes, writeBytes: blockWriteBytes },
    };
  }

  // ─── getContainerMetrics ─────────────────────────────────────────────────

  async function getContainerMetrics(
    filters?: ContainerFilters
  ): Promise<ContainerMetricsResponse[]> {
    await assertDockerAvailable();

    // Build Docker list filters
    const dockerFilters: Record<string, string[]> = {};
    if (filters?.status) {
      // Map our status values to Docker states
      const statusMap: Record<string, string[]> = {
        running: ['running'],
        stopped: ['created', 'paused', 'exited', 'dead'],
        exited: ['exited'],
      };
      dockerFilters.status = statusMap[filters.status] ?? [filters.status];
    }

    const listOptions: Dockerode.ContainerListOptions = {
      all: true,
      filters: Object.keys(dockerFilters).length > 0 ? dockerFilters : undefined,
    };

    const containers = await docker.listContainers(listOptions);

    // Filter by name (case-insensitive substring) if provided
    let filteredContainers = containers;
    if (filters?.name) {
      const nameFilter = filters.name.toLowerCase();
      filteredContainers = containers.filter((c) => {
        const containerName = (c.Names?.[0] ?? '').replace(/^\//, '').toLowerCase();
        return containerName.includes(nameFilter);
      });
    }

    // Collect stats for each container in parallel
    const results: ContainerMetricsResponse[] = [];

    await Promise.all(
      filteredContainers.map(async (containerInfo) => {
        try {
          const container = docker.getContainer(containerInfo.Id);

          // Only get stats for running containers; non-running containers
          // return zero metrics
          if (containerInfo.State === 'running') {
            const stats = await (container.stats({ stream: false }) as Promise<any>);
            results.push(computeContainerMetrics(containerInfo, stats));
          } else {
            // Non-running container — return zero metrics
            const name = (containerInfo.Names?.[0] ?? '').replace(/^\//, '');
            results.push({
              id: containerInfo.Id.substring(0, 12),
              name,
              status: containerInfo.State ?? 'unknown',
              cpu: { usagePercent: 0 },
              memory: { usedBytes: 0, limitBytes: 0 },
              network: { rxBytes: 0, txBytes: 0 },
              blockIo: { readBytes: 0, writeBytes: 0 },
            });
          }
        } catch {
          // Skip containers whose stats we can't read
        }
      })
    );

    return results;
  }

  // ─── getProjectMetrics ───────────────────────────────────────────────────

  async function getProjectMetrics(projectId: string): Promise<ProjectMetricsResponse> {
    if (!projectRegistry) {
      throw new MetricsCollectorError(
        'Project registry is not configured',
        'PROJECT_NOT_FOUND',
        404
      );
    }

    // Look up the project
    const project = await projectRegistry.get(projectId);
    if (!project) {
      throw new MetricsCollectorError(
        `Project "${projectId}" not found`,
        'PROJECT_NOT_FOUND',
        404
      );
    }

    // Get all containers
    await assertDockerAvailable();
    const allContainers = await getContainerMetrics();

    // Match containers using project registry patterns
    const allContainerNames = allContainers.map((c) => c.name);
    const matchedNames = await projectRegistry.matchContainers(projectId, allContainerNames);

    // Filter to only matched containers
    const matchedContainers = allContainers.filter((c) =>
      matchedNames.includes(c.name)
    );

    // Aggregate metrics
    let totalCpuPercent = 0;
    let totalMemoryUsed = 0;
    let totalMemoryLimit = 0;
    let totalNetworkRx = 0;
    let totalNetworkTx = 0;
    let totalBlockRead = 0;
    let totalBlockWrite = 0;

    for (const container of matchedContainers) {
      totalCpuPercent += container.cpu.usagePercent;
      totalMemoryUsed += container.memory.usedBytes;
      totalMemoryLimit += container.memory.limitBytes;
      totalNetworkRx += container.network.rxBytes;
      totalNetworkTx += container.network.txBytes;
      totalBlockRead += container.blockIo.readBytes;
      totalBlockWrite += container.blockIo.writeBytes;
    }

    return {
      projectId,
      displayName: project.displayName,
      cpu: { usagePercent: Math.round(totalCpuPercent * 100) / 100 },
      memory: { usedBytes: totalMemoryUsed, limitBytes: totalMemoryLimit },
      network: { rxBytes: totalNetworkRx, txBytes: totalNetworkTx },
      blockIo: { readBytes: totalBlockRead, writeBytes: totalBlockWrite },
      containers: matchedContainers,
    };
  }

  // ─── getAllProjectsSummary ────────────────────────────────────────────────

  async function getAllProjectsSummary(): Promise<ProjectSummary[]> {
    if (!projectRegistry) {
      return [];
    }

    const projects = await projectRegistry.list();

    if (projects.length === 0) {
      return [];
    }

    // Get all container metrics once
    let allContainers: ContainerMetricsResponse[] = [];
    try {
      allContainers = await getContainerMetrics();
    } catch (err) {
      // If Docker is unavailable, return projects with zero metrics
      if (err instanceof MetricsCollectorError && err.code === 'DOCKER_UNAVAILABLE') {
        return projects.map((project) => ({
          projectId: project.id,
          displayName: project.displayName,
          containerCount: 0,
          cpu: { usagePercent: 0 },
          memory: { usedBytes: 0, limitBytes: 0 },
        }));
      }
      throw err;
    }

    const allContainerNames = allContainers.map((c) => c.name);

    const summaries: ProjectSummary[] = [];

    for (const project of projects) {
      const matchedNames = await projectRegistry.matchContainers(project.id, allContainerNames);
      const matchedContainers = allContainers.filter((c) =>
        matchedNames.includes(c.name)
      );

      let totalCpuPercent = 0;
      let totalMemoryUsed = 0;
      let totalMemoryLimit = 0;

      for (const container of matchedContainers) {
        totalCpuPercent += container.cpu.usagePercent;
        totalMemoryUsed += container.memory.usedBytes;
        totalMemoryLimit += container.memory.limitBytes;
      }

      summaries.push({
        projectId: project.id,
        displayName: project.displayName,
        containerCount: matchedContainers.length,
        cpu: { usagePercent: Math.round(totalCpuPercent * 100) / 100 },
        memory: { usedBytes: totalMemoryUsed, limitBytes: totalMemoryLimit },
      });
    }

    return summaries;
  }

  // ─── Return the public API ─────────────────────────────────────────────────

  return {
    getSystemMetrics,
    getContainerMetrics,
    getProjectMetrics,
    getAllProjectsSummary,
  };
}
