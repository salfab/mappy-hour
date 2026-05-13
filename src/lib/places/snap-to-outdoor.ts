/**
 * Place position helpers — shared between `/api/places/windows`
 * (sunlight-aware path) and `/api/places/viewport` (lightweight overlay).
 *
 * Goal : if a place's OSM `lat`/`lon` lands inside a building (very common —
 * OSM often pins establishments to a building's centroid), nudge it a few
 * meters to a nearby outdoor point so the marker visually sits on the
 * sidewalk / terrace instead of on the roof.
 *
 * The "is this point indoor ?" oracle is the **zenith indoor mask** baked
 * into `data/cache/tile-grid-metadata/<region>/<gridMetadataHash>/g1/<tileId>.json.gz`.
 * That mask is the same one used by `zenithIndoorCheck` in
 * `src/lib/sun/evaluation-context.ts`, so both API surfaces stay coherent.
 *
 * The helper is intentionally cheap : no GPU init, no buildings index, no
 * elevation sampling. In cache-only deployments (Mitch) the buildings index
 * isn't even on disk — we resolve the grid-metadata hash by scanning the
 * filesystem instead.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { wgs84ToLv95Precise } from "@/lib/geo/projection";
import { resolveRegionForBbox } from "@/lib/precompute/sunlight-tile-service";
import type { PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";
import { loadTileGridMetadata, type TileGridMetadata } from "@/lib/precompute/tile-grid-metadata";
import { CACHE_TILE_GRID_METADATA_DIR } from "@/lib/storage/data-paths";

/** Grid step in meters of the zenith indoor mask. Hard-wired to 1 in the
 *  precompute pipeline (see `precompute-tile-grid-metadata.ts`). */
const CACHE_GRID_STEP = 1;
const TILE_SIZE_METERS = 250;

export type PlaceSelectionStrategy =
  | "original"
  | "terrace_offset"
  | "indoor_fallback";

export interface PlaceCandidate {
  lat: number;
  lon: number;
  offsetMeters: number;
}

/** Move a point by `distanceMeters` along a given compass bearing (deg). */
export function offsetPointByMeters(
  lat: number,
  lon: number,
  distanceMeters: number,
  bearingDeg: number,
): { lat: number; lon: number } {
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon =
    metersPerDegreeLat * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const deltaLat = (Math.cos(bearingRad) * distanceMeters) / metersPerDegreeLat;
  const deltaLon = (Math.sin(bearingRad) * distanceMeters) / metersPerDegreeLon;
  return { lat: lat + deltaLat, lon: lon + deltaLon };
}

/** Standard sweep: original point + 8 cardinal/diagonal bearings × 4 m and
 *  8 m. 17 candidates total, ordered original-first then by ascending
 *  distance — so we accept the SMALLEST nudge that produces an outdoor
 *  point. */
export function buildTerraceCandidates(
  lat: number,
  lon: number,
): PlaceCandidate[] {
  const out: PlaceCandidate[] = [{ lat, lon, offsetMeters: 0 }];
  const distances = [4, 8];
  const bearings = [0, 45, 90, 135, 180, 225, 270, 315];
  for (const distance of distances) {
    for (const bearing of bearings) {
      const shifted = offsetPointByMeters(lat, lon, distance, bearing);
      out.push({
        lat: shifted.lat,
        lon: shifted.lon,
        offsetMeters: distance,
      });
    }
  }
  return out;
}

// ── gridMetadataHash discovery (cache-only friendly) ────────────────────
// `getSunlightModelVersion` is the authoritative source for the hash, but it
// pulls the full buildings index + manifests into memory (~hundreds of MB)
// and is unavailable in cache-only deployments. For this helper we only need
// the **latest** hash on disk per region — the indoor mask is stable enough
// across model bumps that picking the newest folder by mtime is a safe
// pragmatic choice : if the mask is "wrong" because the model changed, the
// precompute pipeline would have written a fresher folder we'll pick up.

const hashCache = new Map<PrecomputedRegionName, Promise<string | null>>();

async function resolveGridMetadataHashForRegion(
  region: PrecomputedRegionName,
): Promise<string | null> {
  const cached = hashCache.get(region);
  if (cached) return cached;
  const promise = (async () => {
    const regionDir = path.join(CACHE_TILE_GRID_METADATA_DIR, region);
    let entries: string[];
    try {
      entries = await fs.readdir(regionDir);
    } catch {
      return null;
    }
    let best: { hash: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
      try {
        const stat = await fs.stat(path.join(regionDir, entry));
        if (!stat.isDirectory()) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { hash: entry, mtimeMs: stat.mtimeMs };
        }
      } catch {
        /* race with cleanup — ignore */
      }
    }
    return best?.hash ?? null;
  })();
  hashCache.set(region, promise);
  return promise;
}

/** Test-only hook: drop the in-memory hash cache. */
export function _resetSnapToOutdoorCachesForTests(): void {
  hashCache.clear();
  metadataCache.clear();
}

