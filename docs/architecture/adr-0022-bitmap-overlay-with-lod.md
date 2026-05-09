# ADR-0022: Hybrid Vector/Bitmap Sunlight Overlay with Adaptive LOD

**Date:** 2026-05-09
**Status:** Proposed

## Context

The current sunlight overlay (cf. ADR-0006 for the streaming foundation) uses a vector-only rendering pipeline in `sunlight-map-client.tsx`:

- Each tile's `outdoorMask` + `sunMask` is run through `d3-contour` to produce isoline polygons.
- Each polygon is materialized as an `L.polygon` SVG element in the Leaflet `overlayPane`.
- On every slider tick, polygons are recreated for the new frame.

This worked well at the early stage (small viewports, few tiles). With the new tile-first precompute and the wider regional coverage (Lausanne + Nyon + Morges + Vevey + Genève), realistic viewports now expose 30–100+ tiles simultaneously. At that scale:

- DOM SVG elements explode (often 100+ rings per tile).
- Slider interactions trigger full re-creation of all `L.polygon` instances per frame.
- Frame rate collapses below interactive thresholds.

A naive switch to "all bitmap" solves the throughput problem but loses the precision and crispness of the vector rendering at high zoom — exactly the regime where users zoom in to inspect a specific terrace or street corner.

## Decision

Adopt a **hybrid LOD strategy** with two orthogonal axes.

### Axis 1: Render mode by zoom + visible tile count

| Condition | Mode |
|---|---|
| Zoom ≥ ~18 AND visible tiles ≤ ~5 | Vector (existing path, scoped to viewport) |
| Otherwise | Bitmap (per-tile canvas) |

Hysteresis at the boundary to avoid mode-flapping during slow zoom.

### Axis 2: Adaptive bitmap resolution

When in bitmap mode, the per-tile canvas is dimensioned to the screen footprint of the tile at the current zoom, capped at the native grid resolution and clamped to a safe DPR ceiling:

```
target_px = ceil(grid_size_m × px_per_m_at_current_zoom × DPR)
canvas.{width,height} = clamp(target_px, MIN_RES, native_grid_size)
```

Re-rasterization is triggered on `zoomend` only when the new target deviates from the current canvas size by more than ~50%, so that minor zoom adjustments don't cost CPU.

### Projection precision

The bitmap path uses the same 4-corner bilinear interpolation that the vector path already uses internally. The four `tileCorners` (lat/lon) are computed server-side via `lv95ToWgs84Precise` (cf. ADR-0018) and shipped with each tile in the SSE stream. The client builds a CSS `transform: matrix(...)` from these four corners projected through `latLngToLayerPoint`. This is mathematically equivalent to the per-vertex bilinear reprojection done today by `buildTileContourPolygons`, with the same residual error (<1 cm over 250 m, sub-pixel at any practical zoom).

### Downsample algorithm

When the target bitmap resolution is smaller than the native grid (low zoom), the box-filter (area average) downsample is the default: each output pixel represents the mean sun coverage of the cells it spans. A `max-shadow` (conservative) variant remains available behind a flag for users who explicitly want pessimistic shading.

Nearest-neighbor is rejected: it makes thin shadow bands disappear unpredictably as zoom changes.

## Consequences

### Positive

- **Throughput** scales with screen pixels rather than with grid cells × visible tiles. At zoom 14 with 50 tiles, a tile occupying 10×10 px is rasterized at 10×10 instead of 250×250 — ~625× fewer pixels in memory.
- **No precision loss** vs the current vector path, because the projection chain is identical (`lv95ToWgs84Precise` → `tileCorners` → bilinear via 4 corners).
- **Vector path retained** where it shines: zoomed-in inspection of a specific area, where smooth contours and sub-pixel accuracy matter and where tile count is bounded.
- **DPR-aware** rendering keeps the overlay crisp on Retina/high-density screens up to a configurable cap (DPR=2 by default to bound RAM).
- **Frustum culling** added incidentally: only tiles intersecting the extended viewport are painted/kept in DOM, in both modes.

### Negative

- The render module becomes more complex: a small state machine selects mode and resolution per zoom event, and the per-tile overlay class manages two lifecycles (vector L.polygon vs canvas).
- Re-rasterization on zoom incurs a CPU cost. Mitigated by the >50% delta threshold and by reusing the `<canvas>` instance rather than recreating it.
- The DPR cap means very-high-density screens (DPR=3, DPR=4) won't see pixel-perfect detail at maximum zoom in bitmap mode. The vector mode covers that case for the few tiles in view at high zoom.
- The downsample step adds some up-front cost vs a pure native rasterization, but this is amortized by the reduction in per-frame paint cost.

### Out of scope

- The existing global heatmap pipeline (Pipeline C in the current code) is **not** migrated by this ADR. It remains a single canvas calé sur `overlayBounds`, since it's a one-shot render at the end of the timeline rather than a per-frame interactive surface.
- Optionally moving `paintTileImageData` into a worker via `OffscreenCanvas` is left as a follow-up, conditional on a measured paint cost above ~5 ms per tile per frame after this refactor.

## Alternatives considered

- **All-bitmap with native grid resolution per tile.** Simpler but wastes memory at low zoom and loses the crisp vector rendering at high zoom. Rejected.
- **Single global canvas covering `overlayBounds`.** Avoids per-tile bookkeeping but introduces sub-pixel misalignment at tile boundaries (each tile has its own LV95 alignment) and forces a uniform resolution across the entire region. Rejected.
- **`L.GridLayer` with custom canvas tiles.** Would align to Leaflet's Web Mercator tile grid, not the LV95 tiles emitted by the precompute. Mismatched grids would force a reprojection step on every paint. Rejected.
- **Snap-to-nearest-bucket or compute-on-demand at the API layer** (cf. memory `project_bitmap_overlay_lod.md` siblings). These address a different problem (atlas coverage gaps for years outside the precomputed window), not the rendering throughput. Independent decisions.

## Implementation pointer

The full phased implementation plan lives in the project memory `project_bitmap_overlay_lod.md`. This ADR captures only the architectural decision and the trade-off envelope. The implementation will reference this ADR upon merge.
