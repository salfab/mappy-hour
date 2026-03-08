import { NextResponse } from "next/server";
import { z } from "zod";

import { wgs84ToLv95 } from "@/lib/geo/projection";
import {
  evaluateBuildingsShadow,
  loadBuildingsObstacleIndex,
} from "@/lib/sun/buildings-shadow";
import { loadLausanneHorizonMask } from "@/lib/sun/horizon-mask";
import { evaluatePointSunlight } from "@/lib/sun/solar";
import { sampleSwissTerrainElevationLv95 } from "@/lib/terrain/swiss-terrain";

export const runtime = "nodejs";

const requestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().default("Europe/Zurich"),
  sampleEveryMinutes: z.number().int().min(1).max(60).default(15),
});

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
    const pointLv95 = wgs84ToLv95(parsed.data.lon, parsed.data.lat);
    const [horizonMask, buildingsIndex, pointElevationMeters] = await Promise.all([
      loadLausanneHorizonMask(),
      loadBuildingsObstacleIndex(),
      sampleSwissTerrainElevationLv95(pointLv95.easting, pointLv95.northing),
    ]);

    const buildingShadowEvaluator =
      buildingsIndex && pointElevationMeters !== null
        ? (sample: { azimuthDeg: number; altitudeDeg: number }) =>
            evaluateBuildingsShadow(buildingsIndex.obstacles, {
              pointX: pointLv95.easting,
              pointY: pointLv95.northing,
              pointElevation: pointElevationMeters,
              solarAzimuthDeg: sample.azimuthDeg,
              solarAltitudeDeg: sample.altitudeDeg,
            })
        : undefined;

    const result = evaluatePointSunlight({
      lat: parsed.data.lat,
      lon: parsed.data.lon,
      date: parsed.data.date,
      timeZone: parsed.data.timezone,
      sampleEveryMinutes: parsed.data.sampleEveryMinutes,
      horizonMask,
      buildingShadowEvaluator,
    });

    const warnings: string[] = [];
    if (!horizonMask) {
      warnings.push(
        "No horizon mask found. Run preprocess:lausanne:horizon to enable terrain blocking.",
      );
    }
    if (!buildingsIndex) {
      warnings.push(
        "No buildings obstacle index found. Run preprocess:lausanne:buildings to enable building shadow blocking.",
      );
    }
    if (pointElevationMeters === null) {
      warnings.push(
        "Point elevation unavailable from swissALTI3D. Building-shadow blocking was skipped.",
      );
    }

    return NextResponse.json({
      ...result,
      model: {
        terrainHorizonMethod: horizonMask?.method ?? "none",
        buildingsShadowMethod: buildingsIndex?.method ?? "none",
      },
      pointContext: {
        lv95Easting: Math.round(pointLv95.easting * 1000) / 1000,
        lv95Northing: Math.round(pointLv95.northing * 1000) / 1000,
        pointElevationMeters,
      },
      warnings,
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
