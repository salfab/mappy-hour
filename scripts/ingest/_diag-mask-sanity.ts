/**
 * Sanity-diagnostic on the sun mask bits.
 *
 * For one tile at one frame, compares:
 *  - popcount(tile.sunMask)       — should == framesMeta.sunnyCount
 *  - popcount(atlas_r1.sunMask) at the corresponding 1° bucket
 *  - popcount(atlas_r0.25.sunMask) at the corresponding 0.25° bucket
 *  - bit-overlap (intersection) between tile and atlases
 *
 * At 0.25° the angular Δ is ~0.1°. Shadow positions shift by <1m.
 * If tile vs r0.25 bit-overlap is 99%+, the measurement works.
 * If it's 50%, there's a fundamental encoding/alignment bug.
 *
 * Run:
 *   pnpm tsx scripts/ingest/_diag-mask-sanity.ts
 */

import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
  MASK_KIND_TERRAIN_BLOCKED,
  MASK_KIND_BUILDINGS_BLOCKED,
  MASK_KIND_VEGETATION_BLOCKED,
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
const TILE_ID = "e2538000_n1152500_s250";
const FRAME_LOCAL = "17:00";
// Switch to the freshly Vulkan-regenerated tile window (17:00-17:45)
const TILE_START = "17:00";
const TILE_END = "17:45";

function popcountBits(buf: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let count = 0;
  for (let i = 0; i < fullBytes; i++) {
    let x = buf[i];
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    count += (x + (x >> 4)) & 0x0f;
  }
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    let x = buf[fullBytes] & mask;
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    count += (x + (x >> 4)) & 0x0f;
  }
  return count;
}

function popcountAnd(a: Uint8Array, b: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let count = 0;
  for (let i = 0; i < fullBytes; i++) {
    let x = a[i] & b[i];
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    count += (x + (x >> 4)) & 0x0f;
  }
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    let x = (a[fullBytes] & b[fullBytes]) & mask;
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    count += (x + (x >> 4)) & 0x0f;
  }
  return count;
}

function popcountXor(a: Uint8Array, b: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let count = 0;
  for (let i = 0; i < fullBytes; i++) {
    let x = a[i] ^ b[i];
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    count += (x + (x >> 4)) & 0x0f;
  }
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    let x = (a[fullBytes] ^ b[fullBytes]) & mask;
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    count += (x + (x >> 4)) & 0x0f;
  }
  return count;
}

