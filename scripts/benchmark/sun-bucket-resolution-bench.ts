/**
 * Benchmark: how much do shadow bitmasks diverge when sun angles are
 * quantised to coarser buckets (ADR-0013)?
 *
 * Runs precompute-rust-wgpu-vulkan-dry-run.ts multiple times for the same
 * tile / date / time window:
 *
 *   1. baseline — exact SunCalc angles (MAPPY_SUN_POSITION_ROUND_DEG unset)
 *   2..N       — rounded angles at each candidate resolution
 *
 * Then compares the per-frame sunMask / sunMaskNoVeg buffers bit-wise and
 * reports the divergence, broken down by sun altitude band so you can see
 * where the error lives (near-horizon frames are the sensitive ones).
 *
 * Usage:
 *   pnpm tsx scripts/benchmark/sun-bucket-resolution-bench.ts \
 *     --tile-id=e2538000_n1152250_s250 \
 *     --date=2026-04-13 \
 *     --start-local-time=06:00 --end-local-time=21:00 \
 *     --resolutions=0.25,0.5,1,2
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

type Args = {
  region: string;
  tileId: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  resolutionsDeg: number[];
  mode: "rust-wgpu-vulkan" | "gpu-raster";
};

type FrameSummary = {
  index: number;
  localTime: string;
  utcTime: string;
  sunnyCount: number;
  sunnyCountNoVegetation: number;
  sunMaskBase64: string;
  sunMaskNoVegetationBase64: string;
};

type ValueSummary = {
  frames: FrameSummary[];
  stats: { pointCount: number };
};

function parseArgs(argv: string[]): Args {
  const defaults: Args = {
    region: "lausanne",
    tileId: "e2538000_n1152250_s250",
    date: "2026-04-13",
    timezone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    gridStepMeters: 1,
    startLocalTime: "06:00",
    endLocalTime: "21:00",
    resolutionsDeg: [0.25, 0.5, 1, 2],
    mode: "rust-wgpu-vulkan",
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log("See file header for usage.");
      process.exit(0);
    }
    const [k, v] = arg.split("=");
    if (k === "--region") defaults.region = v;
    else if (k === "--tile-id") defaults.tileId = v;
    else if (k === "--date") defaults.date = v;
    else if (k === "--timezone") defaults.timezone = v;
    else if (k === "--sample-every-minutes") defaults.sampleEveryMinutes = Number(v);
    else if (k === "--grid-step-meters") defaults.gridStepMeters = Number(v);
    else if (k === "--start-local-time") defaults.startLocalTime = v;
    else if (k === "--end-local-time") defaults.endLocalTime = v;
    else if (k === "--resolutions") defaults.resolutionsDeg = v.split(",").map(Number);
    else if (k === "--mode") defaults.mode = v === "gpu-raster" ? "gpu-raster" : "rust-wgpu-vulkan";
  }
  return defaults;
}

async function runDryRun(args: Args, outPath: string, roundDeg: number | null): Promise<void> {
  const env = { ...process.env };
  if (roundDeg != null && roundDeg > 0) {
    env.MAPPY_SUN_POSITION_ROUND_DEG = String(roundDeg);
  } else {
    delete env.MAPPY_SUN_POSITION_ROUND_DEG;
  }
  const childArgs = [
    "tsx",
    "scripts/precompute/precompute-rust-wgpu-vulkan-dry-run.ts",
    `--mode=${args.mode}`,
    `--region=${args.region}`,
    `--tile-id=${args.tileId}`,
    `--date=${args.date}`,
    `--timezone=${args.timezone}`,
    `--sample-every-minutes=${args.sampleEveryMinutes}`,
    `--grid-step-meters=${args.gridStepMeters}`,
    `--start-local-time=${args.startLocalTime}`,
    `--end-local-time=${args.endLocalTime}`,
    `--write-value-summary=${outPath}`,
  ];
  const child = spawn("pnpm", childArgs, { env, stdio: "inherit", shell: true });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`dry-run exited ${code}`))));
    child.on("error", reject);
  });
}

function countDifferingBits(a: string, b: string): number {
  const bufA = Buffer.from(a, "base64");
  const bufB = Buffer.from(b, "base64");
  if (bufA.length !== bufB.length) return -1;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    let x = bufA[i] ^ bufB[i];
    while (x) { x &= x - 1; diff++; }
  }
  return diff;
}

function altitudeBand(alt: number): string {
  if (alt < 0) return "below-horizon";
  if (alt < 5) return "alt<5°";
  if (alt < 15) return "alt 5-15°";
  if (alt < 30) return "alt 15-30°";
  return "alt>=30°";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`tile=${args.tileId} date=${args.date} window=${args.startLocalTime}-${args.endLocalTime} sample=${args.sampleEveryMinutes}min`);
  console.log(`resolutions to test: ${args.resolutionsDeg.map((r) => r + "°").join(", ")}`);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunbucket-bench-"));
  const refPath = path.join(tmpDir, "ref.json");
  const SunCalcMod = await import("suncalc");

  const t0 = performance.now();
  console.log(`\n[baseline] running dry-run at exact angles…`);
  await runDryRun(args, refPath, null);
  console.log(`[baseline] ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  const refSummary = JSON.parse(await fs.readFile(refPath, "utf8")) as ValueSummary;
  const outdoorCount = refSummary.stats.pointCount;
  const bitsPerFrame = outdoorCount;
  console.log(`\nreference: ${refSummary.frames.length} frames, ${outdoorCount} outdoor points → ${bitsPerFrame} bits / mask / frame`);

  // Compute (az, alt) per frame at tile center to bucket by altitude for reports.
  const regionCenters: Record<string, { lat: number; lon: number }> = {
    lausanne: { lat: 46.52, lon: 6.63 }, // approx — only used to bucket frames
  };
  const approxCenter = regionCenters[args.region] ?? { lat: 46.5, lon: 6.6 };
  const frameAlt = new Array<number>(refSummary.frames.length);
  for (let i = 0; i < refSummary.frames.length; i++) {
    const pos = SunCalcMod.default.getPosition(new Date(refSummary.frames[i].utcTime), approxCenter.lat, approxCenter.lon);
    frameAlt[i] = pos.altitude * 180 / Math.PI;
  }

  const results: Array<{
    resolutionDeg: number;
    diffBitsSun: number;
    diffBitsSunNoVeg: number;
    totalBits: number;
    sunPctByBand: Map<string, { diff: number; total: number }>;
  }> = [];

  for (const res of args.resolutionsDeg) {
    const runPath = path.join(tmpDir, `round-${res}.json`);
    console.log(`\n[round ${res}°] running dry-run…`);
    const tRes0 = performance.now();
    await runDryRun(args, runPath, res);
    console.log(`[round ${res}°] ${((performance.now() - tRes0) / 1000).toFixed(1)}s`);
    const runSummary = JSON.parse(await fs.readFile(runPath, "utf8")) as ValueSummary;

    let diffSun = 0, diffSunNoVeg = 0, totalBits = 0;
    const byBand = new Map<string, { diff: number; total: number }>();
    for (let i = 0; i < refSummary.frames.length; i++) {
      const ref = refSummary.frames[i];
      const run = runSummary.frames[i];
      const bits = bitsPerFrame;
      const dSun = countDifferingBits(ref.sunMaskBase64, run.sunMaskBase64);
      const dNoVeg = countDifferingBits(ref.sunMaskNoVegetationBase64, run.sunMaskNoVegetationBase64);
      if (dSun < 0 || dNoVeg < 0) {
        console.warn(`  frame ${i}: mask length mismatch, skipping`);
        continue;
      }
      diffSun += dSun;
      diffSunNoVeg += dNoVeg;
      totalBits += bits;
      const band = altitudeBand(frameAlt[i]);
      const cur = byBand.get(band) ?? { diff: 0, total: 0 };
      cur.diff += dSun;
      cur.total += bits;
      byBand.set(band, cur);
    }
    results.push({ resolutionDeg: res, diffBitsSun: diffSun, diffBitsSunNoVeg: diffSunNoVeg, totalBits, sunPctByBand: byBand });
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`resolution |   sun div    | sunNoVeg div |  total bits`);
  console.log(`-----------+--------------+--------------+------------`);
  for (const r of results) {
    const sunPct = (r.diffBitsSun / r.totalBits * 100).toFixed(3);
    const noVegPct = (r.diffBitsSunNoVeg / r.totalBits * 100).toFixed(3);
    console.log(`${String(r.resolutionDeg + "°").padEnd(10)} | ${String(r.diffBitsSun).padStart(7)} (${sunPct}%) | ${String(r.diffBitsSunNoVeg).padStart(7)} (${noVegPct}%) | ${r.totalBits}`);
  }

  console.log(`\n=== DIVERGENCE BY ALTITUDE BAND (sunMask only) ===`);
  const bands = ["below-horizon", "alt<5°", "alt 5-15°", "alt 15-30°", "alt>=30°"];
  const header = `band          | ${args.resolutionsDeg.map((r) => String(r + "°").padStart(14)).join(" | ")}`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const band of bands) {
    const cols = results.map((r) => {
      const s = r.sunPctByBand.get(band);
      if (!s || s.total === 0) return "      -       ";
      const pct = (s.diff / s.total * 100).toFixed(3);
      return `${String(s.diff).padStart(5)} (${pct}%)`.padStart(14);
    });
    console.log(`${band.padEnd(13)} | ${cols.join(" | ")}`);
  }

  console.log(`\nTemp artifacts: ${tmpDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
