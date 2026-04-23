/**
 * Measure atlas lookup error (XOR %) for a given tile and resolution.
 *
 * For each cached date-keyed frame F:
 *   - Compute (azF, altF) via SunCalc
 *   - Compute (azBucket, altBucket) at atlas resolution
 *   - Look up atlas → M_atlas
 *   - Compute XOR(F.sunMask, M_atlas) / outdoorBits → error for this frame
 *
 * Report: mean/median/p95/max/zero-fraction across all frames, per mask kind.
 *
 * Usage:
 *   pnpm tsx scripts/ingest/_bench-atlas-lookup-error.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";

import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
  MASK_KIND_BUILDINGS_BLOCKED,
  MASK_KIND_VEGETATION_BLOCKED,
} from "../../src/lib/precompute/sunlight-cache-binary";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasBucket,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const TILE_ID = "e2538000_n1152500_s250";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const RESOLUTIONS = [1, 0.75, 0.5];

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}
function popcountXor(a: Uint8Array, b: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let n = 0;
  for (let i = 0; i < fullBytes; i++) n += popcount8(a[i] ^ b[i]);
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    n += popcount8((a[fullBytes] ^ b[fullBytes]) & mask);
  }
  return n;
}

function parseTimeWindow(tw: string): { startLocal: string; endLocal: string } | null {
  const m = /^t(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(tw);
  if (!m) return null;
  return { startLocal: `${m[1]}:${m[2]}`, endLocal: `${m[3]}:${m[4]}` };
}

async function discoverCachedWindows(): Promise<Array<{ date: string; startLocal: string; endLocal: string }>> {
  const dateRoot = path.join(CACHE_SUNLIGHT_DIR, REGION, MODEL_HASH, `g${GRID_STEP}`, `m${SAMPLE_MINUTES}`);
  const out: Array<{ date: string; startLocal: string; endLocal: string }> = [];
  const dates = await fs.readdir(dateRoot);
  // Filter by mtime: only caches regenerated AFTER this cutoff are trusted.
  // Earlier caches were produced with a pre-Vulkan-validation backend version
  // and disagree with the current Vulkan-native atlas by ~5× in sunny-point count.
  // Cutoff = 2026-04-18 13:30 local (Vulkan validation complete at ~13:43).
  const mtimeCutoffMs = Number(process.env.BENCH_MTIME_CUTOFF_MS ?? Date.parse("2026-04-18T13:30:00"));
  let skippedStale = 0;
  for (const d of dates) {
    const dateDir = path.join(dateRoot, d);
    let tws: string[];
    try { tws = await fs.readdir(dateDir); } catch { continue; }
    for (const tw of tws) {
      const f = path.join(dateDir, tw, "tiles", `${TILE_ID}.tile.bin.gz`);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(f);
      } catch { continue; }
      if (stat.mtimeMs < mtimeCutoffMs) { skippedStale++; continue; }
      const wp = parseTimeWindow(tw);
      if (!wp) continue;
      out.push({ date: d, startLocal: wp.startLocal, endLocal: wp.endLocal });
    }
  }
  if (skippedStale > 0) {
    console.log(`(Skipped ${skippedStale} stale tile caches older than mtime cutoff)`);
  }
  return out;
}

function stats(nums: number[]): { mean: number; median: number; p95: number; max: number; zeroFrac: number; count: number } {
  if (nums.length === 0) return { mean: 0, median: 0, p95: 0, max: 0, zeroFrac: 0, count: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];
  const zeroFrac = sorted.filter((x) => x === 0).length / sorted.length;
  return { mean, median, p95, max, zeroFrac, count: sorted.length };
}

async function main() {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(TILE_ID)!;
  const minE = Number(m[1]);
  const minN = Number(m[2]);
  const size = Number(m[3]);
  const { lat, lon } = lv95ToWgs84(minE + size / 2, minN + size / 2);

  const windows = await discoverCachedWindows();
  console.log(`Tile: ${TILE_ID}`);
  console.log(`Cached windows: ${windows.length} (across ${new Set(windows.map((w) => w.date)).size} dates)`);
  console.log();

  for (const res of RESOLUTIONS) {
    console.log(`=== Resolution ${res}° ===`);
    const atlas = await loadPrecomputedTileAtlas({
      region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID_STEP, tileId: TILE_ID, resolutionDeg: res,
    });
    if (!atlas) {
      console.log(`  Atlas not found for res=${res}, skipping.`);
      continue;
    }
    console.log(`  Atlas buckets: ${atlas.bucketCount}, outdoor=${atlas.outdoorPointCount}, maskBytes=${atlas.maskBytesPerBucket}`);

    const errSun: number[] = [];
    const errNoVeg: number[] = [];
    const errBuildings: number[] = [];
    const errVegetation: number[] = [];
    const perFrame: Array<{ date: string; tw: string; time: string; az: number; alt: number; azB: number; altB: number; sunPct: number }> = [];
    let missing = 0;
    let totalFrames = 0;

    for (const w of windows) {
      const tile = await loadPrecomputedSunlightTileBinary({
        region: REGION, modelVersionHash: MODEL_HASH, date: w.date, gridStepMeters: GRID_STEP,
        sampleEveryMinutes: SAMPLE_MINUTES, startLocalTime: w.startLocal, endLocalTime: w.endLocal, tileId: TILE_ID,
      });
      if (!tile) continue;
      const bits = tile.outdoorPointCount;

      for (let f = 0; f < tile.frameCount; f++) {
        const fm = tile.meta.framesMeta[f];
        const utc = new Date(fm.utcTime);
        const pos = SunCalc.getPosition(utc, lat, lon);
        const alt = (pos.altitude * 180) / Math.PI;
        if (alt <= 0) continue;
        let az = ((pos.azimuth * 180) / Math.PI + 180) % 360;
        if (az < 0) az += 360;
        if (alt > 2 && fm.sunnyCount === 0) continue; // skip corrupt old entries

        totalFrames++;
        const azB = Math.floor(az / res);
        const altB = Math.floor(alt / res);

        const entry = lookupAtlasBucket(atlas, azB, altB);
        if (!entry) { missing++; continue; }

        const sunF = getFrameMask(tile, f, MASK_KIND_SUN);
        const noVegF = getFrameMask(tile, f, MASK_KIND_SUN_NO_VEG);
        const bldF = getFrameMask(tile, f, MASK_KIND_BUILDINGS_BLOCKED);
        const vegF = getFrameMask(tile, f, MASK_KIND_VEGETATION_BLOCKED);

        const sunPct = (100 * popcountXor(sunF, entry.sunMask, bits)) / bits;
        const noVegPct = (100 * popcountXor(noVegF, entry.sunNoVegMask, bits)) / bits;
        const bldPct = (100 * popcountXor(bldF, entry.buildingsMask, bits)) / bits;
        const vegPct = (100 * popcountXor(vegF, entry.vegetationMask, bits)) / bits;
        errSun.push(sunPct);
        errNoVeg.push(noVegPct);
        errBuildings.push(bldPct);
        errVegetation.push(vegPct);
        perFrame.push({ date: w.date, tw: `${w.startLocal}-${w.endLocal}`, time: fm.localTime, az, alt, azB, altB, sunPct });
      }
    }

    console.log(`  Frames evaluated: ${totalFrames}, missing buckets: ${missing}`);
    const kinds: Array<[string, number[]]> = [
      ["sun       ", errSun],
      ["noVeg     ", errNoVeg],
      ["buildings ", errBuildings],
      ["vegetation", errVegetation],
    ];
    for (const [name, arr] of kinds) {
      const s = stats(arr);
      console.log(
        `  ${name}  mean=${s.mean.toFixed(3)}%  median=${s.median.toFixed(3)}%  p95=${s.p95.toFixed(3)}%  max=${s.max.toFixed(3)}%  zero-frac=${(s.zeroFrac * 100).toFixed(1)}% (${s.count} frames)`,
      );
    }

    if (res === 1) {
      const top = [...perFrame].sort((a, b) => b.sunPct - a.sunPct).slice(0, 8);
      console.log(`  Top-8 worst sun XOR @ 1°:`);
      for (const t of top) {
        console.log(
          `    ${t.date} ${t.tw} ${t.time}  az=${t.az.toFixed(2)}° alt=${t.alt.toFixed(2)}°  (azB=${t.azB},altB=${t.altB})  sunXOR=${t.sunPct.toFixed(2)}%`,
        );
      }
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
