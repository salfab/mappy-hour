import { describe, expect, it } from "vitest";

import { normalizeBuildingFootprint, polygonArea } from "@/lib/sun/building-footprint";

describe("normalizeBuildingFootprint", () => {
  it("keeps stable concave outlines", () => {
    const lShape = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];

    const normalized = normalizeBuildingFootprint(lShape);
    expect(normalized.footprint).toEqual(lShape);
    expect(normalized.usedConvexHullFallback).toBe(false);
  });

  it("replaces spiky star-like rings with convex hull", () => {
    const spiky = [
      { x: 0, y: 0 },
      { x: 3.6, y: 3.6 },
      { x: 8, y: 0.5 },
      { x: 4.2, y: 4.0 },
      { x: 12, y: 1 },
      { x: 4.8, y: 4.3 },
      { x: 11.5, y: 8 },
      { x: 5, y: 5 },
      { x: 12, y: 12 },
      { x: 4.4, y: 5.5 },
      { x: 1, y: 12 },
      { x: 4, y: 4.8 },
    ];

    const normalized = normalizeBuildingFootprint(spiky);
    expect(normalized.footprint).not.toBeNull();
    expect(normalized.usedConvexHullFallback).toBe(true);
    expect(normalized.footprint!.length).toBeLessThan(spiky.length);
    expect(polygonArea(normalized.footprint!)).toBeGreaterThan(polygonArea(spiky));
  });
});
