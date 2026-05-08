/**
 * Micro-benchmark: measure how tile size amortizes the fixed per-tile cost
 * vs the per-point eval cost, by covering the SAME area (1 km²) with each
 * tile size. A single 1000m tile vs 4× 500m tiles vs 16× 250m tiles.
 *
 * For each size, forges N tiles (N = (1000/size)²) laid out as a grid from
 * the same Lausanne origin, computes each, sums the phase timings.
 *
 * Uses sunOverride to evaluate a single sun position — extrapolates for
 * realistic frame counts by assuming the eval phase scales linearly.
 *
 * Usage:
 *   MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan pnpm tsx scripts/benchmark/bench-tile-size.ts
 *
 * Options (env):
 *   SIZES=250,500,1000         tile sizes to benchmark (meters)
 *   AREA_METERS=1000           side length of the area to cover (must be a multiple of every size)
 *   FRAMES_FOR_EXTRAP=60       frame count used to extrapolate "realistic run"
 *   WARMUP=1                   run a throw-away warmup sweep per size first
 */

import { performance } from "node:perf_hooks";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import { computeSunlightTileArtifact, disposeSunlightTileEvaluationBackends } from "../../src/lib/precompute/sunlight-tile-service";
import { getSunlightModelVersion } from "../../src/lib/precompute/model-version";
import { DEFAULT_SHADOW_CALIBRATION } from "../../src/lib/sun/shadow-calibration";
import type { RegionTileSpec } from "../../src/lib/precompute/sunlight-cache";

const REGION = "lausanne" as const;
const ORIGIN_E = 2538000;
const ORIGIN_N = 1152500;
const GRID_STEP = 1;
const SUN_AZ_DEG = 180;
const SUN_ALT_DEG = 55;

const SIZES = (process.env.SIZES ?? "250,500,1000").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const AREA_METERS = Number(process.env.AREA_METERS ?? 1000);
const FRAMES_FOR_EXTRAP = Number(process.env.FRAMES_FOR_EXTRAP ?? 60);
const WARMUP = process.env.WARMUP !== "0";

function forgeTile(sizeMeters: number, offsetE: number, offsetN: number): RegionTileSpec {
  const minE = ORIGIN_E + offsetE;
  const minN = ORIGIN_N + offsetN;
  const { lat, lon } = lv95ToWgs84Precise(minE + sizeMeters / 2, minN + sizeMeters / 2);
  const margin = 0.02;
  return {
    tileId: `bench_e${minE}_n${minN}_s${sizeMeters}`,
    tileSizeMeters: sizeMeters,
    minEasting: minE,
    minNorthing: minN,
    maxEasting: minE + sizeMeters,
    maxNorthing: minN + sizeMeters,
    bbox: { minLon: lon - margin, maxLon: lon + margin, minLat: lat - margin, maxLat: lat + margin },
  };
}

function buildTileGrid(sizeMeters: number): RegionTileSpec[] {
  const count = AREA_METERS / sizeMeters;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`AREA_METERS=${AREA_METERS} is not a multiple of size=${sizeMeters}`);
  }
  const tiles: RegionTileSpec[] = [];
  for (let ny = 0; ny < count; ny++) {
    for (let nx = 0; nx < count; nx++) {
      tiles.push(forgeTile(sizeMeters, nx * sizeMeters, ny * sizeMeters));
    }
  }
  return tiles;
}

interface PerSizeResult {
  sizeMeters: number;
  tileCount: number;
  totalPoints: number;
  totalMs: number;
  frames: number;
  perTileMs: number[];
}

async function benchOne(tile: RegionTileSpec): Promise<{ points: number; totalMs: number; frames: number }> {
  const mv = await getSunlightModelVersion(REGION, DEFAULT_SHADOW_CALIBRATION);
  const t0 = performance.now();
  const artifact = await computeSunlightTileArtifact({
    region: REGION,
    modelVersionHash: mv.modelVersionHash,
    algorithmVersion: mv.algorithmVersion,
    date: "2027-04-20",
    timezone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    gridStepMeters: GRID_STEP,
    startLocalTime: "12:00",
    endLocalTime: "12:15",
    tile,
    shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
    sunOverride: [{ azimuthDeg: SUN_AZ_DEG, altitudeDeg: SUN_ALT_DEG }],
  });
  return {
    points: artifact.stats.pointCount,
    totalMs: performance.now() - t0,
    frames: artifact.frames.length,
  };
}

