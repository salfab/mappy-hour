import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { loadLausannePlaces } from "@/lib/places/lausanne-places";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import { evaluatePointSunlight } from "@/lib/sun/solar";

export const runtime = "nodejs";

const requestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().default("Europe/Zurich"),
  sampleEveryMinutes: z.number().int().min(1).max(60).default(15),
  placeIds: z.array(z.string()).max(500).optional(),
  category: z.enum(["park", "terrace_candidate"]).optional(),
  outdoorOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
});

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request payload.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const started = performance.now();
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
    if (parsed.data.category) {
      places = places.filter((place) => place.category === parsed.data.category);
    }
    if (parsed.data.outdoorOnly) {
      places = places.filter((place) => place.hasOutdoorSeating);
    }
    if (parsed.data.placeIds && parsed.data.placeIds.length > 0) {
      const selected = new Set(parsed.data.placeIds);
      places = places.filter((place) => selected.has(place.id));
    }
    places = places.slice(0, parsed.data.limit);

    const warnings: string[] = [];
    let terrainMethod = "none";
    let buildingsMethod = "none";

    const placesWithWindows: Array<{
      id: string;
      name: string;
      category: string;
      subcategory: string;
      hasOutdoorSeating: boolean;
      lat: number;
      lon: number;
      pointElevationMeters: number | null;
      sunnyMinutes: number;
      sunnyWindows: Array<{
        startLocalTime: string;
        endLocalTime: string;
        durationMinutes: number;
      }>;
      sunriseLocalTime: string | null;
      sunsetLocalTime: string | null;
      warnings: string[];
    }> = [];

    for (const place of places) {
      const context = await buildPointEvaluationContext(place.lat, place.lon);
      terrainMethod = context.terrainHorizonMethod;
      buildingsMethod = context.buildingsShadowMethod;
      warnings.push(...context.warnings);

      const sunlight = evaluatePointSunlight({
        lat: place.lat,
        lon: place.lon,
        date: parsed.data.date,
        timeZone: parsed.data.timezone,
        sampleEveryMinutes: parsed.data.sampleEveryMinutes,
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
      });

      const sunnyMinutes = sunlight.sunnyWindows.reduce(
        (total, window) => total + window.durationMinutes,
        0,
      );

      placesWithWindows.push({
        id: place.id,
        name: place.name,
        category: place.category,
        subcategory: place.subcategory,
        hasOutdoorSeating: place.hasOutdoorSeating,
        lat: place.lat,
        lon: place.lon,
        pointElevationMeters: context.pointElevationMeters,
        sunnyMinutes,
        sunnyWindows: sunlight.sunnyWindows,
        sunriseLocalTime: sunlight.sunriseLocalTime,
        sunsetLocalTime: sunlight.sunsetLocalTime,
        warnings: context.warnings,
      });
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      date: parsed.data.date,
      timezone: parsed.data.timezone,
      sampleEveryMinutes: parsed.data.sampleEveryMinutes,
      count: placesWithWindows.length,
      places: placesWithWindows,
      model: {
        terrainHorizonMethod: terrainMethod,
        buildingsShadowMethod: buildingsMethod,
      },
      warnings: dedupeWarnings(warnings),
      stats: {
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to compute sunlight windows for places.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
