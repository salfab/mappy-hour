import SunCalc from "suncalc";

import type { ShadowCalibration } from "@/lib/sun/shadow-calibration";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

import {
  bboxContains,
  decodeBase64Bytes,
  getIntersectingTileIds,
  getPrecomputedRegionBbox,
  isMaskBitSet,
  loadPrecomputedSunlightManifest,
  loadPrecomputedSunlightTile,
  pointInBbox,
  type PrecomputedRegionName,
  type RegionBbox,
} from "./sunlight-cache";

const RAD_TO_DEG = 180 / Math.PI;
const PRECOMPUTED_REGIONS: PrecomputedRegionName[] = ["lausanne", "nyon"];

interface InstantAreaCacheRequest {
  bbox: RegionBbox;
  date: string;
  timezone: string;
  localTime: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  maxPoints: number;
  shadowCalibration: ShadowCalibration;
}

interface InstantAreaCachePoint {
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
}

export interface InstantAreaCacheHit {
  region: PrecomputedRegionName;
  localTime: string;
  utcTime: string;
  pointCount: number;
  gridPointCount: number;
  points: InstantAreaCachePoint[];
  warnings: string[];
  model: {
    terrainHorizonMethod: string;
    buildingsShadowMethod: string;
    vegetationShadowMethod: string;
    terrainHorizonDebug: null;
    shadowCalibration: ShadowCalibration;
    cacheHit: true;
    cacheRegion: PrecomputedRegionName;
  };
  stats: {
    elapsedMs: number;
    pointsWithElevation: number;
    pointsWithoutElevation: number;
    indoorPointsExcluded: number;
    cacheHit: true;
    cacheTileCount: number;
  };
}

function normalizeAzimuthDegrees(azimuthDegreesFromSunCalc: number): number {
  const fromNorth = (azimuthDegreesFromSunCalc + 180) % 360;
  return fromNorth >= 0 ? fromNorth : fromNorth + 360;
}

function computeSolarGeometry(
  lat: number,
  lon: number,
  utcDate: Date,
): { altitudeDeg: number; azimuthDeg: number } {
  const position = SunCalc.getPosition(utcDate, lat, lon);
  return {
    altitudeDeg: position.altitude * RAD_TO_DEG,
    azimuthDeg: normalizeAzimuthDegrees(position.azimuth * RAD_TO_DEG),
  };
}

export async function findInstantAreaCacheHit(
  input: InstantAreaCacheRequest,
): Promise<InstantAreaCacheHit | null> {
  const matchingRegion = PRECOMPUTED_REGIONS.find((region) =>
    bboxContains(getPrecomputedRegionBbox(region), input.bbox),
  );

  if (!matchingRegion) {
    return null;
  }

  const manifest = await loadPrecomputedSunlightManifest({
    region: matchingRegion,
    date: input.date,
    gridStepMeters: input.gridStepMeters,
    sampleEveryMinutes: input.sampleEveryMinutes,
  });
  if (!manifest) {
    return null;
  }

  if (manifest.timezone !== input.timezone) {
    return null;
  }

  const requiredTileIds = getIntersectingTileIds({
    region: matchingRegion,
    tileSizeMeters: manifest.tileSizeMeters,
    bbox: input.bbox,
  });

  if (requiredTileIds.length === 0) {
    return null;
  }

  if (
    requiredTileIds.some((tileId) => !manifest.tileIds.includes(tileId)) ||
    requiredTileIds.some((tileId) => manifest.failedTileIds.includes(tileId))
  ) {
    return null;
  }

  const utcDate = zonedDateTimeToUtc(input.date, input.localTime, input.timezone);
  const warnings = [
    "Served from precomputed sunlight cache. Horizon angle and building blocker id diagnostics are not persisted in cache artifacts yet.",
  ];
  const points: InstantAreaCachePoint[] = [];
  let pointsWithElevation = 0;

  for (const tileId of requiredTileIds) {
    const tile = await loadPrecomputedSunlightTile({
      region: matchingRegion,
      date: input.date,
      gridStepMeters: input.gridStepMeters,
      sampleEveryMinutes: input.sampleEveryMinutes,
      tileId,
    });

    if (!tile) {
      return null;
    }

    const frame = tile.frames.find((candidate) => candidate.localTime === input.localTime);
    if (!frame) {
      return null;
    }

    const sunnyMask = decodeBase64Bytes(frame.sunMaskBase64);
    const terrainMask = decodeBase64Bytes(frame.terrainBlockedMaskBase64);
    const buildingsMask = decodeBase64Bytes(frame.buildingsBlockedMaskBase64);
    const vegetationMask = decodeBase64Bytes(frame.vegetationBlockedMaskBase64);

    for (let index = 0; index < tile.points.length; index += 1) {
      const point = tile.points[index];
      if (!pointInBbox(point.lon, point.lat, input.bbox)) {
        continue;
      }

      if (points.length >= input.maxPoints) {
        return null;
      }

      const solarGeometry = computeSolarGeometry(point.lat, point.lon, utcDate);
      if (point.pointElevationMeters !== null) {
        pointsWithElevation += 1;
      }
      points.push({
        id: point.id,
        lat: point.lat,
        lon: point.lon,
        lv95Easting: point.lv95Easting,
        lv95Northing: point.lv95Northing,
        pointElevationMeters: point.pointElevationMeters,
        isSunny: isMaskBitSet(sunnyMask, index),
        terrainBlocked: isMaskBitSet(terrainMask, index),
        buildingsBlocked: isMaskBitSet(buildingsMask, index),
        vegetationBlocked: isMaskBitSet(vegetationMask, index),
        altitudeDeg: Math.round(solarGeometry.altitudeDeg * 1000) / 1000,
        azimuthDeg: Math.round(solarGeometry.azimuthDeg * 1000) / 1000,
        horizonAngleDeg: null,
        buildingBlockerId: null,
        insideBuilding: false,
        indoorBuildingId: null,
      });
    }
  }

  return {
    region: matchingRegion,
    localTime: input.localTime,
    utcTime: utcDate.toISOString(),
    pointCount: points.length,
    gridPointCount: points.length,
    points,
    warnings,
    model: {
      terrainHorizonMethod: "precomputed-cache",
      buildingsShadowMethod: "precomputed-cache",
      vegetationShadowMethod: "precomputed-cache",
      terrainHorizonDebug: null,
      shadowCalibration: input.shadowCalibration,
      cacheHit: true,
      cacheRegion: matchingRegion,
    },
    stats: {
      elapsedMs: 0,
      pointsWithElevation,
      pointsWithoutElevation: points.length - pointsWithElevation,
      indoorPointsExcluded: 0,
      cacheHit: true,
      cacheTileCount: requiredTileIds.length,
    },
  };
}
