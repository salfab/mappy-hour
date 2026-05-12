/**
 * Unified-viewport marching-squares.
 *
 * Stitches the visible tiles into a single padded grid, runs d3-contour once,
 * and emits polygons whose vertices cross former tile boundaries seamlessly.
 *
 * Motivation: the per-tile pipeline (`buildTileContourPolygons` in
 * sunlight-map-client.tsx) 0-pads each tile's grid border before
 * marching-squares — that creates an isoline right at every tile edge, which
 * is the visible "seam" between adjacent polygons. By feeding the algorithm
 * the actual neighbor data on shared edges, isolines pass through cleanly
 * and the seam disappears.
 *
 * Cost is paid once per idle-snapshot, not per frame: this is the upgrade
 * path triggered when the user pauses interaction in bitmap LOD mode.
 *
 * ## Layout assumptions
 *
 * Tiles in this project are placed on a regular LV95 grid with consistent
 * `gridWidth × gridHeight` per tile. We derive the layout from the unique
 * `nw.lat` / `nw.lon` of the visible tiles (rank-based, not coordinate-based,
 * so sub-µm drift between tile corners doesn't fragment the layout).
 *
 * Holes in the visible footprint (missing or not-yet-computed tiles) are
 * filled with the same zero sentinel as the legacy per-tile path; the result
 * is an artificial edge around the hole. Acceptable for v1 — typical
 * viewport is fully covered.
 */

import { contours as d3Contours } from "d3-contour";

import type { LatLon } from "./tile-corners-projection";

export interface VisibleTileInput {
  tileId: string;
  corners: { nw: LatLon; ne: LatLon; sw: LatLon; se: LatLon };
  gridWidth: number;
  gridHeight: number;
  /** Bit-packed sun mask, length = ceil(gridWidth * gridHeight / 8). */
  sunMask: Uint8Array;
  /** Bit-packed outdoor mask. Missing = treat all cells as outdoor. */
  outdoorMask?: Uint8Array;
}

export interface UnifiedContoursOutput {
  sunnyPolygons: Array<[number, number][][]>;
  shadowPolygons: Array<[number, number][][]>;
  buildingPolygons: Array<[number, number][][]>;
  /** Cells × ms is the right unit to track scaling. Reported for empirical
   *  tuning of the "skip vector upgrade above N cells" cap. */
  stats: { totalCells: number; tileCount: number };
}

function bit(mask: Uint8Array, idx: number): number {
  return (mask[idx >> 3] >> (idx & 7)) & 1;
}

