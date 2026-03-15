import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { loadAllPlaces } from "@/lib/places/lausanne-places";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "@/lib/time/zoned-date";

export const runtime = "nodejs";

type PlaceWindowsMode = "instant" | "daily";
type VenueType = "restaurant" | "bar" | "snack" | "foodtruck" | "other";

const requestSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().default("Europe/Zurich"),
    mode: z.enum(["instant", "daily"]).default("daily"),
    localTime: z.string().regex(/^\d{2}:\d{2}$/).default("12:00"),
    startLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
    endLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("23:59"),
    sampleEveryMinutes: z.number().int().min(1).max(60).default(15),
    placeIds: z.array(z.string()).max(500).optional(),
    category: z.enum(["park", "terrace_candidate"]).optional(),
    subcategories: z.array(z.string()).max(20).optional(),
    foodTypes: z
      .array(z.enum(["restaurant", "bar", "snack", "foodtruck"]))
      .max(8)
      .optional(),
    outdoorOnly: z.boolean().default(false),
    includeNonSunny: z.boolean().default(false),
    ignoreVegetation: z.boolean().default(false),
    buildingHeightBiasMeters: z.number().min(-20).max(20).optional(),
    bbox: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .refine(
    (value) =>
      !value.bbox ||
      (value.bbox[0] < value.bbox[2] &&
        value.bbox[1] < value.bbox[3] &&
        value.bbox[0] >= -180 &&
        value.bbox[2] <= 180 &&
        value.bbox[1] >= -90 &&
        value.bbox[3] <= 90),
    {
      message:
        "Invalid bbox. Expected [minLon, minLat, maxLon, maxLat] with min < max in WGS84 bounds.",
      path: ["bbox"],
    },
  );

interface SunnyWindow {
  startLocalTime: string;
  endLocalTime: string;
  durationMinutes: number;
}

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

