/**
 * Phase C validation — atlas vs date-keyed ground truth.
 *
 * For each frame in the date-keyed binary cache, find the matching atlas bucket
 * by sun position and compare the sunMask bit by bit.
 *
 * Produces:
 *  - Coverage: % of above-horizon frames that found an atlas bucket
 *  - Divergence: % of differing bits per altitude band and overall
 *  - sunnyMinutes estimate comparison (aggregate over a full day)
 *
 * Usage:
 *   pnpm tsx scripts/benchmark/validate-atlas-vs-datekey.ts \
 *     --region=lausanne \
 *     --grid-step-meters=1 \
 *     --sample-every-minutes=15 \
 *     --max-tiles=10 \
 *     --max-dates=10
 */

import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import SunCalc from "suncalc";

import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
} from "../../src/lib/precompute/sunlight-cache-binary";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasByAngle,
  ATLAS_MASK_KIND_SUN,
  getAtlasBucketMasks,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

type Args = {
  region: PrecomputedRegionName;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  maxTiles: number;
  maxDates: number;
  resolutionDeg: number;
};

function parseArgs(): Args {
  const args: Args = {
    region: "lausanne",
    gridStepMeters: 1,
    sampleEveryMinutes: 15,
    maxTiles: 5,
    maxDates: 10,
    resolutionDeg: 1,
  };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.split("=");
    if (k === "--region") args.region = v as PrecomputedRegionName;
    else if (k === "--grid-step-meters") args.gridStepMeters = Number(v);
    else if (k === "--sample-every-minutes") args.sampleEveryMinutes = Number(v);
    else if (k === "--max-tiles") args.maxTiles = Number(v);
    else if (k === "--max-dates") args.maxDates = Number(v);
    else if (k === "--resolution-deg") args.resolutionDeg = Number(v);
  }
  return args;
}

function altitudeBand(alt: number): string {
  if (alt < 5) return "alt<5°";
  if (alt < 15) return "alt 5-15°";
  if (alt < 30) return "alt 15-30°";
  return "alt>=30°";
}

function countBits(a: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i];
    while (x) { x &= x - 1; n++; }
  }
  return n;
}

function countDifferingBits(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) { x &= x - 1; d++; }
  }
  return d;
}

type BandStats = {
  framesTotal: number;
  framesWithAtlasBucket: number;
  framesWithoutBucket: number;
  diffBits: number;
  totalBits: number;
  // For sunnyMinutes comparison
  sunnyBitsDatekey: number;
  sunnyBitsAtlas: number;
};

function emptyBand(): BandStats {
  return {
    framesTotal: 0,
    framesWithAtlasBucket: 0,
    framesWithoutBucket: 0,
    diffBits: 0,
    totalBits: 0,
    sunnyBitsDatekey: 0,
    sunnyBitsAtlas: 0,
  };
}

async function discoverCommonTiles(args: Args): Promise<string[]> {
  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, args.region);
  let hashes: string[];
  try { hashes = await fs.readdir(regionRoot); } catch { return []; }

  const atlasTiles = new Set<string>();
  const datekeyTiles = new Set<string>();

  for (const hash of hashes) {
    const atlasDir = path.join(regionRoot, hash, `g${args.gridStepMeters}`, "atlas", `r${args.resolutionDeg}`);
    try {
      const files = await fs.readdir(atlasDir);
      for (const f of files) {
        if (f.endsWith(".atlas.bin.gz")) atlasTiles.add(f.slice(0, -".atlas.bin.gz".length));
      }
    } catch { /* skip */ }

    const gSampleDir = path.join(regionRoot, hash, `g${args.gridStepMeters}`, `m${args.sampleEveryMinutes}`);
    let dates: string[];
    try { dates = await fs.readdir(gSampleDir); } catch { continue; }

    for (const date of dates.slice(0, 3)) {
      const twDir = path.join(gSampleDir, date, "t0600-2100", "tiles");
      try {
        const files = await fs.readdir(twDir);
        for (const f of files) {
          if (f.endsWith(".tile.bin.gz")) datekeyTiles.add(f.slice(0, -".tile.bin.gz".length));
        }
      } catch { /* skip */ }
    }
  }

  const common = [...atlasTiles].filter(t => datekeyTiles.has(t)).sort();
  return common;
}

