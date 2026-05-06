import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "@/lib/geo/projection";
import type { ShadowCalibration } from "@/lib/sun/shadow-calibration";
import {
  computeSunlightTileArtifact,
  createUtcSamples,
  type SunlightTileComputeProgress,
} from "./sunlight-tile-service";
import type { TileGridMetadata } from "./tile-grid-metadata";
import type { PrecomputedRegionName, RegionTileSpec } from "./sunlight-cache";
import {
  atlasToIndex,
  getAtlasBucketKeySet,
  loadPrecomputedTileAtlas,
  loadTileAtlasIndex,
  mergeBucketsIntoAtlas,
  packBucketKey,
  writePrecomputedTileAtlas,
  writeTileAtlasIndex,
  type AtlasBucketEntry,
  type BinaryTileAtlas,
  type TileAtlasIndex,
  type TileAtlasMetadata,
} from "./sunlight-cache-atlas";

const DEFAULT_ATLAS_RESOLUTION_DEG = 0.75;
const RAD_TO_DEG = 180 / Math.PI;

// In-memory cache of atlas bucket-key sets + stats, keyed by tile+resolution.
// Loading an atlas from disk costs ~500-2000ms per tile (gunzip + decode +
// Set construction). On multi-day precompute runs, the same tile's atlas is
// queried up to N_days times. This cache loads each atlas once and reuses the
// key set for subsequent days, turning 301 tiles × 200 days of disk I/O into
// 301 loads total. Populated on first skip-check; refreshed in place after
// merge. Process-local — cleared on process exit.
interface CachedAtlasSkipInfo {
  keys: Set<number>;
  pointCount: number;
  outdoorPointCount: number;
  bucketCount: number;
}
const atlasSkipCache = new Map<string, CachedAtlasSkipInfo>();
function atlasSkipCacheKey(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg: number;
}): string {
  return `${params.region}|${params.modelVersionHash}|${params.gridStepMeters}|${params.tileId}|${params.resolutionDeg}`;
}

export function clearAtlasSkipCache(): void {
  atlasSkipCache.clear();
}

// ── Async atlas-write queue ────────────────────────────────────────────
// Decouples disk I/O (~440 ms per tile: gzip + write of 30-50 MB) from the
// GPU compute pipeline. Atlas writes used to block the next tile's compute,
// leaving the GPU idle. Now they fire-and-forget in a bounded queue,
// letting the GPU start the next tile immediately while the disk catches up.
// Backpressure caps pending writes to avoid memory pressure from accumulated
// buffers when disk is slower than compute.
//
// Bench 2026-05-06 (8 tiles depth=3, post-Phase-G):
//   queue=4 cold  → 40.5 tiles/min   warm → 94.7 tiles/min
//   queue=8 cold  → 81.9 tiles/min   warm → 97.7 tiles/min
// Cold-start gain +103% (queue=4 saturated by initial burst before disk
// could catch up). Warm operation is not disk-bound, so the bigger queue
// only helps the first ~10-15 tiles. Memory peak: ~160 MB (8 atlases ×
// 20 MB compressed in flight) vs 80 MB at queue=4 — acceptable.
const MAX_PENDING_ATLAS_WRITES = 8;
const pendingAtlasWrites = new Map<string, Promise<void>>();

function pendingWriteKey(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg: number;
}): string {
  return `${params.region}|${params.modelVersionHash}|${params.gridStepMeters}|${params.tileId}|${params.resolutionDeg}`;
}

async function kickoffAtlasWrite(
  merged: BinaryTileAtlas,
  params: {
    region: PrecomputedRegionName;
    modelVersionHash: string;
    gridStepMeters: number;
    tileId: string;
    resolutionDeg: number;
  },
): Promise<void> {
  const key = pendingWriteKey(params);
  // Backpressure: wait for a slot if too many writes pending
  while (pendingAtlasWrites.size >= MAX_PENDING_ATLAS_WRITES) {
    await Promise.race(Array.from(pendingAtlasWrites.values()));
  }
  const writeT0 = performance.now();
  const promise = (async () => {
    await writePrecomputedTileAtlas(merged, params);
    const writeMs = performance.now() - writeT0;
    console.log(
      `[atlas-write] ${params.tileId}  ${writeMs.toFixed(0)}ms  buckets=${merged.bucketCount}  (async)`,
    );
  })();
  pendingAtlasWrites.set(
    key,
    promise.finally(() => {
      pendingAtlasWrites.delete(key);
    }),
  );
}

