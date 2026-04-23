/**
 * Regenerate 3 date-keyed tile caches using the Vulkan backend.
 *
 * Creates a fresh `t1700-1745` window for 2026-04-18 on the 3 test tiles,
 * which will contain proper building + terrain + vegetation blocker masks.
 * This provides a correct reference for atlas-vs-tile comparison.
 *
 * Must be run with:
 *   MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan pnpm tsx scripts/ingest/_regen-tile-cache-vulkan.ts
 */

if (process.env.MAPPY_BUILDINGS_SHADOW_MODE !== "rust-wgpu-vulkan") {
  console.error(
    `ERROR: expected MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan, got "${process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(unset)"}"`,
  );
  console.error(
    `Run with:  MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan pnpm tsx scripts/ingest/_regen-tile-cache-vulkan.ts`,
  );
  process.exit(1);
}

import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import {
  computeSunlightTileArtifact,
  disposeSunlightTileEvaluationBackends,
} from "../../src/lib/precompute/sunlight-tile-service";
import { writePrecomputedSunlightTile } from "../../src/lib/precompute/sunlight-cache";
import { DEFAULT_SHADOW_CALIBRATION } from "../../src/lib/sun/shadow-calibration";
import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import type { RegionTileSpec } from "../../src/lib/precompute/sunlight-cache";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = Number(process.env.SAMPLE_MINUTES ?? 15);
const DATE = "2026-04-18";
const START_LOCAL = process.env.START_LOCAL ?? "17:00";
const END_LOCAL = process.env.END_LOCAL ?? "17:45";

const TEST_TILES = (process.env.TILES ?? "e2538000_n1152500_s250,e2538250_n1152250_s250,e2538500_n1152250_s250").split(",");

function parseTileId(id: string): { minE: number; minN: number; size: number } {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id)!;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

async function main(): Promise<void> {
  console.log(`Regenerating ${TEST_TILES.length} date-keyed tiles with Vulkan`);
  console.log(`  backend: ${process.env.MAPPY_BUILDINGS_SHADOW_MODE}`);
  console.log(`  date:    ${DATE}`);
  console.log(`  window:  ${START_LOCAL}..${END_LOCAL}`);
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
    const artifact = await computeSunlightTileArtifact({
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
    const computeMs = Date.now() - t0;

    await writePrecomputedSunlightTile(artifact);
    const writeMs = Date.now() - t0 - computeMs;

    const outdoor = artifact.outdoorPointCount;
    const frames = artifact.frames.length;
    const totalMs = computeMs + writeMs;
    console.log(
      `compute=${(computeMs / 1000).toFixed(1)}s write=${(writeMs / 1000).toFixed(2)}s  outdoor=${outdoor}  frames=${frames}  total=${(totalMs / 1000).toFixed(1)}s`,
    );
  }

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\nDone in ${totalElapsed}s total.`);

  await disposeSunlightTileEvaluationBackends();
}

main().catch((err) => { console.error(err); process.exit(1); });
