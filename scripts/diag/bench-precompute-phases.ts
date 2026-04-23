/**
 * Aggregate per-phase stats from precompute tile log lines.
 *
 * Parses lines like:
 *   [tile e2531000_n1151000_s250] 1.7s total — horizon 0.1s, sources 0.1s,
 *   points 0.5s, eval 0.9s [setup 0.05s, dispatch 0.80s, frameLoop 0.85s],
 *   other 0.10s (1234 evals, 729 µs/eval) — 2500 grid pts, 1800 outdoor, 700 indoor
 *
 * Usage:
 *   npx tsx scripts/diag/bench-precompute-phases.ts < path/to/log.txt
 *   npx tsx scripts/diag/bench-precompute-phases.ts path/to/log.txt
 *   pnpm precompute:all-regions:vulkan ... 2>&1 | tee run.log | npx tsx scripts/diag/bench-precompute-phases.ts
 *
 * Output: one table with count, mean, p50, p90, p99, max for each phase,
 * plus diagnostics on bimodality, setup amortization, and file-write outliers.
 */
import fs from "node:fs";

type PhaseSample = {
  tileId: string;
  total: number;
  horizon: number;
  sources: number;
  points: number;
  eval: number;
  setup: number;
  dispatch: number;
  frameLoop: number;
  other: number;
  evals: number;
  usPerEval: number;
  gridPts: number;
  outdoor: number;
  indoor: number;
};

// Tolerant parser. Accepts:
//   - optional ANSI escape prefix (progress TTY repaint like \x1b[2A\x1b[J)
//   - em-dash or hyphen for section separators
//   - optional `[setup .., dispatch .., frameLoop ..]` eval breakdown (new instrumentation)
//   - optional `, other ..s` section (new instrumentation)
// Old log format: `eval Xs (N evals, Y µs/eval) — ...`
// New log format: `eval Xs [setup .., dispatch .., frameLoop ..], other .. (N evals, Y µs/eval) — ...`
const ANSI_PREFIX = /^(?:\x1b\[[\d;?]*[A-Za-z])*/;
const TILE_LINE_RE =
  /\[tile\s+([^\]]+)\]\s+([\d.]+)s\s+total\s+[—\-]\s+horizon\s+([\d.]+)s,\s+sources\s+([\d.]+)s,\s+points\s+([\d.]+)s,\s+eval\s+([\d.]+)s(?:\s+\[setup\s+([\d.]+)s,\s+dispatch\s+([\d.]+)s,\s+frameLoop\s+([\d.]+)s\])?(?:,\s+other\s+([\d.]+)s)?\s+\((\d+)\s+evals,\s+(\d+)\s+µs\/eval\)\s+[—\-]\s+(\d+)\s+grid\s+pts,\s+(\d+)\s+outdoor,\s+(\d+)\s+indoor/u;

