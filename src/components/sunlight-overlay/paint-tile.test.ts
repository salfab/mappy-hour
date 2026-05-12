import { describe, expect, it } from "vitest";

import { paintTileImageData, type PaintTilePalette } from "./paint-tile";

const PALETTE: PaintTilePalette = {
  sunny: { r: 250, g: 204, b: 21, a: 200 },
  shadow: { r: 51, g: 65, b: 85, a: 150 },
  indoor: { r: 37, g: 99, b: 235, a: 100 },
};

/** Build a bit-packed mask from a list of `0`/`1` values, indexed cellIdx=iy*w+ix. */
function packBits(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

function pixelRGBA(img: ImageData, x: number, y: number): [number, number, number, number] {
  const off = (y * img.width + x) * 4;
  return [img.data[off], img.data[off + 1], img.data[off + 2], img.data[off + 3]];
}

describe("paintTileImageData", () => {
  it("identity render (width = gridWidth) yields correct RGBA per cell, with Y flipped", () => {
    // 2×2 grid: south row [sunny, shadow], north row [shadow, sunny]
    //   cellIdx: 0=(ix=0,iy=0)=south-west, 1=(ix=1,iy=0)=south-east,
    //            2=(ix=0,iy=1)=north-west, 3=(ix=1,iy=1)=north-east
    const sun = packBits([1, 0, 0, 1]);
    const img = paintTileImageData({
      width: 2,
      height: 2,
      gridWidth: 2,
      gridHeight: 2,
      sunMask: sun,
      palette: PALETTE,
    });
    // y=0 is canvas top = north. So:
    //   (0,0) = NW = shadow
    //   (1,0) = NE = sunny
    //   (0,1) = SW = sunny
    //   (1,1) = SE = shadow
    expect(pixelRGBA(img, 0, 0)).toEqual([
      PALETTE.shadow.r,
      PALETTE.shadow.g,
      PALETTE.shadow.b,
      PALETTE.shadow.a,
    ]);
    expect(pixelRGBA(img, 1, 0)).toEqual([
      PALETTE.sunny.r,
      PALETTE.sunny.g,
      PALETTE.sunny.b,
      PALETTE.sunny.a,
    ]);
    expect(pixelRGBA(img, 0, 1)).toEqual([
      PALETTE.sunny.r,
      PALETTE.sunny.g,
      PALETTE.sunny.b,
      PALETTE.sunny.a,
    ]);
    expect(pixelRGBA(img, 1, 1)).toEqual([
      PALETTE.shadow.r,
      PALETTE.shadow.g,
      PALETTE.shadow.b,
      PALETTE.shadow.a,
    ]);
  });

  it("box downsample (4→2) averages sunny fraction and thresholds at 0.5", () => {
    // 4×4 grid. We aggregate 2×2 source cells per output pixel.
    // Layout (iy=0..3 south→north, ix=0..3 west→east):
    //   Top-left of OUTPUT (px=0,py=0) corresponds to NORTH-WEST source quad
    //   = iy ∈ {2,3}, ix ∈ {0,1}. Make it 3/4 sunny → expect sunny.
    //   Top-right output (px=1,py=0) = NE quad iy {2,3} ix {2,3}: 1/4 sunny → shadow.
    //   Bottom-left (px=0,py=1) = SW quad iy {0,1} ix {0,1}: 2/4 sunny → sunny (≥ half).
    //   Bottom-right (px=1,py=1) = SE quad iy {0,1} ix {2,3}: 0/4 sunny → shadow.
    const bits = new Array(16).fill(0);
    const set = (ix: number, iy: number, v: number) => {
      bits[iy * 4 + ix] = v;
    };
    // NW quad: 3 sunny
    set(0, 2, 1); set(1, 2, 1); set(0, 3, 1); set(1, 3, 0);
    // NE quad: 1 sunny
    set(2, 2, 0); set(3, 2, 0); set(2, 3, 1); set(3, 3, 0);
    // SW quad: 2 sunny
    set(0, 0, 1); set(1, 0, 0); set(0, 1, 1); set(1, 1, 0);
    // SE quad: 0 sunny
    set(2, 0, 0); set(3, 0, 0); set(2, 1, 0); set(3, 1, 0);

    const img = paintTileImageData({
      width: 2,
      height: 2,
      gridWidth: 4,
      gridHeight: 4,
      sunMask: packBits(bits),
      palette: PALETTE,
      downsampleMode: "box",
    });

    expect(pixelRGBA(img, 0, 0)).toEqual([PALETTE.sunny.r, PALETTE.sunny.g, PALETTE.sunny.b, PALETTE.sunny.a]);
    expect(pixelRGBA(img, 1, 0)).toEqual([PALETTE.shadow.r, PALETTE.shadow.g, PALETTE.shadow.b, PALETTE.shadow.a]);
    expect(pixelRGBA(img, 0, 1)).toEqual([PALETTE.sunny.r, PALETTE.sunny.g, PALETTE.sunny.b, PALETTE.sunny.a]);
    expect(pixelRGBA(img, 1, 1)).toEqual([PALETTE.shadow.r, PALETTE.shadow.g, PALETTE.shadow.b, PALETTE.shadow.a]);
  });

  it("max-shadow downsample marks the pixel shadow as soon as ≥1 source cell is shadow", () => {
    // 4×4 → 2×2 again. NW quad: 3 sunny + 1 shadow → still SHADOW under max-shadow.
    const bits = new Array(16).fill(1); // all sunny
    bits[3 * 4 + 0] = 0; // one cell in NW quad → shadow
    const img = paintTileImageData({
      width: 2,
      height: 2,
      gridWidth: 4,
      gridHeight: 4,
      sunMask: packBits(bits),
      palette: PALETTE,
      downsampleMode: "max-shadow",
    });
    // NW = (0,0) → shadow because of the one cell
    expect(pixelRGBA(img, 0, 0)).toEqual([PALETTE.shadow.r, PALETTE.shadow.g, PALETTE.shadow.b, PALETTE.shadow.a]);
    // NE, SW, SE still fully sunny
    expect(pixelRGBA(img, 1, 0)[0]).toBe(PALETTE.sunny.r);
    expect(pixelRGBA(img, 0, 1)[0]).toBe(PALETTE.sunny.r);
    expect(pixelRGBA(img, 1, 1)[0]).toBe(PALETTE.sunny.r);
  });

  it("indoor cells get the indoor color (and sun bit is ignored)", () => {
    // 2×2 identity. Mark all cells indoor except (ix=1,iy=1)=NE.
    const sun = packBits([1, 1, 1, 1]); // all "sunny", but most are indoor
    const outdoor = packBits([0, 0, 0, 1]); // only NE is outdoor
    const img = paintTileImageData({
      width: 2,
      height: 2,
      gridWidth: 2,
      gridHeight: 2,
      sunMask: sun,
      outdoorMask: outdoor,
      palette: PALETTE,
    });
    // y=0 top = north row. NE outdoor & sunny → sunny color at (1,0).
    expect(pixelRGBA(img, 1, 0)).toEqual([PALETTE.sunny.r, PALETTE.sunny.g, PALETTE.sunny.b, PALETTE.sunny.a]);
    // NW indoor → indoor color.
    expect(pixelRGBA(img, 0, 0)).toEqual([PALETTE.indoor.r, PALETTE.indoor.g, PALETTE.indoor.b, PALETTE.indoor.a]);
    // South row both indoor.
    expect(pixelRGBA(img, 0, 1)).toEqual([PALETTE.indoor.r, PALETTE.indoor.g, PALETTE.indoor.b, PALETTE.indoor.a]);
    expect(pixelRGBA(img, 1, 1)).toEqual([PALETTE.indoor.r, PALETTE.indoor.g, PALETTE.indoor.b, PALETTE.indoor.a]);
  });

  it("rejects upsampling (output > grid) with a clear error", () => {
    expect(() =>
      paintTileImageData({
        width: 4,
        height: 4,
        gridWidth: 2,
        gridHeight: 2,
        sunMask: packBits([1, 0, 0, 1]),
        palette: PALETTE,
      }),
    ).toThrow(/upsampling/);
  });
});
