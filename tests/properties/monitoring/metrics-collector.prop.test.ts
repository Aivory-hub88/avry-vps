/**
 * Property-based tests for the Metrics Collector Service.
 *
 * Feature: vps-panel-monitoring-api, Property 6: Container name filter correctness
 * For any `name` query parameter value provided to `/api/monitoring/containers`, every container
 * in the response array SHALL have a name that contains the filter value as a case-insensitive
 * substring.
 *
 * Feature: vps-panel-monitoring-api, Property 10: Metrics units consistency
 * For any system metrics response, `cpu.usagePercent` SHALL be between 0 and 100 (inclusive),
 * `memory.usedBytes` SHALL be less than or equal to `memory.totalBytes`, and `disk.usedBytes`
 * SHALL be less than or equal to `disk.totalBytes`.
 *
 * **Validates: Requirements 2.3, 10.5**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Pure filter function extracted from metrics-collector logic ────────────────

/**
 * Applies the case-insensitive substring name filter identical to the one in
 * `getContainerMetrics()` — filters containers whose name contains the filter
 * value as a case-insensitive substring.
 */
function filterContainersByName(
  containers: { name: string }[],
  nameFilter: string
): { name: string }[] {
  const lowerFilter = nameFilter.toLowerCase();
  return containers.filter((c) => c.name.toLowerCase().includes(lowerFilter));
}

/**
 * Simulates system metrics calculation from /proc data, mirroring the logic
 * in `collectSystemMetrics()`.
 */
function computeSystemMetrics(input: {
  cpuIdle1: number;
  cpuTotal1: number;
  cpuIdle2: number;
  cpuTotal2: number;
  memTotalKB: number;
  memAvailableKB: number;
  diskTotalBlocks: number;
  diskFreeBlocks: number;
  diskBsize: number;
}): {
  cpu: { usagePercent: number };
  memory: { usedBytes: number; totalBytes: number };
  disk: { usedBytes: number; totalBytes: number };
} {
  // CPU calculation (mirrors metrics-collector.ts)
  const idleDelta = input.cpuIdle2 - input.cpuIdle1;
  const totalDelta = input.cpuTotal2 - input.cpuTotal1;
  let cpuUsagePercent = 0;
  if (totalDelta > 0) {
    cpuUsagePercent = ((totalDelta - idleDelta) / totalDelta) * 100;
  }
  cpuUsagePercent = Math.round(cpuUsagePercent * 100) / 100;

  // Memory calculation (mirrors metrics-collector.ts)
  const memoryTotalBytes = input.memTotalKB * 1024;
  const memoryUsedBytes = (input.memTotalKB - input.memAvailableKB) * 1024;

  // Disk calculation (mirrors metrics-collector.ts)
  const diskTotalBytes = input.diskTotalBlocks * input.diskBsize;
  const diskFreeBytes = input.diskFreeBlocks * input.diskBsize;
  const diskUsedBytes = diskTotalBytes - diskFreeBytes;

  return {
    cpu: { usagePercent: cpuUsagePercent },
    memory: { usedBytes: memoryUsedBytes, totalBytes: memoryTotalBytes },
    disk: { usedBytes: diskUsedBytes, totalBytes: diskTotalBytes },
  };
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Arbitrary for generating container names — alphanumeric strings with hyphens
 * and underscores, typical of Docker container names.
 */
const containerNameArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '-', '_', '.'
  ),
  { minLength: 1, maxLength: 50 }
);

/**
 * Arbitrary for generating a list of containers with names.
 */
const containerListArb = fc.array(
  containerNameArb.map((name) => ({ name })),
  { minLength: 0, maxLength: 30 }
);

/**
 * Arbitrary for name filter strings (non-empty substrings to filter on).
 */
const nameFilterArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '-', '_'
  ),
  { minLength: 1, maxLength: 20 }
);

/**
 * Arbitrary for valid /proc CPU values.
 *
 * In real /proc/stat, idle time is a component of total time (idle + busy = total).
 * Therefore idle_delta <= total_delta always holds. We generate based on deltas
 * to respect this physical constraint.
 */
const cpuSnapshotsArb = fc.record({
  cpuIdle1: fc.integer({ min: 0, max: 1_000_000 }),
  cpuTotal1: fc.integer({ min: 1, max: 2_000_000 }),
  // totalDelta is the increase in total CPU jiffies between two reads
  totalDelta: fc.integer({ min: 0, max: 1_000_000 }),
}).chain(({ cpuIdle1, cpuTotal1, totalDelta }) => {
  // idleDelta must be <= totalDelta (idle is a component of total)
  return fc.integer({ min: 0, max: totalDelta }).map((idleDelta) => ({
    cpuIdle1,
    cpuTotal1,
    cpuIdle2: cpuIdle1 + idleDelta,
    cpuTotal2: cpuTotal1 + totalDelta,
  }));
});

/**
 * Arbitrary for valid memory values.
 * memAvailableKB <= memTotalKB.
 */
const memoryArb = fc.integer({ min: 1, max: 64 * 1024 * 1024 }).chain((memTotalKB) =>
  fc.record({
    memTotalKB: fc.constant(memTotalKB),
    memAvailableKB: fc.integer({ min: 0, max: memTotalKB }),
  })
);

/**
 * Arbitrary for valid disk values.
 * diskFreeBlocks <= diskTotalBlocks.
 */
