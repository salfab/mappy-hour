import { NextResponse } from "next/server";
import { z } from "zod";

import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import { evaluateInstantSunlight, evaluatePointSunlight } from "@/lib/sun/solar";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

export const runtime = "nodejs";

const requestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().default("Europe/Zurich"),
  mode: z.enum(["instant", "daily"]).default("instant"),
  localTime: z.string().regex(/^\d{2}:\d{2}$/).default("12:00"),
  sampleEveryMinutes: z.number().int().min(1).max(60).default(15),
});

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

function normalizeAzimuth(azimuthDeg: number): number {
  const normalized = Math.round(azimuthDeg) % 360;
  return normalized >= 0 ? normalized : normalized + 360;
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
    const warnings: string[] = [];
    let terrainHorizonOverride:
      | Awaited<ReturnType<typeof buildDynamicHorizonMask>>
      | undefined;

    try {
      const dynamicMask = await buildDynamicHorizonMask({
        lat: parsed.data.lat,
        lon: parsed.data.lon,
      });
      if (dynamicMask) {
        terrainHorizonOverride = dynamicMask;
      } else {
        warnings.push(
          "Dynamic terrain horizon unavailable for this point. Falling back to preprocessed Lausanne horizon mask when available.",
        );
      }
    } catch (error) {
      warnings.push(
        `Dynamic terrain horizon build failed (${error instanceof Error ? error.message : "unknown error"}). Falling back to preprocessed Lausanne horizon mask when available.`,
      );
    }

    const context = await buildPointEvaluationContext(parsed.data.lat, parsed.data.lon, {
      terrainHorizonOverride: terrainHorizonOverride ?? undefined,
    });
    const terrainHorizonDebug = extractTerrainHorizonDebug(terrainHorizonOverride);
    const pointContext = {
      lv95Easting: Math.round(context.pointLv95.easting * 1000) / 1000,
      lv95Northing: Math.round(context.pointLv95.northing * 1000) / 1000,
      pointElevationMeters: context.pointElevationMeters,
      insideBuilding: context.insideBuilding,
      indoorBuildingId: context.indoorBuildingId,
    };
    const model = {
      terrainHorizonMethod: context.terrainHorizonMethod,
      buildingsShadowMethod: context.buildingsShadowMethod,
      terrainHorizonDebug,
    };

    if (parsed.data.mode === "instant") {
      const utcDate = zonedDateTimeToUtc(
        parsed.data.date,
        parsed.data.localTime,
        parsed.data.timezone,
      );
      const sample = evaluateInstantSunlight({
        lat: parsed.data.lat,
        lon: parsed.data.lon,
        utcDate,
        timeZone: parsed.data.timezone,
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
      });
      const ridgePoint = terrainHorizonOverride?.ridgePoints?.find(
        (point) => point.azimuthDeg === normalizeAzimuth(sample.azimuthDeg),
      );

      return NextResponse.json({
        mode: parsed.data.mode,
        date: parsed.data.date,
        timezone: parsed.data.timezone,
        localTime: parsed.data.localTime,
        utcTime: utcDate.toISOString(),
        sample,
        model,
        pointContext,
        diagnostics: {
          terrainRidgePoint: ridgePoint ?? null,
        },
        warnings: dedupeWarnings([...warnings, ...context.warnings]),
      });
    }

    const result = evaluatePointSunlight({
      lat: parsed.data.lat,
      lon: parsed.data.lon,
      date: parsed.data.date,
      timeZone: parsed.data.timezone,
      sampleEveryMinutes: parsed.data.sampleEveryMinutes,
      horizonMask: context.horizonMask,
      buildingShadowEvaluator: context.buildingShadowEvaluator,
    });

    return NextResponse.json({
      mode: parsed.data.mode,
      ...result,
      model,
      pointContext,
      warnings: dedupeWarnings([...warnings, ...context.warnings]),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Sunlight calculation failed.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
