import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  decrement as decrementActiveSse,
  increment as incrementActiveSse,
} from "@/lib/observability/active-sse";
import { loadAllPlaces } from "@/lib/places/lausanne-places";
import {
  filterPlacesInBounds,
  type NormalizedPlaceLite,
} from "@/components/places-overlay/viewport-places";
import {
  mapWithConcurrency,
  snapPlaceToOutdoor,
} from "@/lib/places/snap-to-outdoor";
import {
  getPrecomputedRegionBbox,
  type PrecomputedRegionName,
} from "@/lib/precompute/sunlight-cache";
import { resolveRegionForBbox } from "@/lib/precompute/sunlight-tile-service";
import { requireTurnstile } from "@/lib/security/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/places/viewport`
 *
 * Returns the places inside a bbox, with each point already snapped out of
 * any indoor footprint. The request body accepts a `mode` field:
 *
 *  - `mode: "confirmed"` (DEFAULT) — server-side prefilter keeps only HORECA
 *    terrasses with `outdoor_seating=yes`, drops `food_court` subcategory
 *    and the `park` category. This is what the Leaflet places overlay and
 *    the MapLibre preview consume. ~75% of places are dropped before the
 *    snap-to-outdoor loop, which cuts cold-cache latency ~4×.
 *  - `mode: "all"` — return every place in the bbox (parks + unconfirmed
 *    terrace candidates included). For debug / future features.
 *
 * `mode` can also be passed as a `?mode=` query string (body wins on
 * conflict). Response: `{ generatedAt, sourceGeneratedAt, mode, places }`.
 * The `Server-Timing: snap;dur=N` header reports the snap-loop wall time.
 *
 * Lite shape of a place returned by `/api/places/viewport`. The heavy `tags`
 * field from the raw OSM record is stripped — the booleans + osmType/osmId
 * we send back are enough for the rendering layer and the floating card's
 * "View on OSM" link.
 */
export interface ViewportPlaceLite extends NormalizedPlaceLite {
  osmType: "node" | "way" | "relation";
  osmId: number;
  outdoorSeatingCovered?: "yes" | "no" | "partial";
  outdoorSeatingHeated?: boolean;
}

const bodySchema = z.object({
  south: z.number().min(-90).max(90),
  west: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
  /** Filter mode applied server-side BEFORE the snap loop.
   *  - `confirmed` (default): only HORECA terraces with explicit
   *    `outdoor_seating=yes`, excluding `food_court` (typically indoor mall
   *    galleries) and parks. Matches the app's "Mappy HOUR" UX default and
   *    saves the snap-to-outdoor cost on ~75% of dropped places.
   *  - `all`: return every place in the bbox (debug / future features that
   *    want to show parks or unknown-outdoor candidates client-side). */
  mode: z.enum(["confirmed", "all"]).optional(),
  /** Bbox scope used to pick the candidate set BEFORE the snap loop.
   *  - `viewport` (default): only places strictly inside `{south,west,north,east}`.
   *    Used by the legacy per-pan/zoom fetch that the Leaflet client (and the
   *    initial MapLibre preview) issues on every moveend.
   *  - `region`: ignore the bbox extent and serve every place that lives in
   *    the precomputed region inferred from that bbox (used to resolve which
   *    region the user is looking at). The MapLibre preview switched to this
   *    one-shot mode in 2026-05 so the client can keep the full catalogue in
   *    memory and filter visible markers locally on pan/zoom — no more
   *    re-fetch per viewport change. The bbox MUST still be a valid Swiss
   *    coordinate; we use it solely to pick a region. */
  scope: z.enum(["viewport", "region"]).optional(),
});

export type ViewportPlacesMode = "confirmed" | "all";
export type ViewportPlacesScope = "viewport" | "region";

// Hard cap so the JSON payload never explodes. The default `viewport` scope
// caps at 5000 to keep moveend fetches small; the `region` scope (one-shot
// catalogue load on mount) bumps to 8000 to cover Geneva-class regions whose
// confirmed-terrasses count tops out around ~3k.
const MAX_RESPONSE_VIEWPORT = 5000;
const MAX_RESPONSE_REGION = 8000;

// Outdoor-snap concurrency. Reads gunzipped tile-grid-metadata blobs (~1 MB
// each, cached after the first hit). 16 keeps disk I/O bursts bounded while
// still letting cold tiles overlap. ~500 places typically map onto 4–10
// distinct tiles in a city viewport, so the cap rarely matters in practice.
const SNAP_CONCURRENCY = 16;

