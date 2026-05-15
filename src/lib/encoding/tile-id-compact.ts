/**
 * Compact wire encoding for a list of tile IDs.
 *
 * Canonical tile IDs look like `e2537750_n1152000_s250` (23 chars). Within a
 * single SSE request, every tile shares the same `s` size, so we can strip
 * the size segment, divide e and n by the size to get small grid indices,
 * and drop the prefix letters. The result for the example becomes
 * `10151_4608` (10 chars — roughly 2.3× shorter), letting the client tell
 * the server about ~2× more excluded tiles within the same URL budget.
 *
 * Format: comma-separated `<e/s>_<n/s>` pairs. Decoders must know `s` from
 * the request's `gridStepMeters` (the value of the canonical tile size) to
 * recover full tile IDs.
 */

const TILE_ID_REGEX = /^e(\d+)_n(\d+)_s(\d+)$/;

export interface TileGridCoord {
  e: number;
  n: number;
  s: number;
}

export function parseTileId(tileId: string): TileGridCoord | null {
  const match = TILE_ID_REGEX.exec(tileId);
  if (!match) return null;
  return {
    e: Number(match[1]),
    n: Number(match[2]),
    s: Number(match[3]),
  };
}

/** Build the compact `<e/s>_<n/s>` form for one tile. */
export function compactTileId(tileId: string): string | null {
  const parsed = parseTileId(tileId);
  if (!parsed) return null;
  const { e, n, s } = parsed;
  if (s <= 0) return null;
  // Both e and n are LV95 millimetric-grid-aligned at the canonical tile
  // size; integer division is exact for valid inputs.
  return `${(e / s) | 0}_${(n / s) | 0}`;
}

/** Encode a list of tile IDs. Non-matching IDs are silently dropped. */
export function encodeCompactTileIds(tileIds: Iterable<string>): string {
  const out: string[] = [];
  for (const id of tileIds) {
    const c = compactTileId(id);
    if (c) out.push(c);
  }
  return out.join(",");
}

/**
 * Build a lookup `Set` populated with the compact form of each tile ID the
 * server is iterating. The route stays O(1) per tile event for membership
 * checks.
 */
export function decodeCompactTileIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").filter(Boolean));
}
