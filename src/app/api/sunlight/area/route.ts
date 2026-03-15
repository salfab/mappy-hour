import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { buildGridFromBbox } from "@/lib/geo/grid";
import {
  aggregateDailyAreaFromArtifacts,
  aggregateInstantAreaFromArtifacts,
  resolveSunlightTilesForBbox,
} from "@/lib/precompute/sunlight-tile-service";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";
import {
  evaluateInstantSunlight,
  evaluatePointSunlight,
} from "@/lib/sun/solar";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

export const runtime = "nodejs";
const MAX_RAW_GRID_POINTS = 20_000;

const requestSchema = z
  .object({
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().default("Europe/Zurich"),
    mode: z.enum(["instant", "daily"]).default("instant"),
    localTime: z.string().regex(/^\d{2}:\d{2}$/).default("12:00"),
    sampleEveryMinutes: z.number().int().min(1).max(60).default(15),
    gridStepMeters: z.number().int().min(1).max(2000).default(250),
    maxPoints: z.number().int().min(1).max(5000).default(900),
    ignoreVegetation: z.boolean().default(false),
    buildingHeightBiasMeters: z.number().min(-20).max(20).optional(),
  })
  .refine(
    (value) =>
      value.bbox[0] < value.bbox[2] &&
      value.bbox[1] < value.bbox[3] &&
      value.bbox[0] >= -180 &&
      value.bbox[2] <= 180 &&
      value.bbox[1] >= -90 &&
      value.bbox[3] <= 90,
    {
      message:
        "Invalid bbox. Expected [minLon, minLat, maxLon, maxLat] with min < max.",
      path: ["bbox"],
    },
  );

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

function extractTerrainHorizonDebug(
  mask: Awaited<ReturnType<typeof buildDynamicHorizonMask>> | undefined,
) {
  if (!mask?.ridgePoints || mask.ridgePoints.length === 0) {
    return null;
  }

  return {
    center: mask.center,
    radiusKm: mask.radiusKm,
    ridgePoints: mask.ridgePoints,
  };
}

function maxPointsExceededResponse(params: {
  maxPoints: number;
  gridPointCount: number;
  indoorPointsExcluded: number;
  outdoorPointCount: number;
}) {
  return NextResponse.json(
    {
      error: "Outdoor grid exceeds maxPoints limit.",
      detail: `Computed ${params.outdoorPointCount} outdoor points (from ${params.gridPointCount} raw points and ${params.indoorPointsExcluded} indoor exclusions), but maxPoints is ${params.maxPoints}.`,
    },
    { status: 400 },
  );
}

