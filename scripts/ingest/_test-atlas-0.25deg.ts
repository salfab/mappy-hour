/**
 * Experimental test: does a 0.25° angular atlas resolution reduce the
 * bucket-snap divergence observed at the 1° resolution (27% at 17h)?
 *
 * Methodology:
 *   For each test tile, for each 17h frame (17:00..17:45):
 *     - compute true sun at tile center from utcTime
 *     - snap to (azB, altB) at resolution 0.25°
 *     - compute bucket-center (azB + 0.5, altB + 0.5) × 0.25°
 *     - call computeSunlightTileArtifact with sunOverride = all 4 centers
 *     - XOR fresh mask vs tile-cache mask over outdoor bits
 *     - report divergence
 *
 * If the 0.25° divergence drops to <5%, we know resolution was the bottleneck.
 * If it stays at ~15–25%, something else is going on (non-determinism,
 * boundary sampling, etc).
 *
 * Run:
 *   pnpm tsx scripts/ingest/_test-atlas-0.25deg.ts
 */

import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import {
  computeSunlightTileArtifact,
  disposeSunlightTileEvaluationBackends,
} from "../../src/lib/precompute/sunlight-tile-service";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
} from "../../src/lib/precompute/sunlight-cache-binary";
import { DEFAULT_SHADOW_CALIBRATION } from "../../src/lib/sun/shadow-calibration";
import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import type { RegionTileSpec } from "../../src/lib/precompute/sunlight-cache";

const RAD_TO_DEG = 180 / Math.PI;

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";

// Worst tiles at 17h from the mass comparison.
const TEST_TILES = [
  "e2538000_n1152500_s250", // 61.7% at 17h with 1° resolution
  "e2538250_n1152250_s250", // 60.2%
  "e2538500_n1152250_s250", // 54.1%
];

// Two resolutions to compare.
const RESOLUTIONS = [1.0, 0.25] as const;

// Focus on 17h (max divergence hour) — 4 frames.
const TARGET_HOURS = [17] as const;

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}

function hamming(a: Uint8Array, b: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let diff = 0;
  for (let i = 0; i < fullBytes; i++) diff += popcount8(a[i] ^ b[i]);
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    diff += popcount8((a[fullBytes] ^ b[fullBytes]) & mask);
  }
  return diff;
}

function parseTileId(id: string): { minE: number; minN: number; size: number } | null {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) return null;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

interface FrameSpec {
  frameIdx: number;
  localTime: string;
  utcTime: string;
  azTrue: number;
  altTrue: number;
  azCenter: number;
  altCenter: number;
}

