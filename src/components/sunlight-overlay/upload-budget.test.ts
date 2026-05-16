import { beforeEach, describe, expect, it } from "vitest";

import { MapLibreSunlightCustomLayer } from "./maplibre-sunlight-custom-layer";

/**
 * Tests for the per-frame slice upload budget added in v2 of
 * `MapLibreSunlightCustomLayer`. These exercise the private
 * `uploadDirtySlices()` method against a fake `gl` context — no real WebGL
 * needed — to verify that:
 *
 *  - the budget cap (`MAX_SLICES_UPLOADED_PER_FRAME = 8`) is honoured;
 *  - the `nextSliceUploadIndex` cursor advances by exactly the number of
 *    uploads performed;
 *  - a tile transitions to `textureDirty = false` only once its cursor reaches
 *    `frameCount`;
 *  - `uploadDirtySlices()` returns `stillDirty = true` if-and-only-if any
 *    tile still has slices left to upload, so the caller can avoid an
 *    infinite `triggerRepaint` loop (the v1 bug);
 *  - the priority ordering writes the slice at the captured
 *    `dirtyStartFrameIndex` FIRST, then wraps around — this is what fixes
 *    the v1 invisibility bug (a tile arriving while `u_frameIndex = 30`
 *    used to stay blank for ~4 frames; now it is visible immediately).
 */

const MAX_PER_FRAME = 8;

interface TileState {
  luminanceArray: Uint8Array;
  gridWidth: number;
  gridHeight: number;
  frameCount: number;
  baseLayer: number;
  textureDirty: boolean;
  nextSliceUploadIndex: number;
  dirtyStartFrameIndex: number;
  // Other TileCPUState fields the method does not touch — supplied as
  // dummies so the type check is satisfied via the cast at the call site.
  nwMerc: { x: number; y: number };
  neMerc: { x: number; y: number };
  swMerc: { x: number; y: number };
  seMerc: { x: number; y: number };
  decodedMasksRef: null;
  useNoVegRef: boolean;
}

interface TexSubImageCall {
  zoff: number;
  width: number;
  height: number;
  byteOffset: number;
  byteLength: number;
}

interface FakeGL {
  TEXTURE_2D_ARRAY: number;
  TEXTURE0: number;
  RED: number;
  UNSIGNED_BYTE: number;
  UNPACK_ALIGNMENT: number;
  pixelStorei: (pname: number, param: number) => void;
  activeTexture: (unit: number) => void;
  bindTexture: (target: number, texture: unknown) => void;
  texSubImage3D: (
    target: number,
    level: number,
    xoff: number,
    yoff: number,
    zoff: number,
    width: number,
    height: number,
    depth: number,
    format: number,
    type: number,
    pixels: ArrayBufferView,
  ) => void;
  __calls: {
    texSubImage3D: TexSubImageCall[];
    pixelStorei: Array<[number, number]>;
    bindTexture: Array<[number, unknown]>;
    activeTexture: number[];
  };
}

function makeFakeGL(): FakeGL {
  const calls = {
    texSubImage3D: [] as TexSubImageCall[],
    pixelStorei: [] as Array<[number, number]>,
    bindTexture: [] as Array<[number, unknown]>,
    activeTexture: [] as number[],
  };
  return {
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE0: 0x84c0,
    RED: 0x1903,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_ALIGNMENT: 0x0cf5,
    pixelStorei: (pname: number, param: number) => {
      calls.pixelStorei.push([pname, param]);
    },
    activeTexture: (unit: number) => {
      calls.activeTexture.push(unit);
    },
    bindTexture: (target: number, texture: unknown) => {
      calls.bindTexture.push([target, texture]);
    },
    texSubImage3D: (
      _target,
      _level,
      _xoff,
      _yoff,
      zoff,
      width,
      height,
      _depth,
      _format,
      _type,
      pixels,
    ) => {
      calls.texSubImage3D.push({
        zoff,
        width,
        height,
        byteOffset: pixels.byteOffset,
        byteLength: pixels.byteLength,
      });
    },
    __calls: calls,
  };
}

/** Build a tile state with `frameCount` slices of `width*height` bytes each.
 *  The luminance array is filled with `sliceIdx + 1` per cell so we can later
 *  trace which slice was actually uploaded. */