// ── tile metadata cache ────────────────────────────────────────────────
// `loadTileGridMetadata` reads + gunzips + JSON-parses a ~1 MB blob per
// tile. We cache resolved metadata per (region, hash, tileId) so a
// 500-place viewport that lands on 4–10 distinct tiles only pays the I/O
// once per request.

type MetadataKey = string;
const metadataCache = new Map<MetadataKey, Promise<TileGridMetadata | null>>();

function makeMetadataKey(
  region: PrecomputedRegionName,
  hash: string,
  tileId: string,
): MetadataKey {
  return `${region}:${hash}:${tileId}`;
}

async function getMetadataForTile(
  region: PrecomputedRegionName,
  hash: string,
  tileId: string,
): Promise<TileGridMetadata | null> {
  const key = makeMetadataKey(region, hash, tileId);
  const cached = metadataCache.get(key);
  if (cached) return cached;
  const promise = loadTileGridMetadata(region, hash, CACHE_GRID_STEP, tileId);
  metadataCache.set(key, promise);
  return promise;
}

function pointIsIndoor(
  meta: TileGridMetadata,
  tileMinE: number,
  tileMinN: number,
  easting: number,
  northing: number,
): boolean | null {
  const ix = Math.floor(easting) - Math.floor(tileMinE);
  const iy = Math.floor(northing) - Math.floor(tileMinN);
  const gridW = TILE_SIZE_METERS / CACHE_GRID_STEP;
  if (ix < 0 || ix >= gridW || iy < 0 || iy >= gridW) return null;
  const idx = iy * gridW + ix;
  if (idx < 0 || idx >= meta.indoor.length) return null;
  return meta.indoor[idx] ?? false;
}

export interface SnapResult {
  lat: number;
  lon: number;
  offsetMeters: number;
  selectionStrategy: PlaceSelectionStrategy;
}

/**
 * For a place at `lat/lon`, return either the original point (if outdoor or
 * if we have no indoor data for the area) or the nearest outdoor candidate
 * within ~8 m.
 *
 * Behaviour :
 *  - Outside any precomputed region → `original` (we can't tell).
 *  - No grid-metadata folder for the region → `original`.
 *  - Region known but the specific tile metadata is missing → `original`.
 *  - All 17 candidates indoor → `indoor_fallback` at the original point.
 *  - First outdoor candidate at offset 0 → `original`.
 *  - First outdoor candidate at offset > 0 → `terrace_offset`.
 */
export async function snapPlaceToOutdoor(place: {
  lat: number;
  lon: number;
}): Promise<SnapResult> {
  const region = resolveRegionForBbox({
    minLon: place.lon,
    maxLon: place.lon,
    minLat: place.lat,
    maxLat: place.lat,
  });
  if (!region) {
    return {
      lat: place.lat,
      lon: place.lon,
      offsetMeters: 0,
      selectionStrategy: "original",
    };
  }
  const hash = await resolveGridMetadataHashForRegion(region);
  if (!hash) {
    return {
      lat: place.lat,
      lon: place.lon,
      offsetMeters: 0,
      selectionStrategy: "original",
    };
  }

  const candidates = buildTerraceCandidates(place.lat, place.lon);
  let originalIndoorKnown = false;
  let originalIsIndoor = false;
  for (const cand of candidates) {
    const lv95 = wgs84ToLv95Precise(cand.lon, cand.lat);
    const tileMinE = Math.floor(lv95.easting / TILE_SIZE_METERS) * TILE_SIZE_METERS;
    const tileMinN = Math.floor(lv95.northing / TILE_SIZE_METERS) * TILE_SIZE_METERS;
    const tileId = `e${tileMinE}_n${tileMinN}_s${TILE_SIZE_METERS}`;
    const meta = await getMetadataForTile(region, hash, tileId);
    if (!meta) continue;
    const indoor = pointIsIndoor(meta, tileMinE, tileMinN, lv95.easting, lv95.northing);
    if (indoor === null) continue;
    if (cand.offsetMeters === 0) {
      originalIndoorKnown = true;
      originalIsIndoor = indoor;
    }
    if (!indoor) {
      return {
        lat: cand.lat,
        lon: cand.lon,
        offsetMeters: cand.offsetMeters,
        selectionStrategy: cand.offsetMeters === 0 ? "original" : "terrace_offset",
      };
    }
  }

  // Every candidate we could resolve was indoor — pin to the original
  // point. If we couldn't resolve ANY candidate (every tile missing),
  // call it `original` since we have no signal at all.
  return {
    lat: place.lat,
    lon: place.lon,
    offsetMeters: 0,
    selectionStrategy: originalIndoorKnown && originalIsIndoor ? "indoor_fallback" : "original",
  };
}

/**
 * Bounded-parallelism `map`. Used by the viewport route to walk ~500 places
 * through `snapPlaceToOutdoor` without firing 500 disk reads in parallel
 * (the metadata cache deduplicates by tile, but the first place on each
 * new tile still triggers an I/O — concurrency cap avoids burst spikes).
 */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
