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
  /** Square physical resolution of the canvas (in pixels, post-DPR).
   *  Both width and height of the `<canvas>` are set to this value. */
  bitmapResolution: number;
  /** DPR cap (already clamped by the caller — see `render-strategy.ts`).
   *  Currently informational — we honour it by setting the canvas intrinsic
   *  size to `bitmapResolution` (which the caller computed as
   *  `targetCssPx × dpr`). Stored for future use (e.g. CSS sizing). */
  devicePixelRatio: number;
  /** Where to mount the canvas. Typically `map.getPane("overlayPane")`. */
  container: HTMLElement;
}

export class BitmapTileOverlay {
  readonly tileId: string;
  readonly corners: TileCornersLatLon;
  readonly bitmapResolution: number;
  readonly devicePixelRatio: number;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly container: HTMLElement;
  private disposed = false;

  constructor(opts: BitmapTileOverlayOptions) {
    this.tileId = opts.tileId;
    this.corners = opts.corners;
    this.bitmapResolution = opts.bitmapResolution;
    this.devicePixelRatio = opts.devicePixelRatio;
    this.container = opts.container;

    // ── DPR split between physical and CSS dimensions ──────────────────────
    // The canvas's INTRINSIC pixel size is `bitmapResolution × dpr` — that's
    // how many real pixels we actually draw (more pixels = sharper on HiDPI).
    //
    // Its CSS (logical) size is `bitmapResolution` — that's what the CSS
    // matrix maps onto the 4 tile-edge corners. Decoupling the two means
    // the CSS transform doesn't change when DPR changes; only the canvas's
    // intrinsic buffer does.
    //
    // The transform produced by `cornersToMatrix(..., bitmapResolution, ...)`
    // therefore maps LOGICAL canvas coords to layer points. The browser then
    // applies its own DPR scaling when rasterizing the canvas content.
    const canvas = document.createElement("canvas") as HTMLCanvasElement;
    const dpr = Math.max(1, opts.devicePixelRatio || 1);
    canvas.width = Math.round(opts.bitmapResolution * dpr);
    canvas.height = Math.round(opts.bitmapResolution * dpr);
    canvas.style.width = `${opts.bitmapResolution}px`;
    canvas.style.height = `${opts.bitmapResolution}px`;
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
      this.bitmapResolution,
      this.bitmapResolution,
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
