# ADR-0006: Streaming Tile-by-Tile Architecture and Canvas Rendering

**Date:** 2026-04-04 / 2026-04-05
**Status:** Accepted (implemented)

## Context

The original timeline SSE endpoint accumulated ALL tile artifacts in memory before sending frames to the client. With the GPU shadow backend producing 1m-resolution grids, a viewport covering 99+ tiles (Bourget → Ouchy) caused:

1. **Server OOM** — 99 tiles × ~60 MB each = ~6 GB, exceeding Node.js heap
2. **Client freeze** — 670K+ Leaflet vector polygons crashed the browser
3. **No partial results** — users waited 20+ minutes with no feedback

## Decision

### Server: Stream tiles one at a time

Replace the batch flow (`resolveSunlightTilesForBbox` → `buildTimelineFromArtifacts` → stream frames) with an async generator `streamTilesForBbox` that yields one tile at a time.

**New SSE protocol:** `start` → `tile` × N (with `progress` interleaved) → `done`

Each `tile` event contains the tile's outdoor points and 60 frame masks, re-indexed to tile-local outdoor indices. The server processes one tile, sends it, then drops the reference — memory stays at O(1 tile) regardless of total tile count.

Key implementation details:
- `streamTilesForBbox` is an `AsyncGenerator` in `sunlight-tile-service.ts`
- `stripArtifactDiagnostics` removes unused diagnostic arrays before sending
- `skipMemoryCache: true` prevents tile artifacts from accumulating in the TTL cache
- Tile disk persistence happens before streaming (via `getOrCreateTileArtifact`)

### Client: Canvas overlay instead of vector polygons

For grids exceeding 10K points (`CANVAS_OVERLAY_THRESHOLD`), render sunlight/shadow as a single `L.imageOverlay` with a canvas bitmap instead of individual `L.polygon()` calls.

- `prepareSunShadowGrid` builds a pixel map from tile row/col → canvas coordinates (once)
- `paintSunShadowFrame` writes RGBA pixels via `ImageData` + `putImageData` (per slider change)
- `canvas.toDataURL()` feeds Leaflet's `imageOverlay.setUrl()`
- `image-rendering: pixelated` prevents interpolation artifacts
- Bounds computed via LV95→WGS84 extrapolation from a reference point

Client tile batching: incoming `tile` SSE events accumulate in a `useRef` buffer and flush to React state every 3 seconds or 5 tiles, preventing re-render storms.

### Cache-only mode

A `cacheOnly` query parameter serves only pre-computed tiles from disk:
- Skips `getSunlightModelVersion` (no GPU init) — resolves hash from cache directory
- Skips `buildGridFromBbox` (no OOM on large zones)
- Skips `maxPoints` check — all cached tiles served
- `findCachedModelVersionHash` scans cache directories with 3-level fallback: exact date+time → exact date any time → any date
- Tries all available time windows per tile (a tile cached in `t0600-2100` is found even when requesting `08:00-22:00`)

### Precompute CLI

Added `--bbox` option to `scripts/precompute/precompute-region-sunlight.ts` for zone-specific precomputation. Combined with `--skip-existing=true`, the script is resilient to interruption.

### Additional improvements

- **OOM fix:** `stripDiagnostics` option removes ~1.8 GB of unused diagnostic arrays from accumulated artifacts
- **Eval loop:** Skip unused distance diagnostic arrays, precompute sun position once per frame instead of per point
- **SSE resilience:** Guard `sendEvent`/`controller.close()` against closed controllers; client auto-reconnects on network errors with frame deduplication
- **Progress bar:** High-water mark prevents backward jumps; elapsed time shown on completion
- **Map layer control:** Floating `L.control.layers` toggle for Carte/Satellite
- **maxComputeTiles:** Limits tiles needing computation (default: 50), cached tiles don't count
- **GPU env:** `.env` with `MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster`

## Performance

| Metric | Before | After |
|--------|--------|-------|
| Server memory (99 tiles) | OOM crash at 4 GB | ~200 MB peak |
| Client render (670K pts) | Browser freeze | Canvas overlay, responsive |
| Cache-only (25 tiles) | N/A | 9 seconds, no GPU |
| Cache-only (149 tiles) | N/A | 68 seconds, no GPU |
| Slider frame change | Rebuild 670K objects | `putImageData` + `toDataURL` |

## Key files

| File | Role |
|------|------|
| `src/lib/precompute/sunlight-tile-service.ts` | `streamTilesForBbox`, `stripArtifactDiagnostics`, `loadTileDiskOnly` |
| `src/app/api/sunlight/timeline/stream/route.ts` | Tile streaming SSE route, `cacheOnly`, `maxComputeTiles` |
| `src/components/sunlight-map-client.tsx` | Canvas overlay, tile batching, layer control |
| `src/lib/precompute/sunlight-cache.ts` | `findCachedModelVersionHash`, multi-timewindow discovery |
| `src/lib/sun/solar.ts` | `solarPositionOverride` for per-frame sun position |
| `scripts/precompute/precompute-region-sunlight.ts` | `--bbox` option |
| `docs/architecture/building-model-vs-osm.md` | Building model vs OSM differences |
