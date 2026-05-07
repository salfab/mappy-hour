/**
 * Verifies that the atlas bucket masks correspond to what the tile-service
 * would produce if invoked directly with sunOverride = bucket center.
 *
 * This isolates the "atlas encoding correctness" from "bucket-center vs
 * true-sun divergence". If this test passes, then all divergence observed in
 * the tile-vs-atlas comparison is attributable to angular snap (0.7° residual),
 * not to a wiring bug.
 *
 * Run:
 *   pnpm tsx scripts/ingest/_verify-atlas-bucket-compute.ts
 */

import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import {
  computeSunlightTileArtifact,
  disposeSunlightTileEvaluationBackends,
} from "../../src/lib/precompute/sunlight-tile-service";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasBucket,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
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
const TILE_ID = "e2538250_n1152250_s250"; // worst tile from previous report
const FRAME_LOCAL = "17:00";
const FRAME_UTC = "2026-04-18T15:00:00Z"; // 17:00 CEST = 15:00 UTC

async function main(): Promise<void> {
  const regionConfig = LAUSANNE_CONFIG;

  // 1) Load existing atlas and tile caches; extract the bucket mask and tile mask at 17:00.
  const [tile, atlas] = await Promise.all([
    loadPrecomputedSunlightTileBinary({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      date: DATE,
      gridStepMeters: GRID_STEP,
      sampleEveryMinutes: SAMPLE_MINUTES,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tileId: TILE_ID,
    }),
    loadPrecomputedTileAtlas({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      gridStepMeters: GRID_STEP,
      tileId: TILE_ID,
      resolutionDeg: 1,
    }),
  ]);

  if (!tile || !atlas) {
    console.error("Missing cache(s) for", TILE_ID);
    process.exit(1);
  }

  // Compute tile center sun angle at 17:00
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(TILE_ID)!;
  const minE = Number(m[1]);
  const minN = Number(m[2]);
  const size = Number(m[3]);
  const centerE = minE + size / 2;
  const centerN = minN + size / 2;
  const { lat, lon } = lv95ToWgs84Precise(centerE, centerN);
  const pos = SunCalc.getPosition(new Date(FRAME_UTC), lat, lon);
  const altDegTrue = pos.altitude * RAD_TO_DEG;
  let azDegTrue = (pos.azimuth * RAD_TO_DEG + 180) % 360;
  if (azDegTrue < 0) azDegTrue += 360;
  const azB = Math.floor(azDegTrue);
  const altB = Math.floor(altDegTrue);
  const azCenter = azB + 0.5;
  const altCenter = altB + 0.5;

  console.log(`Tile ${TILE_ID} @ center (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
  console.log(`Frame ${FRAME_LOCAL} UTC=${FRAME_UTC}`);
  console.log(`True sun:   az=${azDegTrue.toFixed(4)}°  alt=${altDegTrue.toFixed(4)}°`);
  console.log(`Bucket:     (${azB}, ${altB})  → center az=${azCenter}°  alt=${altCenter}°`);
  console.log(`Δ:          Δaz=${(azDegTrue - azCenter).toFixed(4)}°  Δalt=${(altDegTrue - altCenter).toFixed(4)}°\n`);

  // Find frame in tile cache
  const frameMeta = tile.meta.framesMeta.find((f) => f.localTime === FRAME_LOCAL);
  if (!frameMeta) {
    console.error(`No frame at ${FRAME_LOCAL} in tile cache`);
    process.exit(1);
  }
  const tileMask = getFrameMask(tile, frameMeta.index, MASK_KIND_SUN);

  // Find bucket in atlas
  const atlasBucket = lookupAtlasBucket(atlas, azB, altB);
  if (!atlasBucket) {
    console.error(`No bucket (${azB}, ${altB}) in atlas`);
    process.exit(1);
  }
  const atlasMask = atlasBucket.sunMask;

  // 2) Recompute the bucket mask from scratch (same tile, sunOverride = bucket center).
  //    This is what the atlas SHOULD store for (azB, altB).
  const tileSpec: RegionTileSpec = {
    tileId: TILE_ID,
    tileSizeMeters: size,
    minEasting: minE,
    minNorthing: minN,
    maxEasting: minE + size,
    maxNorthing: minN + size,
    bbox: {
      minLon: lon - 0.01,
      maxLon: lon + 0.01,
      minLat: lat - 0.01,
      maxLat: lat + 0.01,
    },
  };

  const shadowCalibration = DEFAULT_SHADOW_CALIBRATION;
  const algorithmVersion = MODEL_HASH;

  console.log(`Recomputing bucket (${azB}, ${altB}) from scratch at (az=${azCenter}, alt=${altCenter})...`);
  const startT = Date.now();
  const artifact = await computeSunlightTileArtifact({
    region: REGION,
    modelVersionHash: MODEL_HASH,
    algorithmVersion,
    date: DATE,
    timezone: regionConfig.timezone,
    sampleEveryMinutes: SAMPLE_MINUTES,
    gridStepMeters: GRID_STEP,
    startLocalTime: "00:00",
    endLocalTime: "23:59",
    tile: tileSpec,
    shadowCalibration,
    sunOverride: [{ azimuthDeg: azCenter, altitudeDeg: altCenter }],
  });
  console.log(`  ...done in ${((Date.now() - startT) / 1000).toFixed(1)}s`);

  const freshMask = artifact.frames[0].sunMask;
  console.log(`  fresh mask size: ${freshMask.length} bytes`);
  console.log(`  atlas mask size: ${atlasMask.length} bytes`);
  console.log(`  tile  mask size: ${tileMask.length} bytes`);

  // 3) Bit-level comparison between:
  //    - fresh vs atlas (both at bucket center)   → should be 0 divergence
  //    - fresh vs tile  (bucket center vs true sun) → should equal tile-vs-atlas
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

  const bits = tile.outdoorPointCount;
  const freshVsAtlas = hamming(freshMask, atlasMask, bits);
  const freshVsTile = hamming(freshMask, tileMask, bits);
  const atlasVsTile = hamming(atlasMask, tileMask, bits);

  console.log(`\n=== Bit divergence (${bits} outdoor bits) ===`);
  console.log(`  fresh (bucket-center compute NOW) vs atlas bucket:  ${freshVsAtlas}  (${(100 * freshVsAtlas / bits).toFixed(3)}%)`);
  console.log(`  fresh (bucket-center compute NOW) vs tile (17:00):  ${freshVsTile}  (${(100 * freshVsTile / bits).toFixed(3)}%)`);
  console.log(`  atlas bucket vs tile (17:00):                       ${atlasVsTile}  (${(100 * atlasVsTile / bits).toFixed(3)}%)`);

  console.log(`\n=== Diagnosis ===`);
  if (freshVsAtlas === 0) {
    console.log(`  ✓ Atlas bucket IS exactly what a fresh bucket-center compute produces.`);
    console.log(`    The 27% divergence is entirely due to the angular snap (bucket center vs true sun).`);
  } else {
    console.log(`  ✗ Atlas bucket DIFFERS from a fresh bucket-center compute (${freshVsAtlas} bits).`);
    console.log(`    There is a bug in the atlas write/read path.`);
  }

  // Additional check: the "fresh vs tile" divergence is the PURE angular-snap effect
  // and should be close to the observed "atlas vs tile" (they'd be identical if
  // atlas was correctly encoded — which freshVsAtlas verifies above).
  if (freshVsAtlas === 0) {
    console.log(`\n  Pure angular-snap divergence (fresh vs tile): ${freshVsTile} / ${bits} = ${(100 * freshVsTile / bits).toFixed(3)}%`);
    console.log(`  That IS the true cost of the 1° bucket resolution at this sun angle.`);
  }

  await disposeSunlightTileEvaluationBackends();
}

main().catch((err) => { console.error(err); process.exit(1); });