/**
 * Await all in-flight async atlas writes. MUST be called at the end of a run
 * before the process exits to ensure no writes are lost. Called by
 * `precomputeCacheRuns` after the last tile is done.
 */
export async function awaitAllPendingAtlasWrites(): Promise<void> {
  if (pendingAtlasWrites.size === 0) return;
  const pending = pendingAtlasWrites.size;
  console.log(`[atlas-write] flushing ${pending} pending write(s)...`);
  const flushT0 = performance.now();
  await Promise.all(Array.from(pendingAtlasWrites.values()));
  const flushMs = performance.now() - flushT0;
  console.log(`[atlas-write] flush done in ${flushMs.toFixed(0)}ms (was holding ${pending} writes)`);
}

function indexToCachedSkipInfo(index: TileAtlasIndex): CachedAtlasSkipInfo {
  const keys = new Set<number>();
  for (let i = 0; i < index.bucketCount; i++) {
    keys.add(packBucketKey(index.bucketAz[i], index.bucketAlt[i]));
  }
  return {
    keys,
    pointCount: index.pointCount,
    outdoorPointCount: index.outdoorPointCount,
    bucketCount: index.bucketCount,
  };
}

/**
 * Parallel warm-up: populates `atlasSkipCache` for every tile so that
 * `canSkipAllTilesForDay` can fire on day 1 of a run (cold cache otherwise).
 *
 * Fast path: reads each tile's `.atlas.idx` sidecar (~2 KB uncompressed,
 * bucket indices only). Typical cost < 1 ms per tile.
 *
 * Migration path: if a sidecar is missing (atlas predates the sidecar format),
 * loads the full `.atlas.bin.gz` (~800 KB + gunzip, ~1 s per tile), extracts
 * the index, and writes a sidecar so subsequent runs are fast. Bounded
 * concurrency keeps libuv I/O and zlib threads saturated during migration.
 */
export async function warmAtlasSkipCache(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tiles: ReadonlyArray<RegionTileSpec>;
  resolutionDeg?: number;
  concurrency?: number;
  onProgress?: (loaded: number, total: number, migrated: number) => void;
}): Promise<{ loaded: number; migrated: number; missing: number }> {
  const resolutionDeg = params.resolutionDeg ?? DEFAULT_ATLAS_RESOLUTION_DEG;
  const concurrency = params.concurrency ?? 16;
  const toLoad: RegionTileSpec[] = [];
  for (const tile of params.tiles) {
    const key = atlasSkipCacheKey({
      region: params.region,
      modelVersionHash: params.modelVersionHash,
      gridStepMeters: params.gridStepMeters,
      tileId: tile.tileId,
      resolutionDeg,
    });
    if (!atlasSkipCache.has(key)) toLoad.push(tile);
  }
  if (toLoad.length === 0) {
    return { loaded: 0, migrated: 0, missing: 0 };
  }
  let idx = 0;
  let loaded = 0;
  let migrated = 0;
  let missing = 0;
  const total = toLoad.length;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= total) return;
      const tile = toLoad[i];
      const locator = {
        region: params.region,
        modelVersionHash: params.modelVersionHash,
        gridStepMeters: params.gridStepMeters,
        tileId: tile.tileId,
        resolutionDeg,
      };
      const cacheKey = atlasSkipCacheKey(locator);
      const index = await loadTileAtlasIndex(locator);
      if (index) {
        if (index.resolutionDegAz === resolutionDeg && index.resolutionDegAlt === resolutionDeg) {
          atlasSkipCache.set(cacheKey, indexToCachedSkipInfo(index));
        }
        loaded++;
        params.onProgress?.(loaded, total, migrated);
        continue;
      }
      const atlas = await loadPrecomputedTileAtlas(locator);
      loaded++;
      if (!atlas) {
        missing++;
        params.onProgress?.(loaded, total, migrated);
        continue;
      }
      atlasSkipCache.set(cacheKey, {
        keys: getAtlasBucketKeySet(atlas),
        pointCount: atlas.pointCount,
        outdoorPointCount: atlas.outdoorPointCount,
        bucketCount: atlas.bucketCount,
      });
      // Migrate: write the sidecar so the next run skips the full-atlas load.
      try {
        await writeTileAtlasIndex(atlasToIndex(atlas), locator);
        migrated++;
      } catch {
        // Non-fatal — next run will retry migration.
      }
      params.onProgress?.(loaded, total, migrated);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );
  return { loaded, migrated, missing };
}

