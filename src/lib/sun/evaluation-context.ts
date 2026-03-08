import { wgs84ToLv95 } from "@/lib/geo/projection";
import {
  evaluateBuildingsShadow,
  loadBuildingsObstacleIndex,
} from "@/lib/sun/buildings-shadow";
import { loadLausanneHorizonMask } from "@/lib/sun/horizon-mask";
import { sampleSwissTerrainElevationLv95 } from "@/lib/terrain/swiss-terrain";

export interface PointEvaluationContext {
  pointLv95: {
    easting: number;
    northing: number;
  };
  pointElevationMeters: number | null;
  terrainHorizonMethod: string;
  buildingsShadowMethod: string;
  warnings: string[];
  horizonMask: Awaited<ReturnType<typeof loadLausanneHorizonMask>>;
  buildingShadowEvaluator?: (sample: { azimuthDeg: number; altitudeDeg: number }) => {
    blocked: boolean;
    blockerId: string | null;
    blockerDistanceMeters: number | null;
    blockerAltitudeAngleDeg: number | null;
    checkedObstaclesCount: number;
  };
}

export async function buildPointEvaluationContext(
  lat: number,
  lon: number,
): Promise<PointEvaluationContext> {
  const pointLv95 = wgs84ToLv95(lon, lat);
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

  return {
    pointLv95,
    pointElevationMeters,
    terrainHorizonMethod: horizonMask?.method ?? "none",
    buildingsShadowMethod: buildingsIndex?.method ?? "none",
    warnings,
    horizonMask,
    buildingShadowEvaluator,
  };
}
