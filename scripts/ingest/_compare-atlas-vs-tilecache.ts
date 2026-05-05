/**
 * Mass divergence benchmark: date-keyed tile cache vs angle-keyed atlas cache.
 *
 * For a given region/date/window, for each tile that has BOTH a date-keyed tile
 * cache AND an atlas cache, for each frame in the tile artifact:
 *   - read utcTime → compute (azimuth, altitude) at tile center
 *   - snap to (azB, altB) at resolution 1°
 *   - look up the atlas bucket; if missing, skip
 *   - XOR the two sunMasks bit-by-bit (limited to outdoorPointCount bits)
 *   - accumulate divergence per local hour
 *
 * Outputs a report:
 *   - hourly divergence % (bits differing / bits compared)
 *   - hour with max divergence
 *   - top tiles with largest divergence at that hour (candidates for visual diff)
 *
 * Run:
 *   pnpm tsx scripts/ingest/_compare-atlas-vs-tilecache.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";

import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
} from "../../src/lib/precompute/sunlight-cache-binary";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasBucket,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const RAD_TO_DEG = 180 / Math.PI;
const RES = 1;

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";
const WINDOW = "t0000-2359";
const START_LOCAL = "00:00";
const END_LOCAL = "23:59";

interface TileHourStat {
  tileId: string;
  hour: number;
  framesCompared: number;
  bitsCompared: number;
  bitsDiffering: number;
  bitsDifferingNoVeg: number;
}

interface HourAgg {
  hour: number;
  framesCompared: number;
  bitsCompared: number;
  bitsDiffering: number;
  bitsDifferingNoVeg: number;
  tilesTouched: Set<string>;
  bucketMisses: number;
}

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}

/**
 * Compares two masks bit-by-bit over the first `bits` bits, returns count of
 * differing bits. Stops at the byte boundary covering `bits`.
 */
