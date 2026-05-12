/**
 * Position-precision test for two adjacent bitmap tiles.
 *
 * Phase 2 swaps the per-tile canvas overlay from inline DOM code in
 * `sunlight-map-client.tsx` to the `BitmapTileOverlay` wrapper. Each tile has
 * its own CSS `matrix()` transform computed from its 4 geographic corners.
 *
 * The risk: if `cornersToMatrix` doesn't produce truly affine, edge-coincident
 * matrices for tiles that share a geographic edge, the user sees a 1-pixel
 * crack (or overlap) between tiles. This test checks that the shared-edge
 * screen coordinates produced by tile A's right edge and tile B's left edge
 * are byte-exact equal (up to floating-point error).
 *
 * ## Why sub-pixel tolerance?
 *
 * The two matrices use the SAME `latLngToLayerPoint(corners.ne)` value (for A)
 * and `latLngToLayerPoint(corners.nw)` (for B). When A.ne === B.nw exactly,
 * these calls return the same x/y. The matrices then map:
 *
 *   A: canvas (W, 0) → (a·W + c·0 + e, b·W + d·0 + f) = (a·W + e, b·W + f)
 *      with a = (ne.x - nw.x) / W and e = nw.x → a·W + e = ne.x ✓
 *
 *   B: canvas (0, 0) → (e, f) = (nw.x, nw.y) = (ne_of_A.x, ne_of_A.y) ✓
 *
 * So the screen coords MUST be bitwise equal — no FP error at all. The
 * threshold here (1e-9) is a safety margin against compiler reordering.
 */

import { describe, expect, it } from "vitest";

import {
  cornersToMatrix,
  type MapLike,
  type TileCornersLatLon,
} from "./tile-corners-projection";

/**
 * Deterministic mock Leaflet map. Equirectangular projection scaled to a
 * reasonable pixel range. Pure function — no internal state, no DPI tricks.
 */
const FAKE_MAP: MapLike = {
  latLngToLayerPoint: (latlng) => {
    const arr = latlng as [number, number];
    const lat = arr[0];
    const lon = arr[1];
    // Project to screen: x grows east, y grows south.
    // 100000 px per degree keeps the math in a familiar range and matches
    // the "few-hundred-px per 250m tile" Leaflet operating point.
    return { x: lon * 100000, y: -lat * 100000 };
  },
};

function applyMatrix(
  m: { a: number; b: number; c: number; d: number; e: number; f: number },
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

describe("adjacent tile alignment — shared edges project to identical screen pixels", () => {
  it("A.right === B.left at both endpoints (NE/SE share), to within 1e-9", () => {
    // Two horizontally adjacent tiles. A is the western tile, B the eastern.
    // A.ne === B.nw and A.se === B.sw in lat/lon.
    const sharedTopLat = 46.510;
    const sharedTopLonAB = 6.6225; // A.ne === B.nw
    const sharedBotLat = 46.505;
    const sharedBotLonAB = 6.6225; // A.se === B.sw

    const A: TileCornersLatLon = {
      nw: { lat: 46.510, lon: 6.620 },
      ne: { lat: sharedTopLat, lon: sharedTopLonAB },
      sw: { lat: 46.505, lon: 6.620 },
      se: { lat: sharedBotLat, lon: sharedBotLonAB },
    };
    const B: TileCornersLatLon = {
      nw: { lat: sharedTopLat, lon: sharedTopLonAB },
      ne: { lat: 46.510, lon: 6.625 },
      sw: { lat: sharedBotLat, lon: sharedBotLonAB },
      se: { lat: 46.505, lon: 6.625 },
    };

    const W = 250; // logical canvas pixels per tile side
    const H = 250;
    const mA = cornersToMatrix(A, W, H, FAKE_MAP);
    const mB = cornersToMatrix(B, W, H, FAKE_MAP);

    // Project A's right edge endpoints: canvas (W, 0) and (W, H).
    const aTopRight = applyMatrix(mA, W, 0);
    const aBotRight = applyMatrix(mA, W, H);
    // Project B's left edge endpoints: canvas (0, 0) and (0, H).
    const bTopLeft = applyMatrix(mB, 0, 0);
    const bBotLeft = applyMatrix(mB, 0, H);

    // Sub-pixel threshold: 1e-9 px is overkill (the math is structurally
    // exact) but guards against compiler reordering of the FMA chain.
    const EPS = 1e-9;
    expect(Math.abs(aTopRight.x - bTopLeft.x)).toBeLessThan(EPS);
    expect(Math.abs(aTopRight.y - bTopLeft.y)).toBeLessThan(EPS);
    expect(Math.abs(aBotRight.x - bBotLeft.x)).toBeLessThan(EPS);
    expect(Math.abs(aBotRight.y - bBotLeft.y)).toBeLessThan(EPS);
  });

  it("interior shared-edge points coincide for axis-aligned rectangular tiles", () => {
    // Because `cornersToMatrix` derives an affine matrix from 3 of the 4
    // corners (NW, NE, SW), perfect edge-coincidence only holds when A and B
    // form a TRUE PARALLELOGRAM on the shared edge — i.e. A's right edge
    // (NE → SE) is identical to B's left edge (NW → SW) AND the two `latLng-
    // ToLayerPoint` calls return points on the same straight line.
    //
    // For Leaflet's CRS at tile scale (~250m), and for our equirectangular
    // mock here, axis-aligned rectangular tiles satisfy this. Slanted /
    // rotated quads would expose the affine-vs-perspective gap (and we don't
    // support that — see the documented "affine is sufficient at tile scale"
    // shortcut in tile-corners-projection.ts header).
    const A: TileCornersLatLon = {
      nw: { lat: 46.510, lon: 6.620 },
      ne: { lat: 46.510, lon: 6.6225 },
      sw: { lat: 46.505, lon: 6.620 },
      se: { lat: 46.505, lon: 6.6225 },
    };
    const B: TileCornersLatLon = {
      nw: { lat: 46.510, lon: 6.6225 },
      ne: { lat: 46.510, lon: 6.625 },
      sw: { lat: 46.505, lon: 6.6225 },
      se: { lat: 46.505, lon: 6.625 },
    };

    const W = 250;
    const H = 250;
    const mA = cornersToMatrix(A, W, H, FAKE_MAP);
    const mB = cornersToMatrix(B, W, H, FAKE_MAP);

    // Walk 5 interior points along the shared edge.
    for (let i = 1; i < 5; i++) {
      const y = (i / 5) * H;
      const aRight = applyMatrix(mA, W, y);
      const bLeft = applyMatrix(mB, 0, y);
      expect(Math.abs(aRight.x - bLeft.x)).toBeLessThan(1e-9);
      expect(Math.abs(aRight.y - bLeft.y)).toBeLessThan(1e-9);
    }
  });
});
