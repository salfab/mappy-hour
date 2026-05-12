import { describe, expect, it } from "vitest";

import { buildUnifiedViewportContours, type VisibleTileInput } from "./unified-viewport-contours";

function packBits(values: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) {
    if (values[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

/** Build a synthetic 2×2 grid of tiles, each `gridW × gridH`. Pixel data
 *  comes from `pattern` — a function of unified-grid (ux, uy) → 1 (sunny)
 *  or 0 (shadow). `outdoorPattern` controls indoor cells (default all
 *  outdoor). */
function makeTiles({
  gridW,
  gridH,
  cols,
  rows,
  pattern,
  outdoorPattern,
  baseLat = 46.5,
  baseLon = 6.6,
  step = 0.01,
}: {
  gridW: number;
  gridH: number;
  cols: number;
  rows: number;
  pattern: (ux: number, uy: number) => number;
  outdoorPattern?: (ux: number, uy: number) => number;
  baseLat?: number;
  baseLon?: number;
  step?: number;
}): VisibleTileInput[] {
  const tiles: VisibleTileInput[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const swLat = baseLat + row * step;
      const swLon = baseLon + col * step;
      const sunBits: number[] = [];
      const outBits: number[] = [];
      for (let iy = 0; iy < gridH; iy++) {
        for (let ix = 0; ix < gridW; ix++) {
          const ux = col * gridW + ix;
          const uy = row * gridH + iy;
          sunBits.push(pattern(ux, uy));
          outBits.push(outdoorPattern ? outdoorPattern(ux, uy) : 1);
        }
      }
      tiles.push({
        tileId: `${col}-${row}`,
        corners: {
          sw: { lat: swLat, lon: swLon },
          se: { lat: swLat, lon: swLon + step },
          nw: { lat: swLat + step, lon: swLon },
          ne: { lat: swLat + step, lon: swLon + step },
        },
        gridWidth: gridW,
        gridHeight: gridH,
        sunMask: packBits(sunBits),
        outdoorMask: outdoorPattern ? packBits(outBits) : undefined,
      });
    }
  }
  return tiles;
}

describe("buildUnifiedViewportContours", () => {
  it("returns empty when no tiles", () => {
    const out = buildUnifiedViewportContours([]);
    expect(out.sunnyPolygons).toEqual([]);
    expect(out.shadowPolygons).toEqual([]);
    expect(out.stats.tileCount).toBe(0);
  });

  it("computes a single sunny region spanning a 2×2 tile grid (cross-tile continuity)", () => {
    // All cells sunny ⇒ one big sunny polygon, no shadow.
    const tiles = makeTiles({
      gridW: 4, gridH: 4, cols: 2, rows: 2,
      pattern: () => 1,
    });
    const out = buildUnifiedViewportContours(tiles);
    expect(out.sunnyPolygons.length).toBeGreaterThan(0);
    expect(out.shadowPolygons.length).toBe(0);
    expect(out.stats.totalCells).toBe(8 * 8);
    expect(out.stats.tileCount).toBe(4);
  });

  it("emits ONE shadow polygon for a region that straddles the tile boundary", () => {
    // Sunny everywhere except a 2×8 strip in unified columns 3..4 (the
    // tile seam in a 2×1 layout of 4-wide tiles). If the algorithm clips
    // per-tile, we'd get 2 polygons of width 1 each; unified should give 1.
    const tiles = makeTiles({
      gridW: 4, gridH: 4, cols: 2, rows: 1,
      pattern: (ux) => (ux === 3 || ux === 4 ? 0 : 1),
    });
    const out = buildUnifiedViewportContours(tiles);
    expect(out.shadowPolygons.length).toBe(1);
    // The shadow polygon must contain vertices on BOTH sides of the seam
    // (lon < boundary AND lon > boundary).
    const seamLon = tiles[0].corners.ne.lon;
    const ring = out.shadowPolygons[0][0];
    const lons = ring.map(([, lon]) => lon);
    expect(Math.min(...lons)).toBeLessThan(seamLon);
    expect(Math.max(...lons)).toBeGreaterThan(seamLon);
  });

  it("indoor cells inherit nearest outdoor neighbor's value across tile boundary", () => {
    // Outdoor cells form a sunny strip; an indoor block straddles the seam
    // and should NOT introduce a shadow contour through the buildings.
    const tiles = makeTiles({
      gridW: 4, gridH: 4, cols: 2, rows: 1,
      pattern: () => 1,
      // Indoor in unified cols 3..4 (the seam).
      outdoorPattern: (ux) => (ux === 3 || ux === 4 ? 0 : 1),
    });
    const out = buildUnifiedViewportContours(tiles);
    // All outdoor cells sunny → no shadow polygon (indoor cells were filled
    // from sunny neighbors).
    expect(out.shadowPolygons.length).toBe(0);
    expect(out.sunnyPolygons.length).toBeGreaterThan(0);
    // Building footprint should be present (one polygon for the indoor block).
    expect(out.buildingPolygons.length).toBe(1);
  });
});
