/**
 * Builds angle-keyed atlas files from the existing date-keyed binary tile cache.
 *
 * Strategy (ADR-0013 Phase A — MVP):
 *   For each tile, load all cached date-keyed frames, group them by (az, alt) bucket,
 *   pick the representative frame per bucket (closest to bucket center in angle space),
 *   and write a .atlas.bin.gz file.
 *
 * No GPU needed — mines the existing cache. Divergence ≤ 0.457% at 1° (measured).
 *
 * Usage:
 *   pnpm tsx scripts/precompute/build-atlas-from-cache.ts \
 *     --region=lausanne \
 *     --grid-step-meters=1 \
 *     --sample-every-minutes=15 \
 *     --resolution-deg=1 \
 *     [--max-tiles=20] \
 *     [--skip-existing=true]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import SunCalc from "suncalc";

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
import {
  writePrecomputedTileAtlas,
  loadPrecomputedTileAtlas,
  getAtlasPath,
  ATLAS_MASK_KINDS,
  type BinaryTileAtlas,
  type TileAtlasMetadata,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

type Args = {
  region: PrecomputedRegionName;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  resolutionDeg: number;
  maxTiles: number | null;
  skipExisting: boolean;
  tileId: string | null;
};

function parseArgs(): Args {
  const args: Args = {
    region: "lausanne",
    gridStepMeters: 1,
    sampleEveryMinutes: 15,
    resolutionDeg: 1,
    maxTiles: null,
    skipExisting: true,
    tileId: null,
  };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.split("=");
    if (k === "--region") args.region = v as PrecomputedRegionName;
    else if (k === "--grid-step-meters") args.gridStepMeters = Number(v);
    else if (k === "--sample-every-minutes") args.sampleEveryMinutes = Number(v);
    else if (k === "--resolution-deg") args.resolutionDeg = Number(v);
    else if (k === "--max-tiles") args.maxTiles = Number(v);
    else if (k === "--skip-existing") args.skipExisting = v !== "false" && v !== "0";
    else if (k === "--tile-id") args.tileId = v;
  }
  return args;
}

type TileEntry = {
  tileId: string;
  modelHash: string;
  date: string;
  tw: string;
  fullPath: string;
};

function parseTimeWindow(tw: string): { startMin: number; endMin: number } | null {
  const m = /^t(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(tw);
  if (!m) return null;
  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    endMin: Number(m[3]) * 60 + Number(m[4]),
  };
}

async function discoverEntries(args: Args): Promise<TileEntry[]> {
  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, args.region);
  const entries: TileEntry[] = [];
  let hashes: string[];
  try {
    hashes = await fs.readdir(regionRoot);
  } catch {
    return [];
  }
  for (const hash of hashes) {
    const gSampleDir = path.join(
      regionRoot,
      hash,
      `g${args.gridStepMeters}`,
      `m${args.sampleEveryMinutes}`,
    );
    let dates: string[];
    try {
      dates = await fs.readdir(gSampleDir);
    } catch {
      continue;
    }
    for (const date of dates) {
      const dateDir = path.join(gSampleDir, date);
      let tws: string[];
      try {
        tws = await fs.readdir(dateDir);
      } catch {
        continue;
      }
      for (const tw of tws) {
        const tilesDir = path.join(dateDir, tw, "tiles");
        let files: string[];
        try {
          files = await fs.readdir(tilesDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith(".tile.bin.gz")) continue;
          const tileId = f.slice(0, -".tile.bin.gz".length);
          entries.push({
            tileId,
            modelHash: hash,
            date,
            tw,
            fullPath: path.join(tilesDir, f),
          });
        }
      }
    }
  }
  return entries;
}

function countBits(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    let x = mask[i];
    while (x) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}

async function buildAtlasForTile(
  tileId: string,
  entries: TileEntry[],
  tileCenterLat: number,
  tileCenterLon: number,
  modelHash: string,
  args: Args,
): Promise<BinaryTileAtlas | null> {
  // Frame structure: { az, alt, azB, altB, maskOffset (in source tile), tile ref }
  type FrameRef = {
    az: number;
    alt: number;
    azB: number;
    altB: number;
    sunMask: Uint8Array;
    sunNoVegMask: Uint8Array;
    terrainMask: Uint8Array;
    buildingsMask: Uint8Array;
    vegetationMask: Uint8Array;
    pointCount: number;
    outdoorPointCount: number;
    maskBytes: number;
    // Points (copied from first tile that has this tileId)
    pointLon?: Float64Array;
    pointLat?: Float64Array;
    pointIx?: Int32Array;
    pointIy?: Int32Array;
    pointOutdoorIndex?: Int32Array;
    pointFlags?: Uint32Array;
    meta?: TileEntry;
  };

  const res = args.resolutionDeg;
  // bucket key → best frame ref (closest to bucket center)
  const byBucket = new Map<string, FrameRef>();
  let pointsRef: {
    pointLon: Float64Array;
    pointLat: Float64Array;
    pointIx: Int32Array;
    pointIy: Int32Array;
    pointOutdoorIndex: Int32Array;
    pointFlags: Uint32Array;
    pointCount: number;
    outdoorPointCount: number;
    maskBytes: number;
    meta: TileEntry;
  } | null = null;
  let sourceDateMin = "9999-99-99";
  let sourceDateMax = "0000-00-00";
  let sourceFramesTotal = 0;

  for (const entry of entries) {
    const winParsed = parseTimeWindow(entry.tw);
    if (!winParsed) continue;
    const [y, mo, d] = entry.date.split("-").map(Number);

    const tile = await loadPrecomputedSunlightTileBinary({
      region: args.region,
      modelVersionHash: entry.modelHash,
      date: entry.date,
      gridStepMeters: args.gridStepMeters,
      sampleEveryMinutes: args.sampleEveryMinutes,
      startLocalTime: `${String(Math.floor(winParsed.startMin / 60)).padStart(2, "0")}:${String(winParsed.startMin % 60).padStart(2, "0")}`,
      endLocalTime: `${String(Math.floor(winParsed.endMin / 60)).padStart(2, "0")}:${String(winParsed.endMin % 60).padStart(2, "0")}`,
      tileId,
    });
    if (!tile) continue;

    if (entry.date < sourceDateMin) sourceDateMin = entry.date;
    if (entry.date > sourceDateMax) sourceDateMax = entry.date;

    // Capture points from the first tile loaded
    if (!pointsRef) {
      pointsRef = {
        pointLon: tile.pointLon,
        pointLat: tile.pointLat,
        pointIx: tile.pointIx,
        pointIy: tile.pointIy,
        pointOutdoorIndex: tile.pointOutdoorIndex,
        pointFlags: tile.pointFlags,
        pointCount: tile.pointCount,
        outdoorPointCount: tile.outdoorPointCount,
        maskBytes: tile.maskBytesPerFrame,
        meta: entry,
      };
    }

    for (let f = 0; f < tile.frameCount; f++) {
      const fm = tile.meta.framesMeta[f];
      const utc = new Date(fm.utcTime);
      const pos = SunCalc.getPosition(utc, tileCenterLat, tileCenterLon);
      const alt = pos.altitude * 180 / Math.PI;
      if (alt <= 0) continue;
      let az = (pos.azimuth * 180 / Math.PI + 180) % 360;
      if (az < 0) az += 360;

      // Skip frames that look like corrupt/zero precomputes (all-zero sunMask despite sun being up).
      // Seen in old test runs (1999-04-08, 2018-06-08) that were stored with zero counts.
      if (alt > 2 && fm.sunnyCount === 0) continue;

      const azB = Math.floor(az / res);
      const altB = Math.floor(alt / res);
      const key = `${altB}:${azB}`;

      sourceFramesTotal++;

      // Pick the frame closest to the center of its bucket
      const azCenter = (azB + 0.5) * res;
      const altCenter = (altB + 0.5) * res;
      const azDist = Math.abs(az - azCenter);
      const altDist = Math.abs(alt - altCenter);
      const dist = Math.hypot(azDist, altDist);

      const existing = byBucket.get(key);
      if (existing) {
        const exAzDist = Math.abs(existing.az - azCenter);
        const exAltDist = Math.abs(existing.alt - altCenter);
        const exDist = Math.hypot(exAzDist, exAltDist);
        if (dist >= exDist) continue;
      }

      // Copy masks (slices are views into the buffer, so copy them)
      byBucket.set(key, {
        az, alt, azB, altB,
        sunMask: new Uint8Array(getFrameMask(tile, f, MASK_KIND_SUN)),
        sunNoVegMask: new Uint8Array(getFrameMask(tile, f, MASK_KIND_SUN_NO_VEG)),
        terrainMask: new Uint8Array(getFrameMask(tile, f, MASK_KIND_TERRAIN_BLOCKED)),
        buildingsMask: new Uint8Array(getFrameMask(tile, f, MASK_KIND_BUILDINGS_BLOCKED)),
        vegetationMask: new Uint8Array(getFrameMask(tile, f, MASK_KIND_VEGETATION_BLOCKED)),
        pointCount: tile.pointCount,
        outdoorPointCount: tile.outdoorPointCount,
        maskBytes: tile.maskBytesPerFrame,
      });
    }
  }

  if (!pointsRef || byBucket.size === 0) return null;

  // Sort buckets: altBucket asc, azBucket asc (matches binary search in lookupAtlasBucket)
  const sortedBuckets = Array.from(byBucket.values()).sort((a, b) =>
    a.altB !== b.altB ? a.altB - b.altB : a.azB - b.azB,
  );

  const bucketCount = sortedBuckets.length;
  const maskBytes = pointsRef.maskBytes;
  const maskBuffer = new Uint8Array(bucketCount * ATLAS_MASK_KINDS * maskBytes);
  const bucketAz = new Uint16Array(bucketCount);
  const bucketAlt = new Uint16Array(bucketCount);
  const bucketDataIndex = new Uint32Array(bucketCount);

  for (let i = 0; i < bucketCount; i++) {
    const b = sortedBuckets[i];
    bucketAz[i] = b.azB;
    bucketAlt[i] = b.altB;
    bucketDataIndex[i] = i;
    const base = i * ATLAS_MASK_KINDS * maskBytes;
    maskBuffer.set(b.sunMask, base + 0 * maskBytes);
    maskBuffer.set(b.sunNoVegMask, base + 1 * maskBytes);
    maskBuffer.set(b.terrainMask, base + 2 * maskBytes);
    maskBuffer.set(b.buildingsMask, base + 3 * maskBytes);
    maskBuffer.set(b.vegetationMask, base + 4 * maskBytes);
  }

  const sourceDayCount = (() => {
    if (sourceDateMin === "9999-99-99") return 0;
    const d0 = new Date(sourceDateMin).getTime();
    const d1 = new Date(sourceDateMax).getTime();
    return Math.round((d1 - d0) / 86400000) + 1;
  })();

  const meta: TileAtlasMetadata = {
    atlasFormatVersion: 1,
    region: args.region,
    modelVersionHash: modelHash,
    gridStepMeters: args.gridStepMeters,
    resolutionDegAz: res,
    resolutionDegAlt: res,
    tile: pointsRef.meta.meta?.tile ?? ({} as never),
    warnings: [],
    stats: {
      bucketCount,
      pointCount: pointsRef.pointCount,
      outdoorPointCount: pointsRef.outdoorPointCount,
      sourceFramesTotal,
      sourceDateRange: {
        startDate: sourceDateMin,
        endDate: sourceDateMax,
        dayCount: sourceDayCount,
      },
    },
  };

  // Reconstruct tile metadata (RegionTileSpec) from the first loaded tile
  const firstEntry = entries[0];
  const firstTile = await loadPrecomputedSunlightTileBinary({
    region: args.region,
    modelVersionHash: firstEntry.modelHash,
    date: firstEntry.date,
    gridStepMeters: args.gridStepMeters,
    sampleEveryMinutes: args.sampleEveryMinutes,
    startLocalTime: (() => {
      const wp = parseTimeWindow(firstEntry.tw);
      if (!wp) return "00:00";
      return `${String(Math.floor(wp.startMin / 60)).padStart(2, "0")}:${String(wp.startMin % 60).padStart(2, "0")}`;
    })(),
    endLocalTime: (() => {
      const wp = parseTimeWindow(firstEntry.tw);
      if (!wp) return "23:59";
      return `${String(Math.floor(wp.endMin / 60)).padStart(2, "0")}:${String(wp.endMin % 60).padStart(2, "0")}`;
    })(),
    tileId,
  });
  if (firstTile) {
    meta.tile = firstTile.meta.tile;
    meta.model = firstTile.meta.model as Record<string, unknown>;
    const m = firstTile.meta;
    if (m.pointIds) meta.pointIds = m.pointIds;
    if (m.indoorBuildingIds) meta.indoorBuildingIds = m.indoorBuildingIds;
    if (m.pointElevationMeters) meta.pointElevationMeters = m.pointElevationMeters;
    if (m.pointLv95Easting) meta.pointLv95Easting = Array.from(m.pointLv95Easting as number[]);
    if (m.pointLv95Northing) meta.pointLv95Northing = Array.from(m.pointLv95Northing as number[]);
  }

  return {
    meta,
    pointCount: pointsRef.pointCount,
    bucketCount,
    outdoorPointCount: pointsRef.outdoorPointCount,
    maskBytesPerBucket: maskBytes,
    resolutionDegAz: res,
    resolutionDegAlt: res,
    pointLon: pointsRef.pointLon,
    pointLat: pointsRef.pointLat,
    pointIx: pointsRef.pointIx,
    pointIy: pointsRef.pointIy,
    pointOutdoorIndex: pointsRef.pointOutdoorIndex,
    pointFlags: pointsRef.pointFlags,
    bucketAz,
    bucketAlt,
    bucketDataIndex,
    maskBuffer,
  };
}

async function main() {
  const args = parseArgs();
  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, args.region);
  console.log(
    `Building atlas: region=${args.region} grid=${args.gridStepMeters}m sample=${args.sampleEveryMinutes}min res=${args.resolutionDeg}° skipExisting=${args.skipExisting}`,
  );

  const allEntries = await discoverEntries(args);
  console.log(`Discovered ${allEntries.length} tile date entries.`);

  // Group by (tileId, modelHash)
  const byTile = new Map<string, TileEntry[]>();
  for (const e of allEntries) {
    const key = `${e.modelHash}/${e.tileId}`;
    const list = byTile.get(key) ?? [];
    list.push(e);
    byTile.set(key, list);
  }

  // Compute tile centers (we need lat/lon for SunCalc)
  const tileEntries = Array.from(byTile.entries());

  // Filter by --tile-id if specified
  const selected = args.tileId
    ? tileEntries.filter(([key]) => key.endsWith(`/${args.tileId}`))
    : args.maxTiles
      ? tileEntries.slice(0, args.maxTiles)
      : tileEntries;

  console.log(`Processing ${selected.length} tiles...\n`);

  const t0 = performance.now();
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let totalBuckets = 0;

  for (const [tileKey, entries] of selected) {
    const modelHash = entries[0].modelHash;
    const tileId = entries[0].tileId;

    // Skip-existing check
    if (args.skipExisting) {
      const existing = await loadPrecomputedTileAtlas({
        region: args.region,
        modelVersionHash: modelHash,
        gridStepMeters: args.gridStepMeters,
        tileId,
        resolutionDeg: args.resolutionDeg,
      });
      if (existing) {
        skipped++;
        continue;
      }
    }

    // Compute tile center lat/lon from tileId (e{minE}_n{minN}_s{size})
    const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
    if (!m) {
      failed++;
      console.error(`  SKIP ${tileId} — cannot parse tileId`);
      continue;
    }
    const minE = Number(m[1]);
    const minN = Number(m[2]);
    const size = Number(m[3]);
    const centerE = minE + size / 2;
    const centerN = minN + size / 2;
    const { lat, lon } = lv95ToWgs84(centerE, centerN);

    try {
      const atlas = await buildAtlasForTile(tileId, entries, lat, lon, modelHash, args);
      if (!atlas) {
        console.error(`  SKIP ${tileId} — no frames loaded`);
        failed++;
        continue;
      }

      await writePrecomputedTileAtlas(atlas, {
        region: args.region,
        modelVersionHash: modelHash,
        gridStepMeters: args.gridStepMeters,
        tileId,
        resolutionDeg: args.resolutionDeg,
      });

      done++;
      totalBuckets += atlas.bucketCount;

      if (done % 5 === 0 || done === selected.length) {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        const avgBuckets = done > 0 ? Math.round(totalBuckets / done) : 0;
        console.log(
          `  ${done + skipped + failed}/${selected.length} — done=${done} skip=${skipped} fail=${failed} avgBuckets=${avgBuckets} — ${elapsed}s`,
        );
      }
    } catch (err) {
      console.error(`  ERROR ${tileId}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${totalElapsed}s`);
  console.log(`  Tiles: done=${done} skipped=${skipped} failed=${failed}`);
  console.log(`  Avg buckets/tile: ${done > 0 ? Math.round(totalBuckets / done) : 0}`);
  console.log(`  Atlas path: ${getAtlasPath({ region: args.region, modelVersionHash: "(hash)", gridStepMeters: args.gridStepMeters, tileId: "(tileId)", resolutionDeg: args.resolutionDeg })}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