async function runForTileAtResolution(
  tileId: string,
  resolutionDeg: number,
  targetHours: readonly number[],
): Promise<{
  frames: FrameSpec[];
  diffsSun: number[];
  diffsNoVeg: number[];
  outdoorBits: number;
  computeSeconds: number;
}> {
  const parsed = parseTileId(tileId)!;
  const centerE = parsed.minE + parsed.size / 2;
  const centerN = parsed.minN + parsed.size / 2;
  const { lat, lon } = lv95ToWgs84Precise(centerE, centerN);

  const tile = await loadPrecomputedSunlightTileBinary({
    region: REGION,
    modelVersionHash: MODEL_HASH,
    date: DATE,
    gridStepMeters: GRID_STEP,
    sampleEveryMinutes: SAMPLE_MINUTES,
    startLocalTime: "00:00",
    endLocalTime: "23:59",
    tileId,
  });
  if (!tile) throw new Error(`no tile cache for ${tileId}`);

  const framesMeta = tile.meta.framesMeta;
  const targetFrames: FrameSpec[] = [];
  for (const fm of framesMeta) {
    const hour = Number(fm.localTime.slice(0, 2));
    if (!targetHours.includes(hour)) continue;
    const utc = new Date(fm.utcTime);
    const pos = SunCalc.getPosition(utc, lat, lon);
    const altDeg = pos.altitude * RAD_TO_DEG;
    if (altDeg <= 0) continue;
    let azDeg = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (azDeg < 0) azDeg += 360;
    const azB = Math.floor(azDeg / resolutionDeg);
    const altB = Math.floor(altDeg / resolutionDeg);
    const azCenter = (azB + 0.5) * resolutionDeg;
    const altCenter = (altB + 0.5) * resolutionDeg;
    targetFrames.push({
      frameIdx: fm.index,
      localTime: fm.localTime,
      utcTime: fm.utcTime,
      azTrue: azDeg,
      altTrue: altDeg,
      azCenter,
      altCenter,
    });
  }

  const tileSpec: RegionTileSpec = {
    tileId,
    tileSizeMeters: parsed.size,
    minEasting: parsed.minE,
    minNorthing: parsed.minN,
    maxEasting: parsed.minE + parsed.size,
    maxNorthing: parsed.minN + parsed.size,
    bbox: {
      minLon: lon - 0.01,
      maxLon: lon + 0.01,
      minLat: lat - 0.01,
      maxLat: lat + 0.01,
    },
  };

  const sunOverride = targetFrames.map((f) => ({
    azimuthDeg: f.azCenter,
    altitudeDeg: f.altCenter,
  }));

  const startT = Date.now();
  const artifact = await computeSunlightTileArtifact({
    region: REGION,
    modelVersionHash: MODEL_HASH,
    algorithmVersion: MODEL_HASH,
    date: DATE,
    timezone: LAUSANNE_CONFIG.timezone,
    sampleEveryMinutes: SAMPLE_MINUTES,
    gridStepMeters: GRID_STEP,
    startLocalTime: "00:00",
    endLocalTime: "23:59",
    tile: tileSpec,
    shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
    sunOverride,
  });
  const computeSeconds = (Date.now() - startT) / 1000;

  const outdoorBits = tile.outdoorPointCount;
  const diffsSun: number[] = [];
  const diffsNoVeg: number[] = [];

  for (let i = 0; i < targetFrames.length; i++) {
    const tf = targetFrames[i];
    const freshSun = artifact.frames[i].sunMask;
    const freshNoVeg = artifact.frames[i].sunMaskNoVegetation;
    const tileSun = getFrameMask(tile, tf.frameIdx, MASK_KIND_SUN);
    const tileNoVeg = getFrameMask(tile, tf.frameIdx, MASK_KIND_SUN_NO_VEG);
    diffsSun.push(hamming(freshSun, tileSun, outdoorBits));
    diffsNoVeg.push(hamming(freshNoVeg, tileNoVeg, outdoorBits));
  }

  return { frames: targetFrames, diffsSun, diffsNoVeg, outdoorBits, computeSeconds };
}