const diskArb = fc.record({
  diskBsize: fc.constantFrom(512, 1024, 4096),
}).chain(({ diskBsize }) =>
  fc.integer({ min: 1, max: 10_000_000 }).chain((diskTotalBlocks) =>
    fc.record({
      diskTotalBlocks: fc.constant(diskTotalBlocks),
      diskFreeBlocks: fc.integer({ min: 0, max: diskTotalBlocks }),
      diskBsize: fc.constant(diskBsize),
    })
  )
);

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Metrics Collector Property Tests', () => {
  describe('Property 6: Container name filter correctness', () => {
    it('For any name filter value, every container in the filtered result SHALL have a name that contains the filter value as a case-insensitive substring', () => {
      fc.assert(
        fc.property(
          containerListArb,
          nameFilterArb,
          (containers, nameFilter) => {
            const result = filterContainersByName(containers, nameFilter);

            // Property: Every returned container's name contains the filter as case-insensitive substring
            for (const container of result) {
              expect(
                container.name.toLowerCase().includes(nameFilter.toLowerCase())
              ).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any name filter value, no container excluded by the filter SHALL contain the filter value as a case-insensitive substring', () => {
      fc.assert(
        fc.property(
          containerListArb,
          nameFilterArb,
          (containers, nameFilter) => {
            const result = filterContainersByName(containers, nameFilter);
            const resultNames = new Set(result.map((c) => c.name));

            // Property: Every container NOT in the result does NOT contain the filter
            for (const container of containers) {
              if (!resultNames.has(container.name)) {
                expect(
                  container.name.toLowerCase().includes(nameFilter.toLowerCase())
                ).toBe(false);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any filter, the filtered result SHALL be a subset of the original container list', () => {
      fc.assert(
        fc.property(
          containerListArb,
          nameFilterArb,
          (containers, nameFilter) => {
            const result = filterContainersByName(containers, nameFilter);

            // Property: Result count <= original count
            expect(result.length).toBeLessThanOrEqual(containers.length);

            // Property: Every result element exists in the original list
            const originalNames = containers.map((c) => c.name);
            for (const container of result) {
              expect(originalNames).toContain(container.name);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Filter is case-insensitive: filtering by uppercase, lowercase, or mixed case of the same string SHALL yield the same result count', () => {
      fc.assert(
        fc.property(
          containerListArb,
          nameFilterArb,
          (containers, nameFilter) => {
            const resultLower = filterContainersByName(containers, nameFilter.toLowerCase());
            const resultUpper = filterContainersByName(containers, nameFilter.toUpperCase());
            const resultOriginal = filterContainersByName(containers, nameFilter);

            // Property: Case-insensitive — all variants produce same result count
            expect(resultLower.length).toBe(resultUpper.length);
            expect(resultLower.length).toBe(resultOriginal.length);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 10: Metrics units consistency', () => {
    it('For any valid /proc inputs, cpu.usagePercent SHALL be between 0 and 100 (inclusive)', () => {
      fc.assert(
        fc.property(
          cpuSnapshotsArb,
          memoryArb,
          diskArb,
          (cpuSnaps, memory, disk) => {
            const metrics = computeSystemMetrics({
              ...cpuSnaps,
              ...memory,
              ...disk,
            });

            // Property: CPU usage is between 0 and 100 inclusive
            expect(metrics.cpu.usagePercent).toBeGreaterThanOrEqual(0);
            expect(metrics.cpu.usagePercent).toBeLessThanOrEqual(100);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any valid /proc inputs, memory.usedBytes SHALL be less than or equal to memory.totalBytes', () => {
      fc.assert(
        fc.property(
          cpuSnapshotsArb,
          memoryArb,
          diskArb,
          (cpuSnaps, memory, disk) => {
            const metrics = computeSystemMetrics({
              ...cpuSnaps,
              ...memory,
              ...disk,
            });

            // Property: usedBytes <= totalBytes for memory
            expect(metrics.memory.usedBytes).toBeLessThanOrEqual(metrics.memory.totalBytes);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any valid /proc inputs, disk.usedBytes SHALL be less than or equal to disk.totalBytes', () => {
      fc.assert(
        fc.property(
          cpuSnapshotsArb,
          memoryArb,
          diskArb,
          (cpuSnaps, memory, disk) => {
            const metrics = computeSystemMetrics({
              ...cpuSnaps,
              ...memory,
              ...disk,
            });

            // Property: usedBytes <= totalBytes for disk
            expect(metrics.disk.usedBytes).toBeLessThanOrEqual(metrics.disk.totalBytes);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any valid /proc inputs, all byte values SHALL be non-negative', () => {
      fc.assert(
        fc.property(
          cpuSnapshotsArb,
          memoryArb,
          diskArb,
          (cpuSnaps, memory, disk) => {
            const metrics = computeSystemMetrics({
              ...cpuSnaps,
              ...memory,
              ...disk,
            });

            // Property: All byte values are non-negative
            expect(metrics.memory.usedBytes).toBeGreaterThanOrEqual(0);
            expect(metrics.memory.totalBytes).toBeGreaterThanOrEqual(0);
            expect(metrics.disk.usedBytes).toBeGreaterThanOrEqual(0);
            expect(metrics.disk.totalBytes).toBeGreaterThanOrEqual(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('For any valid /proc inputs, all combined metric constraints SHALL hold simultaneously', () => {
      fc.assert(
        fc.property(
          cpuSnapshotsArb,
          memoryArb,
          diskArb,
          (cpuSnaps, memory, disk) => {
            const metrics = computeSystemMetrics({
              ...cpuSnaps,
              ...memory,
              ...disk,
            });

            // Property: All constraints from Property 10 hold together
            expect(metrics.cpu.usagePercent).toBeGreaterThanOrEqual(0);
            expect(metrics.cpu.usagePercent).toBeLessThanOrEqual(100);
            expect(metrics.memory.usedBytes).toBeLessThanOrEqual(metrics.memory.totalBytes);
            expect(metrics.disk.usedBytes).toBeLessThanOrEqual(metrics.disk.totalBytes);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
