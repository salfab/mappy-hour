# Audit `src/components/sunlight-map-client.tsx` (4871 lignes)

## Sections (sommaire navigable)

| Plage | Rôle |
|---|---|
| 1-424 | Types & interfaces (API, state, géométrie) |
| 446-1033 | Helpers : storage parsers, URL parsers, géométrie |
| 1070-2083 | Builders viz : contours, canvas, heatmap |
| 2084-2187 | Composant + 28 useState + 12 useRef |
| 2189-2362 | Memos dérivés (visualAreaResponse, exposurePoints, helperText) |
| 2364-2828 | Effects init + UI params + persistance |
| 2921-3358 | Effects carte Leaflet + renderLayers |
| 3361-3670 | Effects canvas/overlay (sliderable + heatmap) |
| 3672-4445 | Effects focus run + deep link + auto-apply |
| 3815-4358 | **`runAreaCalculation` HOTSPOT** (instant + daily streaming) |
| 4447-4871 | JSX rendu (controls, slider, places list) |

## Hotspots de complexité

### A. `runAreaCalculation` (3816-4358, ~540 lignes) — CRITICAL
Fusion de 2 protocoles : EventSource (instant) + ReadableStream + manual SSE parsing (daily). Variables dupliquées (`streamFinished`/`streamFailed` × 2). Logique placesRequest inline imbriquée. Extraire `useInstantStream` + `useDailyStream`. **Effort: L**

### B. `handleSseEvent` (4125-4242, ~120 lignes) — HIGH
Switch 5 branches × `JSON.parse(...) as Type` non validé. Schémas Zod manquants. **Effort: M**

### C. `renderLayers` (3075-3321, ~250 lignes) — HIGH
4 boucles for (sunny/shadow/veg/places) × L.polygon/circleMarker + bindPopup + click handlers imbriqués. Extraire micro-hooks. **Effort: M**

### D. `buildTileContourPolygons` (1394-1505) — MEDIUM
Flood-fill second pass non documenté (1451-1470). Pas de timeout protect contre grilles dégénérées. **Effort: M**

### E. `prepareSunShadowGrid` + `paintSunShadowFrame` (1233-1382) — MEDIUM
Couplage étroit prep/paint. Migrations format grid-indexed vs legacy non isolées. Abstraire `PixelMapper`. **Effort: M**

### F. `toInstantAreaResponseFromTimeline` (1744-1792) — MEDIUM
`((mask[i >> 3] >> (i & 7)) & 1)` sans bounds check. Risk OOB silencieux. **Effort: S**

## Findings groupés par section

### A. Parsing & Validation

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| A1 | **Critical** | 3937, 3945, 3953, 3982 | `JSON.parse()` SSE instant sans validation × 4 | M |
| A2 | **Critical** | 4129, 4171, 4216, 4221 | `JSON.parse()` SSE timeline sans validation × 4 | M |
| A3 | High | 3783-3790 | `placesJson?.places ?? []` sans validation array | S |

### B. Monolithic Callbacks

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| B1 | Critical | 3816-4358 | `runAreaCalculation` 540L = instant + daily fused | L |
| B2 | High | 4125-4242 | `handleSseEvent` switch + state updates fused | M |
| B3 | High | 3075-3321 | `renderLayers` 250L × 4 layers monolith | M |

### C. Type Safety

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| C1 | High | 3444, 3455, 3467, 3479, 3495 | `contourLayerRef.current!` × 5 (narrow once) | S |
| C2 | Medium | 3579 | `tile.tileBounds!.minLat/Lon/maxLat/Lon` × 4 | S |
| C3 | Medium | 2616, 2618 | `json.sample.buildingBlocker*!` IIFE | S |

### D. Algorithmic Documentation

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| D1 | Medium | 1451-1470 | Flood-fill non commenté | S |
| D2 | Medium | 1761 | `mask[i >> 3]` sans bounds check | S |
| D3 | Low | 1991 | `sunnyFrames[i] += 1` Uint16 risque overflow >65535 | S |

### E. State Management

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| E1 | Medium | 2099, 2101, 3927, 4089 | `instantCancelledRef` / `timelineCancelledRef` devraient être useState | M |
| E2 | Low | 2785-2828 | useEffect mélange orchestration + persistance | S |

### F. API Contract Brittleness

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| F1 | High | 3929, 4249 | Endpoints `/api/sunlight/*` hardcodés dispersés | S |
| F2 | Medium | 2556, 3760, 3920, 4080 | Timezone "Europe/Zurich" × 4 hardcoded | S |
| F3 | High | 3933+, 4128+ | SSE event types strings non typées (typo silencieuse) | S |
| F4 | Medium | 4198 | `masksEncoding === "gzip-concat-v1"` non versionné | S |
| F5 | High | 4128-4168 | SSE assume "start" first, pas de state machine | M |

### G. Performance & Memory

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| G1 | Medium | 2102, 4100, 4140, 4295 | `decodedTimelineMaskCacheRef` croît jusqu'au prochain run (~48MB) | M |
| G2 | Low | 3605-3609 | `canvas.toDataURL()` chaque slider move 60FPS | M |

### H. Error Handling

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| H1 | Medium | 4286-4287 | `Promise.all(pendingBlobDecodes)` rejection swallowed | S |
| H2 | Low | 4016-4048 | EventSource error fallback null sans console.error | S |

## Candidats d'extraction (priorisés)

1. **`useDailyStream`** (3816-4358 partial) — réduit `runAreaCalculation` de 280L. Effort S.
2. **`validateSSEPayload`** (8 sites) — Zod/valibot. Effort M.
3. **`SunlitPlacesList`** (4817-4866) — composant pur testable. Effort M.
4. **`useTilePixelMapper`** (1239-1274). Effort S.
5. **`maskDecoder` worker** (Map cache + decode). Effort M.
6. **`useMapViewPersistence`** (3007-3014). Effort S.
7. **`useTerrainHorizonDebugLayer`** (3260-3318). Effort S.

## Synthèse

| Sévérité | Count |
|---|---|
| Critical | 3 |
| High | 6 |
| Medium | 8 |
| Low | 3 |

~25-30 findings totaux. Effort cumulé : 1-2 sprints pour hardening + extraction full.