async function main(): Promise<void> {
  console.log(`Testing atlas resolution effect on divergence at 17h\n`);
  console.log(`Test tiles: ${TEST_TILES.join(", ")}`);
  console.log(`Resolutions: ${RESOLUTIONS.join("°, ")}°`);
  console.log(`Target hours: ${TARGET_HOURS.join(", ")}h\n`);

  // Aggregate across tiles per resolution.
  interface Agg {
    resolutionDeg: number;
    framesCompared: number;
    totalBits: number;
    sunDiffBits: number;
    noVegDiffBits: number;
    totalComputeSeconds: number;
    perTile: Array<{
      tileId: string;
      frames: FrameSpec[];
      diffsSun: number[];
      diffsNoVeg: number[];
      outdoorBits: number;
      computeSeconds: number;
    }>;
  }
  const aggs: Agg[] = RESOLUTIONS.map((r) => ({
    resolutionDeg: r,
    framesCompared: 0,
    totalBits: 0,
    sunDiffBits: 0,
    noVegDiffBits: 0,
    totalComputeSeconds: 0,
    perTile: [],
  }));

  for (const resolutionDeg of RESOLUTIONS) {
    console.log(`\n=== Resolution ${resolutionDeg}° ===`);
    const agg = aggs.find((a) => a.resolutionDeg === resolutionDeg)!;
    for (const tileId of TEST_TILES) {
      process.stdout.write(`  ${tileId}: computing... `);
      const res = await runForTileAtResolution(tileId, resolutionDeg, TARGET_HOURS);
      agg.perTile.push({ tileId, ...res });
      agg.framesCompared += res.frames.length;
      agg.totalBits += res.outdoorBits * res.frames.length;
      agg.sunDiffBits += res.diffsSun.reduce((a, b) => a + b, 0);
      agg.noVegDiffBits += res.diffsNoVeg.reduce((a, b) => a + b, 0);
      agg.totalComputeSeconds += res.computeSeconds;
      const sumSun = res.diffsSun.reduce((a, b) => a + b, 0);
      const sumNoVeg = res.diffsNoVeg.reduce((a, b) => a + b, 0);
      const bitsTile = res.outdoorBits * res.frames.length;
      console.log(
        `${res.computeSeconds.toFixed(1)}s — sun=${((100 * sumSun) / bitsTile).toFixed(2)}% noVeg=${((100 * sumNoVeg) / bitsTile).toFixed(2)}%`,
      );
    }
  }

  // Summary
  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(`=== Summary: angular resolution vs divergence ===`);
  console.log(`═══════════════════════════════════════════════════════════════════`);
  console.log(`  resolution │ framesCmp │   bitsCmp │ sunDiff % │ noVeg % │ compute`);
  console.log(`  ───────────┼───────────┼───────────┼───────────┼─────────┼─────────`);
  for (const agg of aggs) {
    const sunPct = agg.totalBits > 0 ? (100 * agg.sunDiffBits) / agg.totalBits : 0;
    const noVegPct = agg.totalBits > 0 ? (100 * agg.noVegDiffBits) / agg.totalBits : 0;
    console.log(
      `    ${agg.resolutionDeg.toFixed(2).padStart(5)}°   │ ${String(agg.framesCompared).padStart(9)} │ ${String(agg.totalBits).padStart(9)} │ ${sunPct.toFixed(3).padStart(8)}% │ ${noVegPct.toFixed(3).padStart(6)}% │ ${agg.totalComputeSeconds.toFixed(1).padStart(6)}s`,
    );
  }

  // Δ
  if (aggs.length >= 2) {
    const ref = aggs[0];
    const test = aggs[aggs.length - 1];
    const refSunPct = (100 * ref.sunDiffBits) / ref.totalBits;
    const testSunPct = (100 * test.sunDiffBits) / test.totalBits;
    const refNoVegPct = (100 * ref.noVegDiffBits) / ref.totalBits;
    const testNoVegPct = (100 * test.noVegDiffBits) / test.totalBits;
    console.log(
      `\n  ${ref.resolutionDeg}° → ${test.resolutionDeg}° effect:`,
    );
    console.log(
      `    sun:   ${refSunPct.toFixed(2)}% → ${testSunPct.toFixed(2)}%   (${testSunPct < refSunPct ? "-" : "+"}${Math.abs(testSunPct - refSunPct).toFixed(2)}pp, ${((100 * (refSunPct - testSunPct)) / refSunPct).toFixed(1)}% reduction)`,
    );
    console.log(
      `    noVeg: ${refNoVegPct.toFixed(2)}% → ${testNoVegPct.toFixed(2)}%   (${testNoVegPct < refNoVegPct ? "-" : "+"}${Math.abs(testNoVegPct - refNoVegPct).toFixed(2)}pp, ${((100 * (refNoVegPct - testNoVegPct)) / refNoVegPct).toFixed(1)}% reduction)`,
    );
    console.log(
      `    compute cost: ${ref.totalComputeSeconds.toFixed(1)}s → ${test.totalComputeSeconds.toFixed(1)}s  (${(test.totalComputeSeconds / ref.totalComputeSeconds).toFixed(2)}× slower)`,
    );
  }

  // Per-frame detail at finest resolution
  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(`=== Per-frame detail at ${RESOLUTIONS[RESOLUTIONS.length - 1]}° ===`);
  console.log(`═══════════════════════════════════════════════════════════════════`);
  const last = aggs[aggs.length - 1];
  for (const t of last.perTile) {
    console.log(`\n  ${t.tileId}  (outdoor bits = ${t.outdoorBits}):`);
    for (let i = 0; i < t.frames.length; i++) {
      const f = t.frames[i];
      const dSun = t.diffsSun[i];
      const dNoVeg = t.diffsNoVeg[i];
      const sunPct = (100 * dSun) / t.outdoorBits;
      const noVegPct = (100 * dNoVeg) / t.outdoorBits;
      console.log(
        `    ${f.localTime}  sun(az=${f.azTrue.toFixed(3)}° alt=${f.altTrue.toFixed(3)}°) → bucket(az=${f.azCenter.toFixed(3)} alt=${f.altCenter.toFixed(3)})  Δaz=${(f.azTrue - f.azCenter).toFixed(3)}° Δalt=${(f.altTrue - f.altCenter).toFixed(3)}°  diff: sun=${sunPct.toFixed(2)}% noVeg=${noVegPct.toFixed(2)}%`,
      );
    }
  }

  await disposeSunlightTileEvaluationBackends();
}

main().catch((err) => { console.error(err); process.exit(1); });
