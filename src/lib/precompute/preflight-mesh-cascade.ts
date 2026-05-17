/**
 * Preflight defense in depth for gpu-mesh integrity (cf. Zurich DXF 1091-41
 * silent skip incident, 2026-05-17). When a binary `gpu-mesh-*` cache was
 * built with a ratio of matched obstacles < 100%, every downstream artifact
 * (tile-grid-metadata, sunlight atlas) computed against it is silently
 * tainted: indoor points marked outdoor, buildingsMask under-counts shadow.
 *
 * This module:
 *   1. Lists incomplete mesh caches via `auditGpuMeshCaches()`.
 *   2. Maps each cache's center (originX, originY) to the region whose LV95
 *      bbox contains it.
 *   3. Quarantines every grid-metadata + sunlight atlas for that region
 *      under `<DATA_ROOT>/_quarantine/<timestamp>/...` so the next run
 *      recomputes them from the freshly rebuilt (complete) mesh.
 *
 * Idempotent: a second run with no incomplete caches is a no-op.
 *
 * Triggered automatically by the precompute-tile-grid-metadata preflight.
 */
import fsPromises from "node:fs/promises";
import path from "node:path";

import { auditGpuMeshCaches, type GpuMeshCacheAudit } from "@/lib/sun/gpu-mesh-loader";
import { PRECOMPUTED_REGION_NAMES } from "@/lib/regions/regions";
import type { PrecomputedRegionName } from "@/lib/regions/regions";
import { getPrecomputedRegionBbox } from "@/lib/regions/regions";
import { wgs84ToLv95Precise } from "@/lib/geo/projection";
import {
  CACHE_TILE_GRID_METADATA_DIR,
  CACHE_SUNLIGHT_DIR,
  DATA_ROOT,
  PROCESSED_BUILDINGS_DIR,
} from "@/lib/storage/data-paths";

interface RegionLv95Bounds {
  region: PrecomputedRegionName;
  minEasting: number;
  maxEasting: number;
  minNorthing: number;
  maxNorthing: number;
}

function regionLv95Bounds(region: PrecomputedRegionName): RegionLv95Bounds {
  const bbox = getPrecomputedRegionBbox(region);
  const corners = [
    wgs84ToLv95Precise(bbox.minLon, bbox.minLat),
    wgs84ToLv95Precise(bbox.minLon, bbox.maxLat),
    wgs84ToLv95Precise(bbox.maxLon, bbox.minLat),
    wgs84ToLv95Precise(bbox.maxLon, bbox.maxLat),
  ];
  return {
    region,
    minEasting: Math.min(...corners.map(c => c.easting)),
    maxEasting: Math.max(...corners.map(c => c.easting)),
    minNorthing: Math.min(...corners.map(c => c.northing)),
    maxNorthing: Math.max(...corners.map(c => c.northing)),
  };
}

/**
 * Parse a mesh cache key (`gpu-mesh-<originX>-<originY>-<obstacleCount>`)
 * back to its (originX, originY) center. Returns null if the key has the
 * `gpu-mesh-NaN-NaN-0` sentinel format (cosmetic stub).
 */
function parseCacheKeyCenter(cacheKey: string): { x: number; y: number } | null {
  const m = /^gpu-mesh-(-?\d+)-(-?\d+)-\d+$/.exec(cacheKey);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

function findContainingRegion(centerX: number, centerY: number, regions: RegionLv95Bounds[]): PrecomputedRegionName | null {
  for (const r of regions) {
    if (centerX >= r.minEasting && centerX <= r.maxEasting &&
        centerY >= r.minNorthing && centerY <= r.maxNorthing) {
      return r.region;
    }
  }
  return null;
}

function timestampForQuarantine(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fsPromises.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function moveDir(src: string, dest: string): Promise<number> {
  await fsPromises.mkdir(path.dirname(dest), { recursive: true });
  // Best-effort rename; if cross-device, fallback to recursive copy + delete.
  try {
    await fsPromises.rename(src, dest);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      await fsPromises.cp(src, dest, { recursive: true, force: true });
      await fsPromises.rm(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
  return 1;
}

export interface MeshCascadeResult {
  incompleteCaches: GpuMeshCacheAudit[];
  affectedRegions: Set<PrecomputedRegionName>;
  unmappedCaches: GpuMeshCacheAudit[];
  quarantineRoot: string | null;
  quarantinedPaths: string[];
}

/**
 * Detect incomplete mesh caches and cascade-quarantine the affected regions'
 * grid-metadata + sunlight atlas. Returns a summary for the caller to log.
 *
 * The incomplete cache .json/.bin themselves are also moved into the
 * quarantine so they cannot poison a subsequent load (`loadFromBinaryCache`
 * already rejects them but quarantine makes the audit log self-explanatory).
 */
export async function preflightMeshCascade(): Promise<MeshCascadeResult> {
  const incompleteCaches = await auditGpuMeshCaches();
  const result: MeshCascadeResult = {
    incompleteCaches,
    affectedRegions: new Set(),
    unmappedCaches: [],
    quarantineRoot: null,
    quarantinedPaths: [],
  };
  if (incompleteCaches.length === 0) return result;

  const regions = PRECOMPUTED_REGION_NAMES.map(regionLv95Bounds);
  for (const c of incompleteCaches) {
    const center = parseCacheKeyCenter(c.cacheKey);
    if (!center) { result.unmappedCaches.push(c); continue; }
    const region = findContainingRegion(center.x, center.y, regions);
    if (!region) { result.unmappedCaches.push(c); continue; }
    result.affectedRegions.add(region);
  }

  if (result.affectedRegions.size === 0 && result.unmappedCaches.length === 0) {
    return result;
  }

  const ts = timestampForQuarantine();
  const quarantineRoot = path.join(DATA_ROOT, "_quarantine", ts);
  result.quarantineRoot = quarantineRoot;

  // Quarantine the offending cache headers/bins so future runs do not see them.
  for (const c of incompleteCaches) {
    for (const ext of [".json", ".bin"]) {
      const src = path.join(PROCESSED_BUILDINGS_DIR, `${c.cacheKey}${ext}`);
      const dest = path.join(quarantineRoot, "processed", "buildings", `${c.cacheKey}${ext}`);
      try {
        await fsPromises.access(src);
        await fsPromises.mkdir(path.dirname(dest), { recursive: true });
        await fsPromises.rename(src, dest);
        result.quarantinedPaths.push(dest);
      } catch {
        // missing file is fine
      }
    }
  }

  // Cascade-quarantine each affected region's grid-metadata + atlas.
  for (const region of result.affectedRegions) {
    const gridSrc = path.join(CACHE_TILE_GRID_METADATA_DIR, region);
    if (await dirExists(gridSrc)) {
      const dest = path.join(quarantineRoot, "cache", "tile-grid-metadata", region);
      await moveDir(gridSrc, dest);
      result.quarantinedPaths.push(dest);
    }
    const atlasSrc = path.join(CACHE_SUNLIGHT_DIR, region);
    if (await dirExists(atlasSrc)) {
      const dest = path.join(quarantineRoot, "cache", "sunlight", region);
      await moveDir(atlasSrc, dest);
      result.quarantinedPaths.push(dest);
    }
  }

  return result;
}
