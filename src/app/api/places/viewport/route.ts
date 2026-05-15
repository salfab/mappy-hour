import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { loadAllPlaces } from "@/lib/places/lausanne-places";
import {
  filterPlacesInBounds,
  type NormalizedPlaceLite,
} from "@/components/places-overlay/viewport-places";
import {
  mapWithConcurrency,
  snapPlaceToOutdoor,
} from "@/lib/places/snap-to-outdoor";

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
});

export type ViewportPlacesMode = "confirmed" | "all";

// Hard cap so the JSON payload never explodes (a worldwide bbox over a
// densely-mapped region could otherwise be megabytes). The client-side
// clusterer is fine with ~5k input candidates.
const MAX_RESPONSE_PLACES = 5000;

// Outdoor-snap concurrency. Reads gunzipped tile-grid-metadata blobs (~1 MB
// each, cached after the first hit). 16 keeps disk I/O bursts bounded while
// still letting cold tiles overlap. ~500 places typically map onto 4–10
// distinct tiles in a city viewport, so the cap rarely matters in practice.
const SNAP_CONCURRENCY = 16;

export async function POST(request: Request) {
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

    let filtered = filterPlacesInBounds(placesFile.places, bounds);

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

    filtered = filtered.slice(0, MAX_RESPONSE_PLACES);

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
  }
}
