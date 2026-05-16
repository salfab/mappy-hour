"use client";

import { useEffect, useState } from "react";

/**
 * Tiny debug widget displayed on top of every page when the URL contains
 * `?debug-cpu=1`. Polls `/api/admin/diag/system` every 2s and shows CPU /
 * memory / load — enough to spot a runaway SSE handler or memory leak on
 * Mitch (the prod NUC) without opening DevTools.
 *
 * Why opt-in via query param:
 * - Zero overhead in default prod sessions (no fetch, no React tree).
 * - Easy to flip on for ANY user URL by appending `&debug-cpu=1` — no
 *   feature flag, no admin login.
 * - Easy to share a "look at this!" link.
 *
 * The component is mounted from the root layout, so it's available on every
 * route (home, /maplibre-preview, /admin/*, etc.).
 */

const POLL_INTERVAL_MS = 2_000;

interface SystemMetrics {
  timestamp: string;
  uptimeSeconds: number;
  processUptimeSeconds: number;
  platform: string;
  cpu: {
    averagePercent: number;
    maxCorePercent: number;
    coreCount: number;
    perCorePercent: number[];
    loadAvg: { oneMin: number; fiveMin: number; fifteenMin: number } | null;
  };
  memory: {
    totalMb: number;
    freeMb: number;
    usedMb: number;
    usedPercent: number;
    processRssMb: number;
    processHeapUsedMb: number;
    processHeapTotalMb: number;
  };
}

function useDebugCpuEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      const params = new URLSearchParams(window.location.search);
      setEnabled(params.get("debug-cpu") === "1");
    };
    check();
    // Respond to client-side navigation that mutates the query string.
    window.addEventListener("popstate", check);
    return () => {
      window.removeEventListener("popstate", check);
    };
  }, []);

  return enabled;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
}

/**
 * Pick a Tailwind text-color class based on a 0-100% threshold. Used to
 * highlight a saturated metric in red so it's spottable at a glance.
 */
function severityColor(percent: number): string {
  if (percent >= 85) return "text-red-300";
  if (percent >= 65) return "text-amber-300";
  return "text-emerald-300";
}

export function CpuProbeOverlay() {
  const enabled = useDebugCpuEnabled();
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const abortController = new AbortController();

    const fetchOnce = async () => {
      try {
        const response = await fetch("/api/admin/diag/system", {
          cache: "no-store",
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as SystemMetrics;
        if (!cancelled) {
          setMetrics(data);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "fetch failed");
      }
    };

    fetchOnce();
    const intervalId = window.setInterval(fetchOnce, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      abortController.abort();
      window.clearInterval(intervalId);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-3 top-3 z-[9999] select-none rounded-md bg-slate-900/85 px-3 py-2 font-mono text-[11px] leading-tight text-slate-100 shadow-lg backdrop-blur-sm"
    >
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-400">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
        <span>debug-cpu</span>
      </div>
      {error ? (
        <div className="text-red-300">err: {error}</div>
      ) : !metrics ? (
        <div className="text-slate-400">measuring</div>
      ) : (
        <div className="space-y-0.5">
          <div>
            <span className="text-slate-400">cpu </span>
            <span className={severityColor(metrics.cpu.averagePercent)}>
              {metrics.cpu.averagePercent.toFixed(0)}%
            </span>
            <span className="text-slate-500"> avg</span>
            <span className="text-slate-400"> | </span>
            <span className={severityColor(metrics.cpu.maxCorePercent)}>
              {metrics.cpu.maxCorePercent.toFixed(0)}%
            </span>
            <span className="text-slate-500"> max</span>
            <span className="text-slate-500"> ({metrics.cpu.coreCount}c)</span>
          </div>
          <div>
            <span className="text-slate-400">mem </span>
            <span className={severityColor(metrics.memory.usedPercent)}>
              {metrics.memory.usedMb} MB
            </span>
            <span className="text-slate-500"> / {metrics.memory.totalMb} MB</span>
          </div>
          <div>
            <span className="text-slate-400">node </span>
            <span className="text-slate-100">{metrics.memory.processRssMb} MB</span>
            <span className="text-slate-500"> rss</span>
            <span className="text-slate-400"> | </span>
            <span className="text-slate-100">{metrics.memory.processHeapUsedMb} MB</span>
            <span className="text-slate-500"> heap</span>
          </div>
          {metrics.cpu.loadAvg ? (
            <div>
              <span className="text-slate-400">load </span>
              <span className="text-slate-100">
                {metrics.cpu.loadAvg.oneMin.toFixed(2)}/{metrics.cpu.loadAvg.fiveMin.toFixed(2)}/
                {metrics.cpu.loadAvg.fifteenMin.toFixed(2)}
              </span>
            </div>
          ) : (
            <div className="text-slate-500">load n/a ({metrics.platform})</div>
          )}
          <div className="text-[9px] text-slate-500">
            up {formatUptime(metrics.processUptimeSeconds)} (host{" "}
            {formatUptime(metrics.uptimeSeconds)})
          </div>
        </div>
      )}
    </div>
  );
}
