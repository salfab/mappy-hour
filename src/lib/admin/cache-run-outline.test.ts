import { describe, expect, it } from "vitest";

import { buildOutlineRingsFromTileIdsLv95 } from "@/lib/admin/cache-run-outline";

describe("buildOutlineRingsFromTileIdsLv95", () => {
  it("builds a single square ring for one tile", () => {
    const rings = buildOutlineRingsFromTileIdsLv95(["e100_n200_s10"]);

    expect(rings).toHaveLength(1);
    expect(rings[0]).toEqual([
      { easting: 100, northing: 200 },
      { easting: 110, northing: 200 },
      { easting: 110, northing: 210 },
      { easting: 100, northing: 210 },
      { easting: 100, northing: 200 },
    ]);
  });

  it("merges adjacent tiles into one rectangle ring", () => {
    const rings = buildOutlineRingsFromTileIdsLv95([
      "e0_n0_s10",
      "e10_n0_s10",
      "e20_n0_s10",
    ]);

    expect(rings).toHaveLength(1);
    expect(rings[0]).toEqual([
      { easting: 0, northing: 0 },
      { easting: 30, northing: 0 },
      { easting: 30, northing: 10 },
      { easting: 0, northing: 10 },
      { easting: 0, northing: 0 },
    ]);
  });

  it("builds a single L-shaped contour for an L selection", () => {
    const rings = buildOutlineRingsFromTileIdsLv95([
      "e0_n0_s10",
      "e10_n0_s10",
      "e0_n10_s10",
    ]);

    expect(rings).toHaveLength(1);
    expect(rings[0]).toEqual([
      { easting: 0, northing: 0 },
      { easting: 20, northing: 0 },
      { easting: 20, northing: 10 },
      { easting: 10, northing: 10 },
      { easting: 10, northing: 20 },
      { easting: 0, northing: 20 },
      { easting: 0, northing: 0 },
    ]);
  });

  it("returns disjoint rings for disjoint tile groups", () => {
    const rings = buildOutlineRingsFromTileIdsLv95([
      "e0_n0_s10",
      "e100_n100_s10",
    ]);

    expect(rings).toHaveLength(2);
    expect(rings[0]).toEqual([
      { easting: 0, northing: 0 },
      { easting: 10, northing: 0 },
      { easting: 10, northing: 10 },
      { easting: 0, northing: 10 },
      { easting: 0, northing: 0 },
    ]);
    expect(rings[1]).toEqual([
      { easting: 100, northing: 100 },
      { easting: 110, northing: 100 },
      { easting: 110, northing: 110 },
      { easting: 100, northing: 110 },
      { easting: 100, northing: 100 },
    ]);
  });

  it("returns outer and inner rings when a hole exists", () => {
    const tileIds: string[] = [];
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        if (x === 1 && y === 1) {
          continue;
        }
        tileIds.push(`e${x * 10}_n${y * 10}_s10`);
      }
    }

    const rings = buildOutlineRingsFromTileIdsLv95(tileIds);
    expect(rings).toHaveLength(2);
    const ringBounds = rings.map((ring) => {
      const eastings = ring.map((point) => point.easting);
      const northings = ring.map((point) => point.northing);
      return {
        minEasting: Math.min(...eastings),
        maxEasting: Math.max(...eastings),
        minNorthing: Math.min(...northings),
        maxNorthing: Math.max(...northings),
        points: ring.length,
      };
    });

    expect(ringBounds).toContainEqual({
      minEasting: 0,
      maxEasting: 30,
      minNorthing: 0,
      maxNorthing: 30,
      points: 5,
    });
    expect(ringBounds).toContainEqual({
      minEasting: 10,
      maxEasting: 20,
      minNorthing: 10,
      maxNorthing: 20,
      points: 5,
    });
  });
});
