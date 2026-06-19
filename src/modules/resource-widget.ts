/**
 * Resource Widget Module
 *
 * Provides system-wide and per-container resource metrics collection.
 * Reads from /proc/stat, /proc/meminfo, /proc/diskstats, /proc/net/dev.
 * Falls back to Docker stats API if /proc is unavailable.
 * Emits updates every 5 seconds via Socket.IO.
 * Highlights warnings when any resource exceeds 90% utilization.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */
import Dockerode from 'dockerode';
import { readFile as fsReadFile } from 'fs/promises';
import { access, constants } from 'fs/promises';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface SystemMetrics {
  cpu: { usagePercent: number; warning: boolean };
  memory: { usedGB: number; totalGB: number; usagePercent: number; warning: boolean };
  disk: { usedGB: number; totalGB: number; usagePercent: number; warning: boolean };
  network: { inBytesPerSec: number; outBytesPerSec: number };
  procAvailable: boolean;
}

export interface ContainerMetrics {
  id: string;
  name: string;
  cpuPercent: number;
  memoryMB: number;
  memoryUsageMB: number;
  memoryLimitMB: number;
  warning: boolean;
}

export interface ResourceUpdate {
  system: SystemMetrics;
  containers: ContainerMetrics[];
  timestamp: number;
  warnings: string[];
}

export interface ResourceWidget {
  getSystemMetrics(): Promise<SystemMetrics>;
  getContainerMetrics(): Promise<ContainerMetrics[]>;
  startMonitoring(io: SocketIOServer): void;
  stopMonitoring(): void;
  /** Get the latest cached update (useful for tests) */
  getLatestUpdate(): ResourceUpdate | null;
  /** Check if /proc filesystem is accessible */
  isProcAvailable(): Promise<boolean>;
}

export interface ResourceWidgetConfig {
  /** Docker host URI. Defaults to DOCKER_HOST env or /var/run/docker.sock */
  dockerHost?: string;
  /** Update interval in ms. Default: 5000 (5 seconds) */
  updateIntervalMs?: number;
  /** Warning threshold percentage. Default: 90 */
  warningThreshold?: number;
  /** Custom proc path for testing. Default: /proc */
  procPath?: string;
}

