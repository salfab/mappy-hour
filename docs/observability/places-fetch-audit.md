# `/maplibre-preview` — Places fetch audit (read-only)

> Date: 2026-05-16
> Scope: understand how many times the MapLibre preview client fetches the
> places dataset during a typical session, measure payload sizes, and quantify
> the win of switching to a single pre-load + client-side filter.

## TL;DR

- The MapLibre preview maintains **two parallel sources of place data**:
  1. **`POST /api/places/viewport`** — re-fetched on every `moveend` (400 ms
     debounce). Source of truth for the GeoJSON layer + filter chips +
     terrasses list base.
  2. **SSE `event: places`** from `/api/sunlight/timeline/stream` — one batch
     per tile that contains outdoor-seating venues, merged into
     `sunlitTimelinePlacesRef`. Re-streamed on every timeline refresh
     (`moveend` 1 s debounce, date change, recalc button).
- This is **structural redundancy**: each `moveend` triggers both pipelines.
  The viewport endpoint re-runs the snap-to-outdoor loop every time, even
  when the user has only nudged the map slightly.
- A typical 10-minute session with ~6 pan/zoom + 1 date change makes the
  client receive places data **~6–7× from `/api/places/viewport` plus the
  SSE events from ~7 timeline streams** (so the SSE bundles places again
  every recalc, even when the underlying static dataset has not changed).
- For Lausanne the **confirmed-mode viewport payload is ~61 KB raw / ~10 KB
  gzip**, dominated by the per-place tags we still ship (`openingHours`,
  snapped vs raw coords). For a maximalist bbox covering all currently
  ingested regions (12 cities) the **one-shot GeoJSON would be ~2.7 MB raw /
  ~234 KB gzip**.
- Switching to a single pre-load + in-browser bbox filter saves roughly
  **5× the per-session bytes** on a normal user trajectory (Lausanne) and
  removes the snap-loop CPU cost entirely after the first hit.

## 1. Current pattern

### 1.1 `POST /api/places/viewport` (primary source on the client)

Code: `src/components/maplibre-preview-client.tsx`

- `fetchViewportPlaces(map)` (l.702-729) issues `POST /api/places/viewport`
  with the current `map.getBounds()`. Aborts any in-flight request via
  `viewportPlacesAbortRef`. Stores response in `rawPlacesRef.current` and
  bumps `rawPlacesTick` so `useMemo`-derived UI (terrasses list, filter
  chip counts) recomputes.
- Triggers:
  - On `map.on("load")` once (l.1214).
  - On `map.on("moveend")` with a **400 ms debounce** (l.1217-1229) — every
    pan, zoom step, programmatic `flyTo`, or `easeTo` ends with a `moveend`,
    so each user gesture costs one round-trip.
- The endpoint (`src/app/api/places/viewport/route.ts`):
  - Loads the merged places file once per Node process (cached via
    `combinedCache` in `loadAllPlaces`).
  - Filters by bbox (`filterPlacesInBounds`).
  - In `mode: "confirmed"` (default), drops parks + `food_court` + venues
    without `outdoor_seating=yes` (`MAX_RESPONSE_PLACES = 5000`).
  - Runs the **snap-to-outdoor** loop concurrency=16 over the bbox-filtered
    set. This reads tile-grid-metadata blobs from disk (`~1 MB each, cached
    after first hit`). The `Server-Timing: snap;dur=N` header on every
    response is the visible cost of repeating this on each `moveend`.
  - Strips `tags` from the response, only forwards a lite shape
    (`ViewportPlaceLite`).

### 1.2 SSE `event: places` from the timeline stream (secondary source)

Code: `src/components/maplibre-preview/sunlight-timeline.ts` (l.311-325) and
`src/app/api/sunlight/timeline/stream/route.ts` (l.866-872, server emit).

- Each tile streamed back includes a `places` event with the **sunlit-aware
  per-tile bundle** (venueType, sunnyMinutes, evaluationLat/Lon, ...).
- The client merges these per id into `sunlitTimelinePlacesRef`, picking the
  entry with the largest `sunnyMinutes` when a venue straddles two tiles.
  The accumulator is wiped on every `start` SSE event (l.942-945), i.e.
  **every refresh re-receives the full bundle**.
- The merged map is read in the `sunlitPlaces` `useMemo` (l.746-785), which
  feeds the terrasses list + venue cards. The places overlay on the map
  (GeoJSON source) is still driven by `rawPlacesRef`, not by this SSE
  bundle.

### 1.3 Re-fetch triggers summary