/**
 * Pre-flight check used by the precompute orchestrator: returns true iff
 * every supplied tile has a cached atlas bucket-key set that fully covers
 * the target buckets for this date/window. Relies on `atlasSkipCache` being
 * populated — on day 1 of a run the cache is cold and this returns false,
 * which is the correct fallback (per-tile flow will warm the cache).
 *
 * Performance note: SunCalc.getPosition(date, lat, lng) internally computes
 * the sun's geocentric coords (dec/ra) from the date only, then applies lat/
 * lng. For a single day × 301 tiles × 96 samples = 29k calls, but only 96
 * unique (date-dependent) geocentric coords. This helper hoists the shared
 * computation out of the tile loop, turning ~3s into ~30ms on typical runs.
 */
export function canSkipAllTilesForDay(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tiles: ReadonlyArray<RegionTileSpec>;
  resolutionDeg?: number;
}): boolean {
  const resolutionDeg = params.resolutionDeg ?? DEFAULT_ATLAS_RESOLUTION_DEG;

  // Early exit: if any tile has no cache entry we can't prove coverage.
  const cachedPerTile: CachedAtlasSkipInfo[] = new Array(params.tiles.length);
  for (let i = 0; i < params.tiles.length; i++) {
    const tile = params.tiles[i];
    const cacheKey = atlasSkipCacheKey({
      region: params.region,
      modelVersionHash: params.modelVersionHash,
      gridStepMeters: params.gridStepMeters,
      tileId: tile.tileId,
      resolutionDeg,
    });
    const cached = atlasSkipCache.get(cacheKey);
    if (!cached) return false;
    cachedPerTile[i] = cached;
  }

  // Precompute date-dependent sun coordinates once per sample (96 samples
  // for a 24h × 15min window). These are independent of observer lat/lng.
  const samples = createUtcSamples(
    params.date,
    params.timezone,
    params.sampleEveryMinutes,
    params.startLocalTime,
    params.endLocalTime,
  );
  const RAD = Math.PI / 180;
  const DAY_MS = 1000 * 60 * 60 * 24;
  // toDays(date) = date/dayMs - 0.5 + J1970 - J2000 = date/dayMs - 10957.5
  const J_OFFSET = -10957.5;
  const OBLIQUITY = RAD * 23.4397;
  const sinObliq = Math.sin(OBLIQUITY);
  const cosObliq = Math.cos(OBLIQUITY);
  const sampleCount = samples.length;
  const decArr = new Float64Array(sampleCount);
  const raArr = new Float64Array(sampleCount);
  const sidBaseArr = new Float64Array(sampleCount);
  for (let s = 0; s < sampleCount; s++) {
    const d = samples[s].valueOf() / DAY_MS + J_OFFSET;
    const M = RAD * (357.5291 + 0.98560028 * d);
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + RAD * 102.9372 + Math.PI;
    const sinL = Math.sin(L);
    const cosL = Math.cos(L);
    decArr[s] = Math.asin(sinObliq * sinL);
    raArr[s] = Math.atan2(sinL * cosObliq, cosL);
    sidBaseArr[s] = RAD * (280.16 + 360.9856235 * d);
  }

  // Per-tile: compute bucket for each above-horizon sample using precomputed
  // dec/ra and check membership in cached keys.
  for (let i = 0; i < params.tiles.length; i++) {
    const tile = params.tiles[i];
    const cached = cachedPerTile[i];
    const centerE = (tile.minEasting + tile.maxEasting) / 2;
    const centerN = (tile.minNorthing + tile.maxNorthing) / 2;
    const tileCenter = lv95ToWgs84Precise(centerE, centerN);
    const phi = RAD * tileCenter.lat;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const lw = RAD * -tileCenter.lon;
    const seen = new Set<number>();
    for (let s = 0; s < sampleCount; s++) {
      const dec = decArr[s];
      const ra = raArr[s];
      const H = sidBaseArr[s] - lw - ra;
      const sinDec = Math.sin(dec);
      const cosDec = Math.cos(dec);
      const cosH = Math.cos(H);
      const altRad = Math.asin(sinPhi * sinDec + cosPhi * cosDec * cosH);
      const altDeg = altRad * RAD_TO_DEG;
      if (altDeg <= 0) continue;
      const azRad = Math.atan2(Math.sin(H), cosH * sinPhi - (sinDec / cosDec) * cosPhi);
      let azDeg = (azRad * RAD_TO_DEG + 180) % 360;
      if (azDeg < 0) azDeg += 360;
      const azB = Math.floor(azDeg / resolutionDeg);
      const altB = Math.floor(altDeg / resolutionDeg);
      const key = packBucketKey(azB, altB);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!cached.keys.has(key)) return false;
    }
  }
  return true;
}