function parseLine(rawLine: string): PhaseSample | null {
  const line = rawLine.replace(ANSI_PREFIX, "");
  const m = TILE_LINE_RE.exec(line);
  if (!m) return null;
  return {
    tileId: m[1],
    total: Number(m[2]),
    horizon: Number(m[3]),
    sources: Number(m[4]),
    points: Number(m[5]),
    eval: Number(m[6]),
    setup: m[7] !== undefined ? Number(m[7]) : NaN,
    dispatch: m[8] !== undefined ? Number(m[8]) : NaN,
    frameLoop: m[9] !== undefined ? Number(m[9]) : NaN,
    other: m[10] !== undefined ? Number(m[10]) : NaN,
    evals: Number(m[11]),
    usPerEval: Number(m[12]),
    gridPts: Number(m[13]),
    outdoor: Number(m[14]),
    indoor: Number(m[15]),
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

type Stats = {
  name: string;
  n: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  sum: number;
};

function stats(name: string, values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    name,
    n: values.length,
    mean: values.length ? sum / values.length : 0,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    sum,
  };
}

function fmt(s: number, digits = 2): string {
  return s.toFixed(digits);
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function printTable(rows: Stats[], totalSum: number): void {
  const header = ["phase", "n", "mean", "p50", "p90", "p99", "max", "sum", "% of total"];
  const data = rows.map((r) => [
    r.name,
    String(r.n),
    fmt(r.mean),
    fmt(r.p50),
    fmt(r.p90),
    fmt(r.p99),
    fmt(r.max),
    fmt(r.sum, 1),
    pct(r.sum, totalSum),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmtRow = (row: string[]) =>
    row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  console.log(fmtRow(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) console.log(fmtRow(row));
}

function readInput(): string {
  const fileArg = process.argv[2];
  if (fileArg) {
    if (!fs.existsSync(fileArg)) {
      console.error(`File not found: ${fileArg}`);
      process.exit(1);
    }
    return fs.readFileSync(fileArg, "utf8");
  }
  if (process.stdin.isTTY) {
    console.error(
      "Usage: npx tsx scripts/diag/bench-precompute-phases.ts <log-file>\n" +
        "       ... | npx tsx scripts/diag/bench-precompute-phases.ts",
    );
    process.exit(1);
  }
  return fs.readFileSync(0, "utf8");
}

function main(): void {
  const input = readInput();
  const samples: PhaseSample[] = [];
  for (const line of input.split(/\r?\n/)) {
    const s = parseLine(line);
    if (s) samples.push(s);
  }
  if (samples.length === 0) {
    console.error("No [tile ...] lines matched. Check log format.");
    process.exit(1);
  }

  const totalSum = samples.reduce((a, s) => a + s.total, 0);

  console.log(`\n== bench-precompute-phases ==`);
  console.log(`Parsed ${samples.length} tile log lines, total wall time ${fmt(totalSum, 1)}s`);
  console.log();

  const pick = (f: (s: PhaseSample) => number) =>
    samples.map(f).filter((v) => Number.isFinite(v));
  const rows: Stats[] = [
    stats("total", pick((s) => s.total)),
    stats("  horizon", pick((s) => s.horizon)),
    stats("  sources", pick((s) => s.sources)),
    stats("  points", pick((s) => s.points)),
    stats("  eval", pick((s) => s.eval)),
    stats("    setup", pick((s) => s.setup)),
    stats("    dispatch", pick((s) => s.dispatch)),
    stats("    frameLoop", pick((s) => s.frameLoop)),
    stats("  other", pick((s) => s.other)),
  ].filter((r) => r.n > 0);
  printTable(rows, totalSum);
  const hasNewInstrumentation = samples.some((s) => Number.isFinite(s.other));
  if (!hasNewInstrumentation) {
    console.log(
      `\n(note: log predates setup/dispatch/frameLoop/other instrumentation — phases omitted)`,
    );
  }

  // ---- Diagnostics -------------------------------------------------------
  console.log(`\n== diagnostics ==\n`);

  // 1. Bimodality per phase: ratio p99/p50. >2x suggests cold/warm or outliers.
  console.log(`Bimodality check (p99/p50 — >2.0 = distribution is skewed):`);
  for (const r of rows) {
    if (r.p50 < 0.01) continue;
    const ratio = r.p99 / r.p50;
    const flag = ratio > 2 ? "  << skewed" : "";
    console.log(`  ${r.name.padEnd(12)} p50=${fmt(r.p50)}s p99=${fmt(r.p99)}s  ratio=${fmt(ratio)}${flag}`);
  }

  // 2. Setup amortization (only if setup instrumentation exists)
  if (hasNewInstrumentation) {
    console.log(`\nSetup amortization (does setup drop when prev tile is same-zone?):`);
    const firstSetup: number[] = [];
    const samezone: number[] = [];
    const crosszone: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i].setup)) continue;
      if (i === 0) {
        firstSetup.push(samples[i].setup);
        continue;
      }
      const curZone = samples[i].tileId.slice(0, 9);
      const prevZone = samples[i - 1].tileId.slice(0, 9);
      if (curZone === prevZone) samezone.push(samples[i].setup);
      else crosszone.push(samples[i].setup);
    }
    const sZ = stats("same-zone", samezone);
    const cZ = stats("cross-zone", crosszone);
    console.log(`  first tile setup:  ${fmt(firstSetup[0] ?? 0)}s`);
    console.log(`  same-zone  (n=${sZ.n}):  mean ${fmt(sZ.mean)}s  p50 ${fmt(sZ.p50)}s  p90 ${fmt(sZ.p90)}s`);
    console.log(`  cross-zone (n=${cZ.n}):  mean ${fmt(cZ.mean)}s  p50 ${fmt(cZ.p50)}s  p90 ${fmt(cZ.p90)}s`);
    if (sZ.n > 5 && cZ.n > 5) {
      const diff = cZ.mean - sZ.mean;
      console.log(`  delta (cross - same): ${fmt(diff)}s — ${diff > 0.1 ? "cross-zone has meaningful overhead" : "negligible"}`);
    }

    console.log(`\n'other' phase distribution:`);
    const otherVals = samples.map((s) => s.other).filter((v) => Number.isFinite(v));
    const otherSorted = [...otherVals].sort((a, b) => a - b);
    const thresholds = [0.1, 0.25, 0.5, 1.0, 2.0];
    for (const t of thresholds) {
      const n = otherSorted.filter((x) => x > t).length;
      console.log(`  tiles with other > ${t}s: ${n}  (${pct(n, otherVals.length)})`);
    }
    const topOther = [...samples]
      .filter((s) => Number.isFinite(s.other))
      .sort((a, b) => b.other - a.other)
      .slice(0, 5);
    console.log(`\n  top 5 'other' outliers:`);
    for (const s of topOther) {
      console.log(`    ${s.tileId}  total=${fmt(s.total)}s  other=${fmt(s.other)}s  (${pct(s.other, s.total)} of total)`);
    }
  } else {
    // Legacy diagnostic: derive "other" as total - sum(horizon+sources+points+eval).
    console.log(`\nImplicit 'other' (total - horizon - sources - points - eval):`);
    const impliedOther = samples.map((s) =>
      Math.max(0, s.total - s.horizon - s.sources - s.points - s.eval),
    );
    const oS = stats("implied-other", impliedOther);
    console.log(`  mean=${fmt(oS.mean)}s  p50=${fmt(oS.p50)}s  p90=${fmt(oS.p90)}s  p99=${fmt(oS.p99)}s  max=${fmt(oS.max)}s`);
    const over = [0.1, 0.25, 0.5, 1.0, 2.0].map((t) => impliedOther.filter((v) => v > t).length);
    console.log(`  > 0.1s: ${over[0]}  > 0.25s: ${over[1]}  > 0.5s: ${over[2]}  > 1.0s: ${over[3]}  > 2.0s: ${over[4]}`);
  }

  // 4. µs/eval stability: if it varies a lot between tiles, GPU isn't the bottleneck.
  const usValues = samples.filter((s) => s.evals > 0).map((s) => s.usPerEval);
  const usStats = stats("µs/eval", usValues);
  console.log(`\nµs/eval (GPU shader throughput):`);
  console.log(
    `  mean=${fmt(usStats.mean, 0)}µs  p50=${fmt(usStats.p50, 0)}µs  p99=${fmt(usStats.p99, 0)}µs  max=${fmt(usStats.max, 0)}µs`,
  );
  if (usStats.p50 > 0 && usStats.p99 / usStats.p50 > 1.5) {
    console.log(`  >> throughput varies ${fmt(usStats.p99 / usStats.p50)}x between tiles — GPU reuse may not be kicking in`);
  }
}

main();
