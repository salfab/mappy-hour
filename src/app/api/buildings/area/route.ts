import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { lv95ToWgs84, wgs84ToLv95 } from "@/lib/geo/projection";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";

export const runtime = "nodejs";

const requestSchema = z
  .object({
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    maxBuildings: z.number().int().min(1).max(20_000).default(4_000),
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

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function intersectsBounds(
  obstacle: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  },
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  },
): boolean {
  return !(
    obstacle.maxX < bounds.minX ||
    obstacle.minX > bounds.maxX ||
    obstacle.maxY < bounds.minY ||
    obstacle.minY > bounds.maxY
  );
}

function bboxToLv95Bounds(bbox: [number, number, number, number]) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const corners = [
    wgs84ToLv95(minLon, minLat),
    wgs84ToLv95(minLon, maxLat),
    wgs84ToLv95(maxLon, minLat),
    wgs84ToLv95(maxLon, maxLat),
  ];

  return {
    minX: Math.min(...corners.map((point) => point.easting)),
    minY: Math.min(...corners.map((point) => point.northing)),
    maxX: Math.max(...corners.map((point) => point.easting)),
    maxY: Math.max(...corners.map((point) => point.northing)),
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
    const buildingsIndex = await loadBuildingsObstacleIndex();
    if (!buildingsIndex) {
      return NextResponse.json({
        bbox: {
          minLon,
          minLat,
          maxLon,
          maxLat,
        },
        count: 0,
        buildings: [],
        model: {
          buildingsMethod: "none",
        },
        warnings: [
          "No buildings obstacle index found. Run preprocess:lausanne:buildings first.",
        ],
        stats: {
          elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
          rawIntersectingCount: 0,
        },
      });
    }

    const lv95Bounds = bboxToLv95Bounds(parsed.data.bbox);
    const buildings: Array<{
      id: string;
      footprint: Array<{
        lat: number;
        lon: number;
      }>;
    }> = [];
    let rawIntersectingCount = 0;

    for (const obstacle of buildingsIndex.obstacles) {
      if (!intersectsBounds(obstacle, lv95Bounds)) {
        continue;
      }

      rawIntersectingCount += 1;
      if (!obstacle.footprint || obstacle.footprint.length < 3) {
        continue;
      }

      const footprint = obstacle.footprint.map((vertex) => {
        const wgs84 = lv95ToWgs84(vertex.x, vertex.y);
        return {
          lat: round6(wgs84.lat),
          lon: round6(wgs84.lon),
        };
      });

      buildings.push({
        id: obstacle.id,
        footprint,
      });

      if (buildings.length > parsed.data.maxBuildings) {
        return NextResponse.json(
          {
            error: "Too many buildings for the requested bbox.",
            detail: `Computed more than ${parsed.data.maxBuildings} buildings. Reduce bbox or increase maxBuildings.`,
          },
          { status: 400 },
        );
      }
    }

    return NextResponse.json({
      bbox: {
        minLon,
        minLat,
        maxLon,
        maxLat,
      },
      count: buildings.length,
      buildings,
      model: {
        buildingsMethod: buildingsIndex.method,
      },
      warnings: [],
      stats: {
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
        rawIntersectingCount,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Buildings area extraction failed.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
