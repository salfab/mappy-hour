import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import SunCalc from "suncalc";

import { lv95ToWgs84, wgs84ToLv95 } from "@/lib/geo/projection";
import { evaluateBuildingsShadow } from "@/lib/sun/buildings-shadow";
import {
  loadTerrainTilesForBounds,
  sampleSwissTerrainElevationLv95FromTiles,
} from "@/lib/terrain/swiss-terrain";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

interface BuildingObstacle {
  id: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  height: number;
  centerX: number;
  centerY: number;
  halfDiagonal: number;
  sourceZip: string;
  footprint?: Array<{ x: number; y: number }>;
  footprintArea?: number;
}

interface BuildingSpatialGrid {
  version: number;
  cellSizeMeters: number;
  cells: Record<string, number[]>;
}

interface BuildingObstacleIndex {
  indexVersion?: number;
  method: string;
  obstacles: BuildingObstacle[];
  spatialGrid?: BuildingSpatialGrid;
}

const RAD_TO_DEG = 180 / Math.PI;

const ANALYSIS = {
  name: "Terrasse Great Escape <-> Palais de Rumine",
  date: "2026-03-08",
  localTime: "17:30",
  timezone: "Europe/Zurich",
  // Zone assumee autour de l'esplanade entre Great Escape et Rumine.
  bbox: {
    minLon: 6.6322,
    minLat: 46.52255,
    maxLon: 6.63335,
    maxLat: 46.52305,
  },
  gridStepMeters: 1,
  maxDistanceMeters: 2500,
  buildingHeightBiasMeters: 0,
} as const;

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeAzimuthDegrees(azimuthDegreesFromSunCalc: number): number {
  const fromNorth = (azimuthDegreesFromSunCalc + 180) % 360;
  return fromNorth >= 0 ? fromNorth : fromNorth + 360;
}

async function loadIndexFromPath(indexPath: string): Promise<BuildingObstacleIndex> {
  const raw = await fs.readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as BuildingObstacleIndex;
  if (!Array.isArray(parsed.obstacles)) {
    throw new Error(`Invalid index file: ${indexPath}`);
  }
  return parsed;
}