function hammingDistance(a: Uint8Array, b: Uint8Array, bits: number): number {
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

function parseTileId(id: string): { minE: number; minN: number; size: number } | null {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) return null;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

async function listTileIdsInDateCache(): Promise<string[]> {
  const dir = path.join(
    CACHE_SUNLIGHT_DIR,
    REGION,
    MODEL_HASH,
    `g${GRID_STEP}`,
    `m${SAMPLE_MINUTES}`,
    DATE,
    WINDOW,
    "tiles",
  );
  const files = await fs.readdir(dir);
  return files
    .filter((f) => f.endsWith(".tile.bin.gz"))
    .map((f) => f.slice(0, -".tile.bin.gz".length));
}

async function main(): Promise<void> {
  const tileIds = await listTileIdsInDateCache();
  console.log(`Found ${tileIds.length} tile(s) in date-keyed cache for ${DATE} ${WINDOW}.`);

  const hourAggs = new Map<number, HourAgg>();
  const tileHourStats: TileHourStat[] = [];
  let tilesProcessed = 0;
  let tilesMissingAtlas = 0;
  let tilesMismatchedGeometry = 0;
  const tilesWithZeroBitsMask: string[] = [];

  const startedAt = Date.now();

  for (const tileId of tileIds) {
    const parsed = parseTileId(tileId);
    if (!parsed) continue;
    const centerE = parsed.minE + parsed.size / 2;
    const centerN = parsed.minN + parsed.size / 2;
    const { lat, lon } = lv95ToWgs84Precise(centerE, centerN);

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
        resolutionDeg: RES,
      }),
    ]);

    if (!tile) continue;
    if (!atlas) {
      tilesMissingAtlas++;
      continue;
    }

    if (tile.outdoorPointCount !== atlas.outdoorPointCount) {
      tilesMismatchedGeometry++;
      continue;
    }
    if (tile.outdoorPointCount === 0) {
      // No outdoor points — nothing to compare.
      continue;
    }

    const outdoorBits = tile.outdoorPointCount;
    const framesMeta = tile.meta.framesMeta;

    const perHour = new Map<number, { frames: number; bits: number; diff: number; diffNoVeg: number }>();

    for (let f = 0; f < framesMeta.length; f++) {
      const fm = framesMeta[f];
      const utc = new Date(fm.utcTime);
      const pos = SunCalc.getPosition(utc, lat, lon);
      const altDeg = pos.altitude * RAD_TO_DEG;
      if (altDeg <= 0) continue;
      let azDeg = (pos.azimuth * RAD_TO_DEG + 180) % 360;
      if (azDeg < 0) azDeg += 360;
      const azB = Math.floor(azDeg / RES);
      const altB = Math.floor(altDeg / RES);

      const bucket = lookupAtlasBucket(atlas, azB, altB);
      const hour = Number(fm.localTime.slice(0, 2));
      let agg = hourAggs.get(hour);
      if (!agg) {
        agg = { hour, framesCompared: 0, bitsCompared: 0, bitsDiffering: 0, bitsDifferingNoVeg: 0, tilesTouched: new Set(), bucketMisses: 0 };
        hourAggs.set(hour, agg);
      }
      if (!bucket) {
        agg.bucketMisses++;
        continue;
      }

      const tileMask = getFrameMask(tile, f, MASK_KIND_SUN);
      const tileMaskNoVeg = getFrameMask(tile, f, MASK_KIND_SUN_NO_VEG);
      const diff = hammingDistance(tileMask, bucket.sunMask, outdoorBits);
      const diffNoVeg = hammingDistance(tileMaskNoVeg, bucket.sunNoVegMask, outdoorBits);

      agg.framesCompared++;
      agg.bitsCompared += outdoorBits;
      agg.bitsDiffering += diff;
      agg.bitsDifferingNoVeg += diffNoVeg;
      agg.tilesTouched.add(tileId);

      let ph = perHour.get(hour);
      if (!ph) {
        ph = { frames: 0, bits: 0, diff: 0, diffNoVeg: 0 };
        perHour.set(hour, ph);
      }
      ph.frames++;
      ph.bits += outdoorBits;
      ph.diff += diff;
      ph.diffNoVeg += diffNoVeg;
    }

    for (const [hour, v] of perHour) {
      tileHourStats.push({
        tileId,
        hour,
        framesCompared: v.frames,
        bitsCompared: v.bits,
        bitsDiffering: v.diff,
        bitsDifferingNoVeg: v.diffNoVeg,
      });
    }

    tilesProcessed++;
    if (tilesProcessed % 20 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ...processed ${tilesProcessed}/${tileIds.length} tiles (${elapsed}s)`);
    }
  }

  const elapsedTotal = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nProcessed ${tilesProcessed} tile(s) in ${elapsedTotal}s. Missing atlas: ${tilesMissingAtlas}. Geometry mismatch: ${tilesMismatchedGeometry}.`,
  );
  if (tilesWithZeroBitsMask.length) {
    console.log(`Tiles with 0 outdoor bits: ${tilesWithZeroBitsMask.length}`);
  }

  // ==========================
  // Hourly divergence report — BOTH sun (with veg) and sunNoVeg (without veg)
  // ==========================
  console.log(`\n=== Hourly divergence — date-keyed vs atlas ===`);
  console.log(`(frames = per-tile-frame comparisons; % = bitsDiffering / bitsCompared)`);
  console.log(`sun = MASK_KIND_SUN (includes vegetation blocking)`);
  console.log(`noVeg = MASK_KIND_SUN_NO_VEG (terrain + buildings only)`);
  console.log(
    `  hour │ frames │ tiles │    bitsCmp │  bitsDiff │ sun %       │ bitsDiffNoVeg │ noVeg %     │ Δ (sun−noVeg)  │ bucketMiss`,
  );
  console.log(
    `  ─────┼────────┼───────┼────────────┼───────────┼─────────────┼───────────────┼─────────────┼────────────────┼────────────`,
  );
  const hours = Array.from(hourAggs.values()).sort((a, b) => a.hour - b.hour);
  let maxHour: HourAgg | null = null;
  let maxPct = -1;
  for (const h of hours) {
    const pct = h.bitsCompared > 0 ? (100 * h.bitsDiffering) / h.bitsCompared : 0;
    const pctNoVeg = h.bitsCompared > 0 ? (100 * h.bitsDifferingNoVeg) / h.bitsCompared : 0;
    const delta = pct - pctNoVeg;
    console.log(
      `   ${String(h.hour).padStart(2, "0")}h │ ${String(h.framesCompared).padStart(6)} │ ${String(h.tilesTouched.size).padStart(5)} │ ${String(h.bitsCompared).padStart(10)} │ ${String(h.bitsDiffering).padStart(9)} │ ${pct.toFixed(3).padStart(8)}%   │ ${String(h.bitsDifferingNoVeg).padStart(13)} │ ${pctNoVeg.toFixed(3).padStart(8)}%   │ ${(delta >= 0 ? "+" : "") + delta.toFixed(3).padStart(9)}%  │ ${String(h.bucketMisses).padStart(10)}`,
    );
    if (pct > maxPct) {
      maxPct = pct;
      maxHour = h;
    }
  }

  if (maxHour) {
    const maxPctNoVeg = maxHour.bitsCompared > 0 ? (100 * maxHour.bitsDifferingNoVeg) / maxHour.bitsCompared : 0;
    console.log(
      `\nMax divergence (sun):   hour=${String(maxHour.hour).padStart(2, "0")}h at ${maxPct.toFixed(3)}% (${maxHour.bitsDiffering} bits on ${maxHour.bitsCompared}, ${maxHour.tilesTouched.size} tiles)`,
    );
    console.log(
      `  same hour (noVeg):    ${maxPctNoVeg.toFixed(3)}% (${maxHour.bitsDifferingNoVeg} bits)`,
    );
    console.log(
      `  vegetation contrib:   ${(maxPct - maxPctNoVeg).toFixed(3)}%  (${maxHour.bitsDiffering - maxHour.bitsDifferingNoVeg} bits)`,
    );
  } else {
    console.log(`\nNo frames compared.`);
    return;
  }

  // ==========================
  // Top tiles at max-divergence hour
  // ==========================
  const maxHourRows = tileHourStats
    .filter((s) => s.hour === maxHour!.hour && s.bitsCompared > 0)
    .map((s) => ({
      tileId: s.tileId,
      pct: (100 * s.bitsDiffering) / s.bitsCompared,
      bitsDiff: s.bitsDiffering,
      bitsCompared: s.bitsCompared,
      frames: s.framesCompared,
    }))
    .sort((a, b) => b.pct - a.pct);

  console.log(`\n=== Top 15 tiles at ${String(maxHour.hour).padStart(2, "0")}h ===`);
  console.log(`   rank │ tileId                       │ frames │ bitsDiff │ bitsCmp │ divergence %`);
  console.log(`   ─────┼──────────────────────────────┼────────┼──────────┼─────────┼──────────────`);
  for (let i = 0; i < Math.min(15, maxHourRows.length); i++) {
    const r = maxHourRows[i];
    console.log(
      `    ${String(i + 1).padStart(3)} │ ${r.tileId.padEnd(28)} │ ${String(r.frames).padStart(6)} │ ${String(r.bitsDiff).padStart(8)} │ ${String(r.bitsCompared).padStart(7)} │ ${r.pct.toFixed(3).padStart(9)}%`,
    );
  }

  // ==========================
  // Overall divergence
  // ==========================
  let totalBits = 0;
  let totalDiff = 0;
  let totalFrames = 0;
  for (const h of hours) {
    totalBits += h.bitsCompared;
    totalDiff += h.bitsDiffering;
    totalFrames += h.framesCompared;
  }
  const overallPct = totalBits > 0 ? (100 * totalDiff) / totalBits : 0;
  console.log(
    `\nOverall divergence across day: ${overallPct.toFixed(4)}% (${totalDiff} differing bits on ${totalBits} bits, ${totalFrames} frames).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