function buildSunnyWindowsFromSamples(
  samples: Array<{ localTime: string; isSunny: boolean; utcTime: string }>,
  sampleEveryMinutes: number,
  timeZone: string,
) {
  const windows: Array<{
    startLocalTime: string;
    endLocalTime: string;
    durationMinutes: number;
  }> = [];
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
      ? new Intl.DateTimeFormat("sv-SE", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(
          new Date(Date.parse(lastSample.utcTime) + sampleEveryMinutes * 60_000),
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

function buildCacheMissMetadata() {
  return {
    hit: false,
    layer: "MISS" as const,
    region: null,
    modelVersionHash: null,
    fullyCovered: false,
  };
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
    const [minLon, minLat, maxLon, maxLat] = parsed.data.bbox;
    const shadowCalibration = normalizeShadowCalibration({
      buildingHeightBiasMeters: parsed.data.buildingHeightBiasMeters,
    });

    const resolvedTiles = await resolveSunlightTilesForBbox({
      bbox: {
        minLon,
        minLat,
        maxLon,
        maxLat,
      },
      date: parsed.data.date,
      timezone: parsed.data.timezone,
      sampleEveryMinutes: parsed.data.sampleEveryMinutes,
      gridStepMeters: parsed.data.gridStepMeters,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      shadowCalibration,
      persistMissingTiles: true,
    });

    if (resolvedTiles) {
      if (parsed.data.mode === "instant") {
        const aggregated = aggregateInstantAreaFromArtifacts({
          artifacts: resolvedTiles.artifacts,
          bbox: {
            minLon,
            minLat,
            maxLon,
            maxLat,
          },
          date: parsed.data.date,
          timezone: parsed.data.timezone,
          localTime: parsed.data.localTime,
          maxPoints: parsed.data.maxPoints,
          ignoreVegetation: parsed.data.ignoreVegetation,
        });
        if (aggregated && "error" in aggregated) {
          return NextResponse.json(aggregated, { status: 400 });
        }
        if (aggregated) {
          return NextResponse.json({
            mode: parsed.data.mode,
            date: parsed.data.date,
            timezone: parsed.data.timezone,
            localTime: parsed.data.localTime,
            utcTime: aggregated.utcTime,
            bbox: {
              minLon,
              minLat,
              maxLon,
              maxLat,
            },
            gridStepMeters: parsed.data.gridStepMeters,
            pointCount: aggregated.pointCount,
            gridPointCount: aggregated.gridPointCount,
            points: aggregated.points,
            model: aggregated.model,
            cache: resolvedTiles.cache,
            warnings: aggregated.warnings,
            stats: {
              ...aggregated.stats,
              elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
            },
          });
        }
      } else {
        const aggregated = aggregateDailyAreaFromArtifacts({
          artifacts: resolvedTiles.artifacts,
          bbox: {
            minLon,
            minLat,
            maxLon,
            maxLat,
          },
          date: parsed.data.date,
          timezone: parsed.data.timezone,
          sampleEveryMinutes: parsed.data.sampleEveryMinutes,
          maxPoints: parsed.data.maxPoints,
          ignoreVegetation: parsed.data.ignoreVegetation,
        });
        if (aggregated && "error" in aggregated) {
          return NextResponse.json(aggregated, { status: 400 });
        }
        if (aggregated) {
          return NextResponse.json({
            mode: parsed.data.mode,
            date: parsed.data.date,
            timezone: parsed.data.timezone,
            bbox: {
              minLon,
              minLat,
              maxLon,
              maxLat,
            },
            gridStepMeters: parsed.data.gridStepMeters,
            sampleEveryMinutes: parsed.data.sampleEveryMinutes,
            pointCount: aggregated.pointCount,
            gridPointCount: aggregated.gridPointCount,
            points: aggregated.points,
            model: aggregated.model,
            cache: resolvedTiles.cache,
            warnings: aggregated.warnings,
            stats: {
              ...aggregated.stats,
              elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
            },
          });
        }
      }
    }

    const grid = buildGridFromBbox(
      { minLon, minLat, maxLon, maxLat },
      parsed.data.gridStepMeters,
    );

    if (grid.length > MAX_RAW_GRID_POINTS) {
      return NextResponse.json(
        {
          error: "Grid exceeds raw safety limit.",
          detail: `Computed ${grid.length} raw points, but hard limit is ${MAX_RAW_GRID_POINTS}. Increase gridStepMeters or reduce bbox.`,
        },
        { status: 400 },
      );
    }

    const warnings: string[] = [];
    let terrainMethod = "none";
    let buildingsMethod = "none";
    let vegetationMethod = "none";
    let pointsWithElevation = 0;
    let indoorPointsExcluded = 0;
    let outdoorPointCount = 0;
    let terrainHorizonOverride:
      | Awaited<ReturnType<typeof buildDynamicHorizonMask>>
      | undefined;

    try {
      const dynamicMask = await buildDynamicHorizonMask({
        lat: (minLat + maxLat) / 2,
        lon: (minLon + maxLon) / 2,
      });
      if (dynamicMask) {
        terrainHorizonOverride = dynamicMask;
        terrainMethod = dynamicMask.method;
      } else {
        warnings.push(
          "Dynamic terrain horizon unavailable for this area center. Falling back to preprocessed horizon mask when available.",
        );
      }
    } catch (error) {
      warnings.push(
        `Dynamic terrain horizon build failed (${error instanceof Error ? error.message : "unknown error"}). Falling back to preprocessed horizon mask when available.`,
      );
    }
    const terrainHorizonDebug = extractTerrainHorizonDebug(terrainHorizonOverride);

    if (parsed.data.mode === "instant") {
      const utcDate = zonedDateTimeToUtc(
        parsed.data.date,
        parsed.data.localTime,
        parsed.data.timezone,
      );
      const points: Array<{
        id: string;
        lat: number;
        lon: number;
        lv95Easting: number;
        lv95Northing: number;
        pointElevationMeters: number | null;
        isSunny: boolean;
        terrainBlocked: boolean;
        buildingsBlocked: boolean;
        vegetationBlocked: boolean;
        altitudeDeg: number;
        azimuthDeg: number;
        horizonAngleDeg: number | null;
        buildingBlockerId: string | null;
        insideBuilding: boolean;
        indoorBuildingId: string | null;
      }> = [];

      for (const point of grid) {
        const context = await buildPointEvaluationContext(point.lat, point.lon, {
          skipTerrainSamplingWhenIndoor: true,
          terrainHorizonOverride: terrainHorizonOverride ?? undefined,
          shadowCalibration,
        });
        terrainMethod = context.terrainHorizonMethod;
        buildingsMethod = context.buildingsShadowMethod;
        vegetationMethod = context.vegetationShadowMethod ?? "none";
        warnings.push(...context.warnings);

        if (context.insideBuilding) {
          indoorPointsExcluded += 1;
          continue;
        }
        outdoorPointCount += 1;
        if (outdoorPointCount > parsed.data.maxPoints) {
          return maxPointsExceededResponse({
            maxPoints: parsed.data.maxPoints,
            gridPointCount: grid.length,
            indoorPointsExcluded,
            outdoorPointCount,
          });
        }
        if (context.pointElevationMeters !== null) {
          pointsWithElevation += 1;
        }

        const sample = evaluateInstantSunlight({
          lat: point.lat,
          lon: point.lon,
          utcDate,
          timeZone: parsed.data.timezone,
          horizonMask: context.horizonMask,
          buildingShadowEvaluator: context.buildingShadowEvaluator,
          vegetationShadowEvaluator: context.vegetationShadowEvaluator,
        });

        points.push({
          id: point.id,
          lat: point.lat,
          lon: point.lon,
          lv95Easting: Math.round(context.pointLv95.easting * 1000) / 1000,
          lv95Northing: Math.round(context.pointLv95.northing * 1000) / 1000,
          pointElevationMeters: context.pointElevationMeters,
          isSunny: parsed.data.ignoreVegetation
            ? sample.aboveAstronomicalHorizon &&
              !sample.terrainBlocked &&
              !sample.buildingsBlocked
            : sample.isSunny,
          terrainBlocked: sample.terrainBlocked,
          buildingsBlocked: sample.buildingsBlocked,
          vegetationBlocked: parsed.data.ignoreVegetation
            ? false
            : sample.vegetationBlocked,
          altitudeDeg: Math.round(sample.altitudeDeg * 1000) / 1000,
          azimuthDeg: Math.round(sample.azimuthDeg * 1000) / 1000,
          horizonAngleDeg:
            sample.horizonAngleDeg === null
              ? null
              : Math.round(sample.horizonAngleDeg * 1000) / 1000,
          buildingBlockerId: sample.buildingBlockerId,
          insideBuilding: false,
          indoorBuildingId: null,
        });
      }

      return NextResponse.json({
        mode: parsed.data.mode,
        date: parsed.data.date,
        timezone: parsed.data.timezone,
        localTime: parsed.data.localTime,
        utcTime: utcDate.toISOString(),
        bbox: {
          minLon,
          minLat,
          maxLon,
          maxLat,
        },
        gridStepMeters: parsed.data.gridStepMeters,
        pointCount: points.length,
        gridPointCount: grid.length,
        points,
        cache: buildCacheMissMetadata(),
        model: {
          terrainHorizonMethod: terrainMethod,
          buildingsShadowMethod: buildingsMethod,
          vegetationShadowMethod: vegetationMethod,
          terrainHorizonDebug,
          shadowCalibration,
        },
        warnings: dedupeWarnings(warnings),
        stats: {
          elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
          pointsWithElevation,
          pointsWithoutElevation: points.length - pointsWithElevation,
          indoorPointsExcluded,
        },
      });
    }

    const points: Array<{
      id: string;
      lat: number;
      lon: number;
      lv95Easting: number;
      lv95Northing: number;
      pointElevationMeters: number | null;
      sunriseLocalTime: string | null;
      sunsetLocalTime: string | null;
      sunnyMinutes: number;
      sunnyWindows: Array<{
        startLocalTime: string;
        endLocalTime: string;
        durationMinutes: number;
      }>;
      insideBuilding: boolean;
      indoorBuildingId: string | null;
    }> = [];

    for (const point of grid) {
      const context = await buildPointEvaluationContext(point.lat, point.lon, {
        skipTerrainSamplingWhenIndoor: true,
        terrainHorizonOverride: terrainHorizonOverride ?? undefined,
        shadowCalibration,
      });
      terrainMethod = context.terrainHorizonMethod;
      buildingsMethod = context.buildingsShadowMethod;
      vegetationMethod = context.vegetationShadowMethod ?? "none";
      warnings.push(...context.warnings);

      if (context.insideBuilding) {
        indoorPointsExcluded += 1;
        continue;
      }
      outdoorPointCount += 1;
      if (outdoorPointCount > parsed.data.maxPoints) {
        return maxPointsExceededResponse({
          maxPoints: parsed.data.maxPoints,
          gridPointCount: grid.length,
          indoorPointsExcluded,
          outdoorPointCount,
        });
      }
      if (context.pointElevationMeters !== null) {
        pointsWithElevation += 1;
      }

      const daily = evaluatePointSunlight({
        lat: point.lat,
        lon: point.lon,
        date: parsed.data.date,
        timeZone: parsed.data.timezone,
        sampleEveryMinutes: parsed.data.sampleEveryMinutes,
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
        vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      });

      const effectiveSamples = parsed.data.ignoreVegetation
        ? daily.samples.map((sample) => ({
            localTime: sample.localTime,
            utcTime: sample.utcTime,
            isSunny:
              sample.aboveAstronomicalHorizon &&
              !sample.terrainBlocked &&
              !sample.buildingsBlocked,
          }))
        : daily.samples.map((sample) => ({
            localTime: sample.localTime,
            utcTime: sample.utcTime,
            isSunny: sample.isSunny,
          }));
      const sunnyWindows = parsed.data.ignoreVegetation
        ? buildSunnyWindowsFromSamples(
            effectiveSamples,
            parsed.data.sampleEveryMinutes,
            parsed.data.timezone,
          )
        : daily.sunnyWindows;
      const sunnyMinutes = sunnyWindows.reduce(
        (total, window) => total + window.durationMinutes,
        0,
      );

      points.push({
        id: point.id,
        lat: point.lat,
        lon: point.lon,
        lv95Easting: Math.round(context.pointLv95.easting * 1000) / 1000,
        lv95Northing: Math.round(context.pointLv95.northing * 1000) / 1000,
        pointElevationMeters: context.pointElevationMeters,
        sunriseLocalTime: daily.sunriseLocalTime,
        sunsetLocalTime: daily.sunsetLocalTime,
        sunnyMinutes,
        sunnyWindows,
        insideBuilding: false,
        indoorBuildingId: null,
      });
    }

    return NextResponse.json({
      mode: parsed.data.mode,
      date: parsed.data.date,
      timezone: parsed.data.timezone,
      bbox: {
        minLon,
        minLat,
        maxLon,
        maxLat,
      },
      gridStepMeters: parsed.data.gridStepMeters,
      sampleEveryMinutes: parsed.data.sampleEveryMinutes,
      pointCount: points.length,
      gridPointCount: grid.length,
      points,
      cache: buildCacheMissMetadata(),
      model: {
        terrainHorizonMethod: terrainMethod,
        buildingsShadowMethod: buildingsMethod,
        vegetationShadowMethod: vegetationMethod,
        terrainHorizonDebug,
        shadowCalibration,
      },
      warnings: dedupeWarnings(warnings),
      stats: {
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
        pointsWithElevation,
        pointsWithoutElevation: points.length - pointsWithElevation,
        indoorPointsExcluded,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Area sunlight calculation failed.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