async function main() {
  const coarsePath = path.join(
    process.cwd(),
    "data",
    "processed",
    "buildings",
    "lausanne-buildings-index.v2.json",
  );
  const improvedPath = path.join(
    process.cwd(),
    "data",
    "processed",
    "buildings",
    "lausanne-buildings-index.v3.json",
  );

  const [coarseIndex, improvedIndex] = await Promise.all([
    loadIndexFromPath(coarsePath),
    loadIndexFromPath(improvedPath),
  ]);

  const corners = [
    wgs84ToLv95(ANALYSIS.bbox.minLon, ANALYSIS.bbox.minLat),
    wgs84ToLv95(ANALYSIS.bbox.minLon, ANALYSIS.bbox.maxLat),
    wgs84ToLv95(ANALYSIS.bbox.maxLon, ANALYSIS.bbox.minLat),
    wgs84ToLv95(ANALYSIS.bbox.maxLon, ANALYSIS.bbox.maxLat),
  ];
  const minX = Math.floor(Math.min(...corners.map((point) => point.easting)));
  const maxX = Math.ceil(Math.max(...corners.map((point) => point.easting)));
  const minY = Math.floor(Math.min(...corners.map((point) => point.northing)));
  const maxY = Math.ceil(Math.max(...corners.map((point) => point.northing)));

  const terrainTiles = await loadTerrainTilesForBounds({
    minX: minX - 20,
    minY: minY - 20,
    maxX: maxX + 20,
    maxY: maxY + 20,
  });
  if (!terrainTiles || terrainTiles.length === 0) {
    throw new Error("Terrain tiles unavailable for analysis bbox.");
  }

  const utcDate = zonedDateTimeToUtc(ANALYSIS.date, ANALYSIS.localTime, ANALYSIS.timezone);
  const points: Array<{
    easting: number;
    northing: number;
    lat: number;
    lon: number;
    elevation: number;
    altitudeDeg: number;
    azimuthDeg: number;
    coarseBlocked: boolean;
    improvedBlocked: boolean;
    coarseBlockerId: string | null;
    improvedBlockerId: string | null;
  }> = [];

  let coarseEvalElapsedMs = 0;
  let improvedEvalElapsedMs = 0;

  for (let northing = minY; northing <= maxY; northing += ANALYSIS.gridStepMeters) {
    for (let easting = minX; easting <= maxX; easting += ANALYSIS.gridStepMeters) {
      const wgs = lv95ToWgs84(easting, northing);
      if (
        wgs.lon < ANALYSIS.bbox.minLon ||
        wgs.lon > ANALYSIS.bbox.maxLon ||
        wgs.lat < ANALYSIS.bbox.minLat ||
        wgs.lat > ANALYSIS.bbox.maxLat
      ) {
        continue;
      }

      const elevation = sampleSwissTerrainElevationLv95FromTiles(
        terrainTiles,
        easting,
        northing,
      );
      if (elevation === null) {
        continue;
      }

      const solar = SunCalc.getPosition(utcDate, wgs.lat, wgs.lon);
      const altitudeDeg = solar.altitude * RAD_TO_DEG;
      const azimuthDeg = normalizeAzimuthDegrees(solar.azimuth * RAD_TO_DEG);

      const coarsePointStartedAt = performance.now();
      const coarse = evaluateBuildingsShadow(
        coarseIndex.obstacles,
        {
          pointX: easting,
          pointY: northing,
          pointElevation: elevation,
          solarAzimuthDeg: azimuthDeg,
          solarAltitudeDeg: altitudeDeg,
          maxDistanceMeters: ANALYSIS.maxDistanceMeters,
          buildingHeightBiasMeters: ANALYSIS.buildingHeightBiasMeters,
        },
        coarseIndex.spatialGrid,
      );
      coarseEvalElapsedMs += performance.now() - coarsePointStartedAt;
      const improvedPointStartedAt = performance.now();

      const improved = evaluateBuildingsShadow(
        improvedIndex.obstacles,
        {
          pointX: easting,
          pointY: northing,
          pointElevation: elevation,
          solarAzimuthDeg: azimuthDeg,
          solarAltitudeDeg: altitudeDeg,
          maxDistanceMeters: ANALYSIS.maxDistanceMeters,
          buildingHeightBiasMeters: ANALYSIS.buildingHeightBiasMeters,
        },
        improvedIndex.spatialGrid,
      );
      improvedEvalElapsedMs += performance.now() - improvedPointStartedAt;

      points.push({
        easting,
        northing,
        lat: wgs.lat,
        lon: wgs.lon,
        elevation,
        altitudeDeg,
        azimuthDeg,
        coarseBlocked: coarse.blocked,
        improvedBlocked: improved.blocked,
        coarseBlockerId: coarse.blockerId,
        improvedBlockerId: improved.blockerId,
      });
    }
  }

  const differences = points.filter((point) => point.coarseBlocked !== point.improvedBlocked);
  const coarseOnlyBlocked = differences.filter(
    (point) => point.coarseBlocked && !point.improvedBlocked,
  );
  const improvedOnlyBlocked = differences.filter(
    (point) => !point.coarseBlocked && point.improvedBlocked,
  );

  console.log(
    JSON.stringify(
      {
        analysis: ANALYSIS,
        indexes: {
          coarse: {
            indexVersion: coarseIndex.indexVersion ?? null,
            method: coarseIndex.method,
            obstacleCount: coarseIndex.obstacles.length,
          },
          improved: {
            indexVersion: improvedIndex.indexVersion ?? null,
            method: improvedIndex.method,
            obstacleCount: improvedIndex.obstacles.length,
          },
        },
        points: {
          compared: points.length,
          differences: differences.length,
          differencesRatio: points.length === 0 ? 0 : differences.length / points.length,
          coarseOnlyBlocked: coarseOnlyBlocked.length,
          improvedOnlyBlocked: improvedOnlyBlocked.length,
          coarseEvaluationElapsedMs: Math.round(coarseEvalElapsedMs * 1000) / 1000,
          improvedEvaluationElapsedMs: Math.round(improvedEvalElapsedMs * 1000) / 1000,
        },
        differencesPreview: differences.slice(0, 30).map((point) => ({
          lat: round6(point.lat),
          lon: round6(point.lon),
          easting: point.easting,
          northing: point.northing,
          coarseBlocked: point.coarseBlocked,
          improvedBlocked: point.improvedBlocked,
          coarseBlockerId: point.coarseBlockerId,
          improvedBlockerId: point.improvedBlockerId,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    `[compare-great-escape-v2-v3-grid1m] Failed: ${
      error instanceof Error ? error.message : "Unknown error"
    }`,
  );
  process.exitCode = 1;
});
