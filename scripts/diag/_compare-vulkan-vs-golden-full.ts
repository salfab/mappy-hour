/**
 * Compare the fresh Vulkan atlas (data/cache) against the gpu-raster
 * golden backed up earlier (data/_cache-gpu-raster-golden-*) across the
 * full 301-tile Lausanne set. Per-tile + aggregate stats on bBlk, vBlk,
 * tBlk, and the final sun mask.
 *
 * Threshold: divergence ≤ 2% per the CLAUDE.md policy. Above = regression.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import SunCalc from "suncalc";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import {
  decodeTileAtlasFromBinary,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const gunzip = promisify(gunzipCb);
const MODEL_HASH = "d43fe24cbb9190af";
const RAD_TO_DEG = 180 / Math.PI;

async function loadAtlas(cacheRoot: string, tileId: string) {
  const p = path.join(
    cacheRoot,
    "sunlight/lausanne",
    MODEL_HASH,
    "g1/atlas/r0.75",
    `${tileId}.atlas.bin.gz`,
  );
  try {
    const buf = await fs.readFile(p);
    return decodeTileAtlasFromBinary(new Uint8Array(await gunzip(buf)));
  } catch {
    return null;
  }
}

function countBits(mask: Uint8Array, outdoorCount: number): number {
  let count = 0;
  for (let i = 0; i < outdoorCount; i++) {
    if ((mask[i >> 3] >> (i & 7)) & 1) count++;
  }
  return count;
}

function xorCount(a: Uint8Array, b: Uint8Array, outdoorCount: number): number {
  let count = 0;
  for (let i = 0; i < outdoorCount; i++) {
    const ba = (a[i >> 3] >> (i & 7)) & 1;
    const bb = (b[i >> 3] >> (i & 7)) & 1;
    if (ba !== bb) count++;
  }
  return count;
}

async function main() {
  const vulkanRoot = "data/cache";
  // Find the golden backup
  const entries = await fs.readdir("data");
  const goldenDir = entries.find((e) => e.startsWith("_cache-gpu-raster-golden-"));
  if (!goldenDir) {
    console.error("No _cache-gpu-raster-golden-* directory found");
    process.exit(1);
  }
  const goldenRoot = path.join("data", goldenDir);
  console.log(`Vulkan: ${vulkanRoot}`);
  console.log(`Golden: ${goldenRoot}\n`);

  const atlasDir = path.join(
    vulkanRoot,
    "sunlight/lausanne",
    MODEL_HASH,
    "g1/atlas/r0.75",
  );
  const files = (await fs.readdir(atlasDir)).filter((f) => f.endsWith(".atlas.bin.gz"));
  const tileIds = files
    .map((f) => f.replace(".atlas.bin.gz", ""))
    .sort();

  // Sample times: morning (low east), midday (high), evening (low west)
  const SAMPLES = [
    { label: "07:30", utc: new Date("2026-04-29T07:30:00+02:00") },
    { label: "12:00", utc: new Date("2026-04-29T12:00:00+02:00") },
    { label: "18:00", utc: new Date("2026-04-29T18:00:00+02:00") },
  ];

  type Stat = { tileCount: number; totalOutdoor: number; totalDiff: number; maxPct: number; maxTile: string };
  const stats = {
    sun: {} as Record<string, Stat>,
    noVeg: {} as Record<string, Stat>,
    bBlk: {} as Record<string, Stat>,
    vBlk: {} as Record<string, Stat>,
    tBlk: {} as Record<string, Stat>,
  };
  for (const s of SAMPLES) {
    for (const k of Object.keys(stats) as Array<keyof typeof stats>) {
      stats[k][s.label] = { tileCount: 0, totalOutdoor: 0, totalDiff: 0, maxPct: 0, maxTile: "" };
    }
  }

  let analyzed = 0;
  let missing = 0;
  const worstDeltas: Array<{ tile: string; sample: string; metric: string; pct: number }> = [];

  for (const tileId of tileIds) {
    const vA = await loadAtlas(vulkanRoot, tileId);
    const gA = await loadAtlas(goldenRoot, tileId);
    if (!vA || !gA) { missing++; continue; }
    if (vA.outdoorPointCount !== gA.outdoorPointCount) { missing++; continue; }
    const m = /^e(\d+)_n(\d+)/.exec(tileId)!;
    const center = lv95ToWgs84(parseInt(m[1]) + 125, parseInt(m[2]) + 125);
    for (const s of SAMPLES) {
      const pos = SunCalc.getPosition(s.utc, center.lat, center.lon);
      const alt = pos.altitude * RAD_TO_DEG;
      if (alt <= 0) continue;
      let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
      if (az < 0) az += 360;
      const bV = lookupAtlasByAngle([vA], az, alt);
      const bG = lookupAtlasByAngle([gA], az, alt);
      if (!bV || !bG) continue;

      const od = vA.outdoorPointCount;
      const compareMetric = (
        key: keyof typeof stats,
        vMask: Uint8Array,
        gMask: Uint8Array,
      ) => {
        const diff = xorCount(vMask, gMask, od);
        const pct = (diff / od) * 100;
        const st = stats[key][s.label];
        st.tileCount++;
        st.totalOutdoor += od;
        st.totalDiff += diff;
        if (pct > st.maxPct) {
          st.maxPct = pct;
          st.maxTile = tileId;
        }
        if (pct > 2) {
          worstDeltas.push({ tile: tileId, sample: s.label, metric: key, pct });
        }
      };
      compareMetric("sun", bV.sunMask, bG.sunMask);
      compareMetric("noVeg", bV.sunNoVegMask, bG.sunNoVegMask);
      compareMetric("bBlk", bV.buildingsMask, bG.buildingsMask);
      compareMetric("vBlk", bV.vegetationMask, bG.vegetationMask);
      compareMetric("tBlk", bV.terrainMask, bG.terrainMask);
    }
    analyzed++;
    if (analyzed % 50 === 0) process.stdout.write(`  ${analyzed}/${tileIds.length}\r`);
  }
  process.stdout.write(`  ${analyzed}/${tileIds.length} ✓\n`);
  if (missing > 0) console.log(`  ${missing} tiles missing/mismatched (skipped)\n`);

  console.log("\nPer-metric aggregate divergence (Vulkan XOR golden / outdoor):");
  console.log("metric  sample  tiles   totalPoints    diffPoints    avg%     max%    worstTile");
  for (const key of ["sun", "noVeg", "bBlk", "vBlk", "tBlk"] as const) {
    for (const s of SAMPLES) {
      const st = stats[key][s.label];
      const avg = st.totalOutdoor > 0 ? (st.totalDiff / st.totalOutdoor) * 100 : 0;
      console.log(
        `${key.padEnd(7)} ${s.label}  ${String(st.tileCount).padStart(4)}  ${String(st.totalOutdoor).padStart(12)}  ${String(st.totalDiff).padStart(11)}  ${avg.toFixed(3).padStart(6)}%  ${st.maxPct.toFixed(2).padStart(5)}%   ${st.maxTile}`,
      );
    }
  }
  if (worstDeltas.length > 0) {
    console.log(`\n${worstDeltas.length} (tile, sample, metric) combinations exceed 2% threshold:`);
    worstDeltas.sort((a, b) => b.pct - a.pct).slice(0, 20).forEach((w) => {
      console.log(`  ${w.tile}  ${w.sample}  ${w.metric}  ${w.pct.toFixed(2)}%`);
    });
  } else {
    console.log(`\n✓ All tiles × samples × metrics under 2% divergence threshold.`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
