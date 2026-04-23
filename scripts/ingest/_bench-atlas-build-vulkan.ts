/**
 * Builds a Vulkan-native atlas for the GE tile at a given resolution,
 * covering a full year's sun trajectory via 8 representative dates.
 *
 * Writes to the standard atlas path (uses `computeAndMergeAtlasForTile`).
 * Requires cache-mined atlas at same resolution to be moved aside first.
 *
 * Usage:
 *   MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan RESOLUTION_DEG=1 pnpm tsx scripts/ingest/_bench-atlas-build-vulkan.ts
 */

if (process.env.MAPPY_BUILDINGS_SHADOW_MODE !== "rust-wgpu-vulkan") {
  console.error(`ERROR: expected MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan, got "${process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(unset)"}"`);
  process.exit(1);
}

import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import { computeAndMergeAtlasForTile } from "../../src/lib/precompute/atlas-tile-service";
import { disposeSunlightTileEvaluationBackends } from "../../src/lib/precompute/sunlight-tile-service";
import { DEFAULT_SHADOW_CALIBRATION } from "../../src/lib/sun/shadow-calibration";
import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import type { RegionTileSpec } from "../../src/lib/precompute/sunlight-cache";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const TILE_ID = "e2538000_n1152500_s250";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const RESOLUTION_DEG = Number(process.env.RESOLUTION_DEG ?? 1);

// 8 representative dates across a year → covers full sun trajectory envelope.
const DATES = [
  "2026-03-20", "2026-04-18", "2026-05-15", "2026-06-21",
  "2026-07-22", "2026-09-22", "2026-10-21", "2026-12-21",
];
const START_LOCAL = "04:00";
const END_LOCAL = "22:00";

async function main(): Promise<void> {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(TILE_ID)!;
  const minE = Number(m[1]); const minN = Number(m[2]); const size = Number(m[3]);
  const { lat, lon } = lv95ToWgs84(minE + size / 2, minN + size / 2);
  const tile: RegionTileSpec = {
    tileId: TILE_ID, tileSizeMeters: size,
    minEasting: minE, minNorthing: minN,
    maxEasting: minE + size, maxNorthing: minN + size,
    bbox: { minLon: lon - 0.01, maxLon: lon + 0.01, minLat: lat - 0.01, maxLat: lat + 0.01 },
  };

  console.log(`Vulkan-native atlas build @ ${RESOLUTION_DEG}°`);
  console.log(`  tile: ${TILE_ID}  dates: ${DATES.length}\n`);

  const totalStart = Date.now();
  let lastBucketCount = 0;
  const perDate: Array<{ date: string; elapsedS: number; bucketsBefore: number; bucketsAfter: number; newBuckets: number }> = [];

  for (const date of DATES) {
    process.stdout.write(`${date}: `);
    const t0 = Date.now();
    const result = await computeAndMergeAtlasForTile({
      region: REGION, modelVersionHash: MODEL_HASH, algorithmVersion: MODEL_HASH,
      date, timezone: LAUSANNE_CONFIG.timezone, sampleEveryMinutes: SAMPLE_MINUTES,
      gridStepMeters: GRID_STEP, startLocalTime: START_LOCAL, endLocalTime: END_LOCAL,
      tile, shadowCalibration: DEFAULT_SHADOW_CALIBRATION, resolutionDeg: RESOLUTION_DEG,
    });
    const elapsed = (Date.now() - t0) / 1000;
    const newBuckets = result.bucketCountTotal - lastBucketCount;
    perDate.push({ date, elapsedS: elapsed, bucketsBefore: lastBucketCount, bucketsAfter: result.bucketCountTotal, newBuckets });
    console.log(`${result.state} in ${elapsed.toFixed(1)}s — buckets=${result.bucketCountTotal} (+${newBuckets})`);
    lastBucketCount = result.bucketCountTotal;
  }

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n=== Summary @ ${RESOLUTION_DEG}° ===`);
  console.log(`Total wall time: ${totalElapsed}s`);
  console.log(`Final bucket count: ${lastBucketCount}`);
  console.log(`Amortization — first date cost: ${perDate[0].elapsedS.toFixed(1)}s for ${perDate[0].newBuckets} buckets`);
  console.log(`             subsequent avg : ${((perDate.slice(1).reduce((a, b) => a + b.elapsedS, 0)) / (perDate.length - 1)).toFixed(1)}s/date avg, new buckets trailing off`);

  await disposeSunlightTileEvaluationBackends();
}
main().catch((err) => { console.error(err); process.exit(1); });
