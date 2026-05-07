/**
 * Cross-validation: detailed CPU ray-tracing vs Vulkan compute shader.
 *
 * Computes an artifact with the `detailed` CPU backend (triangle-by-triangle
 * ray-tracing, the historical reference), and compares its masks bit-by-bit
 * with the Vulkan-generated tile cache on disk.
 *
 * If the two backends converge on the same masks, we have strong evidence
 * that both are computing reality correctly (not just agreeing on a shared bug).
 *
 * Run:
 *   MAPPY_BUILDINGS_SHADOW_MODE=detailed pnpm tsx scripts/ingest/_cross-validate-detailed-vs-vulkan.ts
 */

if (process.env.MAPPY_BUILDINGS_SHADOW_MODE !== "detailed") {
  console.error(
    `ERROR: expected MAPPY_BUILDINGS_SHADOW_MODE=detailed, got "${process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(unset)"}"`,
  );
  process.exit(1);
}

import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import { computeSunlightTileArtifact } from "../../src/lib/precompute/sunlight-tile-service";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
  MASK_KIND_BUILDINGS_BLOCKED,
  MASK_KIND_VEGETATION_BLOCKED,
} from "../../src/lib/precompute/sunlight-cache-binary";
import { DEFAULT_SHADOW_CALIBRATION } from "../../src/lib/sun/shadow-calibration";
import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import type { RegionTileSpec } from "../../src/lib/precompute/sunlight-cache";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = Number(process.env.SAMPLE_MINUTES ?? 15);
const DATE = process.env.DATE ?? "2026-04-18";
const START_LOCAL = process.env.START_LOCAL ?? "09:00";
const END_LOCAL = process.env.END_LOCAL ?? "17:00";
const TILE_ID = process.env.TILE_ID ?? "e2538000_n1152500_s250";
const LABEL = process.env.LABEL ?? TILE_ID;

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}

function popcountBits(buf: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let n = 0;
  for (let i = 0; i < fullBytes; i++) n += popcount8(buf[i]);
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    n += popcount8(buf[fullBytes] & mask);
  }
  return n;
}

function popcountAnd(a: Uint8Array, b: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let n = 0;
  for (let i = 0; i < fullBytes; i++) n += popcount8(a[i] & b[i]);
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    n += popcount8((a[fullBytes] & b[fullBytes]) & mask);
  }
  return n;
}

function popcountXor(a: Uint8Array, b: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let n = 0;
  for (let i = 0; i < fullBytes; i++) n += popcount8(a[i] ^ b[i]);
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    n += popcount8((a[fullBytes] ^ b[fullBytes]) & mask);
  }
  return n;
}

function parseTileId(id: string): { minE: number; minN: number; size: number } {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id)!;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

