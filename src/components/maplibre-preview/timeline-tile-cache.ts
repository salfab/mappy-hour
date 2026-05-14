import type { TimelineTile } from "@/components/sunlight-overlay/maplibre-sunlight-custom-layer";

/**
 * LRU cache for decoded sunlight tiles keyed by (date, tileId).
 *
 * Each cached entry holds the gzip-decoded masks (one big Uint8Array per
 * frame × outdoor mask), which is the expensive thing to recompute. Skipping
 * the decode means re-opening the same viewport / nudging the map after a
 * date change feels essentially instant.
 *
 * Bounded by entry count rather than bytes — tile decoded payload size is
 * fairly uniform (~400-600 KB at the default 250×250 grid with 31 frames).
 * 1000 entries lands around 480 MB; that's heavy but a single zoom-out at
 * city scale can already need 800+ tiles in one request, and a cap lower
 * than that single request would evict tiles from the very fetch that just
 * loaded them — defeating the cache. The number is high; revise downward if
 * we measure real OOM pressure.
 */

const MAX_ENTRIES = 1000;

interface CacheValue {
  outdoor: Uint8Array;
  frames: Array<{ sun: Uint8Array; sunNoVeg: Uint8Array }>;
  grid: { width: number; height: number; minIx: number; maxIx: number; minIy: number; maxIy: number };
  tileCorners: NonNullable<TimelineTile["tileCorners"]>;
  /** Raw frame metadata kept so reusing the tile preserves the timeline shape. */
  frameMeta: TimelineTile["frames"];
}

// Map preserves insertion order; deleting + re-setting moves the key to the
// end, giving us O(1) LRU bookkeeping.
const store = new Map<string, CacheValue>();

function makeKey(date: string, tileId: string): string {
  return `${date}|${tileId}`;
}

export function getCachedTile(date: string, tileId: string): TimelineTile | null {
  const key = makeKey(date, tileId);
  const v = store.get(key);
  if (!v) return null;
  // Touch (move to MRU end).
  store.delete(key);
  store.set(key, v);
  return {
    tileId,
    grid: v.grid,
    tileCorners: v.tileCorners,
    frames: v.frameMeta,
    decodedMasks: { outdoor: v.outdoor, frames: v.frames },
  };
}

export function putCachedTile(date: string, tile: TimelineTile): void {
  if (!tile.decodedMasks || !tile.grid || !tile.tileCorners) return;
  const key = makeKey(date, tile.tileId);
  // Overwrite-as-fresh.
  store.delete(key);
  store.set(key, {
    outdoor: tile.decodedMasks.outdoor,
    frames: tile.decodedMasks.frames,
    grid: tile.grid,
    tileCorners: tile.tileCorners,
    frameMeta: tile.frames,
  });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function clearTileCache(): void {
  store.clear();
}

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/**
 * Cached tile IDs whose footprint overlaps `bbox`, in MRU order, capped at
 * `max`. Useful to tell the server which tiles it can skip computing /
 * streaming on the next request.
 */
export function getCachedTileIdsInBbox(date: string, bbox: Bbox, max: number): string[] {
  const ids: string[] = [];
  const prefix = `${date}|`;
  // Iterate in REVERSE so we pick the freshest (MRU end of the Map) first.
  const entries = Array.from(store.entries()).reverse();
  for (const [key, v] of entries) {
    if (ids.length >= max) break;
    if (!key.startsWith(prefix)) continue;
    const c = v.tileCorners;
    const tileMinLon = Math.min(c.nw.lon, c.sw.lon);
    const tileMaxLon = Math.max(c.ne.lon, c.se.lon);
    const tileMinLat = Math.min(c.sw.lat, c.se.lat);
    const tileMaxLat = Math.max(c.nw.lat, c.ne.lat);
    if (tileMaxLon < bbox.minLon || tileMinLon > bbox.maxLon) continue;
    if (tileMaxLat < bbox.minLat || tileMinLat > bbox.maxLat) continue;
    ids.push(key.slice(prefix.length));
  }
  return ids;
}
