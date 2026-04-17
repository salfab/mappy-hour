/**
 * Measures atlas-vs-date-keyed divergence on the REAL precomputed dataset.
 *
 * The insight: the date-keyed cache stores each frame at its exact
 * (az, alt). If we were to replace it with an atlas at bucket resolution
 * R, every frame whose (az, alt) rounds to the same bucket would share
 * ONE mask entry. The cost of that sharing is the bit-difference between
 * the frames within the same bucket.
 *
 * This script walks every .tile.bin.gz in a region, groups frames by
 * bucket at several resolutions, and reports the within-bucket
 * divergence — without running any extra GPU compute, purely from the
 * existing cache.
 *
 * Usage:
 *   pnpm tsx scripts/benchmark/atlas-divergence-from-dataset.ts \
 *     --region=lausanne \
 *     --grid-step-meters=1 \
 *     --sample-every-minutes=15 \
 *     --resolutions=0.25,0.5,1,2 \
 *     --max-tiles=10
 */

import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import SunCalc from "suncalc";

import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
} from "../../src/lib/precompute/sunlight-cache-binary";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

type Args = {
  region: PrecomputedRegionName;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  resolutions: number[];
  maxTiles: number | null;
  maxDatesPerTile: number | null;
};

function parseArgs(): Args {
  const args: Args = {
    region: "lausanne",
    gridStepMeters: 1,
    sampleEveryMinutes: 15,
    resolutions: [0.25, 0.5, 1, 2],
    maxTiles: null,
    maxDatesPerTile: null,
  };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.split("=");
    if (k === "--region") args.region = v as PrecomputedRegionName;
    else if (k === "--grid-step-meters") args.gridStepMeters = Number(v);
    else if (k === "--sample-every-minutes") args.sampleEveryMinutes = Number(v);
    else if (k === "--resolutions") args.resolutions = v.split(",").map(Number);
    else if (k === "--max-tiles") args.maxTiles = v === "all" ? null : Number(v);
    else if (k === "--max-dates-per-tile") args.maxDatesPerTile = v === "all" ? null : Number(v);
  }
  return args;
}

type TileArtifactEntry = {
  tileId: string;
  modelHash: string;
  date: string;
  tw: string; // "t0600-2100"
  fullPath: string;
};

async function discoverArtifacts(args: Args): Promise<TileArtifactEntry[]> {
  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, args.region);
  const entries: TileArtifactEntry[] = [];
  let hashes: string[];
  try { hashes = await fs.readdir(regionRoot); } catch { return []; }
  for (const hash of hashes) {
    const gSampleDir = path.join(regionRoot, hash, `g${args.gridStepMeters}`, `m${args.sampleEveryMinutes}`);
    let dates: string[];
    try { dates = await fs.readdir(gSampleDir); } catch { continue; }
    for (const date of dates) {
      const dateDir = path.join(gSampleDir, date);
      let tws: string[];
      try { tws = await fs.readdir(dateDir); } catch { continue; }
      for (const tw of tws) {
        const tilesDir = path.join(dateDir, tw, "tiles");
        let files: string[];
        try { files = await fs.readdir(tilesDir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".tile.bin.gz")) continue;
          const tileId = f.slice(0, -".tile.bin.gz".length);
          entries.push({
            tileId, modelHash: hash, date, tw,
            fullPath: path.join(tilesDir, f),
          });
        }
      }
    }
  }
  return entries;
}

function parseTimeWindow(tw: string): { startLocalTime: string; endLocalTime: string } {
  const m = /^t(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(tw);
  if (!m) throw new Error(`Bad time window: ${tw}`);
  return {
    startLocalTime: `${m[1]}:${m[2]}`,
    endLocalTime: `${m[3]}:${m[4]}`,
  };
}

function altitudeBand(alt: number): string {
  if (alt < 0) return "below-horizon";
  if (alt < 5) return "alt<5°";
  if (alt < 15) return "alt 5-15°";
  if (alt < 30) return "alt 15-30°";
  return "alt>=30°";
}

function countDifferingBits(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -1;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) { x &= x - 1; diff++; }
  }
  return diff;
}