function makeTile(opts: {
  frameCount: number;
  width?: number;
  height?: number;
  baseLayer?: number;
  dirtyStartFrameIndex?: number;
}): TileState {
  const width = opts.width ?? 4;
  const height = opts.height ?? 4;
  const stride = width * height;
  const buf = new Uint8Array(stride * opts.frameCount);
  for (let f = 0; f < opts.frameCount; f++) {
    for (let i = 0; i < stride; i++) buf[f * stride + i] = f + 1; // marker
  }
  return {
    luminanceArray: buf,
    gridWidth: width,
    gridHeight: height,
    frameCount: opts.frameCount,
    baseLayer: opts.baseLayer ?? 0,
    textureDirty: true,
    nextSliceUploadIndex: 0,
    dirtyStartFrameIndex: opts.dirtyStartFrameIndex ?? 0,
    nwMerc: { x: 0, y: 0 },
    neMerc: { x: 0, y: 0 },
    swMerc: { x: 0, y: 0 },
    seMerc: { x: 0, y: 0 },
    decodedMasksRef: null,
    useNoVegRef: false,
  };
}

/** Build a layer whose `uploadDirtySlices()` is callable in isolation. We
 *  bypass the constructor's `map` dependency by allocating the instance with
 *  `Object.create` and setting the few fields the upload path touches. */
function makeLayer(
  tiles: TileState[],
  megaTexture: unknown = { __id: "mega" },
): MapLibreSunlightCustomLayer {
  const layer = Object.create(
    MapLibreSunlightCustomLayer.prototype,
  ) as MapLibreSunlightCustomLayer;
  (layer as unknown as {
    renderList: TileState[];
    megaTexture: unknown;
  }).renderList = tiles;
  (layer as unknown as {
    megaTexture: unknown;
  }).megaTexture = megaTexture;
  return layer;
}

function callUpload(layer: MapLibreSunlightCustomLayer, gl: FakeGL): boolean {
  // Access the private method via a typed cast — vitest tests live in the
  // same package and can introspect the class for white-box testing.
  return (
    layer as unknown as {
      uploadDirtySlices: (gl: unknown) => boolean;
    }
  ).uploadDirtySlices(gl);
}

