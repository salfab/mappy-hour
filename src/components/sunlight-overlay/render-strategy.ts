/**
 * LOD strategy for the sunlight overlay (vector ↔ bitmap).
 *
 * Inputs : current Leaflet `zoom` and the number of tiles intersecting the
 * viewport. Output : `{ mode: "vector" | "bitmap", bitmapResolution? }`.
 *
 * ## Convention pixel = cell-extent (figée 2026-05-12)
 *
 * Un pixel canvas représente l'AIRE carrée `grid_step_m × grid_step_m` autour
 * d'une cellule LV95, pas son centre. Le canvas a donc :
 *   - width  = nbCellsX (pas nbCellsX + 1)
 *   - height = nbCellsY
 *
 * → Les 4 `tileCorners` émis par le backend représentent les BORDS du tile
 *   carré 250m × 250m. La projection bilinéaire entre ces 4 coins suffit.
 * → Pas de shift `-0.5` cell-center vs cell-extent. Le shift dans
 *   `buildTileContourPolygons` (ligne 1421 de sunlight-map-client.tsx en
 *   2026-05-12) est un bug latent à corriger en phase 1.
 *
 * ## Hystérésis
 *
 * `selectRenderStrategy` est stateless : elle prend l'état précédent en argument
 * (`previousMode`) et applique des seuils d'entrée différents des seuils de
 * sortie. Évite le flapping vector ↔ bitmap quand on hover la frontière.
 *
 *     mode = "vector"  → reste vector si zoom ≥ ENTER.zoomMin ET tiles ≤ ENTER.tilesMax
 *                        bascule en bitmap dès zoom <  EXIT.zoomMin OU tiles > EXIT.tilesMax
 *     mode = "bitmap"  → bascule en vector dès zoom ≥ ENTER.zoomMin ET tiles ≤ ENTER.tilesMax
 */

export type RenderMode = "vector" | "bitmap";

export interface RenderStrategyInput {
  zoom: number;
  visibleTileCount: number;
  /** `window.devicePixelRatio` clampé. Capped at 2 — cf. comment in MAX_DPR. */
  devicePixelRatio: number;
  /** Tile side in meters (= grid_step × grid_size, e.g. 1m × 250 = 250m). */
  tileSizeMeters: number;
  /** Native cells along one tile edge (= 250 at grid_step=1m). */
  tileNativeSizePx: number;
  /** Previous strategy result. Pass `null` on the very first call. */
  previousMode: RenderMode | null;
}

export interface RenderStrategyOutput {
  mode: RenderMode;
  /** Square pixel resolution to render the tile at. Same `bitmapResolution`
   *  for both modes — vector uses it for its internal contour rasterization,
   *  bitmap uses it as the canvas physical size before DPR. */
  bitmapResolution: number;
}

// ── Vector mode entry conditions ─────────────────────────────────────────────
// Vector contours stay sharp at very tight zoom AND with few visible tiles.
// Above z=19 we're at ~0.3 m/pixel at lat 46.5 — every cell of a 1m grid is
// already 3 px on screen, plenty for crisp SVG polygons. ≤8 visible tiles
// keeps the DOM polygon count manageable (8 × ~100 contour polygons ≈ 800
// SVG elements — Leaflet handles this fine at static zoom).
const VECTOR_ZOOM_ENTER = 19; // need ≥
const VECTOR_TILES_ENTER = 8; // need ≤

// ── Vector mode exit conditions (hysteresis) ─────────────────────────────────
// Slightly looser than entry to avoid flapping when the user is hovering the
// border. ~half-step zoom buffer + one extra tile margin.
const VECTOR_ZOOM_EXIT = 18.5; // exit if <
const VECTOR_TILES_EXIT = 9; // exit if >

// ── Bitmap resolution ────────────────────────────────────────────────────────
// At zoom z, one screen pixel covers `~156543 / 2^z × cos(lat)` meters at the
// equator-corrected Mercator. For lat 46.5, the cosine factor is ~0.69.
// `target_px = ceil(grid_size_m × px_per_m × DPR)` is then clamped to
// [MIN_RES, tileNativeSizePx] — never higher than the source grid (no upsampling).
const MIN_RES_PX = 8; // floor — below that the tile is unreadable anyway
const MAX_DPR = 2; // cap — at DPR ≥ 3 (some phones) the canvas RAM cost
//                      // explodes (50 tiles × 250 × 250 × 4 bytes × 9 = 113 MB)

function pxPerMeterAtZoomLat(zoom: number, latDeg: number): number {
  const latRad = (latDeg * Math.PI) / 180;
  // Web Mercator: 1 tile = 256 px = 156543.03392m / 2^z at equator
  // px_per_m = 2^z / (156543.03392 × cos(lat))
  return Math.pow(2, zoom) / (156543.03392 * Math.cos(latRad));
}

const REFERENCE_LAT_DEG = 46.5; // Lausanne — good enough for the whole map area

export function selectRenderStrategy(input: RenderStrategyInput): RenderStrategyOutput {
  const dpr = Math.min(Math.max(input.devicePixelRatio, 1), MAX_DPR);

  // Choose mode with hysteresis.
  let mode: RenderMode;
  const meetsEntry =
    input.zoom >= VECTOR_ZOOM_ENTER && input.visibleTileCount <= VECTOR_TILES_ENTER;
  const breaksExit =
    input.zoom < VECTOR_ZOOM_EXIT || input.visibleTileCount > VECTOR_TILES_EXIT;
  if (input.previousMode === "vector") {
    // Stay vector unless we cross an EXIT threshold.
    mode = breaksExit ? "bitmap" : "vector";
  } else {
    // Currently bitmap (or first call): switch to vector only if we cross
    // BOTH entry thresholds. First call: previousMode === null → fall here.
    mode = meetsEntry ? "vector" : "bitmap";
  }

  // Resolution target. Both modes compute it the same way; vector uses it as
  // an internal grid resolution for d3-contour, bitmap as canvas physical size.
  const pxPerMeter = pxPerMeterAtZoomLat(input.zoom, REFERENCE_LAT_DEG);
  const targetPx = Math.ceil(input.tileSizeMeters * pxPerMeter * dpr);
  const bitmapResolution = Math.min(input.tileNativeSizePx, Math.max(MIN_RES_PX, targetPx));

  return { mode, bitmapResolution };
}

/**
 * Decide whether the bitmap canvas needs to be re-rasterized following a
 * `zoomend`. Returns true if the gap between the current rasterization and
 * the new target exceeds the 50% threshold — amortizes the cost of frequent
 * re-renders during pinch-zoom while still keeping fidelity at rest.
 */
export function shouldRerasterize(
  currentResolution: number,
  targetResolution: number,
): boolean {
  if (currentResolution <= 0) return true;
  const ratio = targetResolution / currentResolution;
  return ratio > 1.5 || ratio < 0.5;
}
