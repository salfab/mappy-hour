/**
 * Sanity check: does the tile-cache point ordering match the atlas point ordering?
 *
 * If pointIx/pointIy/pointOutdoorIndex differ between tile and atlas for the same
 * geometric index `i`, then the sunMask bit at position `o` in the tile and
 * position `o` in the atlas refer to DIFFERENT pixels — which would produce
 * exactly the "structural divergence" pattern observed in the spatial-distance
 * histogram.
 *
 * Run:
 *   pnpm tsx scripts/ingest/_check-point-ordering.ts
 */

import fs from "node:fs/promises";
import path from "node:path";

import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import { loadPrecomputedSunlightTileBinary } from "../../src/lib/precompute/sunlight-cache-binary";
import { loadPrecomputedTileAtlas } from "../../src/lib/precompute/sunlight-cache-atlas";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";
const START_LOCAL = "00:00";
const END_LOCAL = "23:59";

// Spot-check on a representative worst tile
const SAMPLE_TILE_IDS = [
  "e2538250_n1152250_s250", // top of the "beyond" list
  "e2538000_n1152500_s250",
  "e2537750_n1152000_s250",
];

async function main(): Promise<void> {
  for (const tileId of SAMPLE_TILE_IDS) {
    console.log(`\n=== ${tileId} ===`);
    const [tile, atlas] = await Promise.all([
      loadPrecomputedSunlightTileBinary({
        region: REGION,
        modelVersionHash: MODEL_HASH,
        date: DATE,
        gridStepMeters: GRID_STEP,
        sampleEveryMinutes: SAMPLE_MINUTES,
        startLocalTime: START_LOCAL,
        endLocalTime: END_LOCAL,
        tileId,
      }),
      loadPrecomputedTileAtlas({
        region: REGION,
        modelVersionHash: MODEL_HASH,
        gridStepMeters: GRID_STEP,
        tileId,
        resolutionDeg: 0.25,
      }),
    ]);

    if (!tile) { console.log("  no tile cache"); continue; }
    if (!atlas) { console.log("  no atlas"); continue; }

    console.log(`  pointCount          tile=${tile.pointCount}   atlas=${atlas.pointCount}    match=${tile.pointCount === atlas.pointCount}`);
    console.log(`  outdoorPointCount   tile=${tile.outdoorPointCount}   atlas=${atlas.outdoorPointCount}   match=${tile.outdoorPointCount === atlas.outdoorPointCount}`);

    if (tile.pointCount !== atlas.pointCount) continue;

    let ixMismatch = 0, iyMismatch = 0, oiMismatch = 0, flagMismatch = 0;
    const firstMismatch: { i: number; reason: string; t: unknown; a: unknown } | null = null as unknown as { i: number; reason: string; t: unknown; a: unknown } | null;
    let firstIdx = -1;
    let firstReason = "";
    for (let i = 0; i < tile.pointCount; i++) {
      if (tile.pointIx[i] !== atlas.pointIx[i]) {
        ixMismatch++;
        if (firstIdx < 0) { firstIdx = i; firstReason = `ix tile=${tile.pointIx[i]} atlas=${atlas.pointIx[i]}`; }
      }
      if (tile.pointIy[i] !== atlas.pointIy[i]) {
        iyMismatch++;
        if (firstIdx < 0) { firstIdx = i; firstReason = `iy tile=${tile.pointIy[i]} atlas=${atlas.pointIy[i]}`; }
      }
      if (tile.pointOutdoorIndex[i] !== atlas.pointOutdoorIndex[i]) {
        oiMismatch++;
        if (firstIdx < 0) { firstIdx = i; firstReason = `outdoorIndex tile=${tile.pointOutdoorIndex[i]} atlas=${atlas.pointOutdoorIndex[i]}`; }
      }
      if (tile.pointFlags[i] !== atlas.pointFlags[i]) {
        flagMismatch++;
      }
    }
    console.log(`  pointIx mismatches:          ${ixMismatch}`);
    console.log(`  pointIy mismatches:          ${iyMismatch}`);
    console.log(`  pointOutdoorIndex mismatches: ${oiMismatch}`);
    console.log(`  pointFlags mismatches:       ${flagMismatch}`);
    if (firstIdx >= 0) {
      console.log(`  first mismatch at i=${firstIdx}: ${firstReason}`);
      console.log(`    tile[i]: ix=${tile.pointIx[firstIdx]} iy=${tile.pointIy[firstIdx]} oi=${tile.pointOutdoorIndex[firstIdx]} flags=${tile.pointFlags[firstIdx]}`);
      console.log(`    atlas[i]: ix=${atlas.pointIx[firstIdx]} iy=${atlas.pointIy[firstIdx]} oi=${atlas.pointOutdoorIndex[firstIdx]} flags=${atlas.pointFlags[firstIdx]}`);
    }

    // Also check pointIds if present (stored in meta)
    const tileIds = tile.meta.pointIds ?? [];
    const atlasIds = atlas.meta.pointIds ?? [];
    if (tileIds.length && atlasIds.length) {
      let idMismatch = 0;
      let firstIdMismatch = -1;
      for (let i = 0; i < Math.min(tileIds.length, atlasIds.length); i++) {
        if (tileIds[i] !== atlasIds[i]) {
          idMismatch++;
          if (firstIdMismatch < 0) firstIdMismatch = i;
        }
      }
      console.log(`  pointIds mismatches: ${idMismatch} / ${tileIds.length}`);
      if (firstIdMismatch >= 0) {
        console.log(`    first id mismatch at i=${firstIdMismatch}: tile="${tileIds[firstIdMismatch]}" atlas="${atlasIds[firstIdMismatch]}"`);
      }
    }

    // Model hash comparison
    console.log(`  tile model hash:   ${tile.meta.modelVersionHash}`);
    console.log(`  atlas model hash:  ${atlas.meta.modelVersionHash}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