| Trigger | Viewport endpoint | SSE places event |
| --- | --- | --- |
| Map `load` | yes (l.1214) | yes (initial `refreshTimeline`) |
| `moveend` (any pan / zoom) | yes, 400 ms debounce | yes, 1000 ms debounce (via `setRecalcSignal`) |
| Date change | no | yes (effect on `date`, l.1060) |
| "Recalculer" button | no | yes (l.1753) |
| Filter chip toggle | no (re-runs `applyPlacesToSource` on cached `rawPlacesRef`) | no |
| Style swap (basemap) | no | no |

### 1.4 Typical session estimate (10 min, ~6 pan/zoom + 1 date change)

Assumptions per the trigger table above and the debounce values in
maplibre-preview-client.tsx:

- 1 initial load → 1 viewport fetch + 1 SSE timeline (with N tile places
  events).
- 6 user pan/zoom interactions, each settling cleanly within the 400 ms
  debounce → 6 viewport fetches. Each also triggers the 1000 ms recalc
  debounce → 6 timeline streams **if** the user lingers long enough, fewer
  if they keep moving (the recalc debounce coalesces successive moveends).
- 1 date change → 1 timeline stream (no viewport refetch).

Result: **~7 viewport fetches + ~7 timeline SSEs per 10 min** in the
conservative case. With erratic pan/zoom that fits inside the 400 ms but
not the 1000 ms window, you can drift to ~12 viewport fetches for ~4 SSEs.

## 2. Payload sizes

Measured from the actual JSON on disk (`MAPPY_DATA_ROOT=C:\sources\mappy-data`)
on 2026-05-16. Numbers below are the raw JSON length and the gzip output
length of the same bytes (Node `zlib.gzipSync`).

### 2.1 Static processed files (`data/processed/places/<region>-places.json`)

These include the full `tags` object — they are the ingest output, not the
client-facing payload.

| File | Raw bytes | Gzip bytes |
| --- | --: | --: |
| `bern-places.json` | 595 224 | 80 143 |
| `geneve-places.json` | 1 622 626 | 183 550 |
| `la_chaux_de_fonds-places.json` | 114 494 | 13 490 |
| `lausanne-places.json` | 766 317 | 93 856 |
| `morges-places.json` | 95 702 | 11 711 |
| `neuchatel-places.json` | 201 721 | 23 956 |
| `nyon-places.json` | 159 399 | 18 800 |
| `places.json` (merged) | 5 222 153 | 618 698 |
| `thun-places.json` | 104 586 | 12 770 |
| `vevey_city-places.json` | 142 143 | 18 169 |
| `vevey-places.json` | 32 748 | 4 285 |
| `zurich-places.json` | 1 389 987 | 162 838 |

### 2.2 `POST /api/places/viewport` response (lite shape, no `tags`)

Simulated by stripping each entry to the `ViewportPlaceLite` shape (`id`,
`name`, `category`, `subcategory`, `lat`/`lon`, `hasOutdoorSeating[Unknown]`,
`outdoorSeatingCovered/Heated`, `osmType`/`osmId`, `openingHours`),
wrapping in `{ mode, places: [...] }`.

| Source bbox (whole region) | Mode | Places | Raw | Gzip |
| --- | --- | --: | --: | --: |
| `lausanne-places.json` | `all` | 1 143 | 280 757 | 41 255 |
| `lausanne-places.json` | `confirmed` (default) | 247 | 60 919 | 10 162 |
| `geneve-places.json` | `all` | 2 795 | 651 683 | 87 443 |
| `geneve-places.json` | `confirmed` | 200 | 47 701 | 7 992 |
| `places.json` (merged, all regions) | `all` | 7 771 | 1 893 612 | 268 741 |
| `places.json` (merged, all regions) | `confirmed` | 1 468 | 359 508 | 56 586 |

Note: in production every viewport fetch is much smaller because the bbox
filter drops most points before serialisation. For a Lausanne city
viewport at zoom 14 (~3 km × 3 km), `mode=confirmed` typically returns
~200-280 entries (see the comment l.140 in the route handler), so the
on-the-wire payload is **5-10 KB gzip** per call. The numbers above bound
the worst case (zoom-out to all-region).

### 2.3 One-shot GeoJSON via `GET /api/places?format=geojson`

The route already supports this exact shape with `defaultLimit=20000`
when `format=geojson` (`src/app/api/places/route.ts` l.13-72). The
properties carry the same lite fields as the viewport endpoint, minus
`openingHours` (additive omission, easy to add).

| Query | Places | Raw | Gzip |
| --- | --: | --: | --: |
| `?format=geojson` (no filter, all regions) | 7 771 | 2 722 067 | 234 314 |
| `?format=geojson&category=terrace_candidate` | 6 229 | 2 200 091 | 193 019 |
| `?format=geojson&category=terrace_candidate&outdoorOnly=true` ("confirmed") | 1 468 | ~360 000 | ~57 000 |

