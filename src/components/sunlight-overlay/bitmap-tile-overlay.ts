/**
 * Framework-agnostic lifecycle wrapper for a single bitmap tile overlay.
 *
 * Owns the `<canvas>` element, its 2D context, and the CSS transform that
 * positions it on the Leaflet `overlayPane`. Pure DOM — no React, no hooks,
 * no internal state machine. The caller decides WHEN to paint or move; this
 * class only exposes the verbs.
 *
 * ## What this module does NOT do (deferred to Phase 2)
 *
 *  - It does NOT decide when to repaint. The caller (typically the React
 *    component) calls `paint(image)` whenever it has a fresh `ImageData`.
 *  - It does NOT subscribe to Leaflet `move`/`zoom` events. The caller
 *    invokes `updateTransform(map)` from its own event handlers.
 *  - It does NOT decode masks or resolve LOD. See `paint-tile.ts` and
 *    `render-strategy.ts`.
 *  - It does NOT use `L.ImageOverlay`. We append a raw `<canvas>` directly
 *    to the overlay pane and reposition it via CSS `matrix()` — same
 *    pattern as the existing fallback in sunlight-map-client.tsx (lines
 *    ~3563-3589) but without the `L.imageOverlay` shim used there for
 *    lifecycle.
 *
 * ## Pixel convention reminder (Phase 0 — frozen 2026-05-12)
 *
 * The canvas's `width × height` (intrinsic pixels) is `bitmapResolution`,
 * representing cell-EXTENT (not cell-center) coverage of the tile. The
 * CSS transform projects these onto the 4 tile-edge corners. `image-
 * rendering: pixelated` is forced so the browser does not blur the
 * downsampled palette.
 */

import {
  cornersToMatrix,
  formatCSSMatrix,
  type MapLike,
  type TileCornersLatLon,
} from "./tile-corners-projection";

export interface BitmapTileOverlayOptions {
  tileId: string;
  corners: TileCornersLatLon;
  /** Logical canvas width in pixels (cell-extent count along x). Set
   *  separately from `heightPx` to support edge tiles where the region bbox
   *  truncates one axis (e.g. a 43 × 250 grid at the west edge of Vevey). */
  widthPx: number;
  /** Logical canvas height in pixels (cell-extent count along y). */
  heightPx: number;
  /** DPR cap (already clamped by the caller — see `render-strategy.ts`).
   *  Used to size the intrinsic canvas buffer = `widthPx × dpr` ×
   *  `heightPx × dpr`. CSS dimensions remain `widthPx × heightPx`. */
  devicePixelRatio: number;
  /** Where to mount the canvas. Typically `map.getPane("overlayPane")`. */
  container: HTMLElement;
}

export class BitmapTileOverlay {
  readonly tileId: string;
  readonly corners: TileCornersLatLon;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly devicePixelRatio: number;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly container: HTMLElement;
  private disposed = false;

  constructor(opts: BitmapTileOverlayOptions) {
    this.tileId = opts.tileId;
    this.corners = opts.corners;
    this.widthPx = opts.widthPx;
    this.heightPx = opts.heightPx;
    this.devicePixelRatio = opts.devicePixelRatio;
    this.container = opts.container;

    // Intrinsic canvas buffer = LOGICAL dimensions (Phase 2). The painter
    // produces an `ImageData` of size `widthPx × heightPx`, and `putImageData`
    // ignores any transform, so the buffer MUST match the painter output —
    // otherwise we end up with a partially-filled buffer (top-left quadrant
    // only at DPR=2) and tiles appear "scattered/disjoint" on HiDPI.
    //
    // The `devicePixelRatio` parameter is plumbed through for Phase 3, where
    // the painter will produce DPR-scaled output and we'll re-introduce
    // `width = widthPx × dpr`. For now the browser handles HiDPI by scaling
    // the canvas's CSS box; `image-rendering: pixelated` keeps it crisp.
    const canvas = document.createElement("canvas") as HTMLCanvasElement;
    canvas.width = opts.widthPx;
    canvas.height = opts.heightPx;
    canvas.style.width = `${opts.widthPx}px`;
    canvas.style.height = `${opts.heightPx}px`;
    canvas.dataset.tileId = opts.tileId;
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.transformOrigin = "0 0";
    canvas.style.imageRendering = "pixelated";
    canvas.style.pointerEvents = "none";
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.container.appendChild(canvas);
  }

  /** Stamp a pre-rendered `ImageData` (typically produced by
   *  `paintTileImageData`) onto the canvas. No-op if disposed or if the
   *  2D context could not be acquired. */
  paint(image: ImageData): void {
    if (this.disposed || !this.ctx) return;
    this.ctx.putImageData(image, 0, 0);
  }

  /** Recompute the CSS transform so the canvas projects onto the 4
   *  geographic corners at the map's current zoom/pan. Cheap — call it
   *  on every Leaflet `move`/`zoom` event. */
  updateTransform(map: MapLike): void {
    if (this.disposed) return;
    // Map LOGICAL (CSS) dimensions onto the 4 corners — not the physical
    // pixel dims. See constructor comment for the DPR decoupling rationale.
    const m = cornersToMatrix(
      this.corners,
      this.widthPx,
      this.heightPx,
      map,
    );
    this.canvas.style.transform = formatCSSMatrix(m);
  }

  /** Detach the canvas from the DOM and drop the 2D context reference.
   *  Idempotent. After dispose, all further calls are no-ops. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }

  /** Test-only accessor. Avoid using in production code. */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }
}