export async function POST(request: Request) {
  // Bot gate. In dev (no `TURNSTILE_SECRET_KEY`) this short-circuits to ok.
  // See `src/lib/security/turnstile.ts` + `docs/security/turnstile.md`.
  const gate = requireTurnstile(request);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "turnstile-required", reason: gate.reason },
      { status: 403 },
    );
  }

  // Mark this request as in-flight so /api/admin/diag/system can correlate
  // CPU pressure with concurrent viewport snap-loops. Paired with the
  // matching `decrement` in the `finally` block so the counter cannot
  // drift on exception, abort, or early return.
  incrementActiveSse("places-viewport");
  try {
    const raw = (await request.json()) as unknown;
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid bbox body. Expected { south, west, north, east } numbers.",
          details: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }
    const bounds = parsed.data;
    if (bounds.south > bounds.north || bounds.west > bounds.east) {
      return NextResponse.json(
        { error: "Invalid bbox: south>north or west>east." },
        { status: 400 },
      );
    }
    // Query-string override lets quick `curl ...?mode=all` debugging work
    // without crafting the body. Body field wins if both are present.
    const url = new URL(request.url);
    const queryMode = url.searchParams.get("mode");
    const mode: ViewportPlacesMode =
      parsed.data.mode ??
      (queryMode === "all" || queryMode === "confirmed" ? queryMode : "confirmed");
    const queryScope = url.searchParams.get("scope");
    const scope: ViewportPlacesScope =
      parsed.data.scope ??
      (queryScope === "region" || queryScope === "viewport" ? queryScope : "viewport");

    const placesFile = await loadAllPlaces();
    if (!placesFile) {
      return NextResponse.json(
        {
          error:
            "No places dataset found. Run ingest:lausanne:places to fetch OSM places.",
        },
        { status: 404 },
      );
    }

    // Resolve which precomputed region the request points at (used for the
    // response payload and, when `scope=region`, to widen the candidate
    // bbox to the entire region rather than the viewport on screen).
    const region: PrecomputedRegionName | null = resolveRegionForBbox({
      minLon: bounds.west,
      maxLon: bounds.east,
      minLat: bounds.south,
      maxLat: bounds.north,
    });

    let filtered: typeof placesFile.places;
    if (scope === "region") {
      // One-shot catalogue load: ignore the viewport and serve every place
      // in the resolved region. The bbox argument is still required so we
      // can pick the right region (and so legacy clients keep working).
      if (!region) {
        return NextResponse.json(
          {
            error:
              "Could not resolve a precomputed region from the supplied bbox.",
          },
          { status: 400 },
        );
      }
      const regionBbox = getPrecomputedRegionBbox(region);
      filtered = filterPlacesInBounds(placesFile.places, {
        south: regionBbox.minLat,
        west: regionBbox.minLon,
        north: regionBbox.maxLat,
        east: regionBbox.maxLon,
      });
    } else {
      filtered = filterPlacesInBounds(placesFile.places, bounds);
    }

    // Server-side default filter. Applied BEFORE the snap loop so we don't
    // pay the (~3ms/place cold) snap cost on places nobody will see. On a
    // Lausanne-city bbox this drops the input from ~1050 to ~280 places.
    if (mode === "confirmed") {
      filtered = filtered.filter((place) => {
        if (place.category === "park") return false;
        if (place.subcategory === "food_court") return false;
        return place.hasOutdoorSeating === true;
      });
    }

    const cap = scope === "region" ? MAX_RESPONSE_REGION : MAX_RESPONSE_VIEWPORT;
    filtered = filtered.slice(0, cap);

    // Snap each place out of any building it lands inside. Independent
    // per-place; bounded fan-out so we don't issue 500 disk reads at once.
    const snapStarted = performance.now();
    const snaps = await mapWithConcurrency(filtered, SNAP_CONCURRENCY, (place) =>
      snapPlaceToOutdoor({ lat: place.lat, lon: place.lon }),
    );
    const snapElapsedMs = performance.now() - snapStarted;
    if (filtered.length > 0) {
      // Single line per request — keeps the log tractable while still
      // giving us a signal in case the snap loop ever explodes (cold
      // cache, big viewport, etc).
      process.stderr.write(
        `[places/viewport] snap places=${filtered.length} elapsed=${snapElapsedMs.toFixed(0)}ms avg=${(snapElapsedMs / filtered.length).toFixed(2)}ms\n`,
      );
    }

    const lite: ViewportPlaceLite[] = filtered.map((place, i) => {
      // Surface the raw OSM `opening_hours` tag as a top-level `openingHours`
      // string. The rest of `tags` is intentionally NOT serialised — it would
      // bloat the payload by 5-10× on dense viewports. Additive field: every
      // existing consumer keeps working since they never read it.
      const openingHoursRaw = place.tags?.opening_hours;
      const openingHours =
        typeof openingHoursRaw === "string" && openingHoursRaw.trim().length > 0
          ? openingHoursRaw
          : undefined;
      const snap = snaps[i];
      const snappedLat = Math.round(snap.lat * 1_000_000) / 1_000_000;
      const snappedLon = Math.round(snap.lon * 1_000_000) / 1_000_000;
      const moved = snap.selectionStrategy === "terrace_offset";
      return {
        id: place.id,
        name: place.name,
        category: place.category,
        subcategory: place.subcategory,
        // Primary `lat`/`lon` are the snapped coordinates — the overlay
        // renders these. When the snap didn't move the point (or we had
        // no indoor signal), these equal the OSM values.
        lat: snappedLat,
        lon: snappedLon,
        // Raw OSM coords preserved only when we actually nudged the point,
        // to keep the payload small for the common case.
        osmLat: moved ? place.lat : undefined,
        osmLon: moved ? place.lon : undefined,
        selectionStrategy: snap.selectionStrategy,
        hasOutdoorSeating: place.hasOutdoorSeating,
        hasOutdoorSeatingUnknown: place.hasOutdoorSeatingUnknown,
        outdoorSeatingCovered: place.outdoorSeatingCovered,
        outdoorSeatingHeated: place.outdoorSeatingHeated,
        osmType: place.osmType,
        osmId: place.osmId,
        openingHours,
      };
    });

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        sourceGeneratedAt: placesFile.generatedAt,
        mode,
        scope,
        // `null` when the caller's bbox did not overlap any precomputed
        // region — useful for the client to detect "user panned outside
        // every known city" and short-circuit subsequent fetches.
        region,
        places: lite,
      },
      {
        headers: {
          // Lets the browser devtools surface the snap cost without
          // sprinkling client-side timers everywhere.
          "Server-Timing": `snap;dur=${snapElapsedMs.toFixed(1)}`,
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to compute viewport places.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  } finally {
    decrementActiveSse("places-viewport");
  }
}