async function benchSweep(sizeMeters: number, label: string): Promise<PerSizeResult> {
  const tiles = buildTileGrid(sizeMeters);
  const perTileMs: number[] = [];
  let totalPoints = 0;
  let totalMs = 0;
  let frames = 0;
  const t0 = performance.now();
  for (const tile of tiles) {
    const r = await benchOne(tile);
    perTileMs.push(r.totalMs);
    totalPoints += r.points;
    frames = r.frames;
  }
  totalMs = performance.now() - t0;
  console.log(`  [${label}] ${tiles.length} tile(s) in ${(totalMs / 1000).toFixed(2)}s — points=${totalPoints.toLocaleString()}`);
  return { sizeMeters, tileCount: tiles.length, totalPoints, totalMs, frames, perTileMs };
}

async function main(): Promise<void> {
  const shadowMode = process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(unset)";
  console.log(`[bench-tile-size] shadowMode=${shadowMode} region=${REGION} origin=(${ORIGIN_E},${ORIGIN_N}) step=${GRID_STEP}m sizes=${SIZES.join(",")}m area=${AREA_METERS}×${AREA_METERS}m warmup=${WARMUP}`);

  const results: PerSizeResult[] = [];
  for (const size of SIZES) {
    const count = AREA_METERS / size;
    console.log(`\n═══ size=${size}m (${count}×${count}=${count * count} tile(s) covering ${AREA_METERS}×${AREA_METERS}m) ═══`);
    if (WARMUP) {
      await benchSweep(size, "warmup, ignored");
    }
    const r = await benchSweep(size, "measured");
    results.push(r);
  }

  try {
    await disposeSunlightTileEvaluationBackends();
  } catch { /* ignore */ }

  console.log(`\n═══════ SUMMARY (covering ${(AREA_METERS * AREA_METERS / 1e6).toFixed(2)} km² per sweep) ═══════`);
  console.log(`size(m) | tiles | total pts   | sweep(1f) | min/tile | max/tile | extrap ${FRAMES_FOR_EXTRAP}f(s)*`);
  console.log(`--------+-------+-------------+-----------+----------+----------+----------------`);

  for (const r of results) {
    const minMs = Math.min(...r.perTileMs);
    const maxMs = Math.max(...r.perTileMs);
    // Heuristic extrapolation: we can't separate prep from eval without re-parsing the [tile] logs,
    // so we approximate: total = prepFixed + evalPerFrame × frames. Using 1f total as upper bound
    // and assuming eval ~20% of a 1-frame total (typical with fast Vulkan), extrapolation is:
    // extrap ≈ 0.8 × total(1f) + 0.2 × total(1f) × frames
    const prepShare = 0.8;
    const evalShare = 0.2;
    const extrapMs = (prepShare + evalShare * FRAMES_FOR_EXTRAP) * r.totalMs;
    console.log(
      `${String(r.sizeMeters).padStart(7)} | ${String(r.tileCount).padStart(5)} | ${String(r.totalPoints.toLocaleString()).padStart(11)} | ${(r.totalMs / 1000).toFixed(2).padStart(9)} | ${(minMs / 1000).toFixed(2).padStart(8)} | ${(maxMs / 1000).toFixed(2).padStart(8)} | ${(extrapMs / 1000).toFixed(1).padStart(14)}`,
    );
  }
  console.log();
  console.log(`* rough extrap: ≈ 0.8 × sweep(1f) + 0.2 × sweep(1f) × frames. Look at the per-tile [tile ...]`);
  console.log(`  log lines above for accurate phase breakdowns (horizon/sources/points/eval).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
