/**
 * Parse the [tile ...] log lines from a precompute run and aggregate per-phase
 * timings. Reads from stdin or a file path argument.
 *
 * Usage:
 *   npx tsx scripts/diag/_parse-tile-timings.ts <log-file> [--top=20]
 */
import fs from "node:fs";

interface TilePhases {
  total: number;
  cpuPercent: number;
  horizon: number;
  sources: number;
  points: number;
  pointsLoopMs: number;
  evalTotal: number;
  setup: number;
  dispatch: number;
  frameLoop: number;
  other: number;
  outdoor: number;
}

const TILE_LINE_RE = /\[tile [^\]]+\]\s+([\d.]+)s total \(cpu (\d+)%\).*?horizon ([\d.]+)s.*?sources ([\d.]+)s.*?points ([\d.]+)s \[ctx \d+ms, loop (\d+)ms for \d+ pts \((\d+) in, (\d+) out\)\].*?eval ([\d.]+)s \[setup ([\d.]+)s.*?dispatch ([\d.]+)s, frameLoop ([\d.]+)s\].*?other ([\d.]+)s/;

function parseLine(line: string): TilePhases | null {
  const m = TILE_LINE_RE.exec(line);
  if (!m) return null;
  return {
    total: parseFloat(m[1]),
    cpuPercent: parseInt(m[2], 10),
    horizon: parseFloat(m[3]),
    sources: parseFloat(m[4]),
    points: parseFloat(m[5]),
    pointsLoopMs: parseInt(m[6], 10),
    outdoor: parseInt(m[8], 10),
    evalTotal: parseFloat(m[9]),
    setup: parseFloat(m[10]),
    dispatch: parseFloat(m[11]),
    frameLoop: parseFloat(m[12]),
    other: parseFloat(m[13]),
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

function fmt(n: number, unit: string): string {
  return `${n.toFixed(2)} ${unit}`.padStart(12);
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: tsx _parse-tile-timings.ts <log-file>");
    process.exit(2);
  }
  const minTotal = parseFloat(args.find((a) => a.startsWith("--min-total="))?.slice(12) ?? "3");

  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\n/);

  const tiles: TilePhases[] = [];
  for (const line of lines) {
    if (!line.includes("[tile ")) continue;
    const t = parseLine(line);
    if (t) tiles.push(t);
  }

  console.log(`Parsed ${tiles.length} tile lines.`);

  // Filter to "real compute" tiles: total > minTotal (default 3s) excludes
  // skip-existing fast paths and pure post-warmup quick re-checks.
  const real = tiles.filter((t) => t.total >= minTotal);
  console.log(`Real-compute tiles (total >= ${minTotal}s): ${real.length}`);

  if (real.length === 0) {
    console.log("\n(No tiles met the threshold. Lower --min-total or include warmup-cold tiles.)");
    return;
  }

  const phaseNames: Array<keyof TilePhases> = [
    "total",
    "horizon",
    "sources",
    "points",
    "evalTotal",
    "setup",
    "dispatch",
    "frameLoop",
    "other",
  ];

  console.log("\n--- Per-phase aggregate (real-compute tiles only) ---");
  console.log(
    "Phase".padEnd(14) +
      "mean".padStart(12) +
      "p50".padStart(12) +
      "p95".padStart(12) +
      "p99".padStart(12) +
      "max".padStart(12) +
      "% of total".padStart(14),
  );
  const totalMean = real.reduce((s, t) => s + t.total, 0) / real.length;
  for (const phase of phaseNames) {
    const values = real.map((t) => t[phase] as number).sort((a, b) => a - b);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const pct = (mean / totalMean) * 100;
    console.log(
      phase.padEnd(14) +
        fmt(mean, "s") +
        fmt(quantile(values, 0.5), "s") +
        fmt(quantile(values, 0.95), "s") +
        fmt(quantile(values, 0.99), "s") +
        fmt(values[values.length - 1], "s") +
        `${pct.toFixed(1)}%`.padStart(14),
    );
  }

  const cpuValues = real.map((t) => t.cpuPercent).sort((a, b) => a - b);
  const cpuMean = cpuValues.reduce((s, v) => s + v, 0) / cpuValues.length;
  console.log(
    `\nCPU saturation: mean ${cpuMean.toFixed(0)}% — p50 ${quantile(cpuValues, 0.5).toFixed(0)}% — p95 ${quantile(cpuValues, 0.95).toFixed(0)}%`,
  );

  // Sum-check: do horizon + sources + points + eval + other ≈ total?
  const sumsCheck = real.map((t) => ({
    total: t.total,
    sum: t.horizon + t.sources + t.points + t.evalTotal + t.other,
  }));
  const meanGap =
    sumsCheck.reduce((s, t) => s + (t.total - t.sum), 0) / sumsCheck.length;
  console.log(
    `\nSum check (horizon+sources+points+eval+other vs total): mean gap ${(meanGap * 1000).toFixed(0)} ms (positive = unaccounted time outside named phases — IPC, atlas merge, atlas write)`,
  );

  // Sub-eval breakdown
  const subEvalSum = real.map(
    (t) => ({ evalTotal: t.evalTotal, sub: t.setup + t.frameLoop }),
  );
  const meanSubGap =
    subEvalSum.reduce((s, t) => s + (t.evalTotal - t.sub), 0) / subEvalSum.length;
  console.log(
    `Sub-eval check (setup+frameLoop vs evalTotal, dispatch overlaps with setup): mean gap ${(meanSubGap * 1000).toFixed(0)} ms`,
  );

  console.log("\n--- Top phases by % of total time ---");
  const phasePcts = phaseNames
    .filter((p) => p !== "total" && p !== "evalTotal")
    .map((p) => {
      const mean = real.reduce((s, t) => s + (t[p] as number), 0) / real.length;
      return { phase: p, mean, pct: (mean / totalMean) * 100 };
    })
    .sort((a, b) => b.pct - a.pct);
  for (const p of phasePcts) {
    console.log(`  ${p.phase.padEnd(14)} ${p.mean.toFixed(2).padStart(8)} s  ${p.pct.toFixed(1)}%`);
  }
}

main();