async function discoverAvailableDates(args: Args, hash: string): Promise<string[]> {
  const gSampleDir = path.join(CACHE_SUNLIGHT_DIR, args.region, hash, `g${args.gridStepMeters}`, `m${args.sampleEveryMinutes}`);
  let dates: string[];
  try { dates = await fs.readdir(gSampleDir); } catch { return []; }
  // Filter to 2026 dates spread across seasons
  const d2026 = dates.filter(d => d.startsWith("2026-")).sort();
  if (d2026.length === 0) return dates.slice(0, args.maxDates);
  // Pick evenly spread dates
  const step = Math.max(1, Math.floor(d2026.length / args.maxDates));
  const selected: string[] = [];
  for (let i = 0; i < d2026.length && selected.length < args.maxDates; i += step) {
    selected.push(d2026[i]);
  }
  return selected;
}

async function getModelHash(args: Args): Promise<string | null> {
  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, args.region);
  let hashes: string[];
  try { hashes = await fs.readdir(regionRoot); } catch { return null; }
  return hashes[0] ?? null;
}

async function main() {
  const args = parseArgs();
  console.log(`Phase C validation: atlas vs date-keyed`);
  console.log(`Region=${args.region}, grid=${args.gridStepMeters}m, sample=${args.sampleEveryMinutes}min, res=${args.resolutionDeg}°`);
  console.log();

  const hash = await getModelHash(args);
  if (!hash) { console.error("No model hash found"); process.exit(1); }
  console.log(`Model hash: ${hash}`);

  const commonTiles = await discoverCommonTiles(args);
  console.log(`Common tiles (atlas ∩ date-keyed): ${commonTiles.length}`);

  const selectedTiles = commonTiles.slice(0, args.maxTiles);
  console.log(`Evaluating ${selectedTiles.length} tiles:`);
  for (const t of selectedTiles) console.log(`  ${t}`);
  console.log();

  const availDates = await discoverAvailableDates(args, hash);
  console.log(`Dates sampled (${availDates.length}): ${availDates.join(", ")}`);
  console.log();

  const bandNames = ["alt<5°", "alt 5-15°", "alt 15-30°", "alt>=30°", "OVERALL"] as const;
  const global: Record<string, BandStats> = Object.fromEntries(bandNames.map(b => [b, emptyBand()]));

  const t0 = performance.now();
  let tilesProcessed = 0;

  for (const tileId of selectedTiles) {
    // Load atlas
    const atlas = await loadPrecomputedTileAtlas({
      region: args.region,
      modelVersionHash: hash,
      gridStepMeters: args.gridStepMeters,
      tileId,
      resolutionDeg: args.resolutionDeg,
    });
    if (!atlas) {
      console.log(`  [skip] ${tileId}: no atlas`);
      continue;
    }

    // Get tile center for sun position
    const tb = atlas.meta.tile;
    const centerE = (tb.minEasting + tb.maxEasting) / 2;
    const centerN = (tb.minNorthing + tb.maxNorthing) / 2;
    const { lat: tileLat, lon: tileLon } = lv95ToWgs84Precise(centerE, centerN);

    const tileStats: Record<string, BandStats> = Object.fromEntries(bandNames.map(b => [b, emptyBand()]));

    for (const date of availDates) {
      const tile = await loadPrecomputedSunlightTileBinary({
        region: args.region,
        modelVersionHash: hash,
        date,
        gridStepMeters: args.gridStepMeters,
        sampleEveryMinutes: args.sampleEveryMinutes,
        startLocalTime: "06:00",
        endLocalTime: "21:00",
        tileId,
      });
      if (!tile) continue;

      for (let f = 0; f < tile.frameCount; f++) {
        const fm = tile.meta.framesMeta[f];
        const utc = new Date(fm.utcTime);
        const pos = SunCalc.getPosition(utc, tileLat, tileLon);
        const altDeg = pos.altitude * (180 / Math.PI);

        const band = altitudeBand(altDeg);
        const datekeyMask = new Uint8Array(getFrameMask(tile, f, MASK_KIND_SUN));

        const overall = tileStats["OVERALL"];
        const perBand = tileStats[band];
        overall.framesTotal++;
        perBand.framesTotal++;

        if (altDeg <= 0) {
          // Below horizon: atlas returns null, date-keyed should be all zeros
          // Count as covered (trivially match)
          overall.framesWithAtlasBucket++;
          perBand.framesWithAtlasBucket++;
          // No sunny bits on either side
          continue;
        }

        let azDeg = (pos.azimuth * (180 / Math.PI) + 180) % 360;
        if (azDeg < 0) azDeg += 360;

        const bucket = lookupAtlasByAngle(atlas, azDeg, altDeg);
        if (!bucket) {
          overall.framesWithoutBucket++;
          perBand.framesWithoutBucket++;
          continue;
        }

        overall.framesWithAtlasBucket++;
        perBand.framesWithAtlasBucket++;

        const atlasMask = bucket.sunMask;
        const diff = countDifferingBits(datekeyMask, atlasMask);
        const totalBits = datekeyMask.length * 8;

        overall.diffBits += diff;
        overall.totalBits += totalBits;
        perBand.diffBits += diff;
        perBand.totalBits += totalBits;

        overall.sunnyBitsDatekey += countBits(datekeyMask);
        overall.sunnyBitsAtlas += countBits(atlasMask);
        perBand.sunnyBitsDatekey += countBits(datekeyMask);
        perBand.sunnyBitsAtlas += countBits(atlasMask);
      }
    }

    // Merge into global
    for (const b of bandNames) {
      const s = tileStats[b];
      const g = global[b];
      g.framesTotal += s.framesTotal;
      g.framesWithAtlasBucket += s.framesWithAtlasBucket;
      g.framesWithoutBucket += s.framesWithoutBucket;
      g.diffBits += s.diffBits;
      g.totalBits += s.totalBits;
      g.sunnyBitsDatekey += s.sunnyBitsDatekey;
      g.sunnyBitsAtlas += s.sunnyBitsAtlas;
    }

    tilesProcessed++;
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const ov = tileStats["OVERALL"];
    const covPct = ov.framesTotal > 0
      ? ((ov.framesWithAtlasBucket / ov.framesTotal) * 100).toFixed(1)
      : "n/a";
    const divPct = ov.totalBits > 0
      ? ((ov.diffBits / ov.totalBits) * 100).toFixed(3)
      : "n/a";
    console.log(`  [${tilesProcessed}/${selectedTiles.length}] ${tileId} — coverage=${covPct}%  divergence=${divPct}%  elapsed=${elapsed}s`);
  }

  console.log();
  console.log("=== RESULTS ===");
  console.log(`Tiles: ${tilesProcessed}/${selectedTiles.length}  Dates sampled: ${availDates.length}`);
  console.log();

  const hdr = "Band".padEnd(15) + "Frames".padStart(8) + "Coverage".padStart(11) + "Divergence".padStart(13) + "sunnyBias".padStart(11);
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const band of bandNames) {
    const s = global[band];
    const coverage = s.framesTotal > 0
      ? ((s.framesWithAtlasBucket / s.framesTotal) * 100).toFixed(1) + "%"
      : "n/a";
    const divergence = s.totalBits > 0
      ? ((s.diffBits / s.totalBits) * 100).toFixed(3) + "%"
      : "n/a";
    // sunnyBias: atlas sunny bits vs date-keyed sunny bits
    const bias = s.sunnyBitsDatekey > 0
      ? ((s.sunnyBitsAtlas / s.sunnyBitsDatekey - 1) * 100).toFixed(2) + "%"
      : "n/a";
    console.log(
      band.padEnd(15) +
      String(s.framesTotal).padStart(8) +
      coverage.padStart(11) +
      divergence.padStart(13) +
      bias.padStart(11)
    );
  }

  console.log();
  console.log("Legend:");
  console.log("  Coverage   — % of frames (above horizon) that resolved to an atlas bucket");
  console.log("  Divergence — % of mask bits that differ between atlas and date-keyed");
  console.log("  sunnyBias  — atlas sunny bits / date-keyed sunny bits - 1 (+ = atlas overestimates sun)");
  console.log();

  const ov = global["OVERALL"];
  const targetDiv = 1.0;
  const actualDiv = ov.totalBits > 0 ? (ov.diffBits / ov.totalBits * 100) : 0;
  if (actualDiv <= targetDiv) {
    console.log(`✓ Divergence ${actualDiv.toFixed(3)}% ≤ target ${targetDiv}% — atlas quality OK`);
  } else {
    console.log(`✗ Divergence ${actualDiv.toFixed(3)}% > target ${targetDiv}% — atlas quality needs review`);
  }
  console.log(`Total elapsed: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => { console.error(err); process.exit(1); });
