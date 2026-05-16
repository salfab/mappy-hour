import { describe, expect, it } from "vitest";

import { isInSupportedRegion } from "@/lib/geo/geolocation";
import { findContainingPrecomputedRegion } from "@/lib/precompute/sunlight-cache";

describe("findContainingPrecomputedRegion", () => {
  it("returns the matching region for a point inside the Lausanne bbox", () => {
    // Place de la Riponne, downtown Lausanne.
    expect(findContainingPrecomputedRegion(46.522, 6.633)).toBe("lausanne");
  });

  it("returns the matching region for a point inside the Zurich bbox", () => {
    // Zurich Hauptbahnhof.
    expect(findContainingPrecomputedRegion(47.378, 8.540)).toBe("zurich");
  });

  it("returns null for a point clearly outside every supported region", () => {
    // Paris.
    expect(findContainingPrecomputedRegion(48.857, 2.352)).toBeNull();
  });

  it("returns null at high latitudes", () => {
    // North pole.
    expect(findContainingPrecomputedRegion(90, 0)).toBeNull();
  });
});

describe("isInSupportedRegion", () => {
  it("is true for an in-region point", () => {
    expect(isInSupportedRegion(46.522, 6.633)).toBe(true);
  });

  it("is false for a far-out point", () => {
    expect(isInSupportedRegion(0, 0)).toBe(false);
  });
});