async function main(): Promise<void> {
  console.log(`Cross-validation: detailed (CPU ray-tracing) vs Vulkan`);
  console.log(`Label: ${LABEL}`);
  console.log(`Tile: ${TILE_ID}  window: ${START_LOCAL}..${END_LOCAL} step ${SAMPLE_MINUTES}min\n`);

  // Load Vulkan tile from disk (MUST exist — run _regen-tile-cache-vulkan.ts first with same params)
  const vulkan = await loadPrecomputedSunlightTileBinary({
    region: REGION,
    modelVersionHash: MODEL_HASH,
    date: DATE,
    gridStepMeters: GRID_STEP,
    sampleEveryMinutes: SAMPLE_MINUTES,
    startLocalTime: START_LOCAL,
    endLocalTime: END_LOCAL,
    tileId: TILE_ID,
  });
  if (!vulkan) {
    console.error(
      `ERROR: Vulkan tile cache not found. Regenerate with: SAMPLE_MINUTES=${SAMPLE_MINUTES} START_LOCAL=${START_LOCAL} END_LOCAL=${END_LOCAL} TILES=${TILE_ID} MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan pnpm tsx scripts/ingest/_regen-tile-cache-vulkan.ts`,
    );
    process.exit(1);
  }
  console.log(`Vulkan tile loaded: ${vulkan.meta.framesMeta.length} frames, outdoor=${vulkan.outdoorPointCount}\n`);

  // Build tile spec
  const parsed = parseTileId(TILE_ID);
  const centerE = parsed.minE + parsed.size / 2;
  const centerN = parsed.minN + parsed.size / 2;
  const { lat, lon } = lv95ToWgs84Precise(centerE, centerN);
  const tileSpec: RegionTileSpec = {
    tileId: TILE_ID,
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

  // Compute artifact with detailed backend — expensive, ~4 ms/eval
  console.log(`Computing detailed (CPU ray-tracing) — this will take a few minutes...\n`);
  const t0 = Date.now();
  const detailed = await computeSunlightTileArtifact({
    region: REGION,
    modelVersionHash: MODEL_HASH,
    algorithmVersion: MODEL_HASH,
    date: DATE,
    timezone: LAUSANNE_CONFIG.timezone,
    sampleEveryMinutes: SAMPLE_MINUTES,
    gridStepMeters: GRID_STEP,
    startLocalTime: START_LOCAL,
    endLocalTime: END_LOCAL,
    tile: tileSpec,
    shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`detailed compute done in ${elapsed}s — ${detailed.frames.length} frames\n`);

  // Compare frame by frame
  const bits = vulkan.outdoorPointCount;
  console.log(`Comparison @ ${bits} outdoor bits per frame:\n`);
  console.log(
    `${"frame".padEnd(7)} ${"time".padEnd(6)} ${"az°".padEnd(8)} ${"alt°".padEnd(7)} | ` +
      `${"V sun".padEnd(7)} ${"D sun".padEnd(7)} ${"XOR".padEnd(6)} ${"XOR%".padEnd(7)} | ` +
      `${"V noVeg".padEnd(8)} ${"D noVeg".padEnd(8)} ${"XOR".padEnd(6)} ${"XOR%"}`,
  );
  console.log("─".repeat(120));

  let totalBits = 0;
  let totalXorSun = 0;
  let totalXorNoVeg = 0;
  let totalXorBuildings = 0;
  let totalXorVegetation = 0;

  for (let i = 0; i < vulkan.meta.framesMeta.length; i++) {
    const vFrame = vulkan.meta.framesMeta[i];
    const dFrame = detailed.frames.find((f) => f.localTime === vFrame.localTime);
    if (!dFrame) {
      console.log(`  [skip] no detailed frame matching ${vFrame.localTime}`);
      continue;
    }

    const vSun = getFrameMask(vulkan, vFrame.index, MASK_KIND_SUN);
    const vNoVeg = getFrameMask(vulkan, vFrame.index, MASK_KIND_SUN_NO_VEG);
    const vBuild = getFrameMask(vulkan, vFrame.index, MASK_KIND_BUILDINGS_BLOCKED);
    const vVeg = getFrameMask(vulkan, vFrame.index, MASK_KIND_VEGETATION_BLOCKED);

    const dSun = dFrame.sunMask;
    const dNoVeg = dFrame.sunMaskNoVegetation;
    const dBuild = dFrame.buildingsBlockedMask;
    const dVeg = dFrame.vegetationBlockedMask;

    const vSunCount = popcountBits(vSun, bits);
    const dSunCount = popcountBits(dSun, bits);
    const vNoVegCount = popcountBits(vNoVeg, bits);
    const dNoVegCount = popcountBits(dNoVeg, bits);
    const vBuildCount = popcountBits(vBuild, bits);
    const dBuildCount = popcountBits(dBuild, bits);
    const vVegCount = popcountBits(vVeg, bits);
    const dVegCount = popcountBits(dVeg, bits);

    const xorSun = popcountXor(vSun, dSun, bits);
    const xorNoVeg = popcountXor(vNoVeg, dNoVeg, bits);
    const xorBuild = popcountXor(vBuild, dBuild, bits);
    const xorVeg = popcountXor(vVeg, dVeg, bits);

    // Decompose sun XOR: vulkan-only (V=1 D=0) and detailed-only (V=0 D=1)
    const andSun = popcountAnd(vSun, dSun, bits);
    const vOnlySun = vSunCount - andSun;
    const dOnlySun = dSunCount - andSun;

    totalBits += bits;
    totalXorSun += xorSun;
    totalXorNoVeg += xorNoVeg;
    totalXorBuildings += xorBuild;
    totalXorVegetation += xorVeg;

    // Compute sun angles at tile center for this frame (both backends use identical angles)
    const utc = new Date(vFrame.utcTime);
    const pos = SunCalc.getPosition(utc, lat, lon);
    const altDeg = (pos.altitude * 180) / Math.PI;
    let azDeg = ((pos.azimuth * 180) / Math.PI + 180) % 360;
    if (azDeg < 0) azDeg += 360;
    const azStr = azDeg.toFixed(2);
    const altStr = altDeg.toFixed(2);
    console.log(
      `${String(i).padEnd(7)} ${vFrame.localTime.padEnd(6)} ${azStr.padEnd(8)} ${altStr.padEnd(7)} | ` +
        `${String(vSunCount).padEnd(7)} ${String(dSunCount).padEnd(7)} ${String(xorSun).padEnd(6)} ${((100 * xorSun) / bits).toFixed(3).padEnd(7)} | ` +
        `${String(vNoVegCount).padEnd(8)} ${String(dNoVegCount).padEnd(8)} ${String(xorNoVeg).padEnd(6)} ${((100 * xorNoVeg) / bits).toFixed(3)}`,
    );
    console.log(
      `        buildings: V=${vBuildCount} D=${dBuildCount} XOR=${xorBuild} (${((100 * xorBuild) / bits).toFixed(3)}%) | vegetation: V=${vVegCount} D=${dVegCount} XOR=${xorVeg} (${((100 * xorVeg) / bits).toFixed(3)}%) | sun decomp: V-only=${vOnlySun} D-only=${dOnlySun}`,
    );
  }

  console.log("\nTOTAL:");
  console.log(`  sun:          ${totalXorSun}/${totalBits} = ${((100 * totalXorSun) / totalBits).toFixed(4)}%`);
  console.log(`  noVeg:        ${totalXorNoVeg}/${totalBits} = ${((100 * totalXorNoVeg) / totalBits).toFixed(4)}%`);
  console.log(`  buildings:    ${totalXorBuildings}/${totalBits} = ${((100 * totalXorBuildings) / totalBits).toFixed(4)}%`);
  console.log(`  vegetation:   ${totalXorVegetation}/${totalBits} = ${((100 * totalXorVegetation) / totalBits).toFixed(4)}%`);
}

main().catch((err) => { console.error(err); process.exit(1); });
