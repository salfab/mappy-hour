import { wgs84ToLv95 } from "@/lib/geo/projection";
import {
  evaluateBuildingsShadow,
  findContainingBuilding,
  loadBuildingsObstacleIndex,
} from "@/lib/sun/buildings-shadow";
import { HorizonMask, loadLausanneHorizonMask } from "@/lib/sun/horizon-mask";
import {
  DEFAULT_SHADOW_CALIBRATION,
  ShadowCalibration,
} from "@/lib/sun/shadow-calibration";
import {
  createVegetationShadowEvaluator,
  loadVegetationSurfaceTilesForPoint,
  vegetationShadowMethod,
} from "@/lib/sun/vegetation-shadow";
import { sampleSwissTerrainElevationLv95 } from "@/lib/terrain/swiss-terrain";

export interface BuildPointEvaluationContextOptions {
  skipTerrainSamplingWhenIndoor?: boolean;
  terrainHorizonOverride?: HorizonMask;
  shadowCalibration?: ShadowCalibration;
}

export interface PointEvaluationContext {
  pointLv95: {
    easting: number;
    northing: number;
  };
  insideBuilding: boolean;
  indoorBuildingId: string | null;
  pointElevationMeters: number | null;
  terrainHorizonMethod: string;
  buildingsShadowMethod: string;
  vegetationShadowMethod?: string;
  warnings: string[];
  horizonMask: Awaited<ReturnType<typeof loadLausanneHorizonMask>>;
  buildingShadowEvaluator?: (sample: { azimuthDeg: number; altitudeDeg: number }) => {
    blocked: boolean;
    blockerId: string | null;
    blockerDistanceMeters: number | null;
    blockerAltitudeAngleDeg: number | null;
    checkedObstaclesCount: number;
  };
  vegetationShadowEvaluator?: (sample: { azimuthDeg: number; altitudeDeg: number }) => {
    blocked: boolean;
    blockerDistanceMeters: number | null;
    blockerAltitudeAngleDeg: number | null;
    blockerSurfaceElevationMeters: number | null;
    blockerClearanceMeters: number | null;
    checkedSamplesCount: number;
  };
}

export async function buildPointEvaluationContext(
  lat: number,
  lon: number,
  options: BuildPointEvaluationContextOptions = {},
): Promise<PointEvaluationContext> {
  const shadowCalibration =
    options.shadowCalibration ?? DEFAULT_SHADOW_CALIBRATION;
  const pointLv95 = wgs84ToLv95(lon, lat);
  const [lausanneHorizonMask, buildingsIndex] = await Promise.all([
    loadLausanneHorizonMask(),
    loadBuildingsObstacleIndex(),
  ]);
  const horizonMask = options.terrainHorizonOverride ?? lausanneHorizonMask;

  const containment = buildingsIndex
    ? findContainingBuilding(
        buildingsIndex.obstacles,
        pointLv95.easting,
        pointLv95.northing,
      )
    : {
        insideBuilding: false,
        buildingId: null,
      };

  const shouldSkipTerrainSampling =
    options.skipTerrainSamplingWhenIndoor && containment.insideBuilding;
  const pointElevationMeters = shouldSkipTerrainSampling
    ? null
    : await sampleSwissTerrainElevationLv95(pointLv95.easting, pointLv95.northing);

  const vegetationSurfaceTiles =
    pointElevationMeters !== null && !containment.insideBuilding
      ? await loadVegetationSurfaceTilesForPoint(
          pointLv95.easting,
          pointLv95.northing,
        )
      : null;

  const buildingShadowEvaluator =
    buildingsIndex && pointElevationMeters !== null && !containment.insideBuilding
      ? (sample: { azimuthDeg: number; altitudeDeg: number }) =>
          evaluateBuildingsShadow(buildingsIndex.obstacles, {
            pointX: pointLv95.easting,
            pointY: pointLv95.northing,
            pointElevation: pointElevationMeters,
            observerHeightMeters: shadowCalibration.observerHeightMeters,
            buildingHeightBiasMeters:
              shadowCalibration.buildingHeightBiasMeters,
            solarAzimuthDeg: sample.azimuthDeg,
            solarAltitudeDeg: sample.altitudeDeg,
          })
      : undefined;
  const vegetationShadowEvaluator =
    vegetationSurfaceTiles &&
    vegetationSurfaceTiles.length > 0 &&
    pointElevationMeters !== null &&
    !containment.insideBuilding
      ? createVegetationShadowEvaluator({
          tiles: vegetationSurfaceTiles,
          pointX: pointLv95.easting,
          pointY: pointLv95.northing,
          pointElevation:
            pointElevationMeters + shadowCalibration.observerHeightMeters,
        })
      : undefined;

  const warnings: string[] = [];
  if (!horizonMask) {
    warnings.push(
      "No horizon mask found. Run preprocess:lausanne:horizon (fallback) and ingest terrain horizon DEM tiles for your target area.",
    );
  }
  if (!buildingsIndex) {
    warnings.push(
      "No buildings obstacle index found. Run preprocess:lausanne:buildings after ingesting buildings data for your target area.",
    );
  }
  if (vegetationSurfaceTiles === null) {
    warnings.push(
      "No vegetation surface raster found. Run ingest:lausanne:vegetation:surface and/or ingest:nyon:vegetation:surface to enable vegetation shadow blocking.",
    );
  }
  if (pointElevationMeters === null && !shouldSkipTerrainSampling) {
    warnings.push(
      "Point elevation unavailable from swissALTI3D. Building-shadow blocking was skipped.",
    );
  }

  return {
    pointLv95,
    insideBuilding: containment.insideBuilding,
    indoorBuildingId: containment.buildingId,
    pointElevationMeters,
    terrainHorizonMethod: horizonMask?.method ?? "none",
    buildingsShadowMethod: buildingsIndex?.method ?? "none",
    vegetationShadowMethod:
      vegetationSurfaceTiles && vegetationSurfaceTiles.length > 0
        ? vegetationShadowMethod
        : "none",
    warnings,
    horizonMask,
    buildingShadowEvaluator,
    vegetationShadowEvaluator,
  };
}