export type AtlasComputeState = "computed" | "skipped";

export interface AtlasComputeResult {
  state: AtlasComputeState;
  pointCountTotal: number | null;
  pointCountOutdoor: number | null;
  bucketCountTotal: number;
}

export interface AtlasComputeParams {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: RegionTileSpec;
  shadowCalibration: ShadowCalibration;
  /** Angular bucket size in degrees (az and alt). Defaults to 0.75°. */
  resolutionDeg?: number;
  cooperativeYieldEveryPoints?: number;
  onProgress?: (progress: SunlightTileComputeProgress) => void;
  signal?: AbortSignal;
  gridMetadata?: TileGridMetadata | null;
  /**
   * When `false`, bypasses both the bucket-coverage skip cache and the
   * disk-level bucket match: every target bucket is recomputed and overwrites
   * the existing entry via merge (new wins). Default: true.
   */
  skipExisting?: boolean;
}

/**
 * Resolves which (az, alt) buckets the supplied date window targets at the tile center.
 * Snaps each sample's sun position to a bucket of the specified resolution and dedupes.
 * Skips below-horizon samples.
 */
export function resolveTargetBuckets(
  params: Pick<AtlasComputeParams, "date" | "timezone" | "sampleEveryMinutes" | "startLocalTime" | "endLocalTime">,
  tileCenterLat: number,
  tileCenterLon: number,
  resolutionDeg: number = DEFAULT_ATLAS_RESOLUTION_DEG,
): Array<{ azBucket: number; altBucket: number }> {
  const samples = createUtcSamples(
    params.date,
    params.timezone,
    params.sampleEveryMinutes,
    params.startLocalTime,
    params.endLocalTime,
  );
  const map = new Map<number, { azBucket: number; altBucket: number }>();
  for (const d of samples) {
    const pos = SunCalc.getPosition(d, tileCenterLat, tileCenterLon);
    const altDeg = pos.altitude * RAD_TO_DEG;
    if (altDeg <= 0) continue;
    let azDeg = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (azDeg < 0) azDeg += 360;
    const azB = Math.floor(azDeg / resolutionDeg);
    const altB = Math.floor(altDeg / resolutionDeg);
    const key = packBucketKey(azB, altB);
    if (!map.has(key)) {
      map.set(key, { azBucket: azB, altBucket: altB });
    }
  }
  return Array.from(map.values());
}

/**
 * Bucket-centered atlas compute (ADR-0013):
 *  1. Resolve target (az, alt) buckets from the date/time window at the tile center.
 *  2. Load existing atlas; filter out buckets already covered.
 *  3. If nothing missing → return state="skipped".
 *  4. Otherwise, call computeSunlightTileArtifact with sunOverride = missing bucket centers.
 *  5. Merge new bucket masks into the atlas (existing entries win) and persist.
 */
