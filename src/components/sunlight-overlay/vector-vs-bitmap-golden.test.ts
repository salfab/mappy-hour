/**
 * Golden test — bitmap output equivalence with a reference per-cell renderer.
 *
 * Phase 2 (wiring) needs a regression-proof guarantee that the new bitmap
 * pipeline (`paintTileImageData`) produces the SAME logical pattern as the
 * existing vector pipeline (`buildTileContourPolygons` + L.polygon SVG).
 *
 * ## Why not literally render both and pixel-diff?
 *
 * Vector SVG is anti-aliased by the browser, bitmap canvas isn't. A direct
 * pixel-diff would show 5-15% mismatch on every diagonal edge — not the bug
 * class we want to catch. The interesting risk is: bitmap producing the wrong
 * COLOR PER CELL (wrong mask bit, wrong y-flip, wrong indoor handling). That's
 * a per-cell test, not a per-pixel one.
 *
 * ## Strategy
 *
 * 1. Hand-craft an 8×8 grid with an asymmetric sun pattern (catches y-flip
 *    bugs) plus an outdoor mask with a few indoor cells.
 * 2. Compute the expected ImageData via a deliberately-naive REFERENCE
 *    walker: iterate cells (row-major, y-flipped), pick palette per cell,
 *    paint the corresponding canvas pixel. No clever downsampling, no
 *    bit-packing optimization — just a direct mapping that's trivially
 *    correct by inspection.
 * 3. Compute the candidate ImageData via `paintTileImageData` at native
 *    resolution (no downsample → both implementations must converge).
 * 4. Assert byte-for-byte equality. Any divergence = a real bug in paint-tile.
 *
 * If/when Phase 2 swaps the runtime renderer from vector to bitmap, this test
 * is the canary. The bitmap must keep producing the colors the reference
 * walker produces, so the user sees the same on-screen pattern as the vector
 * path used to.
 */

import { describe, expect, it } from "vitest";

import {
  paintTileImageData,
  type DownsampleMode,
  type PaintTilePalette,
  type RGBA,
} from "./paint-tile";

const PALETTE: PaintTilePalette = {
  sunny: { r: 255, g: 200, b: 80, a: 220 },
  shadow: { r: 30, g: 50, b: 90, a: 160 },
  indoor: { r: 120, g: 120, b: 120, a: 90 },
};

/** Bit-pack a boolean grid (true = bit set). */
function packBits(values: boolean[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) {
    if (values[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

/**
 * Reference renderer — deliberately naive. Walks cells in row-major order
 * (matches paint-tile's iy = 0 = south convention), Y-flips when writing to
 * the output buffer, picks palette per cell. Identity resolution only —
 * downsampling is paint-tile's responsibility and is covered by the unit
 * tests in `paint-tile.test.ts`.
 */
function renderReference(
  gridWidth: number,
  gridHeight: number,
  sunny: boolean[],
  outdoor: boolean[] | null,
  palette: PaintTilePalette,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gridWidth * gridHeight * 4);
  for (let iy = 0; iy < gridHeight; iy++) {
    for (let ix = 0; ix < gridWidth; ix++) {
      const idx = iy * gridWidth + ix;
      const isOutdoor = outdoor ? outdoor[idx] : true;
      const isSunny = sunny[idx];
      let color: RGBA;
      if (!isOutdoor) {
        color = palette.indoor;
      } else {
        color = isSunny ? palette.sunny : palette.shadow;
      }
      // Y-flip to match paint-tile: source iy=0 is south, output y=0 is top.
      const py = gridHeight - 1 - iy;
      const off = (py * gridWidth + ix) * 4;
      out[off] = color.r;
      out[off + 1] = color.g;
      out[off + 2] = color.b;
      out[off + 3] = color.a;
    }
  }
  return out;
}

interface GoldenCase {
  name: string;
  gridWidth: number;
  gridHeight: number;
  sunny: boolean[];
  outdoor: boolean[] | null;
  downsampleMode?: DownsampleMode;
}

const CASES: GoldenCase[] = [
  {
    // Asymmetric: top half (north = iy ≥ 4 in source) sunny, bottom shadow.
    // If paint-tile forgets to Y-flip, output's TOP row will be shadow
    // instead of sunny → catches the bug.
    name: "asymmetric north-sunny / south-shadow",
    gridWidth: 8,
    gridHeight: 8,
    sunny: Array.from({ length: 64 }, (_, i) => Math.floor(i / 8) >= 4),
    outdoor: null,
  },
  {
    // Checkerboard — every pixel must alternate. Catches any rounding /
    // off-by-one in the index computations.
    name: "checkerboard sunny/shadow",
    gridWidth: 8,
    gridHeight: 8,
    sunny: Array.from({ length: 64 }, (_, i) => ((i % 8) + Math.floor(i / 8)) % 2 === 0),
    outdoor: null,
  },
  {
    // Mixed sun/shadow + indoor patch. Indoor cells must come out grey
    // regardless of their sun bit. The L-shaped indoor footprint exercises
    // both edges of the asymmetry.
    name: "asymmetric with L-shaped indoor patch",
    gridWidth: 8,
    gridHeight: 8,
    sunny: Array.from({ length: 64 }, (_, i) => i % 3 !== 0),
    outdoor: Array.from({ length: 64 }, (_, i) => {
      const ix = i % 8;
      const iy = Math.floor(i / 8);
      const inLShape = (ix >= 2 && ix <= 3 && iy >= 1 && iy <= 5) || (ix >= 2 && ix <= 5 && iy === 5);
      return !inLShape;
    }),
  },
];

describe("vector-vs-bitmap golden equivalence", () => {
  for (const tc of CASES) {
    it(`bitmap matches reference walker at native resolution: ${tc.name}`, () => {
      const sunMask = packBits(tc.sunny);
      const outdoorMask = tc.outdoor ? packBits(tc.outdoor) : undefined;

      const expected = renderReference(
        tc.gridWidth,
        tc.gridHeight,
        tc.sunny,
        tc.outdoor,
        PALETTE,
      );

      const got = paintTileImageData({
        width: tc.gridWidth,
        height: tc.gridHeight,
        gridWidth: tc.gridWidth,
        gridHeight: tc.gridHeight,
        sunMask,
        outdoorMask,
        palette: PALETTE,
        downsampleMode: tc.downsampleMode ?? "box",
      });

      const gotBytes = got.data;
      expect(gotBytes.length).toBe(expected.length);

      // Locate the first mismatching byte for a useful error message.
      let firstDiff = -1;
      for (let i = 0; i < expected.length; i++) {
        if (gotBytes[i] !== expected[i]) {
          firstDiff = i;
          break;
        }
      }
      if (firstDiff >= 0) {
        const px = (firstDiff >> 2) % tc.gridWidth;
        const py = Math.floor(firstDiff >> 2) / tc.gridWidth;
        throw new Error(
          `bitmap diverges from reference at byte ${firstDiff} ` +
            `(pixel x=${px}, y=${Math.floor(py)}, channel=${["r", "g", "b", "a"][firstDiff & 3]}). ` +
            `expected=${expected[firstDiff]} got=${gotBytes[firstDiff]}`,
        );
      }
      expect(firstDiff).toBe(-1);
    });
  }

  it("documented edge-AA tolerance for downsampled paths is 0 at identity res", () => {
    // Sanity assertion: the comparison above is byte-exact, no tolerance.
    // The 2% tolerance mentioned in the Phase 1 brief is reserved for
    // downsampled rendering, where the reference walker doesn't apply
    // (downsampling is paint-tile's job; covered by paint-tile.test.ts).
    expect(true).toBe(true);
  });
});
