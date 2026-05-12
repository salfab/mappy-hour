import { describe, expect, it } from "vitest";

import { selectRenderStrategy, shouldRerasterize } from "./render-strategy";

const baseInput = {
  devicePixelRatio: 1,
  tileSizeMeters: 250,
  tileNativeSizePx: 250,
};

describe("selectRenderStrategy", () => {
  it("first call (previousMode=null) at low zoom → bitmap", () => {
    const result = selectRenderStrategy({
      ...baseInput,
      zoom: 14,
      visibleTileCount: 30,
      previousMode: null,
    });
    expect(result.mode).toBe("bitmap");
  });

  it("first call at high zoom + few tiles → vector", () => {
    const result = selectRenderStrategy({
      ...baseInput,
      zoom: 20,
      visibleTileCount: 4,
      previousMode: null,
    });
    expect(result.mode).toBe("vector");
  });

  it("entry threshold: vector enters at zoom >= 19 AND tiles <= 8", () => {
    const justInside = selectRenderStrategy({
      ...baseInput,
      zoom: 19,
      visibleTileCount: 8,
      previousMode: "bitmap",
    });
    expect(justInside.mode).toBe("vector");

    const justZoomOutside = selectRenderStrategy({
      ...baseInput,
      zoom: 18.9,
      visibleTileCount: 8,
      previousMode: "bitmap",
    });
    expect(justZoomOutside.mode).toBe("bitmap");

    const justTilesOutside = selectRenderStrategy({
      ...baseInput,
      zoom: 19,
      visibleTileCount: 9,
      previousMode: "bitmap",
    });
    expect(justTilesOutside.mode).toBe("bitmap");
  });

  it("hysteresis: vector stays vector at zoom 18.9 / 9 tiles (between entry and exit)", () => {
    // Down to 18.9 from 19 — not yet < 18.5 EXIT threshold → stay vector
    const stayZoom = selectRenderStrategy({
      ...baseInput,
      zoom: 18.9,
      visibleTileCount: 5,
      previousMode: "vector",
    });
    expect(stayZoom.mode).toBe("vector");

    // Up to 9 tiles from 8 — not yet > 9 EXIT → stay vector
    const stayTiles = selectRenderStrategy({
      ...baseInput,
      zoom: 19.5,
      visibleTileCount: 9,
      previousMode: "vector",
    });
    expect(stayTiles.mode).toBe("vector");
  });

  it("exit thresholds: vector → bitmap at zoom < 18.5 OR tiles > 9", () => {
    const exitZoom = selectRenderStrategy({
      ...baseInput,
      zoom: 18.4,
      visibleTileCount: 5,
      previousMode: "vector",
    });
    expect(exitZoom.mode).toBe("bitmap");

    const exitTiles = selectRenderStrategy({
      ...baseInput,
      zoom: 19.5,
      visibleTileCount: 10,
      previousMode: "vector",
    });
    expect(exitTiles.mode).toBe("bitmap");
  });

  it("DPR is clamped at 2 (no RAM explosion on 3x screens)", () => {
    const dpr3 = selectRenderStrategy({
      ...baseInput,
      zoom: 18,
      visibleTileCount: 4,
      devicePixelRatio: 3,
      previousMode: null,
    });
    const dpr2 = selectRenderStrategy({
      ...baseInput,
      zoom: 18,
      visibleTileCount: 4,
      devicePixelRatio: 2,
      previousMode: null,
    });
    expect(dpr3.bitmapResolution).toBe(dpr2.bitmapResolution);
  });

  it("bitmapResolution is monotonic in zoom (higher zoom → ≥ resolution)", () => {
    const lowZoom = selectRenderStrategy({
      ...baseInput,
      zoom: 14,
      visibleTileCount: 30,
      previousMode: null,
    });
    const highZoom = selectRenderStrategy({
      ...baseInput,
      zoom: 18,
      visibleTileCount: 30,
      previousMode: null,
    });
    expect(highZoom.bitmapResolution).toBeGreaterThanOrEqual(lowZoom.bitmapResolution);
  });

  it("bitmapResolution is capped at tileNativeSizePx (no upsampling)", () => {
    const veryHighZoom = selectRenderStrategy({
      ...baseInput,
      zoom: 22, // px_per_m huge
      visibleTileCount: 1,
      previousMode: null,
    });
    expect(veryHighZoom.bitmapResolution).toBeLessThanOrEqual(baseInput.tileNativeSizePx);
  });

  it("bitmapResolution is floored at 8 (always readable)", () => {
    const microZoom = selectRenderStrategy({
      ...baseInput,
      zoom: 5,
      visibleTileCount: 1,
      previousMode: null,
    });
    expect(microZoom.bitmapResolution).toBeGreaterThanOrEqual(8);
  });
});

describe("shouldRerasterize", () => {
  it("returns true on first paint (currentResolution=0)", () => {
    expect(shouldRerasterize(0, 100)).toBe(true);
  });

  it("returns false when within ±50% band", () => {
    expect(shouldRerasterize(100, 100)).toBe(false);
    expect(shouldRerasterize(100, 60)).toBe(false);
    expect(shouldRerasterize(100, 140)).toBe(false);
  });

  it("returns true when zoom-in made target >1.5× larger", () => {
    expect(shouldRerasterize(100, 160)).toBe(true);
  });

  it("returns true when zoom-out made target <0.5× smaller", () => {
    expect(shouldRerasterize(100, 40)).toBe(true);
  });
});