export async function computeAndMergeAtlasForTile(
  params: AtlasComputeParams,
): Promise<AtlasComputeResult> {
  const resolutionDeg = params.resolutionDeg ?? DEFAULT_ATLAS_RESOLUTION_DEG;
  const skipExisting = params.skipExisting ?? true;
  const centerE = (params.tile.minEasting + params.tile.maxEasting) / 2;
  const centerN = (params.tile.minNorthing + params.tile.maxNorthing) / 2;
  const tileCenter = lv95ToWgs84Precise(centerE, centerN);

  const targetBuckets = resolveTargetBuckets(
    params,
    tileCenter.lat,
    tileCenter.lon,
    resolutionDeg,
  );

  // Fast skip-check: if we have a cached bucket-key set for this tile, use it
  // to decide skip WITHOUT loading the atlas from disk. Only load when we
  // actually need to merge new buckets. Bypassed when skipExisting=false.
  const skipKey = atlasSkipCacheKey({
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    gridStepMeters: params.gridStepMeters,
    tileId: params.tile.tileId,
    resolutionDeg,
  });
  if (skipExisting) {
    const cachedSkipInfo = atlasSkipCache.get(skipKey);
    if (cachedSkipInfo) {
      const allCovered = targetBuckets.every((b) =>
        cachedSkipInfo.keys.has(packBucketKey(b.azBucket, b.altBucket)),
      );
      if (allCovered) {
        return {
          state: "skipped",
          pointCountTotal: cachedSkipInfo.pointCount,
          pointCountOutdoor: cachedSkipInfo.outdoorPointCount,
          bucketCountTotal: cachedSkipInfo.bucketCount,
        };
      }
    }
  } else {
    // Force recompute: drop any stale in-memory coverage for this tile so the
    // post-merge refresh starts from the newly-written atlas.
    atlasSkipCache.delete(skipKey);
  }

  const existingAtlas = await loadPrecomputedTileAtlas({
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    gridStepMeters: params.gridStepMeters,
    tileId: params.tile.tileId,
    resolutionDeg,
  });

  // When skipExisting=false, treat the on-disk atlas as empty for skip/missing
  // purposes: every target bucket is recomputed. The merge still runs with
  // existingAtlas as base so untouched buckets (outside the date window)
  // survive, and new buckets overwrite the old via merge priority.
  const existingKeys =
    skipExisting && existingAtlas ? getAtlasBucketKeySet(existingAtlas) : new Set<number>();
  const missing = targetBuckets.filter(
    (b) => !existingKeys.has(packBucketKey(b.azBucket, b.altBucket)),
  );

  if (missing.length === 0) {
    // Populate cache so subsequent days skip the disk load entirely.
    atlasSkipCache.set(skipKey, {
      keys: existingKeys,
      pointCount: existingAtlas?.pointCount ?? 0,
      outdoorPointCount: existingAtlas?.outdoorPointCount ?? 0,
      bucketCount: existingAtlas?.bucketCount ?? 0,
    });
    // Reaching this branch means the atlas covers all targets but the sidecar
    // didn't (cache was cold or under-reported coverage). That mismatch
    // happens after a crash between atlas write and sidecar write. Refresh
    // the sidecar so the next process avoids this full-atlas reload entirely.
    if (existingAtlas) {
      try {
        await writeTileAtlasIndex(atlasToIndex(existingAtlas), {
          region: params.region,
          modelVersionHash: params.modelVersionHash,
          gridStepMeters: params.gridStepMeters,
          tileId: params.tile.tileId,
          resolutionDeg,
        });
      } catch {
        // Non-fatal — next run will retry.
      }
    }
    return {
      state: "skipped",
      pointCountTotal: existingAtlas?.pointCount ?? null,
      pointCountOutdoor: existingAtlas?.outdoorPointCount ?? null,
      bucketCountTotal: existingAtlas?.bucketCount ?? 0,
    };
  }

  const sunOverride = missing.map((b) => ({
    azimuthDeg: (b.azBucket + 0.5) * resolutionDeg,
    altitudeDeg: (b.altBucket + 0.5) * resolutionDeg,
  }));

  const artifact = await computeSunlightTileArtifact({
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    algorithmVersion: params.algorithmVersion,
    date: params.date,
    timezone: params.timezone,
    sampleEveryMinutes: params.sampleEveryMinutes,
    gridStepMeters: params.gridStepMeters,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tile: params.tile,
    shadowCalibration: params.shadowCalibration,
    cooperativeYieldEveryPoints: params.cooperativeYieldEveryPoints,
    signal: params.signal,
    gridMetadata: params.gridMetadata,
    sunOverride,
    onProgress: params.onProgress,
  });

  const pointCount = artifact.points.length;
  const pointLon = new Float64Array(pointCount);
  const pointLat = new Float64Array(pointCount);
  const pointIx = new Int32Array(pointCount);
  const pointIy = new Int32Array(pointCount);
  const pointOutdoorIndex = new Int32Array(pointCount);
  const pointFlags = new Uint32Array(pointCount);
  const pointIds: string[] = new Array(pointCount);
  const indoorBuildingIds: Array<string | null> = new Array(pointCount);
  const pointElevationMeters: Array<number | null> = new Array(pointCount);
  const pointLv95Easting: number[] = new Array(pointCount);
  const pointLv95Northing: number[] = new Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    const p = artifact.points[i];
    pointLon[i] = p.lon;
    pointLat[i] = p.lat;
    pointIx[i] = p.ix;
    pointIy[i] = p.iy;
    pointOutdoorIndex[i] = p.outdoorIndex ?? -1;
    pointFlags[i] = p.insideBuilding ? 1 : 0;
    pointIds[i] = p.id;
    indoorBuildingIds[i] = p.indoorBuildingId;
    pointElevationMeters[i] = p.pointElevationMeters;
    pointLv95Easting[i] = p.lv95Easting;
    pointLv95Northing[i] = p.lv95Northing;
  }
  const outdoorPointCount = artifact.stats.pointCount;
  const maskBytesPerBucket = Math.ceil(outdoorPointCount / 8);

  const newBuckets: AtlasBucketEntry[] = [];
  for (let i = 0; i < artifact.frames.length; i++) {
    const frame = artifact.frames[i];
    const bucket = missing[i];
    newBuckets.push({
      azBucket: bucket.azBucket,
      altBucket: bucket.altBucket,
      sunMask: frame.sunMask,
      sunNoVegMask: frame.sunMaskNoVegetation,
      terrainMask: frame.terrainBlockedMask,
      buildingsMask: frame.buildingsBlockedMask,
      vegetationMask: frame.vegetationBlockedMask,
    });
  }

  const meta: TileAtlasMetadata = {
    atlasFormatVersion: 1,
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    gridStepMeters: params.gridStepMeters,
    resolutionDegAz: resolutionDeg,
    resolutionDegAlt: resolutionDeg,
    tile: params.tile,
    model: artifact.model as unknown as Record<string, unknown>,
    warnings: artifact.warnings,
    stats: {
      bucketCount: 0,
      pointCount,
      outdoorPointCount,
      sourceFramesTotal:
        (existingAtlas?.meta.stats.sourceFramesTotal ?? 0) + artifact.frames.length,
    },
    pointIds,
    indoorBuildingIds,
    pointElevationMeters,
    pointLv95Easting,
    pointLv95Northing,
  };

  const atlasMergeT0 = performance.now();
  const merged = mergeBucketsIntoAtlas({
    existing: existingAtlas,
    meta,
    pointCount,
    outdoorPointCount,
    maskBytesPerBucket,
    resolutionDegAz: resolutionDeg,
    resolutionDegAlt: resolutionDeg,
    pointLon,
    pointLat,
    pointIx,
    pointIy,
    pointOutdoorIndex,
    pointFlags,
    newBuckets,
  });
  const atlasMergeMs = performance.now() - atlasMergeT0;
  console.log(
    `[atlas-merge] ${params.tile.tileId}  ${atlasMergeMs.toFixed(0)}ms  newBuckets=${newBuckets.length}  totalBuckets=${merged.bucketCount}  existing=${existingAtlas != null}`,
  );

  // Update in-memory skip cache immediately — independent of the disk write.
  // This must happen synchronously so the next day's tile lookup sees the
  // freshly merged buckets.
  atlasSkipCache.set(skipKey, {
    keys: getAtlasBucketKeySet(merged),
    pointCount,
    outdoorPointCount,
    bucketCount: merged.bucketCount,
  });

  // Fire-and-forget the disk write (with backpressure-bounded queue). The GPU
  // can start computing the next tile while gzip + disk I/O happens in
  // parallel. The await here only blocks if the queue is full (typically not).
  // The orchestrator (precomputeCacheRuns) calls awaitAllPendingAtlasWrites()
  // before returning, ensuring every write completes before the run ends.
  await kickoffAtlasWrite(merged, {
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    gridStepMeters: params.gridStepMeters,
    tileId: params.tile.tileId,
    resolutionDeg,
  });

  return {
    state: "computed",
    pointCountTotal: pointCount,
    pointCountOutdoor: outdoorPointCount,
    bucketCountTotal: merged.bucketCount,
  };
}
