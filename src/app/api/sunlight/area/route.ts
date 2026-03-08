import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { buildGridFromBbox } from "@/lib/geo/grid";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import {
  evaluateInstantSunlight,
  evaluatePointSunlight,
} from "@/lib/sun/solar";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

export const runtime = "nodejs";

const requestSchema = z
  .object({
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().default("Europe/Zurich"),
    mode: z.enum(["instant", "daily"]).default("instant"),
    localTime: z.string().regex(/^\d{2}:\d{2}$/).default("12:00"),
    sampleEveryMinutes: z.number().int().min(1).max(60).default(15),
    gridStepMeters: z.number().int().min(30).max(2000).default(250),
    maxPoints: z.number().int().min(1).max(5000).default(900),
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
    const grid = buildGridFromBbox(
      { minLon, minLat, maxLon, maxLat },
      parsed.data.gridStepMeters,
    );

    if (grid.length > parsed.data.maxPoints) {
      return NextResponse.json(
        {
          error: "Grid exceeds maxPoints limit.",
          detail: `Computed ${grid.length} points, but maxPoints is ${parsed.data.maxPoints}.`,
        },
        { status: 400 },
      );
    }

    const warnings: string[] = [];
    let terrainMethod = "none";
    let buildingsMethod = "none";
    let pointsWithElevation = 0;

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
        altitudeDeg: number;
        azimuthDeg: number;
        horizonAngleDeg: number | null;
        buildingBlockerId: string | null;
      }> = [];

      for (const point of grid) {
        const context = await buildPointEvaluationContext(point.lat, point.lon);
        terrainMethod = context.terrainHorizonMethod;
        buildingsMethod = context.buildingsShadowMethod;
        warnings.push(...context.warnings);
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
        });

        points.push({
          id: point.id,
          lat: point.lat,
          lon: point.lon,
          lv95Easting: Math.round(context.pointLv95.easting * 1000) / 1000,
          lv95Northing: Math.round(context.pointLv95.northing * 1000) / 1000,
          pointElevationMeters: context.pointElevationMeters,
          isSunny: sample.isSunny,
          terrainBlocked: sample.terrainBlocked,
          buildingsBlocked: sample.buildingsBlocked,
          altitudeDeg: Math.round(sample.altitudeDeg * 1000) / 1000,
          azimuthDeg: Math.round(sample.azimuthDeg * 1000) / 1000,
          horizonAngleDeg:
            sample.horizonAngleDeg === null
              ? null
              : Math.round(sample.horizonAngleDeg * 1000) / 1000,
          buildingBlockerId: sample.buildingBlockerId,
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
        points,
        model: {
          terrainHorizonMethod: terrainMethod,
          buildingsShadowMethod: buildingsMethod,
        },
        warnings: dedupeWarnings(warnings),
        stats: {
          elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
          pointsWithElevation,
          pointsWithoutElevation: points.length - pointsWithElevation,
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
    }> = [];

    for (const point of grid) {
      const context = await buildPointEvaluationContext(point.lat, point.lon);
      terrainMethod = context.terrainHorizonMethod;
      buildingsMethod = context.buildingsShadowMethod;
      warnings.push(...context.warnings);
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
      });

      const sunnyMinutes = daily.sunnyWindows.reduce(
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
        sunnyWindows: daily.sunnyWindows,
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
      points,
      model: {
        terrainHorizonMethod: terrainMethod,
        buildingsShadowMethod: buildingsMethod,
      },
      warnings: dedupeWarnings(warnings),
      stats: {
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
        pointsWithElevation,
        pointsWithoutElevation: points.length - pointsWithElevation,
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
