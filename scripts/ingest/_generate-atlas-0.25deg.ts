/**
 * Generates a 0.25° angular-resolution atlas using the SAME Vulkan backend
 * as the production atlas (rust-wgpu-vulkan). Output lands in a separate
 * r0.25 path so it coexists with the r1 atlas.
 *
 * Once generated, the mass comparison (_compare-atlas-0.25deg-vs-tile.ts)
 * can apples-to-apples measure divergence at 0.25° vs tile cache.
 *
 * MUST be run with the backend env var set at process start (ES imports are
 * hoisted, so assigning process.env inside the script is too late):
 *
 *   cross-env MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan \
 *     pnpm tsx scripts/ingest/_generate-atlas-0.25deg.ts
 */

if (process.env.MAPPY_BUILDINGS_SHADOW_MODE !== "rust-wgpu-vulkan") {
  console.error(
    `ERROR: expected MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan, got "${process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(unset)"}"`,
  );
  console.error(
    `Run with:  cross-env MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan pnpm tsx scripts/ingest/_generate-atlas-0.25deg.ts`,
  );
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
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";
// Focus on the 17h window only — 4 sun positions → ~4 unique buckets at 0.25°.
// Keeping it short so the Vulkan compute finishes in a few minutes per tile.
const START_LOCAL = "17:00";
const END_LOCAL = "17:45";
const RESOLUTION_DEG = Number(process.env.RESOLUTION_DEG ?? 0.25);

const TEST_TILES = [
  "e2538000_n1152500_s250",
  "e2538250_n1152250_s250",
  "e2538500_n1152250_s250",
];

function parseTileId(id: string): { minE: number; minN: number; size: number } {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id)!;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

async function main(): Promise<void> {
  console.log(`Generating atlas @ ${RESOLUTION_DEG}° for ${TEST_TILES.length} tiles`);
  console.log(`  backend: MAPPY_BUILDINGS_SHADOW_MODE=${process.env.MAPPY_BUILDINGS_SHADOW_MODE}`);
  console.log(`  window:  ${START_LOCAL}..${END_LOCAL} on ${DATE}`);
  console.log(`  model:   ${MODEL_HASH}\n`);

  const totalStart = Date.now();

  for (const tileId of TEST_TILES) {
    const parsed = parseTileId(tileId);
    const centerE = parsed.minE + parsed.size / 2;
    const centerN = parsed.minN + parsed.size / 2;
    const { lat, lon } = lv95ToWgs84(centerE, centerN);

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

    process.stdout.write(`${tileId}: `);
    const t0 = Date.now();
    const result = await computeAndMergeAtlasForTile({
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
      resolutionDeg: RESOLUTION_DEG,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${result.state} in ${elapsed}s — buckets=${result.bucketCountTotal}, outdoor=${result.pointCountOutdoor}`,
    );
  }

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\nDone in ${totalElapsed}s total.`);

  await disposeSunlightTileEvaluationBackends();
}

main().catch((err) => { console.error(err); process.exit(1); });
