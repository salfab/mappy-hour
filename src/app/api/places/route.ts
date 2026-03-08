import { NextResponse } from "next/server";

import { loadLausannePlaces } from "@/lib/places/lausanne-places";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get("category");
    const outdoorOnly = url.searchParams.get("outdoorOnly") === "true";
    const limitParam = Number(url.searchParams.get("limit") ?? "500");
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), 2000)
        : 500;

    const placesFile = await loadLausannePlaces();
    if (!placesFile) {
      return NextResponse.json(
        {
          error:
            "No places dataset found. Run ingest:lausanne:places to fetch OSM places.",
        },
        { status: 404 },
      );
    }

    let places = placesFile.places;
    if (category === "park" || category === "terrace_candidate") {
      places = places.filter((place) => place.category === category);
    }
    if (outdoorOnly) {
      places = places.filter((place) => place.hasOutdoorSeating);
    }

    places = places.slice(0, limit);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: placesFile.generatedAt,
      totalFiltered: places.length,
      categories: placesFile.categories,
      places,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load places dataset.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