export function buildUnifiedViewportContours(
  tiles: VisibleTileInput[],
): UnifiedContoursOutput {
  const empty: UnifiedContoursOutput = {
    sunnyPolygons: [],
    shadowPolygons: [],
    buildingPolygons: [],
    stats: { totalCells: 0, tileCount: 0 },
  };
  if (tiles.length === 0) return empty;

  // ── 1. Derive tile-grid layout from unique NW lats/lons ────────────────
  // Rank-based, not coord-based, so floating-point noise doesn't fragment
  // the layout. Tiles are sorted: lon ascending = column index from W→E,
  // lat ascending = row index from S→N.
  const SORT_TOL = 1e-7; // ~1cm at this latitude — well below any tile pitch
  const uniqueLons = uniqueSorted(tiles.map((t) => t.corners.nw.lon), SORT_TOL);
  const uniqueLats = uniqueSorted(tiles.map((t) => t.corners.sw.lat), SORT_TOL);
  const cols = uniqueLons.length;
  const rows = uniqueLats.length;

  // Use the MAX grid dimension across visible tiles so an edge tile with a
  // truncated grid (e.g. 43 × 250 at a region's west edge) doesn't shrink
  // the unified slot for its column — it'd otherwise crush every other
  // tile in that column into a 43-cell-wide strip.
  let tileW = 0;
  let tileH = 0;
  for (const t of tiles) {
    if (t.gridWidth > tileW) tileW = t.gridWidth;
    if (t.gridHeight > tileH) tileH = t.gridHeight;
  }

  const W = cols * tileW;
  const H = rows * tileH;
  const padW = W + 2;
  const padH = H + 2;

  // ── 2. Allocate unified grids ──────────────────────────────────────────
  const sunnyGrid = new Float64Array(padW * padH);
  const shadowGrid = new Float64Array(padW * padH);
  const buildingsGrid = new Float64Array(padW * padH);
  // Validity = cell falls inside some tile. Used by the indoor-fill pass.
  const outdoorFlags = new Uint8Array(W * H); // 0 = indoor or absent, 1 = outdoor
  const validFlags = new Uint8Array(W * H); // 0 = absent (hole), 1 = covered

  // ── 3. Copy each tile's cells into the unified grid ────────────────────
  for (const tile of tiles) {
    const col = rankOf(tile.corners.nw.lon, uniqueLons, SORT_TOL);
    const row = rankOf(tile.corners.sw.lat, uniqueLats, SORT_TOL);
    if (col < 0 || row < 0) continue;
    // Per-tile dims may vary at edges; use min to stay safe.
    const tw = Math.min(tile.gridWidth, tileW);
    const th = Math.min(tile.gridHeight, tileH);

    for (let iy = 0; iy < th; iy++) {
      const unifiedY = row * tileH + iy;
      for (let ix = 0; ix < tw; ix++) {
        const unifiedX = col * tileW + ix;
        const cellIdx = iy * tile.gridWidth + ix;
        const isOutdoor = tile.outdoorMask ? bit(tile.outdoorMask, cellIdx) === 1 : true;
        const isSunny = isOutdoor && bit(tile.sunMask, cellIdx) === 1;
        const unifiedIdx = unifiedY * W + unifiedX;
        validFlags[unifiedIdx] = 1;
        outdoorFlags[unifiedIdx] = isOutdoor ? 1 : 0;
        const padIdx = (unifiedY + 1) * padW + (unifiedX + 1);
        if (isOutdoor) {
          sunnyGrid[padIdx] = isSunny ? 1 : 0;
          shadowGrid[padIdx] = isSunny ? 0 : 1;
        }
        buildingsGrid[padIdx] = isOutdoor ? 0 : 1;
      }
    }
  }

  // ── 4. Indoor-fill pass (cross-tile aware) ─────────────────────────────
  // Spread the nearest outdoor neighbor's sunny/shadow value into indoor
  // cells. Same idea as the per-tile path, but neighbors may now live in a
  // different source tile — that's the whole point.
  for (let uy = 0; uy < H; uy++) {
    for (let ux = 0; ux < W; ux++) {
      const idx = uy * W + ux;
      if (!validFlags[idx] || outdoorFlags[idx]) continue;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = ux + dx, ny = uy + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nIdx = ny * W + nx;
        if (!validFlags[nIdx] || !outdoorFlags[nIdx]) continue;
        const nPadIdx = (ny + 1) * padW + (nx + 1);
        const padIdx = (uy + 1) * padW + (ux + 1);
        sunnyGrid[padIdx] = sunnyGrid[nPadIdx];
        shadowGrid[padIdx] = shadowGrid[nPadIdx];
        break;
      }
    }
  }

  // ── 5. Marching-squares on the unified grid ────────────────────────────
  const contourGen = d3Contours().size([padW, padH]).thresholds([0.5]);
  const sunnyContours = contourGen(Array.from(sunnyGrid));
  const shadowContours = contourGen(Array.from(shadowGrid));
  const buildingContours = contourGen(Array.from(buildingsGrid));

  // ── 6. Pad-grid coords → lat/lon via the visible footprint's bbox ──────
  // Compute the actual union bbox by walking ALL four corners of every
  // tile. Previous attempts pulled lat/lon from the SAME corner-key across
  // tiles (e.g. all `sw`), which gave a synthetic point — wrong whenever
  // the visible set isn't a fully-filled rectangle.
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const t of tiles) {
    for (const key of ["nw", "ne", "sw", "se"] as const) {
      const c = t.corners[key];
      if (c.lat < minLat) minLat = c.lat;
      if (c.lat > maxLat) maxLat = c.lat;
      if (c.lon < minLon) minLon = c.lon;
      if (c.lon > maxLon) maxLon = c.lon;
    }
  }
  const sw = { lat: minLat, lon: minLon };
  const se = { lat: minLat, lon: maxLon };
  const nw = { lat: maxLat, lon: minLon };
  const ne = { lat: maxLat, lon: maxLon };

  const toLatLon = (fx: number, fy: number): [number, number] => {
    // fx in [0..W], fy in [0..H]; pad shift of -0.5 applied by caller.
    const tx = W > 0 ? fx / W : 0.5;
    const ty = H > 0 ? fy / H : 0.5;
    const lat = sw.lat * (1 - tx) * (1 - ty) + se.lat * tx * (1 - ty)
              + nw.lat * (1 - tx) * ty + ne.lat * tx * ty;
    const lon = sw.lon * (1 - tx) * (1 - ty) + se.lon * tx * (1 - ty)
              + nw.lon * (1 - tx) * ty + ne.lon * tx * ty;
    return [lat, lon];
  };

  const convert = (contour: { coordinates: number[][][][] }): Array<[number, number][][]> =>
    contour.coordinates.map((polygon) =>
      polygon.map((ring) =>
        ring.map((pt) => toLatLon(pt[0] - 0.5, pt[1] - 0.5))
      )
    );

  return {
    sunnyPolygons: sunnyContours.length > 0 ? convert(sunnyContours[0]) : [],
    shadowPolygons: shadowContours.length > 0 ? convert(shadowContours[0]) : [],
    buildingPolygons: buildingContours.length > 0 ? convert(buildingContours[0]) : [],
    stats: { totalCells: W * H, tileCount: tiles.length },
  };
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
];

function uniqueSorted(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > tol) {
      out.push(v);
    }
  }
  return out;
}

function rankOf(value: number, sorted: number[], tol: number): number {
  for (let i = 0; i < sorted.length; i++) {
    if (Math.abs(value - sorted[i]) <= tol) return i;
  }
  return -1;
}

