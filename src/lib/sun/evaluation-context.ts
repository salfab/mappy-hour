import { wgs84ToLv95 } from "@/lib/geo/projection";
import {
  createDetailedBuildingShadowVerifier,
  evaluateBuildingsShadow,
  evaluateBuildingsShadowTwoLevel,
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
  DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS,
  loadVegetationSurfaceTilesForBounds,
  loadVegetationSurfaceTilesForPoint,
  vegetationShadowMethod,
} from "@/lib/sun/vegetation-shadow";
import {
  loadTerrainTilesForBounds,
  sampleSwissTerrainElevationLv95,
  sampleSwissTerrainElevationLv95FromTiles,
  TerrainTileSource,
} from "@/lib/terrain/swiss-terrain";

export interface Lv95Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BuildSharedPointEvaluationSourcesOptions {
  terrainHorizonOverride?: HorizonMask;
  lv95Bounds?: Lv95Bounds;
  vegetationSearchDistanceMeters?: number;
}

export interface SharedPointEvaluationSources {
  horizonMask: Awaited<ReturnType<typeof loadLausanneHorizonMask>>;
  buildingsIndex: Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>;
  terrainTiles: TerrainTileSource[] | null;
  vegetationSurfaceTiles: Awaited<
    ReturnType<typeof loadVegetationSurfaceTilesForBounds>
  >;
}

