import os from "node:os";

import { NextResponse } from "next/server";

import { getActiveCount } from "@/lib/observability/active-sse";
import {
  getRecentWarnings,
  recordIfWarning,
  type CpuWarning,
  type SystemSnapshot,
} from "@/lib/observability/cpu-warnings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight system probe for /admin/diag/system.
 *
 * Designed to be polled every 1-5s by a debug overlay or external scrapper
 * to follow the load on Mitch (prod NUC) while users hammer the SSE timeline
 * with rapid toggle changes (vegetation, sample rate, etc).
 *
 * Caveats:
 * - Numbers reflect what Node sees from INSIDE the Docker container, not
 *   the host machine. cgroups limits (CPU shares, memory limits) skew the
 *   raw `os.totalmem()` reading: on a constrained container it returns the
 *   limit, not the physical host RAM.
 * - `os.loadavg()` returns 0/0/0 on Windows (host development), so the
 *   widget should treat zeros as "unsupported" rather than "idle".
 * - CPU percentage is computed from two `os.cpus()` snapshots ~250ms apart
 *   to capture an *instantaneous* average; this is intentionally a short
 *   window — long enough to smooth out scheduler jitter, short enough to
 *   react to a burst of incoming SSE requests.
 */

const CPU_SAMPLE_INTERVAL_MS = 250;

interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

function snapshotCpu(): CpuTimes[] {
  return os.cpus().map((cpu) => ({ ...cpu.times }));
}

function diffCpu(before: CpuTimes, after: CpuTimes): { busy: number; total: number } {
  const busy =
    after.user -
    before.user +
    (after.nice - before.nice) +
    (after.sys - before.sys) +
    (after.irq - before.irq);
  const idle = after.idle - before.idle;
  const total = busy + idle;
  return { busy, total };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function measureCpuPercent(): Promise<{
  averagePercent: number;
  maxCorePercent: number;
  coreCount: number;
  perCorePercent: number[];
}> {
  const before = snapshotCpu();
  await sleep(CPU_SAMPLE_INTERVAL_MS);
  const after = snapshotCpu();

  const coreCount = Math.min(before.length, after.length);
  const perCorePercent: number[] = [];
  for (let i = 0; i < coreCount; i += 1) {
    const { busy, total } = diffCpu(before[i], after[i]);
    const percent = total > 0 ? (busy / total) * 100 : 0;
    perCorePercent.push(Number(percent.toFixed(1)));
  }

  const averagePercent =
    perCorePercent.length > 0
      ? Number(
          (perCorePercent.reduce((sum, value) => sum + value, 0) / perCorePercent.length).toFixed(
            1,
          ),
        )
      : 0;
  const maxCorePercent =
    perCorePercent.length > 0 ? Number(Math.max(...perCorePercent).toFixed(1)) : 0;

  return { averagePercent, maxCorePercent, coreCount, perCorePercent };
}

export async function GET(): Promise<NextResponse> {
  try {
    const [{ averagePercent, maxCorePercent, coreCount, perCorePercent }] = await Promise.all([
      measureCpuPercent(),
    ]);

    const loadAvg = os.loadavg();
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = totalMemBytes - freeMemBytes;
    const memoryUsage = process.memoryUsage();
    const activeSse = getActiveCount();

    const cpuBlock = {
      averagePercent,
      maxCorePercent,
      coreCount,
      perCorePercent,
      // os.loadavg() returns [0,0,0] on Windows. Surface it as null there
      // so the widget can render "n/a" rather than a misleading "0.0".
      loadAvg:
        process.platform === "win32"
          ? null
          : {
              oneMin: Number(loadAvg[0].toFixed(2)),
              fiveMin: Number(loadAvg[1].toFixed(2)),
              fifteenMin: Number(loadAvg[2].toFixed(2)),
            },
    };

    const timestamp = new Date().toISOString();
    const snapshotForRule: SystemSnapshot = {
      timestamp,
      cpu: {
        maxCorePercent: cpuBlock.maxCorePercent,
        coreCount: cpuBlock.coreCount,
        loadAvg: cpuBlock.loadAvg,
      },
    };
    // Side effect: may push a new entry into the warning ring buffer if
    // we just crossed the threshold while ≥2 SSE/viewport requests were
    // active. Anti-spam (5s coalesce) lives inside `recordIfWarning`.
    const justRecorded: CpuWarning | null = recordIfWarning(snapshotForRule);

    return NextResponse.json(
      {
        timestamp,
        platform: process.platform,
        nodeVersion: process.version,
        uptimeSeconds: Math.round(os.uptime()),
        processUptimeSeconds: Math.round(process.uptime()),
        cpu: cpuBlock,
        memory: {
          // OS-level view (host or cgroup-limited depending on container).
          totalMb: Math.round(totalMemBytes / 1024 / 1024),
          freeMb: Math.round(freeMemBytes / 1024 / 1024),
          usedMb: Math.round(usedMemBytes / 1024 / 1024),
          usedPercent: Number(((usedMemBytes / totalMemBytes) * 100).toFixed(1)),
          // Node process-level view — closer to "how much is the Next.js
          // server actually consuming on Mitch".
          processRssMb: Math.round(memoryUsage.rss / 1024 / 1024),
          processHeapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          processHeapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
          processExternalMb: Math.round(memoryUsage.external / 1024 / 1024),
        },
        // In-flight SSE / viewport-snap requests. Maintained by route
        // handlers via try/finally pairs around `increment` / `decrement`
        // in `@/lib/observability/active-sse`. Surface both the total and
        // a per-route breakdown so the overlay can render `(t:2 v:1)`.
        activeSse: {
          total: activeSse.total,
          byRoute: activeSse.byRoute,
        },
        // Newest-first list of CPU pressure events. Always returned (empty
        // array when the buffer is fresh); the widget renders a badge with
        // the count and a collapsible inline list. `justRecorded` flags
        // whether this poll *added* an entry — used by the overlay to
        // optionally flash the badge but otherwise informational.
        recentWarnings: getRecentWarnings(10),
        warningRecordedThisPoll: justRecorded !== null,
      },
      {
        headers: {
          // Belt-and-braces: even though `dynamic = "force-dynamic"` should
          // prevent caching, some intermediaries (Tailscale Funnel cache,
          // CDN) might still grab the response. Tell them not to.
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to read system metrics.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
