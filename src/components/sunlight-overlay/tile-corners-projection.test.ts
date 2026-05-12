import { describe, expect, it, vi } from "vitest";

import {
  cornersToMatrix,
  formatCSSMatrix,
  type MapLike,
  type TileCornersLatLon,
} from "./tile-corners-projection";

/** Build a fake Leaflet map whose `latLngToLayerPoint` returns the values
 *  prescribed by `cornerToPoint` — a simple lookup keyed on lat,lon. */
function makeMockMap(
  cornerToPoint: (lat: number, lon: number) => { x: number; y: number },
): MapLike {
  return {
    latLngToLayerPoint: vi.fn((latlng: unknown) => {
      const arr = latlng as [number, number];
      return cornerToPoint(arr[0], arr[1]);
    }),
  };
}

const SAMPLE_CORNERS: TileCornersLatLon = {
  nw: { lat: 46.51, lon: 6.62 },
  ne: { lat: 46.51, lon: 6.625 },
  sw: { lat: 46.505, lon: 6.62 },
  se: { lat: 46.505, lon: 6.625 },
};

describe("cornersToMatrix", () => {
  it("maps a unit-square canvas to the 3 prescribed screen points (axis-aligned)", () => {
    // Pretend the screen-space corners are an axis-aligned 100×80 rectangle.
    const pointFor = (lat: number, lon: number): { x: number; y: number } => {
      // nw=(46.51,6.62)→(10,20), ne=(46.51,6.625)→(110,20), sw=(46.505,6.62)→(10,100)
      const isNorth = lat > 46.5075;
      const isWest = lon < 6.6225;
      const x = isWest ? 10 : 110;
      const y = isNorth ? 20 : 100;
      return { x, y };
    };
    const map = makeMockMap(pointFor);
    const m = cornersToMatrix(SAMPLE_CORNERS, 1, 1, map);

    // x' = a*x + c*y + e — at (0,0): expect nw=(10,20). At (1,0): ne=(110,20).
    // At (0,1): sw=(10,100).
    expect(m.e).toBe(10);
    expect(m.f).toBe(20);
    expect(m.a).toBe(100); // (110-10)/1
    expect(m.b).toBe(0); // ne.y - nw.y = 0
    expect(m.c).toBe(0); // sw.x - nw.x = 0
    expect(m.d).toBe(80); // (100-20)/1
  });

  it("scales the matrix by canvasWidth and canvasHeight", () => {
    const pointFor = (lat: number, lon: number): { x: number; y: number } => {
      const isNorth = lat > 46.5075;
      const isWest = lon < 6.6225;
      return { x: isWest ? 0 : 200, y: isNorth ? 0 : 160 };
    };
    const map = makeMockMap(pointFor);

    // For a 100×80 canvas, the per-pixel step should be (200/100, 160/80) = (2,2).
    const m = cornersToMatrix(SAMPLE_CORNERS, 100, 80, map);
    expect(m.a).toBe(2);
    expect(m.d).toBe(2);
    expect(m.b).toBe(0);
    expect(m.c).toBe(0);
    expect(m.e).toBe(0);
    expect(m.f).toBe(0);

    // Sanity: applying the matrix to canvas (100, 80) recovers SE=(200,160).
    const xPrime = m.a * 100 + m.c * 80 + m.e;
    const yPrime = m.b * 100 + m.d * 80 + m.f;
    expect(xPrime).toBe(200);
    expect(yPrime).toBe(160);
  });

  it("handles a rotated quad (non-zero b and c off-diagonals)", () => {
    // 45° rotation around origin: nw→(0,0), ne→(7,7), sw→(-7,7).
    // canvas 7×7. So a=(7-0)/7=1, b=(7-0)/7=1, c=(-7-0)/7=-1, d=(7-0)/7=1.
    const pointFor = (lat: number, lon: number): { x: number; y: number } => {
      const isNorth = lat > 46.5075;
      const isWest = lon < 6.6225;
      if (isNorth && isWest) return { x: 0, y: 0 };
      if (isNorth && !isWest) return { x: 7, y: 7 };
      if (!isNorth && isWest) return { x: -7, y: 7 };
      return { x: 0, y: 14 };
    };
    const map = makeMockMap(pointFor);
    const m = cornersToMatrix(SAMPLE_CORNERS, 7, 7, map);
    expect(m.a).toBe(1);
    expect(m.b).toBe(1);
    expect(m.c).toBe(-1);
    expect(m.d).toBe(1);
    expect(m.e).toBe(0);
    expect(m.f).toBe(0);
  });

  it("rejects non-positive canvas dimensions", () => {
    const map = makeMockMap(() => ({ x: 0, y: 0 }));
    expect(() => cornersToMatrix(SAMPLE_CORNERS, 0, 10, map)).toThrow();
    expect(() => cornersToMatrix(SAMPLE_CORNERS, 10, -5, map)).toThrow();
  });
});

describe("formatCSSMatrix", () => {
  it("emits the standard `matrix(a,b,c,d,e,f)` string", () => {
    expect(
      formatCSSMatrix({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }),
    ).toBe("matrix(1,2,3,4,5,6)");
  });
});
