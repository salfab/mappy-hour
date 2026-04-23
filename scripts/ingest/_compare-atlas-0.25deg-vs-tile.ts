/**
 * Apples-to-apples comparison: 0.25° atlas (Vulkan) vs date-keyed tile cache (Vulkan).
 *
 * Both sides were computed with the SAME rust-wgpu-vulkan backend, so any
 * divergence observed is attributable to the angular snap (bucket-center vs
 * true sun), not backend-mismatch noise.
 *
 * Prerequisite: run _generate-atlas-0.25deg.ts first to create the r0.25 atlas.
 *
 * Run:
 *   pnpm tsx scripts/ingest/_compare-atlas-0.25deg-vs-tile.ts
 */

import SunCalc from "suncalc";

import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
} from "../../src/lib/precompute/sunlight-cache-binary";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasBucket,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const RAD_TO_DEG = 180 / Math.PI;

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";
const TARGET_HOURS = [17] as const;

const TEST_TILES = [
  "e2538000_n1152500_s250",
  "e2538250_n1152250_s250",
  "e2538500_n1152250_s250",
];

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

function parseTileId(id: string): { minE: number; minN: number; size: number } {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id)!;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

async function compareOneResolution(resolutionDeg: number): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(`=== Resolution ${resolutionDeg}° — atlas vs tile (same backend: Vulkan) ===`);
  console.log(`═══════════════════════════════════════════════════════════════════`);

  let totalBits = 0;
  let totalSunDiff = 0;
  let totalNoVegDiff = 0;
  let framesCompared = 0;
  let bucketsMissing = 0;

  for (const tileId of TEST_TILES) {
    const parsed = parseTileId(tileId);
    const centerE = parsed.minE + parsed.size / 2;
    const centerN = parsed.minN + parsed.size / 2;
    const { lat, lon } = lv95ToWgs84(centerE, centerN);

    const [tile, atlas] = await Promise.all([
      loadPrecomputedSunlightTileBinary({
        region: REGION,
        modelVersionHash: MODEL_HASH,
        date: DATE,
        gridStepMeters: GRID_STEP,
        sampleEveryMinutes: SAMPLE_MINUTES,
        // Vulkan-regenerated window (has full buildings + vegetation blocker masks)
        startLocalTime: "17:00",
        endLocalTime: "17:45",
        tileId,
      }),
      loadPrecomputedTileAtlas({
        region: REGION,
        modelVersionHash: MODEL_HASH,
        gridStepMeters: GRID_STEP,
        tileId,
        resolutionDeg,
      }),
    ]);

    if (!tile || !atlas) {
      console.log(`  ${tileId}: MISSING ${!tile ? "tile" : "atlas"}`);
      continue;
    }
    if (tile.outdoorPointCount !== atlas.outdoorPointCount) {
      console.log(
        `  ${tileId}: outdoor mismatch tile=${tile.outdoorPointCount} atlas=${atlas.outdoorPointCount}`,
      );
      continue;
    }
    const outdoorBits = tile.outdoorPointCount;

    const framesMeta = tile.meta.framesMeta;
    let tileSun = 0, tileNoVeg = 0, tileFrames = 0, tileBucketMiss = 0;
    const perFrame: Array<{
      localTime: string;
      azTrue: number;
      altTrue: number;
      azCenter: number;
      altCenter: number;
      sunDiff: number;
      noVegDiff: number;
    }> = [];

    for (const fm of framesMeta) {
      const hour = Number(fm.localTime.slice(0, 2));
      if (!TARGET_HOURS.includes(hour as (typeof TARGET_HOURS)[number])) continue;
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

      const bucket = lookupAtlasBucket(atlas, azB, altB);
      if (!bucket) {
        tileBucketMiss++;
        bucketsMissing++;
        continue;
      }

      const tileMaskSun = getFrameMask(tile, fm.index, MASK_KIND_SUN);
      const tileMaskNoVeg = getFrameMask(tile, fm.index, MASK_KIND_SUN_NO_VEG);
      const sunDiff = hamming(tileMaskSun, bucket.sunMask, outdoorBits);
      const noVegDiff = hamming(tileMaskNoVeg, bucket.sunNoVegMask, outdoorBits);

      tileSun += sunDiff;
      tileNoVeg += noVegDiff;
      tileFrames++;
      totalBits += outdoorBits;
      totalSunDiff += sunDiff;
      totalNoVegDiff += noVegDiff;
      framesCompared++;

      perFrame.push({
        localTime: fm.localTime,
        azTrue: azDeg,
        altTrue: altDeg,
        azCenter,
        altCenter,
        sunDiff,
        noVegDiff,
      });
    }

    const bitsForTile = outdoorBits * tileFrames;
    const sunPct = bitsForTile > 0 ? (100 * tileSun) / bitsForTile : 0;
    const noVegPct = bitsForTile > 0 ? (100 * tileNoVeg) / bitsForTile : 0;
    console.log(
      `\n  ${tileId}  (outdoor=${outdoorBits}, frames=${tileFrames}, bucketMiss=${tileBucketMiss})`,
    );
    console.log(
      `    aggregate: sun=${sunPct.toFixed(3)}%, noVeg=${noVegPct.toFixed(3)}%  (${tileSun}/${bitsForTile} and ${tileNoVeg}/${bitsForTile} bits)`,
    );
    for (const pf of perFrame) {
      const sunP = (100 * pf.sunDiff) / outdoorBits;
      const noVegP = (100 * pf.noVegDiff) / outdoorBits;
      console.log(
        `    ${pf.localTime}  true(${pf.azTrue.toFixed(3)}° ${pf.altTrue.toFixed(3)}°) → bucket(${pf.azCenter.toFixed(3)} ${pf.altCenter.toFixed(3)})  Δaz=${(pf.azTrue - pf.azCenter).toFixed(3)}° Δalt=${(pf.altTrue - pf.altCenter).toFixed(3)}°  sun=${sunP.toFixed(2)}% noVeg=${noVegP.toFixed(2)}%`,
      );
    }
  }

  const sunPctTotal = totalBits > 0 ? (100 * totalSunDiff) / totalBits : 0;
  const noVegPctTotal = totalBits > 0 ? (100 * totalNoVegDiff) / totalBits : 0;
  console.log(
    `\n  TOTAL @ ${resolutionDeg}°: framesCompared=${framesCompared}, bucketsMissing=${bucketsMissing}`,
  );
  console.log(
    `    sun:   ${sunPctTotal.toFixed(3)}%  (${totalSunDiff}/${totalBits} bits)`,
  );
  console.log(
    `    noVeg: ${noVegPctTotal.toFixed(3)}%  (${totalNoVegDiff}/${totalBits} bits)`,
  );
}

async function main(): Promise<void> {
  await compareOneResolution(1);
  await compareOneResolution(0.5);
  await compareOneResolution(0.25);
}

main().catch((err) => { console.error(err); process.exit(1); });
