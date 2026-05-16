/**
 * In-memory circular buffer of CPU pressure warnings. The `/api/admin/diag/
 * system` endpoint feeds it a snapshot on every poll (~once every 2s when
 * the `?debug-cpu=1` overlay is open); the buffer remembers when the
 * machine was actually under stress so we can review pressure spikes
 * after the fact rather than only see the live value.
 *
 * Why in-memory and not persisted
 * -------------------------------
 * The signal is short-lived diagnostic data: if the Next server restarts
 * the spike was almost certainly tied to that restart. Persisting it
 * would also force an authentication / size discussion we don't need.
 *
 * Buffer size (50) is deliberately small: with the 5s anti-spam window
 * below, 50 entries cover ~250s of distinct pressure events — more than
 * enough to triage the last few minutes from the overlay UI.
 *
 * Anti-spam (coalescing)
 * ----------------------
 * Without coalescing, a 10-second pressure spike sampled every 2s would
 * generate 5 nearly-identical warnings and crowd out earlier history.
 * Instead we treat consecutive samples that stay above threshold as a
 * single "still hot" event: only the first sample of a rafale (or one
 * that arrives more than COALESCE_WINDOW_MS after the previous warning)
 * is recorded. As soon as the metrics drop below threshold for longer
 * than the window, the next over-threshold sample starts a fresh entry.
 */

import {
  type ActiveSseSnapshot,
  getActiveCount,
} from "@/lib/observability/active-sse";

/**
 * A snapshot of the system probe as exposed by `/api/admin/diag/system`.
 * Kept narrow on purpose: only the fields needed by the warning rule live
 * here so the test suite doesn't have to reproduce the full payload.
 */
export interface SystemSnapshot {
  timestamp: string;
  cpu: {
    maxCorePercent: number;
    coreCount: number;
    loadAvg: { oneMin: number; fiveMin: number; fifteenMin: number } | null;
  };
}

export type CpuWarningReason = "cpu-high" | "loadavg-high" | "both";

export interface CpuWarning {
  timestamp: string;
  cpuMaxCorePercent: number;
  loadAvg1m: number | null;
  coreCount: number;
  activeSseTotal: number;
  activeSseByRoute: Record<string, number>;
  reason: CpuWarningReason;
}

const MAX_BUFFER = 50;
const COALESCE_WINDOW_MS = 5_000;
const CPU_THRESHOLD_PERCENT = 75;
const MIN_ACTIVE_SSE_FOR_WARNING = 2;

const GLOBAL_KEY = Symbol.for("mappyhour.observability.cpuWarnings");

interface CpuWarningRegistry {
  buffer: CpuWarning[];
  lastWarningTs: number | null;
}

interface GlobalWithRegistry {
  [GLOBAL_KEY]?: CpuWarningRegistry;
}

function getRegistry(): CpuWarningRegistry {
  const slot = globalThis as GlobalWithRegistry;
  let registry = slot[GLOBAL_KEY];
  if (!registry) {
    registry = { buffer: [], lastWarningTs: null };
    slot[GLOBAL_KEY] = registry;
  }
  return registry;
}

interface ThresholdResult {
  triggered: boolean;
  reason: CpuWarningReason;
}

function evaluateThreshold(snapshot: SystemSnapshot): ThresholdResult {
  const cpuHigh = snapshot.cpu.maxCorePercent > CPU_THRESHOLD_PERCENT;
  const loadAvg1m = snapshot.cpu.loadAvg?.oneMin ?? null;
  // loadavg returns null on Windows (host dev) — fall back to CPU-only in
  // that case so the dev box still produces warnings when we exercise the
  // overlay locally. On Linux (Mitch) both signals are available and we
  // combine them with OR so we can catch either "a single core is pinned"
  // (cpu-high) or "scheduler queue depth exceeds core count" (loadavg-high).
  const loadHigh =
    loadAvg1m !== null && loadAvg1m > snapshot.cpu.coreCount;
  if (cpuHigh && loadHigh) {
    return { triggered: true, reason: "both" };
  }
  if (cpuHigh) {
    return { triggered: true, reason: "cpu-high" };
  }
  if (loadHigh) {
    return { triggered: true, reason: "loadavg-high" };
  }
  return { triggered: false, reason: "cpu-high" };
}

function pushBuffer(registry: CpuWarningRegistry, warning: CpuWarning): void {
  registry.buffer.push(warning);
  while (registry.buffer.length > MAX_BUFFER) {
    registry.buffer.shift();
  }
}

interface RecordOptions {
  // Indirection so tests can inject a deterministic value without
  // monkey-patching `Date.now()`. Production callers omit this and we
  // fall back to the wall clock.
  now?: () => number;
  // Same indirection for the active-SSE snapshot, so we can simulate
  // load without spinning up real fetch handlers in tests.
  getActive?: () => ActiveSseSnapshot;
}

/**
 * Record a warning if the snapshot crosses the threshold AND at least
 * `MIN_ACTIVE_SSE_FOR_WARNING` SSE/viewport requests were in flight at
 * sample time. Returns the new entry (so callers can echo it back in
 * the same response) or `null` if no entry was added — either because
 * the snapshot was under threshold, the active-SSE precondition wasn't
 * met, or the previous warning was inside the coalesce window.
 */
export function recordIfWarning(
  snapshot: SystemSnapshot,
  options?: RecordOptions,
): CpuWarning | null {
  const now = options?.now ?? Date.now;
  const activeSnapshot = (options?.getActive ?? getActiveCount)();
  if (activeSnapshot.total < MIN_ACTIVE_SSE_FOR_WARNING) {
    return null;
  }
  const threshold = evaluateThreshold(snapshot);
  if (!threshold.triggered) {
    return null;
  }
  const registry = getRegistry();
  const tsNow = now();
  if (
    registry.lastWarningTs !== null &&
    tsNow - registry.lastWarningTs < COALESCE_WINDOW_MS
  ) {
    // Same pressure rafale, still inside the 5s coalesce window — skip
    // so the buffer keeps room for distinct events.
    return null;
  }
  const warning: CpuWarning = {
    timestamp: snapshot.timestamp,
    cpuMaxCorePercent: snapshot.cpu.maxCorePercent,
    loadAvg1m: snapshot.cpu.loadAvg?.oneMin ?? null,
    coreCount: snapshot.cpu.coreCount,
    activeSseTotal: activeSnapshot.total,
    activeSseByRoute: activeSnapshot.byRoute,
    reason: threshold.reason,
  };
  pushBuffer(registry, warning);
  registry.lastWarningTs = tsNow;
  return warning;
}

/**
 * Return the most recent warnings, newest first. `limit` defaults to the
 * full buffer.
 */
export function getRecentWarnings(limit: number = MAX_BUFFER): CpuWarning[] {
  const { buffer } = getRegistry();
  const slice = buffer.slice(-limit);
  return slice.slice().reverse();
}

export function __resetForTests(): void {
  const registry = getRegistry();
  registry.buffer = [];
  registry.lastWarningTs = null;
}

// Exposed for the diag endpoint so the response payload can label its
// thresholds explicitly (useful for a future "why was this flagged?"
// tooltip in the overlay).
export const CPU_WARNING_THRESHOLDS = Object.freeze({
  cpuMaxCorePercent: CPU_THRESHOLD_PERCENT,
  minActiveSse: MIN_ACTIVE_SSE_FOR_WARNING,
  coalesceWindowMs: COALESCE_WINDOW_MS,
  maxBufferSize: MAX_BUFFER,
});