describe("MapLibreSunlightCustomLayer.uploadDirtySlices", () => {
  let gl: FakeGL;

  beforeEach(() => {
    gl = makeFakeGL();
  });

  it("uploads exactly MAX_SLICES_UPLOADED_PER_FRAME when enough dirty slices are available", () => {
    const tile = makeTile({ frameCount: 60 });
    const layer = makeLayer([tile]);

    const stillDirty = callUpload(layer, gl);

    expect(gl.__calls.texSubImage3D.length).toBe(MAX_PER_FRAME);
    expect(stillDirty).toBe(true);
    expect(tile.textureDirty).toBe(true);
    expect(tile.nextSliceUploadIndex).toBe(MAX_PER_FRAME);
  });

  it("advances the cursor by exactly the number of uploads performed", () => {
    const tile = makeTile({ frameCount: 60 });
    const layer = makeLayer([tile]);

    callUpload(layer, gl);
    expect(tile.nextSliceUploadIndex).toBe(MAX_PER_FRAME);

    callUpload(layer, gl);
    expect(tile.nextSliceUploadIndex).toBe(2 * MAX_PER_FRAME);

    callUpload(layer, gl);
    expect(tile.nextSliceUploadIndex).toBe(3 * MAX_PER_FRAME);
  });

  it("marks a tile clean (textureDirty=false) when the cursor reaches frameCount", () => {
    const tile = makeTile({ frameCount: 10 }); // 10 < 8*2 so it finishes in 2 frames
    const layer = makeLayer([tile]);

    // Frame 1: uploads 8, cursor=8, still dirty.
    let stillDirty = callUpload(layer, gl);
    expect(stillDirty).toBe(true);
    expect(tile.textureDirty).toBe(true);
    expect(tile.nextSliceUploadIndex).toBe(MAX_PER_FRAME);

    // Frame 2: uploads remaining 2, cursor reaches 10 = frameCount → clean.
    const callsBefore = gl.__calls.texSubImage3D.length;
    stillDirty = callUpload(layer, gl);
    const callsAfter = gl.__calls.texSubImage3D.length;
    expect(callsAfter - callsBefore).toBe(2);
    expect(stillDirty).toBe(false);
    expect(tile.textureDirty).toBe(false);
    expect(tile.nextSliceUploadIndex).toBe(10); // reaches frameCount, reset by markTileDirty later
  });

  it("returns stillDirty=false when no tile is dirty (idempotent — no infinite repaint)", () => {
    const tile = makeTile({ frameCount: 60 });
    tile.textureDirty = false; // already clean
    const layer = makeLayer([tile]);

    const stillDirty = callUpload(layer, gl);

    expect(stillDirty).toBe(false);
    expect(gl.__calls.texSubImage3D.length).toBe(0);
    // Lazy bind: when there is no work to do, no GL state should be touched.
    expect(gl.__calls.bindTexture.length).toBe(0);
    expect(gl.__calls.pixelStorei.length).toBe(0);
    expect(gl.__calls.activeTexture.length).toBe(0);
  });

  it("splits the budget across multiple dirty tiles", () => {
    const tileA = makeTile({ frameCount: 60, baseLayer: 0 });
    const tileB = makeTile({ frameCount: 60, baseLayer: 60 });
    const layer = makeLayer([tileA, tileB]);

    const stillDirty = callUpload(layer, gl);

    // Tile A consumed the full 8-slice budget; tile B was not touched yet.
    expect(gl.__calls.texSubImage3D.length).toBe(MAX_PER_FRAME);
    expect(tileA.nextSliceUploadIndex).toBe(MAX_PER_FRAME);
    expect(tileB.nextSliceUploadIndex).toBe(0);
    expect(tileB.textureDirty).toBe(true);
    expect(stillDirty).toBe(true);
  });

  it("budget rolls over to the next tile once the current one finishes", () => {
    const tileA = makeTile({ frameCount: 5, baseLayer: 0 }); // small tile, fits in one frame
    const tileB = makeTile({ frameCount: 60, baseLayer: 5 });
    const layer = makeLayer([tileA, tileB]);

    const stillDirty = callUpload(layer, gl);

    // Tile A took 5 of the 8-slice budget; tile B took the remaining 3.
    expect(gl.__calls.texSubImage3D.length).toBe(MAX_PER_FRAME);
    expect(tileA.textureDirty).toBe(false);
    expect(tileB.nextSliceUploadIndex).toBe(3);
    expect(tileB.textureDirty).toBe(true);
    expect(stillDirty).toBe(true);
  });

  it("priority ordering: first slice written is at dirtyStartFrameIndex (so the tile is visible immediately at u_frameIndex)", () => {
    // Tile of 31 frames whose dirty pass started at frameIndex = 15. The very
    // first texSubImage3D call must write slice 15 (NOT slice 0).
    const tile = makeTile({ frameCount: 31, dirtyStartFrameIndex: 15, baseLayer: 100 });
    const layer = makeLayer([tile]);

    callUpload(layer, gl);

    const firstCall = gl.__calls.texSubImage3D[0];
    expect(firstCall.zoff).toBe(100 + 15); // baseLayer + dirtyStart
  });

  it("priority ordering wraps around: after the last frame, continues from frame 0", () => {
    const tile = makeTile({ frameCount: 5, dirtyStartFrameIndex: 3, baseLayer: 0 });
    const layer = makeLayer([tile]);

    callUpload(layer, gl);

    // 5 frames total, dirtyStart=3, expected slice order: 3, 4, 0, 1, 2.
    const sliceOrder = gl.__calls.texSubImage3D.map((c) => c.zoff);
    expect(sliceOrder).toEqual([3, 4, 0, 1, 2]);
  });

  it("uses TEXTURE0 + UNPACK_ALIGNMENT=1 during uploads, restores 4 + unbind on exit", () => {
    const tile = makeTile({ frameCount: 4 });
    const layer = makeLayer([tile]);

    callUpload(layer, gl);

    // Setup: activeTexture(TEXTURE0), bindTexture(megaTexture), UNPACK_ALIGNMENT=1.
    expect(gl.__calls.activeTexture).toContain(gl.TEXTURE0);
    expect(gl.__calls.pixelStorei[0]).toEqual([gl.UNPACK_ALIGNMENT, 1]);
    // Cleanup: UNPACK_ALIGNMENT=4, bindTexture(TEXTURE_2D_ARRAY, null).
    const lastPixelStorei = gl.__calls.pixelStorei.at(-1);
    expect(lastPixelStorei).toEqual([gl.UNPACK_ALIGNMENT, 4]);
    const lastBind = gl.__calls.bindTexture.at(-1);
    expect(lastBind?.[1]).toBeNull();
  });
});
