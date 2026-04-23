/**
 * Measures the spatial distance between each divergent bit (tile vs atlas) and
 * the nearest tile-cache pixel that agrees with the atlas.
 *
 * Interpretation:
 *   - If median distance ≤ 1-2 px (meters), the divergence is boundary aliasing:
 *     the atlas is "shifted by one pixel" which is expected when the sun angle
 *     is snapped to a 1° bucket (0.5-0.7° residual error).
 *   - If median distance ≥ 5 px, the atlas diverges structurally from the tile
 *     cache — possible design bug (e.g., wrong point order, wrong bucket
 *     center, mask for a different frame, etc.).
 *
 * Run:
 *   pnpm tsx scripts/ingest/_measure-atlas-error-spatial.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";

import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
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

const RAD_TO_DEG = 180 / Math.PI;
const RES = 1;

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";
const HOUR = 17;
const START_LOCAL = "00:00";
const END_LOCAL = "23:59";

// Max Chebyshev search radius — beyond this the bit is considered "structurally wrong".
const MAX_SEARCH_RADIUS_PX = 20;

interface Grid {
  width: number;
  height: number;
  /** -1 = indoor/off-grid, 0 = shadow (tile), 1 = sunny (tile). */
  tileBit: Int8Array;
}

function parseTileId(id: string): { minE: number; minN: number; size: number } {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) throw new Error(`Bad tileId: ${id}`);
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

function readBit(mask: Uint8Array, bitIndex: number): number {
  return (mask[bitIndex >> 3] >> (bitIndex & 7)) & 1;
}

function buildTileBitGrid(
  tile: { pointCount: number; pointIx: Int32Array; pointIy: Int32Array; pointFlags: Uint32Array; pointOutdoorIndex: Int32Array },
  tileMask: Uint8Array,
  originIx: number,
  originIy: number,
): Grid {
  let maxLx = 0;
  let maxLy = 0;
  for (let i = 0; i < tile.pointCount; i++) {
    const lx = tile.pointIx[i] - originIx;
    const ly = tile.pointIy[i] - originIy;
    if (lx > maxLx) maxLx = lx;
    if (ly > maxLy) maxLy = ly;
  }
  const width = maxLx + 1;
  const height = maxLy + 1;
  const tileBit = new Int8Array(width * height);
  for (let i = 0; i < width * height; i++) tileBit[i] = -1;
  for (let i = 0; i < tile.pointCount; i++) {
    const lx = tile.pointIx[i] - originIx;
    const ly = tile.pointIy[i] - originIy;
    const indoor = (tile.pointFlags[i] & 1) !== 0;
    const oi = tile.pointOutdoorIndex[i];
    if (indoor || oi < 0) continue;
    tileBit[ly * width + lx] = readBit(tileMask, oi);
  }
  return { width, height, tileBit };
}

/** Returns Chebyshev distance to nearest tile pixel with value === target (0 or 1), or -1 if none within maxR. */
function nearestTileValueDistance(
  grid: Grid,
  x: number,
  y: number,
  target: 0 | 1,
  maxR: number,
): number {
  for (let r = 1; r <= maxR; r++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(grid.height - 1, y + r);
    const x0 = Math.max(0, x - r);
    const x1 = Math.min(grid.width - 1, x + r);
    // Top & bottom edges of ring
    for (const yy of [y - r, y + r]) {
      if (yy < 0 || yy >= grid.height) continue;
      const rowOff = yy * grid.width;
      for (let xx = x0; xx <= x1; xx++) {
        if (grid.tileBit[rowOff + xx] === target) return r;
      }
    }
    // Left & right edges of ring (excluding corners already scanned)
    for (const xx of [x - r, x + r]) {
      if (xx < 0 || xx >= grid.width) continue;
      for (let yy = Math.max(y0, y - r + 1); yy <= Math.min(y1, y + r - 1); yy++) {
        if (grid.tileBit[yy * grid.width + xx] === target) return r;
      }
    }
  }
  return -1;
}

async function listTileIdsInDateCache(): Promise<string[]> {
  const dir = path.join(
    CACHE_SUNLIGHT_DIR,
    REGION,
    MODEL_HASH,
    `g${GRID_STEP}`,
    `m${SAMPLE_MINUTES}`,
    DATE,
    "t0000-2359",
    "tiles",
  );
  const files = await fs.readdir(dir);
  return files
    .filter((f) => f.endsWith(".tile.bin.gz"))
    .map((f) => f.slice(0, -".tile.bin.gz".length));
}

