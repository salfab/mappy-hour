import { NextResponse } from "next/server";

import { loadAllPlaces } from "@/lib/places/lausanne-places";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get("category");
    const outdoorOnly = url.searchParams.get("outdoorOnly") === "true";
    const format = url.searchParams.get("format");
    const isGeoJson = format === "geojson";
    // GeoJSON mode is intended for the MapLibre preview which needs the full
    // dataset client-side (no bbox-server-side filter — MapLibre handles
    // viewport culling natively). Bump the cap accordingly; bake is ~8k pts.
    const defaultLimit = isGeoJson ? 20000 : 500;
    const maxLimit = isGeoJson ? 20000 : 2000;
    const limitParam = Number(url.searchParams.get("limit") ?? String(defaultLimit));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), maxLimit)
        : defaultLimit;

    const placesFile = await loadAllPlaces();
    if (!placesFile) {
      return NextResponse.json(
        {
          error:
            "No places dataset found. Run ingest:lausanne:places and/or ingest:nyon:places to fetch OSM places.",
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

    if (isGeoJson) {
      // MapLibre-friendly GeoJSON FeatureCollection. Strip the heavy `tags`
      // object — the renderer only needs the lite props for paint / popups.
      const features = places.map((place) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [place.lon, place.lat] as [number, number],
        },
        properties: {
          id: place.id,
          name: place.name,
          category: place.category,
          subcategory: place.subcategory,
          hasOutdoorSeating: place.hasOutdoorSeating,
          hasOutdoorSeatingUnknown: place.hasOutdoorSeatingUnknown ?? false,
          outdoorSeatingCovered: place.outdoorSeatingCovered ?? null,
          outdoorSeatingHeated: place.outdoorSeatingHeated ?? null,
          osmType: place.osmType,
          osmId: place.osmId,
        },
      }));
      return NextResponse.json({
        type: "FeatureCollection",
        features,
      });
    }

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