async function main() {
  const args = parseArgs();
  console.log(`Region: ${args.region}, grid=${args.gridStepMeters}m, sample=${args.sampleEveryMinutes}min`);
  console.log(`Resolutions: ${args.resolutions.map(r => r + "°").join(", ")}`);

  const artifacts = await discoverArtifacts(args);
  console.log(`Discovered ${artifacts.length} tile artifacts.`);

  // Group by tileId
  const byTile = new Map<string, TileArtifactEntry[]>();
  for (const e of artifacts) {
    const list = byTile.get(e.tileId) ?? [];
    list.push(e);
    byTile.set(e.tileId, list);
  }
  const tileIds = [...byTile.keys()];
  tileIds.sort();
  const selectedTiles = args.maxTiles ? tileIds.slice(0, args.maxTiles) : tileIds;
  console.log(`Evaluating ${selectedTiles.length} / ${tileIds.length} tile IDs.\n`);

  // For each tile, build a grouping of frames by bucket, per resolution.
  type BucketAgg = {
    resolution: number;
    band: string;
    withinBucketDiffBits: number;
    withinBucketTotalBitsCompared: number;
    bucketCount: number;
    bucketMultiCount: number;
    frameCountInMultiBuckets: number;
  };
  const aggsByRes = new Map<number, Map<string, BucketAgg>>();
  for (const res of args.resolutions) {
    const bandMap = new Map<string, BucketAgg>();
    for (const band of ["below-horizon", "alt<5°", "alt 5-15°", "alt 15-30°", "alt>=30°", "OVERALL"]) {
      bandMap.set(band, {
        resolution: res, band,
        withinBucketDiffBits: 0,
        withinBucketTotalBitsCompared: 0,
        bucketCount: 0,
        bucketMultiCount: 0,
        frameCountInMultiBuckets: 0,
      });
    }
    aggsByRes.set(res, bandMap);
  }

  const t0 = performance.now();
  let tilesDone = 0;
  for (const tileId of selectedTiles) {
    const entries = byTile.get(tileId)!;
    const subset = args.maxDatesPerTile ? entries.slice(0, args.maxDatesPerTile) : entries;
    // Load all frames for this tile across all its dates
    type Frame = {
      sunMask: Uint8Array;
      sunNoVegMask: Uint8Array;
      az: number;
      alt: number;
      band: string;
      outdoorPointCount: number;
    };
    const frames: Frame[] = [];
    let tileCenterLat: number | null = null;
    let tileCenterLon: number | null = null;
    for (const e of subset) {
      const { startLocalTime, endLocalTime } = parseTimeWindow(e.tw);
      const tile = await loadPrecomputedSunlightTileBinary({
        region: args.region,
        modelVersionHash: e.modelHash,
        date: e.date,
        gridStepMeters: args.gridStepMeters,
        sampleEveryMinutes: args.sampleEveryMinutes,
        startLocalTime, endLocalTime,
        tileId,
      });
      if (!tile) continue;
      if (tileCenterLat === null) {
        const tb = tile.meta.tile;
        const centerE = (tb.minEasting + tb.maxEasting) / 2;
        const centerN = (tb.minNorthing + tb.maxNorthing) / 2;
        const c = lv95ToWgs84(centerE, centerN);
        tileCenterLat = c.lat; tileCenterLon = c.lon;
      }
      for (let f = 0; f < tile.frameCount; f++) {
        const fm = tile.meta.framesMeta[f];
        const utc = new Date(fm.utcTime);
        const p = SunCalc.getPosition(utc, tileCenterLat!, tileCenterLon!);
        const alt = p.altitude * 180 / Math.PI;
        let az = (p.azimuth * 180 / Math.PI + 180) % 360;
        if (az < 0) az += 360;
        const sunMask = new Uint8Array(getFrameMask(tile, f, MASK_KIND_SUN));
        const sunNoVegMask = new Uint8Array(getFrameMask(tile, f, MASK_KIND_SUN_NO_VEG));
        frames.push({
          sunMask, sunNoVegMask, az, alt,
          band: altitudeBand(alt),
          outdoorPointCount: tile.outdoorPointCount,
        });
      }
    }

    // Group by bucket for each resolution
    for (const res of args.resolutions) {
      const byBucket = new Map<string, Frame[]>();
      for (const f of frames) {
        const key = `${Math.floor(f.az / res)}:${Math.floor(f.alt / res)}`;
        const list = byBucket.get(key) ?? [];
        list.push(f);
        byBucket.set(key, list);
      }
      const bandMap = aggsByRes.get(res)!;
      for (const [bucketKey, bucketFrames] of byBucket) {
        const agg = bandMap.get(bucketFrames[0].band)!;
        const aggOverall = bandMap.get("OVERALL")!;
        agg.bucketCount++; aggOverall.bucketCount++;
        if (bucketFrames.length > 1) {
          agg.bucketMultiCount++; aggOverall.bucketMultiCount++;
          agg.frameCountInMultiBuckets += bucketFrames.length;
          aggOverall.frameCountInMultiBuckets += bucketFrames.length;
          // Representative = first frame. For each subsequent frame, count bits differing from rep.
          const rep = bucketFrames[0];
          for (let i = 1; i < bucketFrames.length; i++) {
            const d = countDifferingBits(rep.sunMask, bucketFrames[i].sunMask);
            if (d >= 0) {
              agg.withinBucketDiffBits += d;
              aggOverall.withinBucketDiffBits += d;
              agg.withinBucketTotalBitsCompared += rep.sunMask.length * 8;
              aggOverall.withinBucketTotalBitsCompared += rep.sunMask.length * 8;
            }
          }
        }
      }
    }

    tilesDone++;
    if (tilesDone % 5 === 0 || tilesDone === selectedTiles.length) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(`  ${tilesDone}/${selectedTiles.length} tiles (${frames.length} frames latest) — ${elapsed}s elapsed`);
    }
  }

  // Report
  console.log(`\n=== WITHIN-BUCKET DIVERGENCE (atlas lossiness) ===`);
  console.log(`Per resolution, % of bits that would change if all frames in a bucket`);
  console.log(`shared one stored mask (the first observed).\n`);

  for (const res of args.resolutions) {
    const bandMap = aggsByRes.get(res)!;
    console.log(`-- Resolution ${res}° --`);
    for (const band of ["OVERALL", "alt<5°", "alt 5-15°", "alt 15-30°", "alt>=30°"]) {
      const a = bandMap.get(band)!;
      const pct = a.withinBucketTotalBitsCompared > 0
        ? (a.withinBucketDiffBits / a.withinBucketTotalBitsCompared * 100).toFixed(3)
        : "   -   ";
      const dedupFactor = a.bucketCount > 0 ? (a.frameCountInMultiBuckets / Math.max(a.bucketMultiCount, 1)).toFixed(2) : "1.00";
      console.log(`  ${band.padEnd(15)} div=${pct}%  buckets=${a.bucketCount}  multi=${a.bucketMultiCount}  avg-frames-per-multi-bucket=${dedupFactor}`);
    }
    console.log();
  }

  console.log(`Total tiles analysed: ${selectedTiles.length}`);
  console.log(`Elapsed: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => { console.error(err); process.exit(1); });
