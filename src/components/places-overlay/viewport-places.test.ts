import { describe, expect, it } from "vitest";

import {
  applyHardLimit,
  clusterPoints,
  filterPlacesInBounds,
  pickLod,
  type NormalizedPlaceLite,
  type ViewportClusterPoint,
} from "./viewport-places";

function makePlace(
  id: string,
  lat: number,
  lon: number,
  overrides: Partial<NormalizedPlaceLite> = {},
): NormalizedPlaceLite {
  return {
    id,
    name: id,
    category: "terrace_candidate",
    subcategory: "cafe",
    lat,
    lon,
    hasOutdoorSeating: false,
    ...overrides,
  };
}

describe("pickLod", () => {
  it("buckets zooms into L0 / L1 / L2", () => {
    expect(pickLod(8)).toBe("L0");
    expect(pickLod(12)).toBe("L0");
    expect(pickLod(13)).toBe("L1");
    expect(pickLod(15)).toBe("L1");
    expect(pickLod(16)).toBe("L2");
    expect(pickLod(19)).toBe("L2");
  });
});

describe("filterPlacesInBounds", () => {
  it("keeps only places inside the lat/lon rectangle", () => {
    const places = [
      makePlace("a", 46.5, 6.6),
      makePlace("b", 46.5, 6.65), // east of east edge
      makePlace("c", 46.45, 6.6),
      makePlace("d", 46.7, 6.6), // north of north edge
    ];
    const kept = filterPlacesInBounds(places, {
      south: 46.4,
      west: 6.55,
      north: 46.6,
      east: 6.62,
    });
    expect(kept.map((p) => p.id)).toEqual(["a", "c"]);
  });
});

describe("clusterPoints", () => {
  // Identity projection — 1° = 1000px. Cell size 100px = 0.1°.
  const project = (lat: number, lon: number) => ({ x: lon * 1000, y: lat * 1000 });

  it("emits singles when cell size is 0 (L2 fast path)", () => {
    const places = [makePlace("a", 0, 0), makePlace("b", 0, 0.01)];
    const out = clusterPoints(places, 0, project);
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.kind === "single")).toBe(true);
  });

  it("collapses places sharing a cell into one cluster with the centroid", () => {
    const places = [
      makePlace("a", 0, 0),
      makePlace("b", 0.02, 0.02), // same 100px cell
      makePlace("c", 0.5, 0.5), // far away, own cell
    ];
    const out = clusterPoints(places, 100, project);
    const clusters = out.filter((p) => p.kind === "cluster");
    const singles = out.filter((p) => p.kind === "single");
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].lat).toBeCloseTo(0.01, 4);
    expect(clusters[0].lon).toBeCloseTo(0.01, 4);
    expect(singles).toHaveLength(1);
    expect(singles[0].place?.id).toBe("c");
  });

  it("emits stable keys (no collision between same-cell clusters & singles)", () => {
    const places = [makePlace("a", 0, 0), makePlace("b", 0.02, 0.02)];
    const out = clusterPoints(places, 100, project);
    const keys = new Set(out.map((p) => p.key));
    expect(keys.size).toBe(out.length);
  });
});

describe("applyHardLimit", () => {
  function singleOf(id: string, confirmed: boolean): ViewportClusterPoint {
    return {
      kind: "single",
      lat: 0,
      lon: 0,
      key: id,
      place: { ...makePlace(id, 0, 0), hasOutdoorSeating: confirmed },
    };
  }
  function clusterOf(id: string, count: number): ViewportClusterPoint {
    return { kind: "cluster", lat: 0, lon: 0, key: id, count, places: [] };
  }

  it("returns input unchanged when under the limit", () => {
    const points = [singleOf("a", false), singleOf("b", false)];
    expect(applyHardLimit(points, 10)).toBe(points);
  });

  it("preserves all clusters then confirmed-terrace singles, then fills rest", () => {
    const points: ViewportClusterPoint[] = [
      clusterOf("c1", 5),
      singleOf("u1", false), // unknown
      singleOf("y1", true), // confirmed yes
      singleOf("u2", false),
      singleOf("y2", true),
      singleOf("u3", false),
    ];
    const limit = 4;
    const kept = applyHardLimit(points, limit);
    expect(kept).toHaveLength(limit);
    // Cluster + both confirmed must be present.
    expect(kept.find((p) => p.key === "c1")).toBeDefined();
    expect(kept.find((p) => p.key === "y1")).toBeDefined();
    expect(kept.find((p) => p.key === "y2")).toBeDefined();
  });
});
