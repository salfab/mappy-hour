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

/**
 * Returns `true` when every point of `bbox` falls inside at least one cached
 * tile's bounding rectangle for the given `date`. Used by `fetchTimeline` to
 * short-circuit the SSE call entirely when the LRU already holds everything
 * needed.
 *
 * Coverage is approximated by sampling `bbox` at a `samples+1` × `samples+1`
 * grid (default 8 → 81 points). False positives (declares covered when a tiny
 * gap exists) require all samples to miss the gap — unlikely on 250 m tiles.
 * False negatives just fall back to the regular SSE call.
 */
export function isBboxCoveredByCache(
  date: string,
  bbox: Bbox,
  samples = 8,
): boolean {
  const prefix = `${date}|`;
  const rects: Array<{
    minLon: number; maxLon: number; minLat: number; maxLat: number;
  }> = [];
  for (const [key, v] of store) {
    if (!key.startsWith(prefix)) continue;
    const c = v.tileCorners;
    const minLon = Math.min(c.nw.lon, c.sw.lon);
    const maxLon = Math.max(c.ne.lon, c.se.lon);
    const minLat = Math.min(c.sw.lat, c.se.lat);
    const maxLat = Math.max(c.nw.lat, c.ne.lat);
    if (maxLon < bbox.minLon || minLon > bbox.maxLon) continue;
    if (maxLat < bbox.minLat || minLat > bbox.maxLat) continue;
    rects.push({ minLon, maxLon, minLat, maxLat });
  }
  if (rects.length === 0) return false;

  const stepLon = (bbox.maxLon - bbox.minLon) / samples;
  const stepLat = (bbox.maxLat - bbox.minLat) / samples;
  for (let i = 0; i <= samples; i++) {
    const lon = bbox.minLon + i * stepLon;
    for (let j = 0; j <= samples; j++) {
      const lat = bbox.minLat + j * stepLat;
      let inside = false;
      for (const r of rects) {
        if (lon >= r.minLon && lon <= r.maxLon && lat >= r.minLat && lat <= r.maxLat) {
          inside = true;
          break;
        }
      }
      if (!inside) return false;
    }
  }
  return true;
}

/** Debug snapshot — exposed on `window.__tileCache` for console inspection. */
export function inspectTileCache(): {
  size: number;
  capacity: number;
  byDate: Record<string, number>;
  oldestKey: string | null;
  newestKey: string | null;
} {
  const byDate: Record<string, number> = {};
  for (const key of store.keys()) {
    const date = key.split("|", 1)[0] ?? "?";
    byDate[date] = (byDate[date] ?? 0) + 1;
  }
  const keys = Array.from(store.keys());
  return {
    size: store.size,
    capacity: MAX_ENTRIES,
    byDate,
    oldestKey: keys[0] ?? null,
    newestKey: keys[keys.length - 1] ?? null,
  };
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
