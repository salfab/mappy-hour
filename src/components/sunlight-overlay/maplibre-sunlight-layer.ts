/**
 * MapLibre adapter for the sunlight bitmap overlay (Phase 2).
 *
 * Bridges the framework-agnostic `BitmapTileOverlay` / `cornersToMatrix` API
 * (which speaks Leaflet's `latLngToLayerPoint` convention) to MapLibre GL JS
 * (`map.project([lng, lat])`).
 *
 * Key design decisions:
 *  - We do NOT use `addProtocol` — our LV95 atlas grid is incompatible with
 *    MapLibre's Web Mercator z/x/y tile scheme.
 *  - We append a raw `<div>` overlay to `map.getContainer()` (not a MapLibre
 *    layer/source) so the canvases stay above all GL content without touching
 *    the style spec.
 *  - The `MapLike` adapter converts MapLibre's `[lng, lat]` projection to the
 *    `[lat, lng]` / `{ lat, lng }` convention that `cornersToMatrix` expects.
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import { BitmapTileOverlay } from "./bitmap-tile-overlay";
import { paintTileImageData, type RGBA } from "./paint-tile";
import { selectRenderStrategy, shouldRerasterize } from "./render-strategy";
import type { MapLike, TileCornersLatLon } from "./tile-corners-projection";

// ── Types (redeclared locally — mirror sunlight-map-client.tsx) ──────────────

interface LatLon {
  lat: number;
  lon: number;
}

interface TimelineFrame {
  index: number;
  localTime: string;
  sunnyCount: number;
  sunMaskBase64: string;
  sunMaskNoVegetationBase64?: string;
}

interface DecodedTileMasks {
  outdoor: Uint8Array;
  frames: Array<{ sun: Uint8Array; sunNoVeg: Uint8Array }>;
}

interface TileGrid {
  width: number;
  height: number;
  minIx: number;
  maxIx: number;
  minIy: number;
  maxIy: number;
}

export interface TimelineTile {
  tileId: string;
  grid?: TileGrid;
  outdoorMaskBase64?: string;
  decodedMasks?: DecodedTileMasks;
  frames: TimelineFrame[];
  tileCorners?: { nw: LatLon; ne: LatLon; sw: LatLon; se: LatLon };
}

// ── Palette ───────────────────────────────────────────────────────────────────

const DEFAULT_PALETTE = {
  sunny:  { r: 255, g: 220, b: 60,  a: 110 },
  shadow: { r: 40,  g: 60,  b: 140, a: 100 },
  indoor: { r: 0,   g: 0,   b: 0,   a: 0   },
} satisfies { sunny: RGBA; shadow: RGBA; indoor: RGBA };

// ── Mask decoding helpers ─────────────────────────────────────────────────────

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function getTileMask(tile: TimelineTile, frameIdx: number): Uint8Array | null {
  if (tile.decodedMasks) return tile.decodedMasks.frames[frameIdx]?.sun ?? null;
  const frame = tile.frames[Math.max(0, Math.min(frameIdx, tile.frames.length - 1))];
  if (!frame) return null;
  return decodeBase64(frame.sunMaskBase64);
}

function getTileOutdoorMask(tile: TimelineTile): Uint8Array | undefined {
  if (tile.decodedMasks) return tile.decodedMasks.outdoor;
  return tile.outdoorMaskBase64 ? decodeBase64(tile.outdoorMaskBase64) : undefined;
}

// ── Render-strategy bookkeeping per tile ─────────────────────────────────────

interface TileRenderState {
  overlay: BitmapTileOverlay;
  currentResolution: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface MapLibreSunlightLayerOptions {
  map: MapLibreMap;
  palette?: { sunny: RGBA; shadow: RGBA; indoor: RGBA };
}

export class MapLibreSunlightLayer {
  private readonly map: MapLibreMap;
  private readonly palette: { sunny: RGBA; shadow: RGBA; indoor: RGBA };
  private readonly overlayContainer: HTMLDivElement;
  private readonly overlays: Map<string, TileRenderState> = new Map();
  private tiles: TimelineTile[] = [];
  private visible = true;

  /** Satisfies tile-corners-projection.ts `MapLike` at runtime.
   *  MapLibre `project([lng, lat])` returns pixel coords relative to the
   *  map container — identical to what Leaflet `latLngToLayerPoint` returns
   *  relative to the overlay pane (which is inset-0 inside the container). */
  private readonly mapLikeAdapter: MapLike;

  // Move/zoom event handler refs (for cleanup).
  private readonly onMove: () => void;
  private readonly onMoveEnd: () => void;

  constructor(opts: MapLibreSunlightLayerOptions) {
    this.map = opts.map;
    this.palette = opts.palette ?? DEFAULT_PALETTE;

    // Create the overlay container and attach it to the map DOM.
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.inset = "0";
    container.style.pointerEvents = "none";
    container.style.overflow = "hidden";
    container.setAttribute("aria-hidden", "true");
    this.overlayContainer = container;
    this.map.getContainer().appendChild(container);

    // Adapter: translate Leaflet-style [lat, lng] or {lat, lng} calls to
    // MapLibre `map.project([lng, lat])`.
    const mapRef = this.map;
    this.mapLikeAdapter = {
      latLngToLayerPoint(
        latlng: [number, number] | { lat: number; lng?: number; lon?: number },
      ) {
        let lat: number;
        let lng: number;
        if (Array.isArray(latlng)) {
          [lat, lng] = latlng;
        } else {
          lat = latlng.lat;
          lng = (latlng as { lng?: number }).lng ?? (latlng as { lon?: number }).lon ?? 0;
        }
        return mapRef.project([lng, lat] as [number, number]);
      },
    } as unknown as MapLike;

    // Register map event listeners.
    this.onMove = () => this.updateTransforms();
    this.onMoveEnd = () => this.updateTransforms();
    this.map.on("move", this.onMove);
    this.map.on("moveend", this.onMoveEnd);
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  /** Replace the full set of tiles and repaint at the given frame. */
  setTimeline(
    tiles: TimelineTile[],
    frameIndex: number,
    showSunny: boolean,
    showShadow: boolean,
  ): void {
    this.tiles = tiles;
    // Dispose any overlay for tiles no longer in the set.
    const newIds = new Set(tiles.map((t) => t.tileId));
    for (const [id, state] of this.overlays) {
      if (!newIds.has(id)) {
        state.overlay.dispose();
        this.overlays.delete(id);
      }
    }
    this.paint(frameIndex, showSunny, showShadow);
  }

  /** Just repaint at a different frame index (slider move). Fast path. */
  setFrameIndex(frameIndex: number, showSunny: boolean, showShadow: boolean): void {
    this.paint(frameIndex, showSunny, showShadow);
  }

  /** Show or hide all canvases. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.overlayContainer.style.display = visible ? "" : "none";
  }

  /** Remove the overlay container and dispose all tile canvases. */
  dispose(): void {
    this.map.off("move", this.onMove);
    this.map.off("moveend", this.onMoveEnd);
    for (const state of this.overlays.values()) {
      state.overlay.dispose();
    }
    this.overlays.clear();
    if (this.overlayContainer.parentNode) {
      this.overlayContainer.parentNode.removeChild(this.overlayContainer);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private updateTransforms(): void {
    for (const state of this.overlays.values()) {
      state.overlay.updateTransform(this.mapLikeAdapter);
    }
  }

  private paint(frameIndex: number, showSunny: boolean, showShadow: boolean): void {
    if (!this.visible) return;

    const zoom = this.map.getZoom();
    const dpr = Math.min(Math.max(window.devicePixelRatio ?? 1, 1), 2);
    const visibleTileCount = this.tiles.length;

    // Effective palette: zero alpha on the channels the user has toggled off.
    const palette = {
      sunny:  showSunny  ? this.palette.sunny  : { ...this.palette.sunny,  a: 0 },
      shadow: showShadow ? this.palette.shadow : { ...this.palette.shadow, a: 0 },
      indoor: this.palette.indoor,
    };

    for (const tile of this.tiles) {
      if (!tile.tileCorners || !tile.grid) continue;

      const sunMask = getTileMask(tile, frameIndex);
      if (!sunMask) continue;

      const outdoorMask = getTileOutdoorMask(tile);

      // Atlas tiles are 250 m × 250 m with 1 m grid step.
      const TILE_SIZE_METERS = 250;
      const tileNativeSizePx = tile.grid.width; // cells along x (≈ 250)

      const strategy = selectRenderStrategy({
        zoom,
        visibleTileCount,
        devicePixelRatio: dpr,
        tileSizeMeters: TILE_SIZE_METERS,
        tileNativeSizePx,
        previousMode: this.overlays.get(tile.tileId)
          ? "bitmap"
          : null,
      });

      const { bitmapResolution } = strategy;
      const existing = this.overlays.get(tile.tileId);

      // Decide whether we need to rebuild (re-rasterize) the canvas.
      const needRebuild =
        !existing || shouldRerasterize(existing.currentResolution, bitmapResolution);

      let overlay: BitmapTileOverlay;

      if (needRebuild) {
        existing?.overlay.dispose();

        const corners: TileCornersLatLon = tile.tileCorners;

        overlay = new BitmapTileOverlay({
          tileId: tile.tileId,
          corners,
          widthPx: bitmapResolution,
          heightPx: bitmapResolution,
          devicePixelRatio: dpr,
          container: this.overlayContainer,
        });

        this.overlays.set(tile.tileId, { overlay, currentResolution: bitmapResolution });
      } else {
        overlay = existing!.overlay;
      }

      // Paint the tile.
      const imageData = paintTileImageData({
        width: bitmapResolution,
        height: bitmapResolution,
        gridWidth: tile.grid.width,
        gridHeight: tile.grid.height,
        sunMask,
        outdoorMask,
        palette,
      });

      overlay.paint(imageData);
      overlay.updateTransform(this.mapLikeAdapter);
    }
  }
}
