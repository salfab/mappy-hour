import { NextResponse } from "next/server";
import { z } from "zod";

import { loadAllPlaces } from "@/lib/places/lausanne-places";
import {
  filterPlacesInBounds,
  type NormalizedPlaceLite,
} from "@/components/places-overlay/viewport-places";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
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
});

// Hard cap so the JSON payload never explodes (a worldwide bbox over a
// densely-mapped region could otherwise be megabytes). The client-side
// clusterer is fine with ~5k input candidates.
const MAX_RESPONSE_PLACES = 5000;

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

    const filtered = filterPlacesInBounds(placesFile.places, bounds).slice(
      0,
      MAX_RESPONSE_PLACES,
    );

    const lite: ViewportPlaceLite[] = filtered.map((place) => {
      // Surface the raw OSM `opening_hours` tag as a top-level `openingHours`
      // string. The rest of `tags` is intentionally NOT serialised — it would
      // bloat the payload by 5-10× on dense viewports. Additive field: every
      // existing consumer keeps working since they never read it.
      const openingHoursRaw = place.tags?.opening_hours;
      const openingHours =
        typeof openingHoursRaw === "string" && openingHoursRaw.trim().length > 0
          ? openingHoursRaw
          : undefined;
      return {
        id: place.id,
        name: place.name,
        category: place.category,
        subcategory: place.subcategory,
        lat: place.lat,
        lon: place.lon,
        hasOutdoorSeating: place.hasOutdoorSeating,
        hasOutdoorSeatingUnknown: place.hasOutdoorSeatingUnknown,
        outdoorSeatingCovered: place.outdoorSeatingCovered,
        outdoorSeatingHeated: place.outdoorSeatingHeated,
        osmType: place.osmType,
        osmId: place.osmId,
        openingHours,
      };
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: placesFile.generatedAt,
      places: lite,
    });
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