/** Minimal Socket.IO Server interface for dependency injection */
export interface SocketIOServer {
  emit(event: string, data: any): void;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_UPDATE_INTERVAL_MS = 5_000;
const DEFAULT_WARNING_THRESHOLD = 90;
const DEFAULT_PROC_PATH = '/proc';

const WARNING_THRESHOLD_FRACTION = 0.90;

// ─── Internal State for CPU Calculation ────────────────────────────────────────

interface CpuSnapshot {
  idle: number;
  total: number;
  timestamp: number;
}

interface NetworkSnapshot {
  rxBytes: number;
  txBytes: number;
  timestamp: number;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createResourceWidget(
  config?: ResourceWidgetConfig
): ResourceWidget {
  const dockerHost = config?.dockerHost ?? process.env.DOCKER_HOST ?? '/var/run/docker.sock';
  const updateIntervalMs = config?.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
  const warningThreshold = config?.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
  const procPath = config?.procPath ?? DEFAULT_PROC_PATH;

  // Initialize Docker client
  const dockerOpts = dockerHost.startsWith('/')
    ? { socketPath: dockerHost }
    : { host: dockerHost };
  const docker = new Dockerode(dockerOpts);

  // Internal state
  let monitoringTimer: ReturnType<typeof setInterval> | null = null;
  let latestUpdate: ResourceUpdate | null = null;
  let previousCpu: CpuSnapshot | null = null;
  let previousNetwork: NetworkSnapshot | null = null;
  let procAvailableCache: boolean | null = null;

  // ─── /proc Availability Check ──────────────────────────────────────────

  async function isProcAvailable(): Promise<boolean> {
    if (procAvailableCache !== null) return procAvailableCache;
    try {
      await access(`${procPath}/stat`, constants.R_OK);
      await access(`${procPath}/meminfo`, constants.R_OK);
      procAvailableCache = true;
    } catch {
      procAvailableCache = false;
    }
    return procAvailableCache;
  }

  // ─── /proc Readers ─────────────────────────────────────────────────────

  async function readProcStat(): Promise<{ idle: number; total: number }> {
    const content = await fsReadFile(`${procPath}/stat`, 'utf-8');
    const cpuLine = content.split('\n').find((line) => line.startsWith('cpu '));
    if (!cpuLine) throw new Error('Could not parse /proc/stat');

    // cpu  user nice system idle iowait irq softirq steal guest guest_nice
    const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((sum, val) => sum + val, 0);

    return { idle, total };
  }

  async function readProcMeminfo(): Promise<{ usedGB: number; totalGB: number; usagePercent: number }> {
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

    const totalGB = totalKB / (1024 * 1024);
    const usedGB = (totalKB - availableKB) / (1024 * 1024);
    const usagePercent = totalKB > 0 ? ((totalKB - availableKB) / totalKB) * 100 : 0;

    return {
      usedGB: Math.round(usedGB * 100) / 100,
      totalGB: Math.round(totalGB * 100) / 100,
      usagePercent: Math.round(usagePercent * 100) / 100,
    };
  }

  async function readProcDiskstats(): Promise<{ usedGB: number; totalGB: number; usagePercent: number }> {
    // /proc/diskstats gives I/O stats per device, not filesystem usage.
    // For filesystem usage, we read /proc/mounts and use statfs-like approach.
    // However, in Node.js we can use the `statvfs` equivalent via a simpler approach.
    // We'll use a shell-free method: read from the OS directly.
    try {
      const { statfs } = await import('fs/promises');
      const stats = await statfs('/');
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bfree * stats.bsize;
      const usedBytes = totalBytes - freeBytes;

      const totalGB = totalBytes / (1024 * 1024 * 1024);
      const usedGB = usedBytes / (1024 * 1024 * 1024);
      const usagePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

      return {
        usedGB: Math.round(usedGB * 100) / 100,
        totalGB: Math.round(totalGB * 100) / 100,
        usagePercent: Math.round(usagePercent * 100) / 100,
      };
    } catch {
      // Fallback: return zeros if statfs is not available
      return { usedGB: 0, totalGB: 0, usagePercent: 0 };
    }
  }

  async function readProcNetDev(): Promise<{ rxBytes: number; txBytes: number }> {
    const content = await fsReadFile(`${procPath}/net/dev`, 'utf-8');
    const lines = content.split('\n');

    let totalRx = 0;
    let totalTx = 0;

    for (const line of lines) {
      // Skip header lines
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

  // ─── System Metrics (via /proc) ─────────────────────────────────────────

  async function getSystemMetricsFromProc(): Promise<SystemMetrics> {
    // CPU
    const cpuRaw = await readProcStat();
    let cpuUsagePercent = 0;

    if (previousCpu) {
      const idleDelta = cpuRaw.idle - previousCpu.idle;
      const totalDelta = cpuRaw.total - previousCpu.total;
      if (totalDelta > 0) {
        cpuUsagePercent = ((totalDelta - idleDelta) / totalDelta) * 100;
      }
    }
    previousCpu = { idle: cpuRaw.idle, total: cpuRaw.total, timestamp: Date.now() };

    // Memory
    const memory = await readProcMeminfo();

    // Disk
    const disk = await readProcDiskstats();

    // Network
    const netRaw = await readProcNetDev();
    let inBytesPerSec = 0;
    let outBytesPerSec = 0;

    if (previousNetwork) {
      const elapsedSec = (Date.now() - previousNetwork.timestamp) / 1000;
      if (elapsedSec > 0) {
        inBytesPerSec = Math.max(0, (netRaw.rxBytes - previousNetwork.rxBytes) / elapsedSec);
        outBytesPerSec = Math.max(0, (netRaw.txBytes - previousNetwork.txBytes) / elapsedSec);
      }
    }
    previousNetwork = { rxBytes: netRaw.rxBytes, txBytes: netRaw.txBytes, timestamp: Date.now() };

    cpuUsagePercent = Math.round(cpuUsagePercent * 100) / 100;

    return {
      cpu: {
        usagePercent: cpuUsagePercent,
        warning: cpuUsagePercent >= warningThreshold,
      },
      memory: {
        usedGB: memory.usedGB,
        totalGB: memory.totalGB,
        usagePercent: memory.usagePercent,
        warning: memory.usagePercent >= warningThreshold,
      },
      disk: {
        usedGB: disk.usedGB,
        totalGB: disk.totalGB,
        usagePercent: disk.usagePercent,
        warning: disk.usagePercent >= warningThreshold,
      },
      network: {
        inBytesPerSec: Math.round(inBytesPerSec),
        outBytesPerSec: Math.round(outBytesPerSec),
      },
      procAvailable: true,
    };
  }

  // ─── System Metrics Fallback (via Docker) ───────────────────────────────

  async function getSystemMetricsFallback(): Promise<SystemMetrics> {
    // When /proc is not available, we can only provide container-level metrics.
    // System-wide CPU/memory/disk/network are not obtainable from Docker stats alone.
    return {
      cpu: { usagePercent: 0, warning: false },
      memory: { usedGB: 0, totalGB: 0, usagePercent: 0, warning: false },
      disk: { usedGB: 0, totalGB: 0, usagePercent: 0, warning: false },
      network: { inBytesPerSec: 0, outBytesPerSec: 0 },
      procAvailable: false,
    };
  }

  // ─── getSystemMetrics ───────────────────────────────────────────────────

  async function getSystemMetrics(): Promise<SystemMetrics> {
    const procOk = await isProcAvailable();
    if (procOk) {
      return getSystemMetricsFromProc();
    }
    return getSystemMetricsFallback();
  }

  // ─── getContainerMetrics ────────────────────────────────────────────────

  async function getContainerMetrics(): Promise<ContainerMetrics[]> {
    const containers = await docker.listContainers({ filters: { status: ['running'] } });
    const metrics: ContainerMetrics[] = [];

    for (const containerInfo of containers) {
      try {
        const container = docker.getContainer(containerInfo.Id);
        const stats = await (container.stats({ stream: false }) as Promise<any>);

        // Calculate CPU %
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

        // Calculate Memory MB
        const memoryUsage = stats.memory_stats?.usage ?? 0;
        const memoryCache = stats.memory_stats?.stats?.cache ?? 0;
        const memoryMB = Math.round(((memoryUsage - memoryCache) / (1024 * 1024)) * 100) / 100;

        // Memory limit for warning calculation and resource bars
        const memoryLimitMB = Math.round(((stats.memory_stats?.limit ?? 0) / (1024 * 1024)) * 100) / 100;
        const memoryUsagePercent = memoryLimitMB > 0 ? (memoryMB / memoryLimitMB) * 100 : 0;

        const name = (containerInfo.Names?.[0] ?? '').replace(/^\//, '');

        metrics.push({
          id: containerInfo.Id,
          name,
          cpuPercent,
          memoryMB,
          memoryUsageMB: memoryMB,
          memoryLimitMB,
          warning: cpuPercent >= warningThreshold || memoryUsagePercent >= warningThreshold,
        });
      } catch {
        // Skip containers whose stats we can't read
      }
    }

    return metrics;
  }

  // ─── Collect Warnings ───────────────────────────────────────────────────

  function collectWarnings(system: SystemMetrics, containers: ContainerMetrics[]): string[] {
    const warnings: string[] = [];

    if (system.cpu.warning) {
      warnings.push(`System CPU usage at ${system.cpu.usagePercent}% (exceeds ${warningThreshold}%)`);
    }
    if (system.memory.warning) {
      warnings.push(`System memory usage at ${system.memory.usagePercent}% (exceeds ${warningThreshold}%)`);
    }
    if (system.disk.warning) {
      warnings.push(`System disk usage at ${system.disk.usagePercent}% (exceeds ${warningThreshold}%)`);
    }

    for (const container of containers) {
      if (container.warning) {
        warnings.push(`Container "${container.name}" resource usage exceeds ${warningThreshold}%`);
      }
    }

    return warnings;
  }

  // ─── Monitoring Loop ────────────────────────────────────────────────────

  async function collectAndEmit(io: SocketIOServer): Promise<void> {
    try {
      const [system, containers] = await Promise.all([
        getSystemMetrics(),
        getContainerMetrics(),
      ]);

      const warnings = collectWarnings(system, containers);

      const update: ResourceUpdate = {
        system,
        containers,
        timestamp: Date.now(),
        warnings,
      };

      latestUpdate = update;
      io.emit('resource:update', update);
    } catch {
      // Swallow errors during periodic collection to avoid crashing the loop
    }
  }

  function startMonitoring(io: SocketIOServer): void {
    if (monitoringTimer) return;

    // Perform an immediate first collection
    collectAndEmit(io).catch(() => { /* swallow */ });

    monitoringTimer = setInterval(() => {
      collectAndEmit(io).catch(() => { /* swallow */ });
    }, updateIntervalMs);

    // Don't prevent Node.js from exiting
    if (monitoringTimer.unref) {
      monitoringTimer.unref();
    }
  }

  function stopMonitoring(): void {
    if (monitoringTimer) {
      clearInterval(monitoringTimer);
      monitoringTimer = null;
    }
  }

  function getLatestUpdate(): ResourceUpdate | null {
    return latestUpdate;
  }

  // ─── Return the public API ─────────────────────────────────────────────

  return {
    getSystemMetrics,
    getContainerMetrics,
    startMonitoring,
    stopMonitoring,
    getLatestUpdate,
    isProcAvailable,
  };
}
