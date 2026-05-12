/**
 * Pure projection of the 4 geographic corners of a tile to a CSS `matrix()`
 * transform that positions a `canvasWidth × canvasHeight` bitmap onto the
 * Leaflet overlayPane.
 *
 * The returned matrix maps canvas pixel coordinates to layer-point screen
 * coordinates so that:
 *
 *     canvas (0,           0)          → NW corner
 *     canvas (canvasWidth, 0)          → NE corner
 *     canvas (0,           canvasHeight) → SW corner
 *     canvas (canvasWidth, canvasHeight) → SE corner (implicit, affine)
 *
 * ## What this module does NOT do (deferred to Phase 2)
 *
 *  - It does NOT touch the DOM. The caller applies the matrix via CSS:
 *      element.style.transform = `matrix(${a},${b},${c},${d},${e},${f})`;
 *  - It does NOT subscribe to map events. The caller invokes it again
 *    on every `move`/`zoom` to refresh the transform.
 *  - It does NOT validate that the 4 corners form a non-degenerate quad.
 *    The Leaflet `latLngToLayerPoint` projection is treated as linear
 *    enough at tile scale (250m) that an affine matrix derived from 3
 *    corners (NW, NE, SW) is sufficient — SE is implied. This matches
 *    the legacy code in sunlight-map-client.tsx (lines ~3550-3590).
 *
 * ## Pixel convention reminder (Phase 0 — frozen 2026-05-12)
 *
 * The 4 corners are TILE EDGES, not cell centers. No `-0.5` half-cell shift
 * is applied here either — consistent with `paint-tile.ts`.
 */

import type { Map as LeafletMap, LatLngExpression, Point } from "leaflet";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface TileCornersLatLon {
  nw: LatLon;
  ne: LatLon;
  sw: LatLon;
  /** Kept on the interface for symmetry / future bilinear support, but
   *  currently unused: an affine matrix is over-determined by 4 points. */
  se: LatLon;
}

/** CSS `matrix(a,b,c,d,e,f)` — column-vector convention:
 *      x' = a·x + c·y + e
 *      y' = b·x + d·y + f
 */
export interface CSSMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Minimal subset of Leaflet's `Map` API we actually need. Declared as a
 *  type-only dependency so tests can pass a hand-rolled stub without
 *  importing Leaflet itself (which requires `window`). */
export interface MapLike {
  latLngToLayerPoint(latlng: LatLngExpression): Point | { x: number; y: number };
}

export function cornersToMatrix(
  corners: TileCornersLatLon,
  canvasWidth: number,
  canvasHeight: number,
  map: MapLike | LeafletMap,
): CSSMatrix {
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error(
      `cornersToMatrix: invalid canvas size ${canvasWidth}×${canvasHeight}`,
    );
  }

  const m = map as MapLike;
  const nw = m.latLngToLayerPoint([corners.nw.lat, corners.nw.lon]);
  const ne = m.latLngToLayerPoint([corners.ne.lat, corners.ne.lon]);
  const sw = m.latLngToLayerPoint([corners.sw.lat, corners.sw.lon]);

  // CSS matrix(a,b,c,d,e,f): x' = a*x + c*y + e ; y' = b*x + d*y + f
  // We need:
  //   (0, 0)             ↦ nw   ⇒ e = nw.x, f = nw.y
  //   (canvasWidth, 0)   ↦ ne   ⇒ a = (ne.x - nw.x) / W, b = (ne.y - nw.y) / W
  //   (0, canvasHeight)  ↦ sw   ⇒ c = (sw.x - nw.x) / H, d = (sw.y - nw.y) / H
  return {
    a: (ne.x - nw.x) / canvasWidth,
    b: (ne.y - nw.y) / canvasWidth,
    c: (sw.x - nw.x) / canvasHeight,
    d: (sw.y - nw.y) / canvasHeight,
    e: nw.x,
    f: nw.y,
  };
}

/** Serialize a `CSSMatrix` to the string accepted by `element.style.transform`. */
export function formatCSSMatrix(m: CSSMatrix): string {
  return `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
}