function localTimeToMinutes(localTime: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!match) {
    return -1;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function extractClock(localDateTime: string): string {
  const match = /\b(\d{2}:\d{2})(?::\d{2})?\b/.exec(localDateTime);
  return match ? match[1] : localDateTime;
}

function formatDateTimeLocal(date: Date, timeZone: string): string {
  const datePart = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${datePart} ${timePart}`;
}

function createUtcSamples(
  date: string,
  timeZone: string,
  sampleEveryMinutes: number,
  startLocalTime: string,
  endLocalTime: string,
): Date[] {
  const { startUtc: dayStartUtc, endUtc: dayEndUtc } = getZonedDayRangeUtc(date, timeZone);
  const rangeStartUtc = zonedDateTimeToUtc(date, startLocalTime, timeZone);
  const rangeEndUtc = zonedDateTimeToUtc(date, endLocalTime, timeZone);
  const startUtc = new Date(
    Math.max(dayStartUtc.getTime(), rangeStartUtc.getTime()),
  );
  const endUtc = new Date(Math.min(dayEndUtc.getTime(), rangeEndUtc.getTime()));
  if (endUtc.getTime() <= startUtc.getTime()) {
    return [];
  }

  const samples: Date[] = [];
  const sampleEveryMs = sampleEveryMinutes * 60_000;
  for (
    let cursor = startUtc.getTime();
    cursor < endUtc.getTime();
    cursor += sampleEveryMs
  ) {
    samples.push(new Date(cursor));
  }

  return samples;
}

function buildSunnyWindows(
  samples: Array<{
    isSunny: boolean;
    localTime: string;
    utcTime: string;
  }>,
  sampleEveryMinutes: number,
  timeZone: string,
): SunnyWindow[] {
  const windows: SunnyWindow[] = [];
  let currentStart: string | null = null;
  let currentDuration = 0;

  for (const sample of samples) {
    if (sample.isSunny) {
      if (!currentStart) {
        currentStart = sample.localTime;
      }
      currentDuration += sampleEveryMinutes;
      continue;
    }

    if (currentStart) {
      windows.push({
        startLocalTime: currentStart,
        endLocalTime: sample.localTime,
        durationMinutes: currentDuration,
      });
      currentStart = null;
      currentDuration = 0;
    }
  }

  if (currentStart) {
    const lastSample = samples.at(-1);
    const endLocalTime = lastSample
      ? formatDateTimeLocal(
          new Date(Date.parse(lastSample.utcTime) + sampleEveryMinutes * 60_000),
          timeZone,
        )
      : currentStart;

    windows.push({
      startLocalTime: currentStart,
      endLocalTime,
      durationMinutes: currentDuration,
    });
  }

  return windows;
}

function isSampleSunny(
  sample: {
    isSunny: boolean;
    aboveAstronomicalHorizon: boolean;
    terrainBlocked: boolean;
    buildingsBlocked: boolean;
  },
  ignoreVegetation: boolean,
): boolean {
  if (!ignoreVegetation) {
    return sample.isSunny;
  }

  return (
    sample.aboveAstronomicalHorizon &&
    !sample.terrainBlocked &&
    !sample.buildingsBlocked
  );
}

function classifyVenueType(place: {
  name: string;
  subcategory: string;
  tags: Record<string, string>;
}): VenueType {
  const subcategory = place.subcategory.toLowerCase();
  const amenity = (place.tags.amenity ?? "").toLowerCase();
  const name = place.name.toLowerCase();
  const isFoodTruck =
    place.tags.food_truck === "yes" ||
    place.tags.mobile === "yes" ||
    place.tags.street_vendor === "yes" ||
    name.includes("truck");

  if (isFoodTruck) {
    return "foodtruck";
  }
  if (subcategory === "bar" || subcategory === "pub" || subcategory === "biergarten") {
    return "bar";
  }
  if (subcategory === "fast_food" || subcategory === "food_court") {
    return "snack";
  }
  if (subcategory === "restaurant" || subcategory === "cafe") {
    return "restaurant";
  }
  if (amenity === "bar" || amenity === "pub" || amenity === "biergarten") {
    return "bar";
  }
  if (amenity === "fast_food" || amenity === "food_court") {
    return "snack";
  }
  if (amenity === "restaurant" || amenity === "cafe") {
    return "restaurant";
  }

  return "other";
}

function isInsideBbox(
  lat: number,
  lon: number,
  bbox: [number, number, number, number],
): boolean {
  return (
    lon >= bbox[0] &&
    lat >= bbox[1] &&
    lon <= bbox[2] &&
    lat <= bbox[3]
  );
}

function offsetPointByMeters(
  lat: number,
  lon: number,
  distanceMeters: number,
  bearingDeg: number,
): { lat: number; lon: number } {
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon =
    metersPerDegreeLat * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const deltaLat = (Math.cos(bearingRad) * distanceMeters) / metersPerDegreeLat;
  const deltaLon = (Math.sin(bearingRad) * distanceMeters) / metersPerDegreeLon;

  return {
    lat: lat + deltaLat,
    lon: lon + deltaLon,
  };
}

function buildTerraceCandidates(lat: number, lon: number): Array<{
  lat: number;
  lon: number;
  offsetMeters: number;
}> {
  const candidates: Array<{ lat: number; lon: number; offsetMeters: number }> = [
    { lat, lon, offsetMeters: 0 },
  ];
  const distances = [4, 8];
  const bearings = [0, 45, 90, 135, 180, 225, 270, 315];

  for (const distance of distances) {
    for (const bearing of bearings) {
      const shifted = offsetPointByMeters(lat, lon, distance, bearing);
      candidates.push({
        lat: shifted.lat,
        lon: shifted.lon,
        offsetMeters: distance,
      });
    }
  }

  return candidates;
}

async function pickOutdoorEvaluationPoint(
  place: {
    lat: number;
    lon: number;
    hasOutdoorSeating: boolean;
  },
  options: {
    shadowCalibration: {
      buildingHeightBiasMeters: number;
    };
  },
) {
  const candidates = place.hasOutdoorSeating
    ? buildTerraceCandidates(place.lat, place.lon)
    : [{ lat: place.lat, lon: place.lon, offsetMeters: 0 }];
  let fallback:
    | {
        lat: number;
        lon: number;
        offsetMeters: number;
        context: Awaited<ReturnType<typeof buildPointEvaluationContext>>;
      }
    | undefined;

  for (const candidate of candidates) {
    const context = await buildPointEvaluationContext(candidate.lat, candidate.lon, {
      skipTerrainSamplingWhenIndoor: true,
      shadowCalibration: options.shadowCalibration,
    });
    if (!fallback) {
      fallback = { ...candidate, context };
    }
    if (!context.insideBuilding) {
      return {
        ...candidate,
        context,
        selectionStrategy: candidate.offsetMeters === 0 ? "original" : "terrace_offset",
      } as const;
    }
  }

  if (!fallback) {
    const context = await buildPointEvaluationContext(place.lat, place.lon, {
      skipTerrainSamplingWhenIndoor: true,
      shadowCalibration: options.shadowCalibration,
    });
    return {
      lat: place.lat,
      lon: place.lon,
      offsetMeters: 0,
      context,
      selectionStrategy: "original",
    } as const;
  }

  return {
    ...fallback,
    selectionStrategy: "indoor_fallback",
  } as const;
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

  const dailyRangeInvalid =
    parsed.data.mode === "daily" &&
    localTimeToMinutes(parsed.data.endLocalTime) <=
      localTimeToMinutes(parsed.data.startLocalTime);
  if (dailyRangeInvalid) {
    return NextResponse.json(
      {
        error: "Invalid daily time range.",
        detail: "endLocalTime must be strictly after startLocalTime.",
      },
      { status: 400 },
    );
  }

  try {
    const started = performance.now();
    const shadowCalibration = normalizeShadowCalibration({
      buildingHeightBiasMeters: parsed.data.buildingHeightBiasMeters,
    });
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
    if (parsed.data.category) {
      places = places.filter((place) => place.category === parsed.data.category);
    }
    if (parsed.data.outdoorOnly) {
      places = places.filter((place) => place.hasOutdoorSeating);
    }
    if (parsed.data.subcategories && parsed.data.subcategories.length > 0) {
      const subcategories = new Set(
        parsed.data.subcategories.map((subcategory) => subcategory.toLowerCase()),
      );
      places = places.filter((place) =>
        subcategories.has(place.subcategory.toLowerCase()),
      );
    }
    if (parsed.data.placeIds && parsed.data.placeIds.length > 0) {
      const selected = new Set(parsed.data.placeIds);
      places = places.filter((place) => selected.has(place.id));
    }
    if (parsed.data.bbox) {
      places = places.filter((place) =>
        isInsideBbox(place.lat, place.lon, parsed.data.bbox!),
      );
    }
    if (parsed.data.foodTypes && parsed.data.foodTypes.length > 0) {
      const allowedTypes = new Set(parsed.data.foodTypes);
      places = places.filter((place) => {
        const venueType = classifyVenueType(place);
        return venueType !== "other" && allowedTypes.has(venueType);
      });
    }
    places = places.slice(0, parsed.data.limit);

    const warnings: string[] = [];
    let terrainMethod = "none";
    let buildingsMethod = "none";
    let vegetationMethod = "none";
    const mode: PlaceWindowsMode = parsed.data.mode;

    const placesWithWindows: Array<{
      id: string;
      name: string;
      category: string;
      subcategory: string;
      venueType: VenueType;
      hasOutdoorSeating: boolean;
      lat: number;
      lon: number;
      evaluationLat: number;
      evaluationLon: number;
      selectionStrategy: "original" | "terrace_offset" | "indoor_fallback";
      selectionOffsetMeters: number;
      pointElevationMeters: number | null;
      insideBuilding: boolean;
      isSunnyNow: boolean | null;
      sunnyMinutes: number;
      sunnyWindows: SunnyWindow[];
      sunlightStartLocalTime: string | null;
      sunlightEndLocalTime: string | null;
      warnings: string[];
    }> = [];

    const dailySamples =
      mode === "daily"
        ? createUtcSamples(
            parsed.data.date,
            parsed.data.timezone,
            parsed.data.sampleEveryMinutes,
            parsed.data.startLocalTime,
            parsed.data.endLocalTime,
          )
        : [];
    if (mode === "daily" && dailySamples.length === 0) {
      return NextResponse.json(
        {
          error: "Invalid daily time range.",
          detail:
            "No samples available in selected daily range. Change start/end local time.",
        },
        { status: 400 },
      );
    }
    const instantUtcDate =
      mode === "instant"
        ? zonedDateTimeToUtc(
            parsed.data.date,
            parsed.data.localTime,
            parsed.data.timezone,
          )
        : null;

    for (const place of places) {
      const selectedPoint = await pickOutdoorEvaluationPoint(place, {
        shadowCalibration,
      });
      const context = selectedPoint.context;
      terrainMethod = context.terrainHorizonMethod;
      buildingsMethod = context.buildingsShadowMethod;
      vegetationMethod = context.vegetationShadowMethod ?? "none";
      warnings.push(...context.warnings);

      const venueType = classifyVenueType(place);
      if (mode === "instant" && instantUtcDate) {
        const sample = evaluateInstantSunlight({
          lat: selectedPoint.lat,
          lon: selectedPoint.lon,
          utcDate: instantUtcDate,
          timeZone: parsed.data.timezone,
          horizonMask: context.horizonMask,
          buildingShadowEvaluator: context.buildingShadowEvaluator,
          vegetationShadowEvaluator: context.vegetationShadowEvaluator,
        });
        const isSunny = isSampleSunny(sample, parsed.data.ignoreVegetation);
        if (!parsed.data.includeNonSunny && !isSunny) {
          continue;
        }

        const clock = extractClock(sample.localTime);
        placesWithWindows.push({
          id: place.id,
          name: place.name,
          category: place.category,
          subcategory: place.subcategory,
          venueType,
          hasOutdoorSeating: place.hasOutdoorSeating,
          lat: place.lat,
          lon: place.lon,
          evaluationLat: Math.round(selectedPoint.lat * 1_000_000) / 1_000_000,
          evaluationLon: Math.round(selectedPoint.lon * 1_000_000) / 1_000_000,
          selectionStrategy: selectedPoint.selectionStrategy,
          selectionOffsetMeters: selectedPoint.offsetMeters,
          pointElevationMeters: context.pointElevationMeters,
          insideBuilding: context.insideBuilding,
          isSunnyNow: isSunny,
          sunnyMinutes: isSunny ? parsed.data.sampleEveryMinutes : 0,
          sunnyWindows: isSunny
            ? [
                {
                  startLocalTime: clock,
                  endLocalTime: clock,
                  durationMinutes: parsed.data.sampleEveryMinutes,
                },
              ]
            : [],
          sunlightStartLocalTime: isSunny ? clock : null,
          sunlightEndLocalTime: isSunny ? clock : null,
          warnings: context.warnings,
        });
        continue;
      }

      const samples = dailySamples.map((utcDate) =>
        evaluateInstantSunlight({
          lat: selectedPoint.lat,
          lon: selectedPoint.lon,
          utcDate,
          timeZone: parsed.data.timezone,
          horizonMask: context.horizonMask,
          buildingShadowEvaluator: context.buildingShadowEvaluator,
          vegetationShadowEvaluator: context.vegetationShadowEvaluator,
        }),
      );
      const sunnyWindows = buildSunnyWindows(
        samples.map((sample) => ({
          isSunny: isSampleSunny(sample, parsed.data.ignoreVegetation),
          localTime: sample.localTime,
          utcTime: sample.utcTime,
        })),
        parsed.data.sampleEveryMinutes,
        parsed.data.timezone,
      );
      const sunnyMinutes = sunnyWindows.reduce(
        (total, window) => total + window.durationMinutes,
        0,
      );
      if (!parsed.data.includeNonSunny && sunnyMinutes <= 0) {
        continue;
      }

      placesWithWindows.push({
        id: place.id,
        name: place.name,
        category: place.category,
        subcategory: place.subcategory,
        venueType,
        hasOutdoorSeating: place.hasOutdoorSeating,
        lat: place.lat,
        lon: place.lon,
        evaluationLat: Math.round(selectedPoint.lat * 1_000_000) / 1_000_000,
        evaluationLon: Math.round(selectedPoint.lon * 1_000_000) / 1_000_000,
        selectionStrategy: selectedPoint.selectionStrategy,
        selectionOffsetMeters: selectedPoint.offsetMeters,
        pointElevationMeters: context.pointElevationMeters,
        insideBuilding: context.insideBuilding,
        isSunnyNow: null,
        sunnyMinutes,
        sunnyWindows,
        sunlightStartLocalTime:
          sunnyWindows.length > 0
            ? extractClock(sunnyWindows[0].startLocalTime)
            : null,
        sunlightEndLocalTime:
          sunnyWindows.length > 0
            ? extractClock(sunnyWindows[sunnyWindows.length - 1].endLocalTime)
            : null,
        warnings: context.warnings,
      });
    }

    placesWithWindows.sort((left, right) => {
      if (mode === "instant") {
        const sunnyDelta = Number(right.isSunnyNow) - Number(left.isSunnyNow);
        if (sunnyDelta !== 0) {
          return sunnyDelta;
        }
      } else {
        const sunnyDelta = right.sunnyMinutes - left.sunnyMinutes;
        if (sunnyDelta !== 0) {
          return sunnyDelta;
        }
      }
      return left.name.localeCompare(right.name);
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      mode,
      date: parsed.data.date,
      timezone: parsed.data.timezone,
      localTime: parsed.data.localTime,
      startLocalTime: parsed.data.startLocalTime,
      endLocalTime: parsed.data.endLocalTime,
      sampleEveryMinutes: parsed.data.sampleEveryMinutes,
      ignoreVegetation: parsed.data.ignoreVegetation,
      shadowCalibration,
      count: placesWithWindows.length,
      places: placesWithWindows,
      model: {
        terrainHorizonMethod: terrainMethod,
        buildingsShadowMethod: buildingsMethod,
        vegetationShadowMethod: vegetationMethod,
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
