/**
 * Audit across all 161 tiles: do tile caches have buildings/terrain blocker masks?
 *
 * For each tile, picks the midday frame and reports popcount of each blocker mask.
 * If buildingsBlocked=0 for all/most tiles, the date-keyed cache was computed without
 * building shadows — which invalidates any tile-vs-atlas comparison using MASK_KIND_SUN.
 *
 * Run:
 *   pnpm tsx scripts/ingest/_audit-tile-blocker-masks.ts
 */

import fs from "node:fs/promises";
import path from "node:path";

import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
  MASK_KIND_TERRAIN_BLOCKED,
  MASK_KIND_BUILDINGS_BLOCKED,
  MASK_KIND_VEGETATION_BLOCKED,
} from "../../src/lib/precompute/sunlight-cache-binary";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}

function popcountBits(buf: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let count = 0;
  for (let i = 0; i < fullBytes; i++) count += popcount8(buf[i]);
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    count += popcount8(buf[fullBytes] & mask);
  }
  return count;
}

async function listTileIds(): Promise<string[]> {
  const tilesDir = path.join(
    CACHE_SUNLIGHT_DIR,
    REGION,
    MODEL_HASH,
    `g${GRID_STEP}`,
    `m${SAMPLE_MINUTES}`,
    DATE,
    "t0000-2359",
    "tiles",
  );
  try {
    const entries = await fs.readdir(tilesDir);
    return entries
      .filter((n) => n.endsWith(".tile.bin.gz"))
      .map((n) => n.replace(/\.tile\.bin\.gz$/, ""))
      .sort();
  } catch (err) {
    console.error(`Cannot list ${tilesDir}:`, err);
    return [];
  }
}

async function main(): Promise<void> {
  const tileIds = await listTileIds();
  console.log(`Auditing ${tileIds.length} tiles for blocker mask population...\n`);

  let tilesWithBuildings = 0;
  let tilesWithTerrain = 0;
  let tilesWithVegetation = 0;
  let totalTiles = 0;

  const worstExamples: Array<{
    id: string;
    outdoor: number;
    b: number;
    t: number;
    v: number;
    sun: number;
    noVeg: number;
  }> = [];

  for (const tileId of tileIds) {
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
    if (!tile) continue;
    totalTiles++;

    // Pick midday frame
    const midday = tile.meta.framesMeta.find((f) => f.localTime === "12:00")
      ?? tile.meta.framesMeta.find((f) => f.localTime === "13:00")
      ?? tile.meta.framesMeta[Math.floor(tile.meta.framesMeta.length / 2)];
    if (!midday) continue;

    const bits = tile.outdoorPointCount;
    const terrain = getFrameMask(tile, midday.index, MASK_KIND_TERRAIN_BLOCKED);
    const buildings = getFrameMask(tile, midday.index, MASK_KIND_BUILDINGS_BLOCKED);
    const vegetation = getFrameMask(tile, midday.index, MASK_KIND_VEGETATION_BLOCKED);
    const sun = getFrameMask(tile, midday.index, MASK_KIND_SUN);
    const noVeg = getFrameMask(tile, midday.index, MASK_KIND_SUN_NO_VEG);

    const t = popcountBits(terrain, bits);
    const b = popcountBits(buildings, bits);
    const v = popcountBits(vegetation, bits);
    const s = popcountBits(sun, bits);
    const nv = popcountBits(noVeg, bits);

    if (b > 0) tilesWithBuildings++;
    if (t > 0) tilesWithTerrain++;
    if (v > 0) tilesWithVegetation++;

    if (worstExamples.length < 10) {
      worstExamples.push({ id: tileId, outdoor: bits, b, t, v, sun: s, noVeg: nv });
    }
  }

  console.log(`Total tiles audited: ${totalTiles}`);
  console.log(`Tiles with buildingsBlocked > 0:   ${tilesWithBuildings} (${(100 * tilesWithBuildings / totalTiles).toFixed(1)}%)`);
  console.log(`Tiles with terrainBlocked > 0:     ${tilesWithTerrain} (${(100 * tilesWithTerrain / totalTiles).toFixed(1)}%)`);
  console.log(`Tiles with vegetationBlocked > 0:  ${tilesWithVegetation} (${(100 * tilesWithVegetation / totalTiles).toFixed(1)}%)`);

  console.log(`\nFirst 10 examples (midday frame):`);
  console.log(`  ${"tileId".padEnd(32)}  outdoor  t     b     v     sun   noVeg`);
  for (const ex of worstExamples) {
    console.log(
      `  ${ex.id.padEnd(32)}  ${String(ex.outdoor).padEnd(7)}  ${String(ex.t).padEnd(5)} ${String(ex.b).padEnd(5)} ${String(ex.v).padEnd(5)} ${String(ex.sun).padEnd(5)} ${ex.noVeg}`,
    );
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