export interface BuildPointEvaluationContextOptions {
  skipTerrainSamplingWhenIndoor?: boolean;
  terrainHorizonOverride?: HorizonMask;
  shadowCalibration?: ShadowCalibration;
  sharedSources?: SharedPointEvaluationSources;
  buildingShadowAllowedIds?: ReadonlySet<string>;
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

type BuildingsShadowMode = "detailed" | "two-level" | "prism";

function parseBuildingsShadowMode(): BuildingsShadowMode {
  const raw = (process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "").trim().toLowerCase();
  if (raw === "detailed" || raw === "two-level" || raw === "prism") {
    return raw;
  }
  if (process.env.MAPPY_BUILDINGS_TWO_LEVEL_REFINEMENT === "0") {
    return "prism";
  }
  return "detailed";
}

const BUILDINGS_SHADOW_MODE = parseBuildingsShadowMode();
const BUILDINGS_TWO_LEVEL_NEAR_THRESHOLD_DEGREES = 2;
const BUILDINGS_TWO_LEVEL_MAX_REFINEMENT_STEPS = 3;
const BUILDINGS_DETAILED_MAX_REFINEMENT_STEPS = 32;

export async function buildSharedPointEvaluationSources(
  options: BuildSharedPointEvaluationSourcesOptions = {},
): Promise<SharedPointEvaluationSources> {
  const [fallbackHorizonMask, buildingsIndex] = await Promise.all([
    loadLausanneHorizonMask(),
    loadBuildingsObstacleIndex(),
  ]);
  const horizonMask = options.terrainHorizonOverride ?? fallbackHorizonMask;
  const terrainTiles = options.lv95Bounds
    ? await loadTerrainTilesForBounds({
        minX: options.lv95Bounds.minX,
        minY: options.lv95Bounds.minY,
        maxX: options.lv95Bounds.maxX,
        maxY: options.lv95Bounds.maxY,
      })
    : null;
  const vegetationSurfaceTiles = options.lv95Bounds
    ? await loadVegetationSurfaceTilesForBounds({
        minX:
          options.lv95Bounds.minX -
          (options.vegetationSearchDistanceMeters ??
            DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS),
        minY:
          options.lv95Bounds.minY -
          (options.vegetationSearchDistanceMeters ??
            DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS),
        maxX:
          options.lv95Bounds.maxX +
          (options.vegetationSearchDistanceMeters ??
            DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS),
        maxY:
          options.lv95Bounds.maxY +
          (options.vegetationSearchDistanceMeters ??
            DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS),
      })
    : null;

  return {
    horizonMask,
    buildingsIndex,
    terrainTiles,
    vegetationSurfaceTiles,
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
  const sharedSources =
    options.sharedSources ??
    (await buildSharedPointEvaluationSources({
      terrainHorizonOverride: options.terrainHorizonOverride,
    }));
  const horizonMask = sharedSources.horizonMask;
  const buildingsIndex = sharedSources.buildingsIndex;

  const containment = buildingsIndex
    ? findContainingBuilding(
        buildingsIndex.obstacles,
        pointLv95.easting,
        pointLv95.northing,
        buildingsIndex.spatialGrid,
      )
    : {
        insideBuilding: false,
        buildingId: null,
      };

  const shouldSkipTerrainSampling =
    options.skipTerrainSamplingWhenIndoor && containment.insideBuilding;
  const pointElevationMeters = shouldSkipTerrainSampling
    ? null
    : sharedSources.terrainTiles && sharedSources.terrainTiles.length > 0
      ? sampleSwissTerrainElevationLv95FromTiles(
          sharedSources.terrainTiles,
          pointLv95.easting,
          pointLv95.northing,
        )
      : await sampleSwissTerrainElevationLv95(pointLv95.easting, pointLv95.northing);

  const shouldEvaluateVegetation =
    pointElevationMeters !== null && !containment.insideBuilding;
  const vegetationSurfaceTiles = shouldEvaluateVegetation
    ? sharedSources.vegetationSurfaceTiles ??
      (await loadVegetationSurfaceTilesForPoint(
        pointLv95.easting,
        pointLv95.northing,
      ))
    : null;

  const buildingShadowEvaluator =
    buildingsIndex && pointElevationMeters !== null && !containment.insideBuilding
      ? (() => {
          const detailedVerifier =
            BUILDINGS_SHADOW_MODE === "prism"
              ? null
              : createDetailedBuildingShadowVerifier(buildingsIndex.obstacles);

          return (sample: { azimuthDeg: number; altitudeDeg: number }) => {
            if (!detailedVerifier || BUILDINGS_SHADOW_MODE === "prism") {
              return evaluateBuildingsShadow(
                buildingsIndex.obstacles,
                {
                  pointX: pointLv95.easting,
                  pointY: pointLv95.northing,
                  pointElevation: pointElevationMeters,
                  allowedBlockerIds: options.buildingShadowAllowedIds,
                  buildingHeightBiasMeters:
                    shadowCalibration.buildingHeightBiasMeters,
                  solarAzimuthDeg: sample.azimuthDeg,
                  solarAltitudeDeg: sample.altitudeDeg,
                },
                buildingsIndex.spatialGrid,
              );
            }

            if (BUILDINGS_SHADOW_MODE === "two-level") {
              return evaluateBuildingsShadowTwoLevel(
                buildingsIndex.obstacles,
                {
                  pointX: pointLv95.easting,
                  pointY: pointLv95.northing,
                  pointElevation: pointElevationMeters,
                  allowedBlockerIds: options.buildingShadowAllowedIds,
                  buildingHeightBiasMeters:
                    shadowCalibration.buildingHeightBiasMeters,
                  solarAzimuthDeg: sample.azimuthDeg,
                  solarAltitudeDeg: sample.altitudeDeg,
                },
                buildingsIndex.spatialGrid,
                {
                  detailedVerifier,
                  nearThresholdDegrees:
                    BUILDINGS_TWO_LEVEL_NEAR_THRESHOLD_DEGREES,
                  maxRefinementSteps:
                    BUILDINGS_TWO_LEVEL_MAX_REFINEMENT_STEPS,
                },
              );
            }

            return evaluateBuildingsShadowTwoLevel(
              buildingsIndex.obstacles,
              {
                pointX: pointLv95.easting,
                pointY: pointLv95.northing,
                pointElevation: pointElevationMeters,
                allowedBlockerIds: options.buildingShadowAllowedIds,
                buildingHeightBiasMeters:
                  shadowCalibration.buildingHeightBiasMeters,
                solarAzimuthDeg: sample.azimuthDeg,
                solarAltitudeDeg: sample.altitudeDeg,
              },
              buildingsIndex.spatialGrid,
              {
                detailedVerifier,
                nearThresholdDegrees: Number.POSITIVE_INFINITY,
                maxRefinementSteps:
                  BUILDINGS_DETAILED_MAX_REFINEMENT_STEPS,
              },
            );
          };
        })()
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
          pointElevation: pointElevationMeters,
        })
      : undefined;

  const warnings: string[] = [];
  if (!horizonMask) {
    warnings.push(
      "No horizon mask found. Run preprocess:horizon:mask (fallback) and ingest terrain horizon DEM tiles for your target area.",
    );
  }
  if (!buildingsIndex) {
    warnings.push(
      "No buildings obstacle index found. Run preprocess:buildings:index after ingesting buildings data for your target area.",
    );
  }
  if (shouldEvaluateVegetation && vegetationSurfaceTiles === null) {
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
    buildingsShadowMethod: buildingsIndex
      ? `${buildingsIndex.method}${
          BUILDINGS_SHADOW_MODE === "two-level"
            ? "|two-level-near-threshold-v1"
            : BUILDINGS_SHADOW_MODE === "detailed"
              ? "|detailed-direct-v1"
              : ""
        }`
      : "none",
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
