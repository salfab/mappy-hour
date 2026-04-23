/**
 * Diagnostic: compare pointIds between atlas and tile cache for a given tile.
 * If pointOutdoorIndex arrays disagree, we have our culprit.
 */

import SunCalc from "suncalc";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
} from "../../src/lib/precompute/sunlight-cache-binary";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasBucket,
} from "../../src/lib/precompute/sunlight-cache-atlas";

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}
function popcount(buf: Uint8Array, bits: number): number {
  const fb = Math.floor(bits / 8); const tb = bits - fb * 8;
  let n = 0;
  for (let i = 0; i < fb; i++) n += popcount8(buf[i]);
  if (tb > 0) n += popcount8(buf[fb] & ((1 << tb) - 1));
  return n;
}
function popcountXor(a: Uint8Array, b: Uint8Array, bits: number): number {
  const fb = Math.floor(bits / 8); const tb = bits - fb * 8;
  let n = 0;
  for (let i = 0; i < fb; i++) n += popcount8(a[i] ^ b[i]);
  if (tb > 0) n += popcount8((a[fb] ^ b[fb]) & ((1 << tb) - 1));
  return n;
}

const REGION = "lausanne";
const MODEL_HASH = "d43fe24cbb9190af";
const TILE_ID = "e2538000_n1152500_s250";
const GRID_STEP = 1;

async function main() {
  const tile = await loadPrecomputedSunlightTileBinary({
    region: REGION as never, modelVersionHash: MODEL_HASH,
    date: "2026-04-18", gridStepMeters: GRID_STEP, sampleEveryMinutes: 15,
    startLocalTime: "00:00", endLocalTime: "23:59", tileId: TILE_ID,
  });
  if (!tile) { console.error("tile not found"); return; }

  const atlas = await loadPrecomputedTileAtlas({
    region: REGION as never, modelVersionHash: MODEL_HASH,
    gridStepMeters: GRID_STEP, tileId: TILE_ID, resolutionDeg: 1,
  });
  if (!atlas) { console.error("atlas not found"); return; }

  console.log(`tile  pointCount=${tile.pointCount}  outdoor=${tile.outdoorPointCount}`);
  console.log(`atlas pointCount=${atlas.pointCount}  outdoor=${atlas.outdoorPointCount}`);
  console.log();

  // Compare first 10 points: lat/lon/ix/iy/outdoorIndex/flags
  console.log("First 10 points comparison (tile | atlas):");
  console.log("  i  |  tile lon    lat    ix iy outIdx flg |  atlas lon   lat    ix iy outIdx flg | eq?");
  for (let i = 0; i < 10; i++) {
    const tileEq = {
      lon: tile.pointLon[i], lat: tile.pointLat[i], ix: tile.pointIx[i], iy: tile.pointIy[i],
      oi: tile.pointOutdoorIndex[i], flg: tile.pointFlags[i],
    };
    const atlasEq = {
      lon: atlas.pointLon[i], lat: atlas.pointLat[i], ix: atlas.pointIx[i], iy: atlas.pointIy[i],
      oi: atlas.pointOutdoorIndex[i], flg: atlas.pointFlags[i],
    };
    const same = tileEq.lon === atlasEq.lon && tileEq.lat === atlasEq.lat &&
                 tileEq.ix === atlasEq.ix && tileEq.iy === atlasEq.iy &&
                 tileEq.oi === atlasEq.oi && tileEq.flg === atlasEq.flg;
    console.log(
      `  ${String(i).padStart(2)} | ${tileEq.lon.toFixed(5)} ${tileEq.lat.toFixed(5)} ${tileEq.ix} ${tileEq.iy} ${tileEq.oi} ${tileEq.flg} | ${atlasEq.lon.toFixed(5)} ${atlasEq.lat.toFixed(5)} ${atlasEq.ix} ${atlasEq.iy} ${atlasEq.oi} ${atlasEq.flg} | ${same ? "SAME" : "DIFF"}`,
    );
  }

  // Full array equality
  let mismatches = 0;
  const n = Math.min(tile.pointCount, atlas.pointCount);
  for (let i = 0; i < n; i++) {
    if (tile.pointOutdoorIndex[i] !== atlas.pointOutdoorIndex[i]) mismatches++;
  }
  console.log(`\nTotal outdoorIndex mismatches: ${mismatches} / ${n}`);

  // Check ix/iy mapping
  let ixIyMismatches = 0;
  for (let i = 0; i < n; i++) {
    if (tile.pointIx[i] !== atlas.pointIx[i] || tile.pointIy[i] !== atlas.pointIy[i]) ixIyMismatches++;
  }
  console.log(`Total ix/iy mismatches: ${ixIyMismatches} / ${n}`);

  // Per-frame: atlas lookup XOR
  const { lat, lon } = lv95ToWgs84(
    (tile.meta.tile.minEasting + tile.meta.tile.maxEasting) / 2,
    (tile.meta.tile.minNorthing + tile.meta.tile.maxNorthing) / 2,
  );
  const bits = tile.outdoorPointCount;
  console.log(`\nPer-frame XOR: bits=${bits}`);
  console.log(`  time    az°      alt°    | tileSun  atlasSun  XOR    XOR%     | bucket(azB,altB) | bucket center`);
  for (let f = 0; f < tile.frameCount; f++) {
    const fm = tile.meta.framesMeta[f];
    const utc = new Date(fm.utcTime);
    const pos = SunCalc.getPosition(utc, lat, lon);
    const alt = pos.altitude * 180 / Math.PI;
    if (alt <= 0) continue;
    if (alt > 2 && fm.sunnyCount === 0) continue;
    let az = (pos.azimuth * 180 / Math.PI + 180) % 360;
    if (az < 0) az += 360;
    const azB = Math.floor(az); const altB = Math.floor(alt);
    const entry = lookupAtlasBucket(atlas, azB, altB);
    if (!entry) continue;
    const tileSun = getFrameMask(tile, f, MASK_KIND_SUN);
    const atlasSun = entry.sunMask;
    const ts = popcount(tileSun, bits);
    const as_ = popcount(atlasSun, bits);
    const x = popcountXor(tileSun, atlasSun, bits);
    const azCenter = azB + 0.5; const altCenter = altB + 0.5;
    // Only print a few interesting ones
    if (f % 4 === 0 || x / bits > 0.1) {
      console.log(
        `  ${fm.localTime} ${az.toFixed(2).padStart(6)}° ${alt.toFixed(2).padStart(6)}° | ${String(ts).padStart(7)}  ${String(as_).padStart(8)}  ${String(x).padStart(6)}  ${((100 * x) / bits).toFixed(3).padStart(6)}% | (${azB},${altB})        | (${azCenter},${altCenter})`,
      );
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
