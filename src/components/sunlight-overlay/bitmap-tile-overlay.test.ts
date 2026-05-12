import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BitmapTileOverlay } from "./bitmap-tile-overlay";
import type { MapLike, TileCornersLatLon } from "./tile-corners-projection";

// ──────────────────────────────────────────────────────────────────────────────
// Minimal DOM stub. The project's vitest config uses `environment: "node"` and
// no jsdom/happy-dom is installed (spec forbids adding new deps). We hand-roll
// just enough of the `document.createElement("canvas")` + parent/child surface
// that `BitmapTileOverlay` exercises. Real-browser semantics for
// `putImageData` are out of scope here — we spy on the method.
// ──────────────────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  children: FakeElement[];
  parentNode: FakeElement | null;
  style: Record<string, string>;
  dataset: Record<string, string>;
  width: number;
  height: number;
  appendChild(child: FakeElement): FakeElement;
  removeChild(child: FakeElement): FakeElement;
  getContext(type: string): unknown;
}

function makeFakeElement(tagName: string): FakeElement {
  const ctxSpy = {
    putImageData: vi.fn(),
  };
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    width: 0,
    height: 0,
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx >= 0) el.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    getContext(type: string) {
      return type === "2d" ? ctxSpy : null;
    },
  };
  return el;
}

const CORNERS: TileCornersLatLon = {
  nw: { lat: 46.51, lon: 6.62 },
  ne: { lat: 46.51, lon: 6.625 },
  sw: { lat: 46.505, lon: 6.62 },
  se: { lat: 46.505, lon: 6.625 },
};

const FAKE_MAP: MapLike = {
  latLngToLayerPoint: (latlng) => {
    const arr = latlng as [number, number];
    // Trivial projection: just scale lat/lon so we get distinct points.
    return { x: arr[1] * 1000, y: -arr[0] * 1000 };
  },
};

let originalDocument: unknown;

beforeEach(() => {
  originalDocument = (globalThis as unknown as { document?: unknown }).document;
  (globalThis as unknown as { document: { createElement: (t: string) => FakeElement } }).document = {
    createElement: (tag: string) => makeFakeElement(tag),
  };
});

afterEach(() => {
  (globalThis as unknown as { document: unknown }).document = originalDocument;
});

describe("BitmapTileOverlay", () => {
  it("creates a canvas, sizes it (DPR-scaled physical, CSS logical), and appends it to the provided container", () => {
    const container = makeFakeElement("div");
    const overlay = new BitmapTileOverlay({
      tileId: "tile-001",
      corners: CORNERS,
      bitmapResolution: 128,
      devicePixelRatio: 2,
      container: container as unknown as HTMLElement,
    });

    expect(container.children.length).toBe(1);
    expect(container.children[0].tagName).toBe("CANVAS");
    // Physical buffer = bitmapResolution × DPR.
    expect(container.children[0].width).toBe(256);
    expect(container.children[0].height).toBe(256);
    // CSS dimensions stay at the logical resolution — the CSS matrix maps
    // these onto the 4 tile corners regardless of DPR.
    expect(container.children[0].style.width).toBe("128px");
    expect(container.children[0].style.height).toBe("128px");
    expect(container.children[0].dataset.tileId).toBe("tile-001");
    expect(container.children[0].style.position).toBe("absolute");
    expect(container.children[0].style.imageRendering).toBe("pixelated");
    expect(overlay.tileId).toBe("tile-001");
  });

  it("paint() forwards ImageData to ctx.putImageData", () => {
    const container = makeFakeElement("div");
    const overlay = new BitmapTileOverlay({
      tileId: "t",
      corners: CORNERS,
      bitmapResolution: 8,
      devicePixelRatio: 1,
      container: container as unknown as HTMLElement,
    });

    const fakeImage = { data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 } as unknown as ImageData;
    overlay.paint(fakeImage);

    const ctxSpy = container.children[0].getContext("2d") as { putImageData: ReturnType<typeof vi.fn> };
    expect(ctxSpy.putImageData).toHaveBeenCalledTimes(1);
    expect(ctxSpy.putImageData).toHaveBeenCalledWith(fakeImage, 0, 0);
  });

  it("updateTransform() applies a CSS matrix transform string derived from the map", () => {
    const container = makeFakeElement("div");
    const overlay = new BitmapTileOverlay({
      tileId: "t",
      corners: CORNERS,
      bitmapResolution: 100,
      devicePixelRatio: 1,
      container: container as unknown as HTMLElement,
    });
    overlay.updateTransform(FAKE_MAP);
    const transform = container.children[0].style.transform;
    expect(transform).toMatch(/^matrix\(/);
    // 6 comma-separated numbers inside matrix(...)
    const inside = transform.slice("matrix(".length, -1);
    expect(inside.split(",")).toHaveLength(6);
  });

  it("dispose() removes the canvas and makes subsequent calls no-ops", () => {
    const container = makeFakeElement("div");
    const overlay = new BitmapTileOverlay({
      tileId: "t",
      corners: CORNERS,
      bitmapResolution: 8,
      devicePixelRatio: 1,
      container: container as unknown as HTMLElement,
    });
    const canvas = container.children[0];
    const ctxSpy = canvas.getContext("2d") as { putImageData: ReturnType<typeof vi.fn> };

    overlay.dispose();
    expect(container.children.length).toBe(0);
    expect(canvas.parentNode).toBeNull();

    // Idempotent
    overlay.dispose();

    // Post-dispose calls are no-ops (no throw, no ctx call).
    const fakeImage = { data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 } as unknown as ImageData;
    overlay.paint(fakeImage);
    overlay.updateTransform(FAKE_MAP);
    expect(ctxSpy.putImageData).not.toHaveBeenCalled();
  });
});
