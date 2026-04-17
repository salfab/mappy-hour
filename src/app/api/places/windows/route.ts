import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { loadAllPlaces } from "@/lib/places/lausanne-places";
import { wgs84ToLv95 } from "@/lib/geo/projection";
import {
  findCachedModelVersionHash,
  type PrecomputedRegionName,
} from "@/lib/precompute/sunlight-cache";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
  type BinaryTileArtifact,
} from "@/lib/precompute/sunlight-cache-binary";
import { resolveRegionForBbox } from "@/lib/precompute/sunlight-tile-service";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
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
    sharedSources: Awaited<ReturnType<typeof buildSharedPointEvaluationSources>>;
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
      sharedSources: options.sharedSources,
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
      sharedSources: options.sharedSources,
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

    const timings = {
      pickPoint: 0,
      evalSamples: 0,
      placesProcessed: 0,
      shared: 0,
      tileHits: 0,
      tileMiss: 0,
      tileLookup: 0,
    };
    const routeT0 = performance.now();

    // ── Fast path: read precomputed sun masks from the tile cache ─────
    // For daily mode at g=1m / sample=15min, every place at a grid-aligned
    // cell already has its sunny/not-sunny bit per frame stored on disk.
    // This skips the per-place GPU evaluate loop (which is O(places × samples)
    // at ~30ms each on ANGLE) entirely.
    const CACHE_GRID_STEP = 1;
    const tileSizeMeters = 250;
    // Cache stores the Promise, not the resolved value, so concurrent
    // lookups for the same tile share one disk+decode pass.
    const tilePointCache = new Map<string, Promise<BinaryTileArtifact | null>>();
    const regionInfoCache = new Map<
      PrecomputedRegionName,
      { modelVersionHash: string; tw: { startLocalTime: string; endLocalTime: string } } | null
    >();
    const canUseTileLookup =
      mode === "daily" && parsed.data.sampleEveryMinutes === 15;
    const resolveRegionInfo = async (region: PrecomputedRegionName) => {
      const cached = regionInfoCache.get(region);
      if (cached !== undefined) return cached;
      const hit = await findCachedModelVersionHash({
        region,
        date: parsed.data.date,
        gridStepMeters: CACHE_GRID_STEP,
        sampleEveryMinutes: 15,
        startLocalTime: parsed.data.startLocalTime,
        endLocalTime: parsed.data.endLocalTime,
      });
      if (!hit) {
        regionInfoCache.set(region, null);
        return null;
      }
      const clientStart = localTimeToMinutes(parsed.data.startLocalTime);
      const clientEnd = localTimeToMinutes(parsed.data.endLocalTime);
      const covering = hit.timeWindows.find((tw) => {
        const twStart = localTimeToMinutes(tw.startLocalTime);
        const twEnd = localTimeToMinutes(tw.endLocalTime);
        return twStart <= clientStart && twEnd >= clientEnd;
      });
      if (!covering) {
        regionInfoCache.set(region, null);
        return null;
      }
      const info = { modelVersionHash: hit.modelVersionHash, tw: covering };
      regionInfoCache.set(region, info);
      return info;
    };
    const loadTileForPoint = async (
      lat: number,
      lon: number,
    ): Promise<{
      tile: BinaryTileArtifact;
      region: PrecomputedRegionName;
      ix: number;
      iy: number;
    } | null> => {
      const region = resolveRegionForBbox({
        minLon: lon,
        maxLon: lon,
        minLat: lat,
        maxLat: lat,
      });
      if (!region) return null;
      const info = await resolveRegionInfo(region);
      if (!info) return null;
      const lv95 = wgs84ToLv95(lon, lat);
      const ix = Math.floor(lv95.easting);
      const iy = Math.floor(lv95.northing);
      const tileMinE = Math.floor(ix / tileSizeMeters) * tileSizeMeters;
      const tileMinN = Math.floor(iy / tileSizeMeters) * tileSizeMeters;
      const tileId = `e${tileMinE}_n${tileMinN}_s${tileSizeMeters}`;
      const cacheKey = `${region}:${info.modelVersionHash}:${parsed.data.date}:${info.tw.startLocalTime}-${info.tw.endLocalTime}:${tileId}`;
      let tilePromise = tilePointCache.get(cacheKey);
      if (!tilePromise) {
        tilePromise = loadPrecomputedSunlightTileBinary({
          region,
          modelVersionHash: info.modelVersionHash,
          date: parsed.data.date,
          gridStepMeters: CACHE_GRID_STEP,
          sampleEveryMinutes: 15,
          startLocalTime: info.tw.startLocalTime,
          endLocalTime: info.tw.endLocalTime,
          tileId,
        });
        tilePointCache.set(cacheKey, tilePromise);
      }
      const tile = await tilePromise;
      if (!tile) return null;
      return { tile, region, ix, iy };
    };

    // Look up the grid cell for (ix, iy) in a tile. Points are laid out
    // row-major in buildTilePoints (iy outer, ix inner) so we can compute
    // the index directly without a linear scan. The check at the end
    // guards against precompute layouts that skip edge cells.
    const lookupPointInTile = (
      tile: BinaryTileArtifact,
      ix: number,
      iy: number,
    ): number | null => {
      const tileMinE = tile.meta.tile.minEasting;
      const tileMinN = tile.meta.tile.minNorthing;
      const widthCells = Math.round(
        (tile.meta.tile.maxEasting - tileMinE) / CACHE_GRID_STEP,
      );
      const col = ix - Math.floor(tileMinE / CACHE_GRID_STEP);
      const row = iy - Math.floor(tileMinN / CACHE_GRID_STEP);
      if (col < 0 || col >= widthCells || row < 0) return null;
      const pointIdx = row * widthCells + col;
      if (pointIdx < 0 || pointIdx >= tile.pointCount) return null;
      if (tile.pointIx[pointIdx] !== ix || tile.pointIy[pointIdx] !== iy) {
        // Layout mismatch — fall back to scan
        for (let i = 0; i < tile.pointCount; i++) {
          if (tile.pointIx[i] === ix && tile.pointIy[i] === iy) return i;
        }
        return null;
      }
      return pointIdx;
    };

    // Build GPU-backed shared sources lazily — only if at least one place
    // falls through to the GPU fallback path. For fully-cached bboxes, this
    // avoids the 1-2s GPU backend setup entirely.
    let sharedSources: Awaited<ReturnType<typeof buildSharedPointEvaluationSources>> | null = null;
    const sharedLv95Bounds = (() => {
      if (places.length === 0) return undefined;
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
      for (const p of places) {
        if (p.lon < minLon) minLon = p.lon;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lon > maxLon) maxLon = p.lon;
        if (p.lat > maxLat) maxLat = p.lat;
      }
      const sw = wgs84ToLv95(minLon, minLat);
      const ne = wgs84ToLv95(maxLon, maxLat);
      return {
        minX: Math.min(sw.easting, ne.easting),
        minY: Math.min(sw.northing, ne.northing),
        maxX: Math.max(sw.easting, ne.easting),
        maxY: Math.max(sw.northing, ne.northing),
      };
    })();
    const ensureSharedSources = async () => {
      if (sharedSources) return sharedSources;
      const tShared0 = performance.now();
      sharedSources = await buildSharedPointEvaluationSources({
        lv95Bounds: sharedLv95Bounds,
      });
      timings.shared += performance.now() - tShared0;
      return sharedSources;
    };
    // Try to pick a terrace point via tile lookup alone (no GPU). Returns
    // null when the tile is not cached or the place is wholly indoor across
    // all terrace candidates.
    const pickViaTile = async (place: typeof places[number]) => {
      if (!canUseTileLookup) return null;
      const candidates = place.hasOutdoorSeating
        ? buildTerraceCandidates(place.lat, place.lon)
        : [{ lat: place.lat, lon: place.lon, offsetMeters: 0 }];
      let fallback: {
        cand: typeof candidates[number];
        hit: NonNullable<Awaited<ReturnType<typeof loadTileForPoint>>>;
        pointIdx: number;
        outdoorIndex: number;
        insideBuilding: boolean;
      } | null = null;
      for (const cand of candidates) {
        const hit = await loadTileForPoint(cand.lat, cand.lon);
        if (!hit) return null; // any candidate misses tile → GPU fallback
        const pointIdx = lookupPointInTile(hit.tile, hit.ix, hit.iy);
        if (pointIdx === null) return null;
        const flags = hit.tile.pointFlags[pointIdx];
        const outdoorIndex = hit.tile.pointOutdoorIndex[pointIdx];
        const insideBuilding = (flags & 1) !== 0 || outdoorIndex < 0;
        if (!fallback) {
          fallback = { cand, hit, pointIdx, outdoorIndex, insideBuilding };
        }
        if (!insideBuilding) {
          return {
            ...cand,
            hit,
            pointIdx,
            outdoorIndex,
            insideBuilding,
            selectionStrategy: cand.offsetMeters === 0 ? "original" : "terrace_offset",
          } as const;
        }
      }
      if (!fallback) return null;
      return {
        ...fallback.cand,
        hit: fallback.hit,
        pointIdx: fallback.pointIdx,
        outdoorIndex: fallback.outdoorIndex,
        insideBuilding: fallback.insideBuilding,
        selectionStrategy: "indoor_fallback",
      } as const;
    };

    // Pre-warm the tile cache with bounded concurrency. Same-tile requests
    // share a single disk+decode via the Promise cache; different-tile
    // requests load in parallel up to CONCURRENCY at a time.
    let tilePicks: Array<Awaited<ReturnType<typeof pickViaTile>>> = [];
    if (canUseTileLookup && mode === "daily") {
      const tWarm0 = performance.now();
      tilePicks = new Array(places.length);
      const CONCURRENCY = 8;
      let cursor = 0;
      const runWorker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= places.length) return;
          tilePicks[i] = await pickViaTile(places[i]);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => runWorker()));
      timings.tileLookup += performance.now() - tWarm0;
    }

    for (let placeIdx = 0; placeIdx < places.length; placeIdx++) {
      const place = places[placeIdx];
      timings.placesProcessed += 1;
      const venueType = classifyVenueType(place);

      // ── Fast path: resolve the place entirely from tile data ─────────
      if (canUseTileLookup && mode === "daily") {
        const tilePick = tilePicks[placeIdx];
        if (tilePick) {
          const { hit, pointIdx, outdoorIndex, insideBuilding, lat, lon, offsetMeters, selectionStrategy } = tilePick;
          const clientStart = localTimeToMinutes(parsed.data.startLocalTime);
          const clientEnd = localTimeToMinutes(parsed.data.endLocalTime);
          let sunnyWindows: SunnyWindow[];
          if (insideBuilding) {
            sunnyWindows = [];
          } else {
            const byteIdx = outdoorIndex >> 3;
            const bitMask = 1 << (outdoorIndex & 7);
            const tileSamples: Array<{ isSunny: boolean; localTime: string; utcTime: string }> = [];
            for (let f = 0; f < hit.tile.frameCount; f++) {
              const fm = hit.tile.meta.framesMeta[f];
              const m = localTimeToMinutes(fm.localTime);
              if (m < clientStart || m >= clientEnd) continue;
              const mask = parsed.data.ignoreVegetation
                ? getFrameMask(hit.tile, f, MASK_KIND_SUN_NO_VEG)
                : getFrameMask(hit.tile, f, MASK_KIND_SUN);
              tileSamples.push({
                isSunny: (mask[byteIdx] & bitMask) !== 0,
                localTime: fm.localTime,
                utcTime: fm.utcTime,
              });
            }
            sunnyWindows = buildSunnyWindows(
              tileSamples,
              parsed.data.sampleEveryMinutes,
              parsed.data.timezone,
            );
          }
          const sunnyMinutes = sunnyWindows.reduce(
            (total, w) => total + w.durationMinutes,
            0,
          );
          if (!parsed.data.includeNonSunny && sunnyMinutes <= 0) {
            timings.tileHits += 1;
            continue;
          }
          const elev = hit.tile.meta.pointElevationMeters?.[pointIdx] ?? null;
          placesWithWindows.push({
            id: place.id,
            name: place.name,
            category: place.category,
            subcategory: place.subcategory,
            venueType,
            hasOutdoorSeating: place.hasOutdoorSeating,
            lat: place.lat,
            lon: place.lon,
            evaluationLat: Math.round(lat * 1_000_000) / 1_000_000,
            evaluationLon: Math.round(lon * 1_000_000) / 1_000_000,
            selectionStrategy,
            selectionOffsetMeters: offsetMeters,
            pointElevationMeters: elev,
            insideBuilding,
            isSunnyNow: null,
            sunnyMinutes,
            sunnyWindows,
            sunlightStartLocalTime:
              sunnyWindows.length > 0 ? extractClock(sunnyWindows[0].startLocalTime) : null,
            sunlightEndLocalTime:
              sunnyWindows.length > 0 ? extractClock(sunnyWindows[sunnyWindows.length - 1].endLocalTime) : null,
            warnings: [],
          });
          timings.tileHits += 1;
          // Record methods once (precomputed = rust-wgpu-vulkan)
          if (terrainMethod === "none") terrainMethod = "precomputed";
          if (buildingsMethod === "none") buildingsMethod = "precomputed";
          if (vegetationMethod === "none") vegetationMethod = "precomputed";
          continue;
        }
        timings.tileMiss += 1;
      }

      // ── Slow path: GPU fallback (lazily initialised) ─────────────────
      const gpuShared = await ensureSharedSources();
      const tPick0 = performance.now();
      const selectedPoint = await pickOutdoorEvaluationPoint(place, {
        shadowCalibration,
        sharedSources: gpuShared,
      });
      timings.pickPoint += performance.now() - tPick0;
      const context = selectedPoint.context;
      terrainMethod = context.terrainHorizonMethod;
      buildingsMethod = context.buildingsShadowMethod;
      vegetationMethod = context.vegetationShadowMethod ?? "none";
      warnings.push(...context.warnings);

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

      const tEval0 = performance.now();
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
      timings.evalSamples += performance.now() - tEval0;
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

    if (timings.placesProcessed > 0) {
      const total = performance.now() - routeT0;
      const n = timings.placesProcessed;
      process.stderr.write(
        `[places/windows] mode=${mode} places=${n}/${places.length} samples=${dailySamples.length} total=${total.toFixed(0)}ms shared=${timings.shared.toFixed(0)}ms avg pickPoint=${(timings.pickPoint / n).toFixed(1)}ms evalSamples=${(timings.evalSamples / n).toFixed(1)}ms tileLookup=${(timings.tileLookup / n).toFixed(1)}ms (tileHits=${timings.tileHits} tileMiss=${timings.tileMiss})\n`,
      );
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