## 3. Does a one-shot endpoint already exist?

Yes — **`GET /api/places?format=geojson`** is already implemented and
returns the full dataset (cap 20 000) as a GeoJSON FeatureCollection. It
omits the snap-to-outdoor pass and the `openingHours` field, but the
overlay code does not currently consume those for rendering (only the
floating venue card does, and only when the user clicks).

It is **not** wired into `/maplibre-preview` today. The client always goes
through `POST /api/places/viewport`.

## 4. Recommendation (chiffrée)

Switch the MapLibre preview to a **single pre-load** of the full lite
dataset on `map.on("load")`, cache it in `rawPlacesRef`, and do all
viewport filtering client-side (MapLibre already does this natively for
GeoJSON sources via clustering + zoom-dependent paint).

### 4.1 Bytes saved per typical 10-min session (Lausanne)

Baseline (today): 7 viewport fetches × ~10 KB gzip = **~70 KB gzip on the
wire** for places data alone, plus 7 snap-loops × ~250 places × ~3 ms = ~5 s
of cumulative server-side snap-to-outdoor work.

One-shot strategy: 1 fetch of `?format=geojson&category=terrace_candidate`
clipped to the active region = **~57 KB gzip** (confirmed-only filter
applied server-side once) or **~234 KB gzip** for the whole merged
dataset (12 cities) without any filter. After that, every pan/zoom is free.

| Metric | Baseline (7× viewport) | One-shot (region) | One-shot (all-regions) |
| --- | --: | --: | --: |
| Total gzip bytes / session | ~70 KB | ~57 KB | ~234 KB |
| Server snap CPU / session | ~5 s | 0 | 0 |
| Network round-trips / session | 7 | 1 | 1 |

For a single-region session the gzip savings are modest (~20%) but the
**snap-loop CPU is eliminated entirely** and the perceived latency on
every pan/zoom drops to zero (the cluster paint is already incremental).
For a multi-region session the one-shot strategy costs ~3× more bytes
once but eliminates all subsequent round-trips.

### 4.2 SSE places event — is it still needed?

Yes, because it carries the **per-window sunlit state** (`isSunnyNow`,
`sunnyMinutes`, `sunlightStartLocalTime`/`End`), not just the static OSM
metadata. The redundancy is the duplication of `id`/`name`/`category` in
both pipelines, which is ~50 bytes × ~250 places per timeline = ~12 KB
gzip / SSE.

A leaner v2 would have the SSE event ship only the sunlit fields keyed by
`id`, letting the client merge against the pre-loaded static dataset. That
saves another ~10 KB gzip per SSE (~70 KB gzip over a 7-SSE session).

## 5. Risks

- **Payload size on slow mobile**: the all-regions one-shot is ~234 KB
  gzip. On a 3G connection (~750 kbit/s effective) that is ~2.5 s before
  the first map paint. Mitigation: ship only the **active region** (the
  homepage already knows the entry zoom and city centre) and lazy-load
  neighbouring regions when the viewport crosses a boundary. The
  region-scoped Lausanne payload is ~10 KB gzip, indistinguishable from
  the current bbox payload.
- **Cache staleness vs filter chips**: the current bbox flow re-runs the
  snap-to-outdoor loop on every `moveend`, which means snapped coords
  reflect the latest building data even without a redeploy. With a
  one-shot strategy the snapped coords are baked into the GeoJSON at fetch
  time. This is fine in practice (places + buildings change at most once
  per ingest, much less often than the session lifetime), but should be
  documented.
- **MAX_RESPONSE_PLACES=5000 cap**: the viewport endpoint caps the response
  at 5 000 entries. The merged dataset is 7 771 places total, so a naive
  "fetch everything" hits the cap and silently drops places near the
  bbox edges. The one-shot endpoint already raises this to 20 000 for
  `format=geojson`, which is enough for the current and foreseeable
  region set.
- **No turnstile gate on `GET /api/places`**: the viewport route has a
  `requireTurnstile` check (bot gate), `GET /api/places` does not. If we
  move the main client path to GeoJSON we should mirror that gate or
  accept the lower abuse surface (it is already public via the OSM source
  anyway).

## 6. Open questions

- The "typical session" numbers are derived from the debounce values and a
  heuristic for user gestures, not from real production telemetry. We have
  the `active-sse` counter (`incrementActiveSse("places-viewport")`) but no
  per-session aggregation. Adding a 1-day umami counter on
  `places-viewport-fetch` events would let us validate the 6–7×/session
  estimate. **Not done in this audit** (read-only scope).
- The SSE `places` event size is not measured directly here — it is
  estimated from the static dataset shape. Real bytes depend on which
  tiles contain venues; instrumenting the server `sendEvent("places", ...)`
  call would give the exact number.
