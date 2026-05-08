/**
 * Aggregate per-tile profiling from a precompute log: parses [tile ...],
 * [rust-ipc], [atlas-merge], [atlas-write] lines and joins by tileId.
 *
 * Usage: npx tsx scripts/diag/_parse-tile-timings-full.ts <log-file>
 */
import fs from "node:fs";

interface TileSample {
  tileId: string;
  total: number;
  cpuPercent: number;
  horizon: number;
  sources: number;
  points: number;
  evalTotal: number;
  setup: number;
  dispatch: number;
  frameLoop: number;
  other: number;
  outdoor: number;
  ipcMs?: number;
  mergeMs?: number;
  writeMs?: number;
  totalBucketsAfterMerge?: number;
  existingAtlas?: boolean;
}

const TILE_LINE_RE = /\[tile (\S+)\]\s+([\d.]+)s total \(cpu (\d+)%\).*?horizon ([\d.]+)s.*?sources ([\d.]+)s.*?points ([\d.]+)s.*?\((\d+) in, (\d+) out\)\].*?eval ([\d.]+)s \[setup ([\d.]+)s.*?dispatch ([\d.]+)s, frameLoop ([\d.]+)s\].*?other ([\d.]+)s/;
const IPC_RE = /\[rust-ipc\] evaluateBatch\s+(\d+)ms\s+frames=(\d+)\s+points=(\d+)/;
const MERGE_RE = /\[atlas-merge\]\s+(\S+)\s+(\d+)ms\s+newBuckets=(\d+)\s+totalBuckets=(\d+)\s+existing=(true|false)/;
const WRITE_RE = /\[atlas-write\]\s+(\S+)\s+(\d+)ms\s+buckets=(\d+)/;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function fmt(n: number, unit = "ms"): string {
  return `${n.toFixed(1)} ${unit}`.padStart(11);
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: tsx _parse-tile-timings-full.ts <log-file>");
    process.exit(2);
  }
  const lines = fs.readFileSync(file, "utf8").split(/\n/);

  const samples = new Map<string, TileSample>();
  let pendingIpcMs: number | null = null;

  for (const line of lines) {
    if (line.includes("[rust-ipc]")) {
      const m = IPC_RE.exec(line);
      if (m) pendingIpcMs = parseInt(m[1], 10);
      continue;
    }
    if (line.includes("[tile ")) {
      const m = TILE_LINE_RE.exec(line);
      if (!m) continue;
      const sample: TileSample = {
        tileId: m[1],
        total: parseFloat(m[2]),
        cpuPercent: parseInt(m[3], 10),
        horizon: parseFloat(m[4]),
        sources: parseFloat(m[5]),
        points: parseFloat(m[6]),
        outdoor: parseInt(m[8], 10),
        evalTotal: parseFloat(m[9]),
        setup: parseFloat(m[10]),
        dispatch: parseFloat(m[11]),
        frameLoop: parseFloat(m[12]),
        other: parseFloat(m[13]),
      };
      if (pendingIpcMs !== null) {
        sample.ipcMs = pendingIpcMs;
        pendingIpcMs = null;
      }
      samples.set(sample.tileId, sample);
      continue;
    }
    if (line.includes("[atlas-merge]")) {
      const m = MERGE_RE.exec(line);
      if (!m) continue;
      const s = samples.get(m[1]);
      if (s) {
        s.mergeMs = parseInt(m[2], 10);
        s.totalBucketsAfterMerge = parseInt(m[4], 10);
        s.existingAtlas = m[5] === "true";
      }
      continue;
    }
    if (line.includes("[atlas-write]")) {
      const m = WRITE_RE.exec(line);
      if (!m) continue;
      const s = samples.get(m[1]);
      if (s) s.writeMs = parseInt(m[2], 10);
    }
  }

  // Filter to tiles with full instrumentation (= real compute, has ipc/merge/write)
  const real = Array.from(samples.values()).filter(
    (s) => s.ipcMs != null && s.mergeMs != null && s.writeMs != null && s.total >= 0.5,
  );
  console.log(`Real-compute tiles with full instrumentation: ${real.length}/${samples.size}\n`);

  if (real.length === 0) return;

  type PhaseKey =
    | "total" | "horizon" | "sources" | "points" | "evalTotal"
    | "setup" | "dispatch" | "frameLoop" | "other"
    | "ipcMs" | "mergeMs" | "writeMs";
  const phases: { key: PhaseKey; toMs: (v: number) => number; label: string }[] = [
    { key: "total", toMs: (v) => v * 1000, label: "TOTAL" },
    { key: "horizon", toMs: (v) => v * 1000, label: "horizon" },
    { key: "sources", toMs: (v) => v * 1000, label: "sources" },
    { key: "points", toMs: (v) => v * 1000, label: "points" },
    { key: "evalTotal", toMs: (v) => v * 1000, label: "eval (total)" },
    { key: "setup", toMs: (v) => v * 1000, label: "  setup" },
    { key: "dispatch", toMs: (v) => v * 1000, label: "  dispatch (GPU)" },
    { key: "frameLoop", toMs: (v) => v * 1000, label: "  frameLoop" },
    { key: "ipcMs", toMs: (v) => v, label: "ipc evaluateBatch (subset of dispatch)" },
    { key: "mergeMs", toMs: (v) => v, label: "atlas-merge" },
    { key: "writeMs", toMs: (v) => v, label: "atlas-write" },
    { key: "other", toMs: (v) => v * 1000, label: "other (hooks)" },
  ];

  const totalMean =
    real.reduce((s, t) => s + t.total * 1000, 0) / real.length;

  console.log("Phase".padEnd(40) + "mean".padStart(11) + "p50".padStart(11) + "p95".padStart(11) + "p99".padStart(11) + "max".padStart(11) + "% of total".padStart(13));
  for (const ph of phases) {
    const values = real
      .map((t) => {
        const v = t[ph.key];
        return v == null ? null : ph.toMs(v as number);
      })
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    if (!values.length) continue;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const pct = (mean / totalMean) * 100;
    console.log(
      ph.label.padEnd(40) +
        fmt(mean) +
        fmt(quantile(values, 0.5)) +
        fmt(quantile(values, 0.95)) +
        fmt(quantile(values, 0.99)) +
        fmt(values[values.length - 1]) +
        `${pct.toFixed(1)}%`.padStart(13),
    );
  }

  // Sum check: phases additives = horizon + sources + points + eval + other (atlas-merge/write are sub-phases of frameLoop area or end-of-tile)
  const additiveSum = real.map((t) => ({
    total: t.total * 1000,
    sum: (t.horizon + t.sources + t.points + t.evalTotal + t.other) * 1000,
  }));
  const meanGap = additiveSum.reduce((s, t) => s + (t.total - t.sum), 0) / additiveSum.length;
  console.log(
    `\nUnaccounted time (total - horizon - sources - points - eval - other): mean ${meanGap.toFixed(0)} ms`,
  );
  console.log(
    `   This gap should align with atlas-merge + atlas-write outside the [tile ...] timing.`,
  );

  // Tiles where atlas existed (cumulative atlas, slow merge/write) vs fresh
  const cumul = real.filter((s) => s.existingAtlas === true);
  const fresh = real.filter((s) => s.existingAtlas === false);
  if (cumul.length && fresh.length) {
    console.log(`\nBy atlas state:`);
    console.log(`  cumulative atlas (existing=true): ${cumul.length} tiles, mean atlas-write ${(cumul.reduce((s, t) => s + (t.writeMs ?? 0), 0) / cumul.length).toFixed(0)} ms, mean atlas-merge ${(cumul.reduce((s, t) => s + (t.mergeMs ?? 0), 0) / cumul.length).toFixed(0)} ms, mean total ${(cumul.reduce((s, t) => s + t.total * 1000, 0) / cumul.length).toFixed(0)} ms`);
    console.log(`  fresh atlas (existing=false):     ${fresh.length} tiles, mean atlas-write ${(fresh.reduce((s, t) => s + (t.writeMs ?? 0), 0) / fresh.length).toFixed(0)} ms, mean atlas-merge ${(fresh.reduce((s, t) => s + (t.mergeMs ?? 0), 0) / fresh.length).toFixed(0)} ms, mean total ${(fresh.reduce((s, t) => s + t.total * 1000, 0) / fresh.length).toFixed(0)} ms`);
  }
}

main();