async function main(): Promise<void> {
  const tileIds = await listTileIdsInDateCache();
  console.log(`Scanning ${tileIds.length} tile(s) at ${HOUR}h...`);

  // Histogram buckets: 1,2,3,4,5, 6-10, 11-20, >20 (unreachable within maxR).
  const histogram = { d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6to10: 0, d11to20: 0, beyond: 0 };
  const allDistances: number[] = [];
  let totalDiffs = 0;
  let framesCompared = 0;
  let tilesScanned = 0;
  let tilesSkipped = 0;

  // Per-tile summary: median distance + diff count.
  const perTile: Array<{ tileId: string; diffs: number; median: number; p95: number; beyond: number }> = [];

  const startedAt = Date.now();

  for (const tileId of tileIds) {
    const parsed = parseTileId(tileId);
    const centerE = parsed.minE + parsed.size / 2;
    const centerN = parsed.minN + parsed.size / 2;
    const { lat, lon } = lv95ToWgs84(centerE, centerN);
    const originIx = Math.floor(parsed.minE / GRID_STEP);
    const originIy = Math.floor(parsed.minN / GRID_STEP);

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

    if (!tile || !atlas || tile.outdoorPointCount !== atlas.outdoorPointCount) {
      tilesSkipped++;
      continue;
    }

    const framesMeta = tile.meta.framesMeta;
    let tileDiffs = 0;
    const tileDistances: number[] = [];
    let tileBeyond = 0;
    let frameCountForTile = 0;

    for (let f = 0; f < framesMeta.length; f++) {
      const fm = framesMeta[f];
      const h = Number(fm.localTime.slice(0, 2));
      if (h !== HOUR) continue;

      const utc = new Date(fm.utcTime);
      const pos = SunCalc.getPosition(utc, lat, lon);
      const altDeg = pos.altitude * RAD_TO_DEG;
      if (altDeg <= 0) continue;
      let azDeg = (pos.azimuth * RAD_TO_DEG + 180) % 360;
      if (azDeg < 0) azDeg += 360;
      const azB = Math.floor(azDeg / RES);
      const altB = Math.floor(altDeg / RES);
      const bucket = lookupAtlasBucket(atlas, azB, altB);
      if (!bucket) continue;

      const tileMask = getFrameMask(tile, f, MASK_KIND_SUN);
      const atlasMask = bucket.sunMask;

      const grid = buildTileBitGrid(tile, tileMask, originIx, originIy);

      // Walk outdoor points (via tile) and check divergence. For each divergent
      // pixel, find the nearest tile-cache pixel whose value equals the atlas bit.
      for (let i = 0; i < tile.pointCount; i++) {
        const indoor = (tile.pointFlags[i] & 1) !== 0;
        const oi = tile.pointOutdoorIndex[i];
        if (indoor || oi < 0) continue;
        const tBit = readBit(tileMask, oi);
        const aBit = readBit(atlasMask, oi);
        if (tBit === aBit) continue;

        const lx = tile.pointIx[i] - originIx;
        const ly = tile.pointIy[i] - originIy;
        const d = nearestTileValueDistance(grid, lx, ly, aBit as 0 | 1, MAX_SEARCH_RADIUS_PX);

        totalDiffs++;
        tileDiffs++;
        if (d < 0) {
          histogram.beyond++;
          tileBeyond++;
        } else {
          tileDistances.push(d);
          allDistances.push(d);
          if (d === 1) histogram.d1++;
          else if (d === 2) histogram.d2++;
          else if (d === 3) histogram.d3++;
          else if (d === 4) histogram.d4++;
          else if (d === 5) histogram.d5++;
          else if (d <= 10) histogram.d6to10++;
          else histogram.d11to20++;
        }
      }
      framesCompared++;
      frameCountForTile++;
    }

    tilesScanned++;
    if (frameCountForTile > 0 && tileDiffs > 0) {
      tileDistances.sort((a, b) => a - b);
      const median = tileDistances.length
        ? tileDistances[Math.floor(tileDistances.length / 2)]
        : -1;
      const p95 = tileDistances.length
        ? tileDistances[Math.floor(tileDistances.length * 0.95)]
        : -1;
      perTile.push({ tileId, diffs: tileDiffs, median, p95, beyond: tileBeyond });
    }

    if (tilesScanned % 20 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ...${tilesScanned}/${tileIds.length} tiles (${elapsed}s, ${totalDiffs} diffs so far)`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nScanned ${tilesScanned} tile(s) (${tilesSkipped} skipped) × ${framesCompared} frames in ${elapsed}s.`,
  );
  console.log(`Total divergent bits: ${totalDiffs.toLocaleString()}`);

  // ==========================
  // Overall histogram
  // ==========================
  const pct = (n: number): string => ((100 * n) / totalDiffs).toFixed(2).padStart(6) + "%";
  console.log(`\n=== Distance histogram (Chebyshev, pixels = meters @ gridStep 1m) ===`);
  console.log(`  d=1  (adjacent):      ${String(histogram.d1).padStart(10)}  (${pct(histogram.d1)})`);
  console.log(`  d=2:                  ${String(histogram.d2).padStart(10)}  (${pct(histogram.d2)})`);
  console.log(`  d=3:                  ${String(histogram.d3).padStart(10)}  (${pct(histogram.d3)})`);
  console.log(`  d=4:                  ${String(histogram.d4).padStart(10)}  (${pct(histogram.d4)})`);
  console.log(`  d=5:                  ${String(histogram.d5).padStart(10)}  (${pct(histogram.d5)})`);
  console.log(`  d=6..10:              ${String(histogram.d6to10).padStart(10)}  (${pct(histogram.d6to10)})`);
  console.log(`  d=11..20:             ${String(histogram.d11to20).padStart(10)}  (${pct(histogram.d11to20)})`);
  console.log(`  beyond (>20, no match in range): ${String(histogram.beyond).padStart(10)}  (${pct(histogram.beyond)})`);

  // Percentiles on allDistances (excludes "beyond").
  allDistances.sort((a, b) => a - b);
  if (allDistances.length > 0) {
    const p = (q: number): number => allDistances[Math.floor(allDistances.length * q)];
    console.log(`\nPercentiles (excluding ${histogram.beyond} "beyond" entries):`);
    console.log(`  P50 (median): ${p(0.5)} px / m`);
    console.log(`  P75:          ${p(0.75)} px / m`);
    console.log(`  P90:          ${p(0.9)} px / m`);
    console.log(`  P95:          ${p(0.95)} px / m`);
    console.log(`  P99:          ${p(0.99)} px / m`);
    console.log(`  Max:          ${allDistances[allDistances.length - 1]} px / m`);
  }

  // ==========================
  // Diagnosis
  // ==========================
  console.log(`\n=== Diagnosis ===`);
  if (totalDiffs === 0) {
    console.log(`  No divergence — atlas and tile match exactly.`);
  } else {
    const nearBoundary = histogram.d1 + histogram.d2;
    const nearBoundaryPct = (100 * nearBoundary) / totalDiffs;
    const farAndBeyond = histogram.d6to10 + histogram.d11to20 + histogram.beyond;
    const farPct = (100 * farAndBeyond) / totalDiffs;
    console.log(`  Near-boundary (d≤2):  ${nearBoundaryPct.toFixed(1)}% of diffs`);
    console.log(`  Far (d≥6 or beyond):  ${farPct.toFixed(1)}% of diffs`);
    if (nearBoundaryPct >= 80 && histogram.beyond === 0) {
      console.log(`  → Divergence is dominated by BOUNDARY ALIASING. Atlas is correct.`);
      console.log(`    (Expected for 1° bucket: 0.5-0.7° angular residual shifts shadow`);
      console.log(`    boundaries by a few pixels on a 1 m grid.)`);
    } else if (histogram.beyond > totalDiffs * 0.05) {
      console.log(`  → Structural bug suspected: ${histogram.beyond} bit(s) have no matching`);
      console.log(`    tile pixel within ${MAX_SEARCH_RADIUS_PX} px. Atlas may be using the`);
      console.log(`    wrong mask / wrong bucket for some frames.`);
    } else if (farPct > 20) {
      console.log(`  → Mixed: much of the divergence is far from boundaries (${farPct.toFixed(1)}%).`);
      console.log(`    Investigate the atlas compute path for a subtle error.`);
    } else {
      console.log(`  → Most divergence near boundaries; modest amount at mid-range.`);
      console.log(`    Likely acceptable, but resolution could be tightened.`);
    }
  }

  // ==========================
  // Worst tiles (by "beyond" count, then by tileDiffs)
  // ==========================
  perTile.sort((a, b) => b.beyond - a.beyond || b.diffs - a.diffs);
  const worst = perTile.slice(0, 10);
  console.log(`\n=== Top 10 worst tiles (by out-of-range bits, then total diffs) ===`);
  console.log(`   rank │ tileId                       │  diffs │ median │  P95  │ beyond`);
  console.log(`   ─────┼──────────────────────────────┼────────┼────────┼───────┼────────`);
  for (let i = 0; i < worst.length; i++) {
    const t = worst[i];
    console.log(
      `    ${String(i + 1).padStart(3)} │ ${t.tileId.padEnd(28)} │ ${String(t.diffs).padStart(6)} │ ${String(t.median).padStart(6)} │ ${String(t.p95).padStart(5)} │ ${String(t.beyond).padStart(6)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
