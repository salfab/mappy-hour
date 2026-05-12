/**
 * Pure tile painter — bytes in, ImageData out.
 *
 * Produces an `ImageData` of size `width × height` for a single tile, given
 * its native cell grid (`gridWidth × gridHeight`) plus bit-packed sun/outdoor
 * masks. When `width < gridWidth` (resp. `height < gridHeight`) the source
 * cells are aggregated per output pixel using the requested downsample mode.
 *
 * ## What this module does NOT do (deferred to Phase 2)
 *
 *  - It does NOT touch the DOM (no canvas, no context, no `putImageData`).
 *    The caller draws the returned `ImageData` onto its own canvas.
 *  - It does NOT decode masks. The caller must already have the decoded
 *    bit-packed `Uint8Array` (see `src/lib/encoding/mask-codec-client.ts`).
 *  - It does NOT decide when to repaint, nor which palette to use beyond
 *    what's passed in. That logic stays in the React component (or moves
 *    there in Phase 2).
 *
 * ## Pixel convention — cell-extent (frozen 2026-05-12 in Phase 0)
 *
 * One canvas pixel covers the full square area of one (or several aggregated)
 * native grid cell(s). The 4 corners returned by the precompute backend are
 * the EDGES of the tile (not cell centers). Consequently this routine uses
 * NO `-0.5` half-cell shift anywhere.
 *
 * This is the inverse of `buildTileContourPolygons` (sunlight-map-client.tsx
 * line ~1421 in 2026-05-12), which DOES apply a `-0.5` shift before bilinear
 * interpolation — a latent bug to be addressed downstream of Phase 1.
 *
 * ## Mask byte layout
 *
 * Bit-packed: cell `cellIdx` → byte `cellIdx >> 3`, bit `cellIdx & 7`.
 * Cells are ordered `iy * gridWidth + ix` with `iy = 0` representing the
 * SOUTH edge of the tile. The output `ImageData` has `y = 0` on top
 * (canvas/Leaflet convention), so iy is flipped: `y = height - 1 - py`.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PaintTilePalette {
  sunny: RGBA;
  shadow: RGBA;
  /** Color for cells masked as indoor by `outdoorMask`. If `outdoorMask` is
   *  undefined this is ignored. */
  indoor: RGBA;
}

export type DownsampleMode = "box" | "max-shadow";

export interface PaintTileInput {
  /** Output canvas width in pixels. Must be ≤ `gridWidth`. */
  width: number;
  /** Output canvas height in pixels. Must be ≤ `gridHeight`. */
  height: number;
  /** Native cells along x in the source tile (e.g. 250 at grid_step=1m). */
  gridWidth: number;
  /** Native cells along y. */
  gridHeight: number;
  /** Bit-packed sun mask, length `ceil(gridWidth*gridHeight / 8)`. */
  sunMask: Uint8Array;
  /** Optional bit-packed outdoor mask. Bit=1 ⇒ outdoor. Missing ⇒ all cells
   *  treated as outdoor. */
  outdoorMask?: Uint8Array;
  palette: PaintTilePalette;
  /** Default `"box"`. Only relevant when width<gridWidth or height<gridHeight. */
  downsampleMode?: DownsampleMode;
}

/** Read bit `cellIdx` from a bit-packed Uint8Array. */
function readBit(mask: Uint8Array, cellIdx: number): number {
  return (mask[cellIdx >> 3] >> (cellIdx & 7)) & 1;
}

/** Standalone factory so this module stays usable in Node tests (no DOM).
 *  Mirrors the shape of the browser `ImageData` type. */
function makeImageData(width: number, height: number): ImageData {
  // Prefer the real constructor when available (browser, jsdom). Fall back to
  // a structural object that quacks like `ImageData` for Node tests.
  if (typeof ImageData !== "undefined") {
    return new ImageData(width, height);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

export function paintTileImageData(input: PaintTileInput): ImageData {
  const {
    width,
    height,
    gridWidth,
    gridHeight,
    sunMask,
    outdoorMask,
    palette,
    downsampleMode = "box",
  } = input;

  if (width <= 0 || height <= 0) {
    throw new Error(`paintTileImageData: invalid output size ${width}×${height}`);
  }
  if (gridWidth <= 0 || gridHeight <= 0) {
    throw new Error(`paintTileImageData: invalid grid size ${gridWidth}×${gridHeight}`);
  }
  if (width > gridWidth || height > gridHeight) {
    throw new Error(
      `paintTileImageData: upsampling not supported (output ${width}×${height} > grid ${gridWidth}×${gridHeight})`,
    );
  }

  const image = makeImageData(width, height);
  const data = image.data;

  // Source cells per output pixel along each axis. For the simple identity
  // case (width === gridWidth) this is exactly 1 and the inner loops collapse.
  const sxPerPx = gridWidth / width;
  const syPerPx = gridHeight / height;

  for (let py = 0; py < height; py++) {
    // Output y=0 is the TOP of the canvas (north). Source iy=0 is the SOUTH
    // edge. → mirror Y when picking source rows.
    const iyStartF = (height - 1 - py) * syPerPx;
    const iyEndF = iyStartF + syPerPx;
    const iyStart = Math.floor(iyStartF + 1e-9);
    const iyEnd = Math.min(gridHeight, Math.ceil(iyEndF - 1e-9));

    for (let px = 0; px < width; px++) {
      const ixStartF = px * sxPerPx;
      const ixEndF = ixStartF + sxPerPx;
      const ixStart = Math.floor(ixStartF + 1e-9);
      const ixEnd = Math.min(gridWidth, Math.ceil(ixEndF - 1e-9));

      let outdoorCount = 0;
      let indoorCount = 0;
      let sunnyCount = 0;
      let anyShadow = false;

      for (let iy = iyStart; iy < iyEnd; iy++) {
        for (let ix = ixStart; ix < ixEnd; ix++) {
          const cellIdx = iy * gridWidth + ix;
          const isOutdoor = outdoorMask ? readBit(outdoorMask, cellIdx) === 1 : true;
          if (!isOutdoor) {
            indoorCount++;
            continue;
          }
          outdoorCount++;
          const isSunny = readBit(sunMask, cellIdx) === 1;
          if (isSunny) {
            sunnyCount++;
          } else {
            anyShadow = true;
          }
        }
      }

      let color: RGBA;
      if (outdoorCount === 0 && indoorCount > 0) {
        // Entirely indoor — use indoor color.
        color = palette.indoor;
      } else if (outdoorCount === 0) {
        // No source cell at all (shouldn't happen given the loop bounds, but
        // be safe). Render shadow so we don't leak the canvas background.
        color = palette.shadow;
      } else if (downsampleMode === "max-shadow") {
        color = anyShadow ? palette.shadow : palette.sunny;
      } else {
        // "box" — threshold sunny fraction at 0.5.
        color = sunnyCount * 2 >= outdoorCount ? palette.sunny : palette.shadow;
      }

      const off = (py * width + px) * 4;
      data[off] = color.r;
      data[off + 1] = color.g;
      data[off + 2] = color.b;
      data[off + 3] = color.a;
    }
  }

  return image;
}