async function main(): Promise<void> {
  const [tile, r1, r025] = await Promise.all([
    loadPrecomputedSunlightTileBinary({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      date: DATE,
      gridStepMeters: GRID_STEP,
      sampleEveryMinutes: SAMPLE_MINUTES,
      startLocalTime: TILE_START,
      endLocalTime: TILE_END,
      tileId: TILE_ID,
    }),
    loadPrecomputedTileAtlas({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      gridStepMeters: GRID_STEP,
      tileId: TILE_ID,
      resolutionDeg: 1,
    }),
    loadPrecomputedTileAtlas({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      gridStepMeters: GRID_STEP,
      tileId: TILE_ID,
      resolutionDeg: 0.25,
    }),
  ]);
  if (!tile || !r1 || !r025) { console.error("missing cache(s)"); process.exit(1); }

  const frameMeta = tile.meta.framesMeta.find((f) => f.localTime === FRAME_LOCAL)!;
  const utc = new Date(frameMeta.utcTime);
  const centerE = tile.meta.tile.minEasting + tile.meta.tile.tileSizeMeters / 2;
  const centerN = tile.meta.tile.minNorthing + tile.meta.tile.tileSizeMeters / 2;
  const { lat, lon } = lv95ToWgs84Precise(centerE, centerN);
  const pos = SunCalc.getPosition(utc, lat, lon);
  const altDeg = pos.altitude * RAD_TO_DEG;
  let azDeg = (pos.azimuth * RAD_TO_DEG + 180) % 360;
  if (azDeg < 0) azDeg += 360;

  const azB1 = Math.floor(azDeg);
  const altB1 = Math.floor(altDeg);
  const b1 = lookupAtlasBucket(r1, azB1, altB1);
  const azB025 = Math.floor(azDeg / 0.25);
  const altB025 = Math.floor(altDeg / 0.25);
  const b025 = lookupAtlasBucket(r025, azB025, altB025);

  if (!b1 || !b025) { console.error("missing bucket(s)"); process.exit(1); }

  const tileMask = getFrameMask(tile, frameMeta.index, MASK_KIND_SUN);
  const tileMaskNoVeg = getFrameMask(tile, frameMeta.index, MASK_KIND_SUN_NO_VEG);
  const r1Mask = b1.sunMask;
  const r025Mask = b025.sunMask;
  const r1MaskNoVeg = b1.sunNoVegMask;
  const r025MaskNoVeg = b025.sunNoVegMask;

  const bits = tile.outdoorPointCount;

  console.log(`Tile: ${TILE_ID}  frame: ${FRAME_LOCAL}`);
  console.log(`True sun: az=${azDeg.toFixed(4)}°  alt=${altDeg.toFixed(4)}°`);
  console.log(`1° bucket (${azB1}, ${altB1}) center=(${azB1 + 0.5}, ${altB1 + 0.5}) Δaz=${(azDeg - (azB1 + 0.5)).toFixed(4)}° Δalt=${(altDeg - (altB1 + 0.5)).toFixed(4)}°`);
  console.log(`0.25° bucket (${azB025}, ${altB025}) center=(${(azB025 + 0.5) * 0.25}, ${(altB025 + 0.5) * 0.25}) Δaz=${(azDeg - (azB025 + 0.5) * 0.25).toFixed(4)}° Δalt=${(altDeg - (altB025 + 0.5) * 0.25).toFixed(4)}°`);
  console.log(`outdoor bits: ${bits}`);
  console.log(`mask sizes: tile=${tileMask.length}B, r1=${r1Mask.length}B, r025=${r025Mask.length}B`);

  const tileSunny = popcountBits(tileMask, bits);
  const r1Sunny = popcountBits(r1Mask, bits);
  const r025Sunny = popcountBits(r025Mask, bits);
  console.log(`\nSunny count (popcount of mask):`);
  console.log(`  tile: ${tileSunny} (${(100 * tileSunny / bits).toFixed(2)}%), framesMeta.sunnyCount: ${frameMeta.sunnyCount}`);
  console.log(`  r1:   ${r1Sunny} (${(100 * r1Sunny / bits).toFixed(2)}%)`);
  console.log(`  r025: ${r025Sunny} (${(100 * r025Sunny / bits).toFixed(2)}%)`);

  const tileAndR1 = popcountAnd(tileMask, r1Mask, bits);
  const tileAndR025 = popcountAnd(tileMask, r025Mask, bits);
  const tileXorR1 = popcountXor(tileMask, r1Mask, bits);
  const tileXorR025 = popcountXor(tileMask, r025Mask, bits);

  console.log(`\nOverlap (both sunny):`);
  console.log(`  tile ∩ r1:   ${tileAndR1}   (${(100 * tileAndR1 / tileSunny).toFixed(2)}% of tile's sunny bits)`);
  console.log(`  tile ∩ r025: ${tileAndR025}   (${(100 * tileAndR025 / tileSunny).toFixed(2)}% of tile's sunny bits)`);

  console.log(`\nXOR (disagree):`);
  console.log(`  tile ^ r1:   ${tileXorR1}   (${(100 * tileXorR1 / bits).toFixed(2)}% of all bits)`);
  console.log(`  tile ^ r025: ${tileXorR025}   (${(100 * tileXorR025 / bits).toFixed(2)}% of all bits)`);

  // Decomposition of XOR: bits that are sunny-in-tile-only + sunny-in-atlas-only
  // bit_in_a_not_b = count(a & ~b); total_xor = bit_in_a_not_b + bit_in_b_not_a
  const tileOnlyVsR1 = tileSunny - tileAndR1;
  const r1OnlyVsTile = r1Sunny - tileAndR1;
  const tileOnlyVsR025 = tileSunny - tileAndR025;
  const r025OnlyVsTile = r025Sunny - tileAndR025;
  console.log(`\nDecomposed:`);
  console.log(`  r1:   tile-sunny-only=${tileOnlyVsR1}, atlas-sunny-only=${r1OnlyVsTile}  (sum=${tileOnlyVsR1 + r1OnlyVsTile})`);
  console.log(`  r025: tile-sunny-only=${tileOnlyVsR025}, atlas-sunny-only=${r025OnlyVsTile}  (sum=${tileOnlyVsR025 + r025OnlyVsTile})`);

  // --- NO_VEG ---
  console.log(`\n\n────────────── MASK_KIND_SUN_NO_VEG (buildings-only shadow) ──────────────`);

  const tileNoVegSunny = popcountBits(tileMaskNoVeg, bits);
  const r1NoVegSunny = popcountBits(r1MaskNoVeg, bits);
  const r025NoVegSunny = popcountBits(r025MaskNoVeg, bits);
  console.log(`\nSunny count:`);
  console.log(`  tile.noVeg: ${tileNoVegSunny} (${(100 * tileNoVegSunny / bits).toFixed(2)}%), framesMeta.sunnyNoVegCount: ${frameMeta.sunnyNoVegCount ?? "?"}`);
  console.log(`  r1.noVeg:   ${r1NoVegSunny} (${(100 * r1NoVegSunny / bits).toFixed(2)}%)`);
  console.log(`  r025.noVeg: ${r025NoVegSunny} (${(100 * r025NoVegSunny / bits).toFixed(2)}%)`);

  const tileAndR1NoVeg = popcountAnd(tileMaskNoVeg, r1MaskNoVeg, bits);
  const tileAndR025NoVeg = popcountAnd(tileMaskNoVeg, r025MaskNoVeg, bits);
  const tileXorR1NoVeg = popcountXor(tileMaskNoVeg, r1MaskNoVeg, bits);
  const tileXorR025NoVeg = popcountXor(tileMaskNoVeg, r025MaskNoVeg, bits);

  console.log(`\nOverlap:`);
  console.log(`  tile.noVeg ∩ r1.noVeg:   ${tileAndR1NoVeg}   (${(100 * tileAndR1NoVeg / tileNoVegSunny).toFixed(2)}% of tile's noVeg sunny)`);
  console.log(`  tile.noVeg ∩ r025.noVeg: ${tileAndR025NoVeg}   (${(100 * tileAndR025NoVeg / tileNoVegSunny).toFixed(2)}% of tile's noVeg sunny)`);

  console.log(`\nXOR:`);
  console.log(`  tile.noVeg ^ r1.noVeg:   ${tileXorR1NoVeg}   (${(100 * tileXorR1NoVeg / bits).toFixed(2)}%)`);
  console.log(`  tile.noVeg ^ r025.noVeg: ${tileXorR025NoVeg}   (${(100 * tileXorR025NoVeg / bits).toFixed(2)}%)`);

  const tileOnlyVsR1NV = tileNoVegSunny - tileAndR1NoVeg;
  const r1OnlyVsTileNV = r1NoVegSunny - tileAndR1NoVeg;
  const tileOnlyVsR025NV = tileNoVegSunny - tileAndR025NoVeg;
  const r025OnlyVsTileNV = r025NoVegSunny - tileAndR025NoVeg;
  console.log(`\nDecomposed:`);
  console.log(`  r1.noVeg:   tile-only=${tileOnlyVsR1NV}, atlas-only=${r1OnlyVsTileNV}`);
  console.log(`  r025.noVeg: tile-only=${tileOnlyVsR025NV}, atlas-only=${r025OnlyVsTileNV}`);

  // --- Cross checks ---
  console.log(`\n\n────────────── Cross checks ──────────────`);

  // tile.sun vs tile.noVeg — should be: sun is a subset of noVeg (vegetation only adds shadow)
  const tileSunAndNoVeg = popcountAnd(tileMask, tileMaskNoVeg, bits);
  const tileSunAndNotNoVeg = tileSunny - tileSunAndNoVeg; // sun=1, noVeg=0 → invariant violation (veg should make things darker, not brighter)
  const tileNoVegAndNotSun = tileNoVegSunny - tileSunAndNoVeg; // noVeg=1, sun=0 → pixels where veg casts shadow
  console.log(`\nTile internal invariant (sun ⊆ noVeg? i.e. vegetation only darkens):`);
  console.log(`  tile.sun ∩ tile.noVeg = ${tileSunAndNoVeg}`);
  console.log(`  tile: sun=1 AND noVeg=0 = ${tileSunAndNotNoVeg}  (should be 0 — veg shouldn't brighten)`);
  console.log(`  tile: sun=0 AND noVeg=1 = ${tileNoVegAndNotSun}  (veg casts shadow on these)`);

  // Same for r025
  const r025SunAndNoVeg = popcountAnd(r025Mask, r025MaskNoVeg, bits);
  const r025SunAndNotNoVeg = r025Sunny - r025SunAndNoVeg;
  const r025NoVegAndNotSun = r025NoVegSunny - r025SunAndNoVeg;
  console.log(`\nAtlas r025 internal invariant:`);
  console.log(`  r025.sun ∩ r025.noVeg = ${r025SunAndNoVeg}`);
  console.log(`  r025: sun=1 AND noVeg=0 = ${r025SunAndNotNoVeg}`);
  console.log(`  r025: sun=0 AND noVeg=1 = ${r025NoVegAndNotSun}`);

  // --- Tile cache raw blocker masks ---
  console.log(`\n\n────────────── Tile cache raw blocker masks ──────────────`);
  const terrainBlocked = getFrameMask(tile, frameMeta.index, MASK_KIND_TERRAIN_BLOCKED);
  const buildingsBlocked = getFrameMask(tile, frameMeta.index, MASK_KIND_BUILDINGS_BLOCKED);
  const vegetationBlocked = getFrameMask(tile, frameMeta.index, MASK_KIND_VEGETATION_BLOCKED);
  const terrainBlockedCount = popcountBits(terrainBlocked, bits);
  const buildingsBlockedCount = popcountBits(buildingsBlocked, bits);
  const vegetationBlockedCount = popcountBits(vegetationBlocked, bits);
  console.log(`  terrainBlocked:     ${terrainBlockedCount} (${(100 * terrainBlockedCount / bits).toFixed(2)}%)`);
  console.log(`  buildingsBlocked:   ${buildingsBlockedCount} (${(100 * buildingsBlockedCount / bits).toFixed(2)}%)`);
  console.log(`  vegetationBlocked:  ${vegetationBlockedCount} (${(100 * vegetationBlockedCount / bits).toFixed(2)}%)`);
  console.log(`  → expected sunNoVeg = ${bits - terrainBlockedCount - buildingsBlockedCount} (allowing overlap)`);
  console.log(`  → actual   sunNoVeg = ${tileNoVegSunny}`);
  console.log(`  → expected sun      = ${bits - terrainBlockedCount - buildingsBlockedCount - vegetationBlockedCount} (allowing overlap)`);
  console.log(`  → actual   sun      = ${tileSunny}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
