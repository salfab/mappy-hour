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
 * ## Layout
 *
 * Tile placement is **bbox-relative**, not rank-based: each tile's NW corner
 * is converted to a cell offset by `(lon - minLon) * cellsPerDegLon`. This
 * means a hole in the visible footprint (a missing tile in the middle)
 * leaves a literal gap in the unified grid, instead of compressing the
 * layout into a fully-packed grid where the surviving tiles end up at the
 * wrong lat/lon. The gap is then filled from any valid neighbor in the
 * indoor-fill pass so it doesn't produce artificial contour boundaries.
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

  // ── 1. Union bbox over ALL 4 corners of EVERY tile ─────────────────────
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
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  if (lonSpan <= 0 || latSpan <= 0) return empty;

  // ── 2. Cell density (cells per degree) from a representative tile ──────
  // All tiles share the same LV95 cell pitch in this project. We compute
  // density per-axis from the first valid tile and use it to size the
  // unified grid.
  const ref = tiles[0];
  const refLonSpan = Math.abs(ref.corners.ne.lon - ref.corners.nw.lon);
  const refLatSpan = Math.abs(ref.corners.nw.lat - ref.corners.sw.lat);
  if (refLonSpan <= 0 || refLatSpan <= 0) return empty;
  const cellsPerDegLon = ref.gridWidth / refLonSpan;
  const cellsPerDegLat = ref.gridHeight / refLatSpan;

  const W = Math.max(1, Math.round(lonSpan * cellsPerDegLon));
  const H = Math.max(1, Math.round(latSpan * cellsPerDegLat));
  const padW = W + 2;
  const padH = H + 2;

  // ── 3. Allocate unified grids ──────────────────────────────────────────
  const sunnyGrid = new Float64Array(padW * padH);
  const shadowGrid = new Float64Array(padW * padH);
  const buildingsGrid = new Float64Array(padW * padH);
  const outdoorFlags = new Uint8Array(W * H); // 1 = outdoor, 0 = indoor/absent
  const validFlags = new Uint8Array(W * H); // 1 = covered by a tile

  // ── 4. Place each tile by bbox-relative offset ────────────────────────
  // Holes in the visible footprint stay as un-flagged cells, which the
  // gap-fill pass below resolves before marching-squares runs.
  for (const tile of tiles) {
    const startX = Math.round((tile.corners.nw.lon - minLon) * cellsPerDegLon);
    const startY = Math.round((tile.corners.sw.lat - minLat) * cellsPerDegLat);

    for (let iy = 0; iy < tile.gridHeight; iy++) {
      const unifiedY = startY + iy;
      if (unifiedY < 0 || unifiedY >= H) continue;
      for (let ix = 0; ix < tile.gridWidth; ix++) {
        const unifiedX = startX + ix;
        if (unifiedX < 0 || unifiedX >= W) continue;
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

  // ── 5. Fill indoor cells AND gap cells from valid outdoor neighbors ────
  // A two-pass BFS-lite: cells that are (indoor) or (absent) inherit their
  // nearest valid-outdoor neighbor's sunny/shadow value. Without this, the
  // 0-init contour at the gap/indoor boundary produces artificial polygons
  // and the result looks like scattered fragments — same root cause as the
  // earlier 0-padding seam at tile borders.
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const idx = iy * W + ix;
      if (validFlags[idx] && outdoorFlags[idx]) continue;
      // Search neighbors for a valid outdoor source.
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = ix + dx, ny = iy + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nIdx = ny * W + nx;
        if (!validFlags[nIdx] || !outdoorFlags[nIdx]) continue;
        const nPadIdx = (ny + 1) * padW + (nx + 1);
        const padIdx = (iy + 1) * padW + (ix + 1);
        sunnyGrid[padIdx] = sunnyGrid[nPadIdx];
        shadowGrid[padIdx] = shadowGrid[nPadIdx];
        // Note: buildings grid stays as the per-cell indoor/outdoor decision
        // for actually-valid cells. Gaps (validFlags=0) inherit 0 by default,
        // which means buildings are NOT drawn through gaps — preferable to
        // an artificial "everything-is-a-building" stripe.
        break;
      }
    }
  }

  // ── 6. Marching-squares on the unified grid ────────────────────────────
  const contourGen = d3Contours().size([padW, padH]).thresholds([0.5]);
  const sunnyContours = contourGen(Array.from(sunnyGrid));
  const shadowContours = contourGen(Array.from(shadowGrid));
  const buildingContours = contourGen(Array.from(buildingsGrid));

  // ── 7. Pad-grid coords → lat/lon ───────────────────────────────────────
  // Bbox-relative bilinear. By construction, cell (x, y) corresponds to
  // (minLon + x/W * lonSpan, minLat + y/H * latSpan). The pad shift of -0.5
  // applied by `convert` keeps the contour vertices aligned with cell
  // boundaries (same convention as the per-tile pipeline).
  const toLatLon = (fx: number, fy: number): [number, number] => {
    const lat = minLat + (fy / H) * latSpan;
    const lon = minLon + (fx / W) * lonSpan;
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
