import { performance } from "node:perf_hooks";

import SunCalc from "suncalc";

import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
/** Pre-computed grid metadata (indoor/outdoor + elevations). */
interface TileGridMetadata {
  tileId: string;
  modelVersionHash: string;
  gridStepMeters: number;
  totalPoints: number;
  outdoorCount: number;
  indoorCount: number;
  elevations: (number | null)[];
  indoor: boolean[];
}
import { isBatchBackend } from "@/lib/sun/building-shadow-backend";
import { lv95ToWgs84, wgs84ToLv95 } from "@/lib/geo/projection";
import {
  adaptiveHorizonSharingConfig,
  resolveAdaptiveTerrainHorizonForTile,
} from "@/lib/sun/adaptive-horizon-sharing";
import type { ShadowCalibration } from "@/lib/sun/shadow-calibration";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "@/lib/time/zoned-date";

import { getSunlightModelVersion } from "./model-version";
import { TtlCache, runWithInFlightDedup } from "./runtime-cache";
import {
  buildRegionTiles,
  buildTilePoints,
  decodeBase64Bytes,
  findCachedModelVersionHash,
  getIntersectingTileIds,
  getPrecomputedRegionBbox,
  isMaskBitSet,
  loadPrecomputedSunlightManifest,
  loadPrecomputedSunlightTile,
  pointInBbox,
  setMaskBit,
  writePrecomputedSunlightManifest,
  writePrecomputedSunlightTile,
  type PrecomputedRegionName,
  type PrecomputedSunlightManifest,
  type PrecomputedSunlightTileArtifact,
  type RegionBbox,
  type RegionTileSpec,
} from "./sunlight-cache";

const DEFAULT_CACHE_TILE_SIZE_METERS = 250;
const RAD_TO_DEG = 180 / Math.PI;
const BUILDING_SHADOW_MAX_DISTANCE_METERS = 2500;
const BUILDING_TILE_ALLOWLIST_VERSION = "tile-allowlist-v1";
const PRECOMPUTED_REGIONS: PrecomputedRegionName[] = ["lausanne", "nyon", "morges", "geneve"];
const manifestMemoryCache = new TtlCache<PrecomputedSunlightManifest | null>(60_000, 64);
const tileMemoryCache = new TtlCache<PrecomputedSunlightTileArtifact | null>(60_000, 128);

type BuildingsIndex = NonNullable<
  Awaited<ReturnType<typeof buildSharedPointEvaluationSources>>["buildingsIndex"]
>;
type BuildingObstacle = BuildingsIndex["obstacles"][number];
type BuildingSpatialGrid = NonNullable<BuildingsIndex["spatialGrid"]>;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface PreparedOutdoorPoint {
  lat: number;
  lon: number;
  pointElevationMeters: number | null;
  horizonMask: Awaited<ReturnType<typeof buildPointEvaluationContext>>["horizonMask"];
  buildingShadowEvaluator: Awaited<ReturnType<typeof buildPointEvaluationContext>>["buildingShadowEvaluator"];
  vegetationShadowEvaluator: Awaited<ReturnType<typeof buildPointEvaluationContext>>["vegetationShadowEvaluator"];
}

interface SunlightTileComputeProgress {
  stage: "prepare-points" | "evaluate-frames";
  completed: number;
  total: number;
  pointCountTotal: number;
  pointCountOutdoor: number;
  frameCountTotal: number;
  frameIndex: number | null;
  elapsedMs: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Tile precompute aborted.");
  }
}

export interface CacheMetadata {
  hit: boolean;
  layer: "L1" | "L2" | "PARTIAL" | "MISS";
  region: PrecomputedRegionName | null;
  modelVersionHash: string | null;
  fullyCovered: boolean;
}

export interface ResolvedSunlightTiles {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  artifacts: PrecomputedSunlightTileArtifact[];
  tileSizeMeters: number;
  cache: CacheMetadata & {
    tilesRequested: number;
    tilesFromL1: number;
    tilesFromL2: number;
    tilesComputed: number;
  };
}

function formatLocalTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTimeLocal(date: Date, timeZone: string): string {
  const datePart = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const timePart = formatLocalTime(date, timeZone);
  return `${datePart} ${timePart}`;
}

function safeFormatDateTimeLocal(date: Date, timeZone: string): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return formatDateTimeLocal(date, timeZone);
}

function buildSunnyWindowsFromFrameStates(
  frameStates: Array<{ localTime: string; isSunny: boolean }>,
  sampleEveryMinutes: number,
  timeZone: string,
  lastUtcTime: string | null,
): Array<{ startLocalTime: string; endLocalTime: string; durationMinutes: number }> {
  const windows: Array<{
    startLocalTime: string;
    endLocalTime: string;
    durationMinutes: number;
  }> = [];
  let currentStart: string | null = null;
  let currentDuration = 0;

  for (const frame of frameStates) {
    if (frame.isSunny) {
      if (!currentStart) {
        currentStart = frame.localTime;
      }
      currentDuration += sampleEveryMinutes;
      continue;
    }

    if (currentStart) {
      windows.push({
        startLocalTime: currentStart,
        endLocalTime: frame.localTime,
        durationMinutes: currentDuration,
      });
      currentStart = null;
      currentDuration = 0;
    }
  }

  if (currentStart) {
    const endLocalTime = lastUtcTime
      ? formatDateTimeLocal(
          new Date(Date.parse(lastUtcTime) + sampleEveryMinutes * 60_000),
          timeZone,
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

function computeSolarGeometry(
  lat: number,
  lon: number,
  utcDate: Date,
): { altitudeDeg: number; azimuthDeg: number } {
  const position = SunCalc.getPosition(utcDate, lat, lon);
  const fromNorth = ((position.azimuth * RAD_TO_DEG) + 180) % 360;
  return {
    altitudeDeg: position.altitude * RAD_TO_DEG,
    azimuthDeg: fromNorth >= 0 ? fromNorth : fromNorth + 360,
  };
}

function buildSpatialCellKey(cellX: number, cellY: number): string {
  return `${cellX}:${cellY}`;
}

function collectTileSampleCandidateObstacleIndices(params: {
  obstacles: BuildingObstacle[];
  spatialGrid: BuildingSpatialGrid;
  centerX: number;
  centerY: number;
  tileRadiusMeters: number;
  dirX: number;
  dirY: number;
  maxDistanceMeters: number;
  maxObstacleHalfDiagonalMeters: number;
}): Set<number> {
  const cellSizeMeters = params.spatialGrid.cellSizeMeters;
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    return new Set(params.obstacles.map((_, index) => index));
  }

  const corridorLength = params.maxDistanceMeters + params.tileRadiusMeters;
  const endX = params.centerX + params.dirX * corridorLength;
  const endY = params.centerY + params.dirY * corridorLength;
  const corridorPadding =
    params.tileRadiusMeters + params.maxObstacleHalfDiagonalMeters + cellSizeMeters;
  const minX = Math.min(params.centerX, endX) - corridorPadding;
  const maxX = Math.max(params.centerX, endX) + corridorPadding;
  const minY = Math.min(params.centerY, endY) - corridorPadding;
  const maxY = Math.max(params.centerY, endY) + corridorPadding;
  const minCellX = Math.floor(minX / cellSizeMeters);
  const maxCellX = Math.floor(maxX / cellSizeMeters);
  const minCellY = Math.floor(minY / cellSizeMeters);
  const maxCellY = Math.floor(maxY / cellSizeMeters);

  const cellHalfDiagonal = (Math.SQRT2 * cellSizeMeters) / 2;
  const minDotThreshold = -(params.tileRadiusMeters + cellHalfDiagonal);
  const maxCenterDistance =
    params.maxDistanceMeters + params.tileRadiusMeters + cellHalfDiagonal;
  const corridorHalfWidth =
    params.tileRadiusMeters + cellHalfDiagonal + params.maxObstacleHalfDiagonalMeters;
  const candidateIndices = new Set<number>();

  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      const key = buildSpatialCellKey(cellX, cellY);
      const indices = params.spatialGrid.cells[key];
      if (!indices || indices.length === 0) {
        continue;
      }

      const cellCenterX = (cellX + 0.5) * cellSizeMeters;
      const cellCenterY = (cellY + 0.5) * cellSizeMeters;
      const dx = cellCenterX - params.centerX;
      const dy = cellCenterY - params.centerY;
      const dot = dx * params.dirX + dy * params.dirY;
      if (dot < minDotThreshold) {
        continue;
      }
      const lateral = Math.abs(dx * params.dirY - dy * params.dirX);
      if (lateral > corridorHalfWidth) {
        continue;
      }
      const centerDistance = Math.hypot(dx, dy);
      if (centerDistance > maxCenterDistance) {
        continue;
      }

      for (const obstacleIndex of indices) {
        candidateIndices.add(obstacleIndex);
      }
    }
  }

  return candidateIndices;
}

function collectTileWindowBuildingAllowlist(params: {
  tile: RegionTileSpec;
  samples: Date[];
  buildingsIndex: BuildingsIndex | null;
  maxDistanceMeters?: number;
}): ReadonlySet<string> | undefined {
  if (!params.buildingsIndex || params.samples.length === 0) {
    return undefined;
  }

  const obstacles = params.buildingsIndex.obstacles;
  if (obstacles.length === 0) {
    return undefined;
  }

  const centerX = (params.tile.minEasting + params.tile.maxEasting) / 2;
  const centerY = (params.tile.minNorthing + params.tile.maxNorthing) / 2;
  const tileRadiusMeters =
    Math.hypot(
      params.tile.maxEasting - params.tile.minEasting,
      params.tile.maxNorthing - params.tile.minNorthing,
    ) / 2;
  const centerWgs84 = lv95ToWgs84(centerX, centerY);
  const maxDistanceMeters = params.maxDistanceMeters ?? BUILDING_SHADOW_MAX_DISTANCE_METERS;
  const maxObstacleHalfDiagonalMeters = obstacles.reduce(
    (maxValue, obstacle) => Math.max(maxValue, obstacle.halfDiagonal),
    0,
  );
  const spatialGrid = params.buildingsIndex.spatialGrid;
  const allowedBlockerIds = new Set<string>();
  let aboveHorizonSamples = 0;

  for (const sampleDate of params.samples) {
    const solarGeometry = computeSolarGeometry(centerWgs84.lat, centerWgs84.lon, sampleDate);
    if (solarGeometry.altitudeDeg <= 0) {
      continue;
    }

    aboveHorizonSamples += 1;
    const azimuthRad = (solarGeometry.azimuthDeg * Math.PI) / 180;
    const dirX = Math.sin(azimuthRad);
    const dirY = Math.cos(azimuthRad);
    const candidateIndices = spatialGrid
      ? collectTileSampleCandidateObstacleIndices({
          obstacles,
          spatialGrid,
          centerX,
          centerY,
          tileRadiusMeters,
          dirX,
          dirY,
          maxDistanceMeters,
          maxObstacleHalfDiagonalMeters,
        })
      : new Set(obstacles.map((_, index) => index));

    for (const obstacleIndex of candidateIndices) {
      const obstacle = obstacles[obstacleIndex];
      if (!obstacle) {
        continue;
      }
      if (allowedBlockerIds.has(obstacle.id)) {
        continue;
      }

      const dx = obstacle.centerX - centerX;
      const dy = obstacle.centerY - centerY;
      const dot = dx * dirX + dy * dirY;
      if (dot < -(tileRadiusMeters + obstacle.halfDiagonal)) {
        continue;
      }
      const lateral = Math.abs(dx * dirY - dy * dirX);
      if (lateral > tileRadiusMeters + obstacle.halfDiagonal) {
        continue;
      }
      const centerDistance = Math.hypot(dx, dy);
      if (centerDistance > maxDistanceMeters + tileRadiusMeters + obstacle.halfDiagonal) {
        continue;
      }
      allowedBlockerIds.add(obstacle.id);
    }
  }

  if (aboveHorizonSamples === 0 || allowedBlockerIds.size === 0) {
    return undefined;
  }

  return allowedBlockerIds;
}

export function resolveRegionForBbox(bbox: RegionBbox): PrecomputedRegionName | null {
  return (
    PRECOMPUTED_REGIONS.find((region) => {
      const regionBbox = getPrecomputedRegionBbox(region);
      return (
        regionBbox.minLon <= bbox.minLon &&
        regionBbox.minLat <= bbox.minLat &&
        regionBbox.maxLon >= bbox.maxLon &&
        regionBbox.maxLat >= bbox.maxLat
      );
    }) ?? null
  );
}

export function createUtcSamples(
  date: string,
  timeZone: string,
  sampleEveryMinutes: number,
  startLocalTime: string,
  endLocalTime: string,
): Date[] {
  const { startUtc: dayStartUtc, endUtc: dayEndUtc } = getZonedDayRangeUtc(date, timeZone);
  const rangeStartUtc = zonedDateTimeToUtc(date, startLocalTime, timeZone);
  const rangeEndUtc = zonedDateTimeToUtc(date, endLocalTime, timeZone);
  const startUtc = new Date(Math.max(dayStartUtc.getTime(), rangeStartUtc.getTime()));
  const endUtc = new Date(Math.min(dayEndUtc.getTime(), rangeEndUtc.getTime()));
  if (endUtc.getTime() <= startUtc.getTime()) {
    return [];
  }

  const result: Date[] = [];
  const sampleEveryMs = sampleEveryMinutes * 60_000;
  for (let cursor = startUtc.getTime(); cursor < endUtc.getTime(); cursor += sampleEveryMs) {
    result.push(new Date(cursor));
  }
  return result;
}

async function loadManifestCached(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}) {
  const key = JSON.stringify(params);
  const cached = manifestMemoryCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const loaded = await loadPrecomputedSunlightManifest(params);
  manifestMemoryCache.set(key, loaded);
  return loaded;
}

async function loadTileCached(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileId: string;
}) {
  const key = JSON.stringify(params);
  const cached = tileMemoryCache.get(key);
  if (cached !== undefined) {
    return cached
      ? { artifact: cached, layer: "L1" as const }
      : { artifact: null, layer: "MISS" as const };
  }
  const loaded = await loadPrecomputedSunlightTile(params);
  tileMemoryCache.set(key, loaded);
  return {
    artifact: loaded,
    layer: loaded ? ("L2" as const) : ("MISS" as const),
  };
}

const emptyDiagnostics: PrecomputedSunlightTileArtifact["frames"][number]["diagnostics"] = {
  horizonAngleDegByPoint: [],
  buildingBlockerIdByPoint: [],
  buildingBlockerDistanceMetersByPoint: [],
  vegetationBlockerDistanceMetersByPoint: [],
};

function stripArtifactDiagnostics(
  artifact: PrecomputedSunlightTileArtifact,
): PrecomputedSunlightTileArtifact {
  return {
    ...artifact,
    frames: artifact.frames.map((frame) => ({
      ...frame,
      diagnostics: emptyDiagnostics,
    })),
  };
}

async function loadTileDiskOnly(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileId: string;
  stripDiagnostics?: boolean;
}) {
  const loaded = await loadPrecomputedSunlightTile(params);
  const artifact = loaded && params.stripDiagnostics
    ? stripArtifactDiagnostics(loaded)
    : loaded;
  return {
    artifact,
    layer: loaded ? ("L2" as const) : ("MISS" as const),
  };
}

async function upsertManifest(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileSizeMeters: number;
  succeededTileIds: string[];
  failedTileIds: string[];
}) {
  const current =
    (await loadPrecomputedSunlightManifest({
      region: params.region,
      modelVersionHash: params.modelVersionHash,
      date: params.date,
      gridStepMeters: params.gridStepMeters,
      sampleEveryMinutes: params.sampleEveryMinutes,
      startLocalTime: params.startLocalTime,
      endLocalTime: params.endLocalTime,
    })) ?? null;
  const regionTiles = buildRegionTiles(params.region, params.tileSizeMeters);
  const nextTileIds = Array.from(
    new Set([...(current?.tileIds ?? []), ...params.succeededTileIds]),
  ).sort();
  const nextFailedTileIds = Array.from(
    new Set([...(current?.failedTileIds ?? []), ...params.failedTileIds]),
  ).sort();
  const manifest: PrecomputedSunlightManifest = {
    artifactFormatVersion: current?.artifactFormatVersion ?? 2,
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    timezone: params.timezone,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tileSizeMeters: params.tileSizeMeters,
    tileIds: nextTileIds,
    failedTileIds: nextFailedTileIds,
    bbox: getPrecomputedRegionBbox(params.region),
    generatedAt: new Date().toISOString(),
    complete:
      nextFailedTileIds.length === 0 && nextTileIds.length === regionTiles.length,
  };

  await writePrecomputedSunlightManifest(manifest);
  manifestMemoryCache.set(
    JSON.stringify({
      region: params.region,
      modelVersionHash: params.modelVersionHash,
      date: params.date,
      gridStepMeters: params.gridStepMeters,
      sampleEveryMinutes: params.sampleEveryMinutes,
      startLocalTime: params.startLocalTime,
      endLocalTime: params.endLocalTime,
    }),
    manifest,
  );
}

export async function computeSunlightTileArtifact(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: RegionTileSpec;
  shadowCalibration: ShadowCalibration;
  cooperativeYieldEveryPoints?: number;
  onProgress?: (progress: SunlightTileComputeProgress) => void;
  signal?: AbortSignal;
  /** Pre-computed grid metadata (indoor/outdoor + elevations). Skips per-point context building when provided. */
  gridMetadata?: TileGridMetadata | null;
}): Promise<PrecomputedSunlightTileArtifact> {
  const started = performance.now();
  const phaseMs = { adaptiveHorizon: 0, sharedSources: 0, pointContexts: 0, evaluations: 0 };
  throwIfAborted(params.signal);
  const rawTilePoints = buildTilePoints(params.tile, params.gridStepMeters);
  const warnings: string[] = [];
  let terrainMethod = "none";
  let buildingsMethod = "none";
  let vegetationMethod = "none";
  let indoorPointsExcluded = 0;
  let pointsWithElevation = 0;
  let terrainHorizonOverride:
    | Awaited<ReturnType<typeof resolveAdaptiveTerrainHorizonForTile>>["horizonMask"]
    | undefined;
  const horizonT0 = performance.now();
  try {
    const adaptiveHorizon = await resolveAdaptiveTerrainHorizonForTile({
      region: params.region,
      modelVersionHash: params.modelVersionHash,
      tile: params.tile,
      date: params.date,
      timezone: params.timezone,
      sampleEveryMinutes: params.sampleEveryMinutes,
      startLocalTime: params.startLocalTime,
      endLocalTime: params.endLocalTime,
      gridStepMeters: params.gridStepMeters,
    });
    terrainHorizonOverride = adaptiveHorizon.horizonMask ?? undefined;
    terrainMethod = adaptiveHorizon.terrainMethod;
    warnings.push(...adaptiveHorizon.warnings);
    if (!adaptiveHorizon.horizonMask) {
      warnings.push(`Dynamic terrain horizon unavailable for tile ${params.tile.tileId}.`);
    }
  } catch (error) {
    warnings.push(
      `Adaptive terrain horizon resolution failed for tile ${params.tile.tileId} (${error instanceof Error ? error.message : "unknown error"}).`,
    );
  }

  phaseMs.adaptiveHorizon = performance.now() - horizonT0;

  const points: PrecomputedSunlightTileArtifact["points"] = [];
  const preparedOutdoorPoints: PreparedOutdoorPoint[] = [];
  const sourcesT0 = performance.now();
  const sharedSources = await buildSharedPointEvaluationSources({
    terrainHorizonOverride: terrainHorizonOverride ?? undefined,
    region: params.region,
    lv95Bounds: {
      minX: params.tile.minEasting,
      minY: params.tile.minNorthing,
      maxX: params.tile.maxEasting,
      maxY: params.tile.maxNorthing,
    },
  });
  const samples = createUtcSamples(
    params.date,
    params.timezone,
    params.sampleEveryMinutes,
    params.startLocalTime,
    params.endLocalTime,
  );
  if (samples.length === 0) {
    throw new Error(
      `No samples produced for ${params.date} ${params.startLocalTime}-${params.endLocalTime}.`,
    );
  }
  const tileBuildingAllowlist = collectTileWindowBuildingAllowlist({
    tile: params.tile,
    samples,
    buildingsIndex: sharedSources.buildingsIndex,
  });
  const buildingMethodSuffix = tileBuildingAllowlist
    ? `|${BUILDING_TILE_ALLOWLIST_VERSION}`
    : "";
  phaseMs.sharedSources = performance.now() - sourcesT0;

  const pointsT0 = performance.now();
  const gm = params.gridMetadata;
  for (let rawPointIndex = 0; rawPointIndex < rawTilePoints.length; rawPointIndex += 1) {
    throwIfAborted(params.signal);
    const point = rawTilePoints[rawPointIndex];

    // Fast path: use pre-computed grid metadata for indoor/elevation
    if (gm && gm.indoor[rawPointIndex]) {
      indoorPointsExcluded += 1;
      points.push({
        ...point,
        insideBuilding: true,
        indoorBuildingId: null,
        outdoorIndex: null,
        pointElevationMeters: null,
      });
      continue;
    }

    if (gm) {
      // Outdoor point with cached elevation — still need evaluator functions
      const context = await buildPointEvaluationContext(point.lat, point.lon, {
        skipTerrainSamplingWhenIndoor: true,
        terrainHorizonOverride: terrainHorizonOverride ?? undefined,
        shadowCalibration: params.shadowCalibration,
        sharedSources,
        buildingShadowAllowedIds: tileBuildingAllowlist,
        // Override elevation from metadata to skip terrain sampling
        overrideElevation: gm.elevations[rawPointIndex],
        skipIndoorCheck: true,
      });
      terrainMethod = context.terrainHorizonMethod;
      buildingsMethod = `${context.buildingsShadowMethod}${buildingMethodSuffix}`;
      vegetationMethod = context.vegetationShadowMethod ?? "none";
      warnings.push(...context.warnings);
      const outdoorIndex = preparedOutdoorPoints.length;
      if (gm.elevations[rawPointIndex] !== null) pointsWithElevation += 1;
      preparedOutdoorPoints.push({
        lat: point.lat,
        lon: point.lon,
        pointElevationMeters: gm.elevations[rawPointIndex],
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
        vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      });
      points.push({
        ...point,
        insideBuilding: false,
        indoorBuildingId: null,
        outdoorIndex,
        pointElevationMeters: gm.elevations[rawPointIndex],
      });
    } else {
      // Original path: full context building
      const context = await buildPointEvaluationContext(point.lat, point.lon, {
        skipTerrainSamplingWhenIndoor: true,
        terrainHorizonOverride: terrainHorizonOverride ?? undefined,
        shadowCalibration: params.shadowCalibration,
        sharedSources,
        buildingShadowAllowedIds: tileBuildingAllowlist,
      });
      terrainMethod = context.terrainHorizonMethod;
      buildingsMethod = `${context.buildingsShadowMethod}${buildingMethodSuffix}`;
      vegetationMethod = context.vegetationShadowMethod ?? "none";
      warnings.push(...context.warnings);

      if (context.insideBuilding) {
        indoorPointsExcluded += 1;
        points.push({
          ...point,
          insideBuilding: true,
          indoorBuildingId: context.indoorBuildingId,
          outdoorIndex: null,
          pointElevationMeters: null,
        });
        continue;
      }

      const outdoorIndex = preparedOutdoorPoints.length;
      if (context.pointElevationMeters !== null) {
        pointsWithElevation += 1;
      }
      preparedOutdoorPoints.push({
        lat: point.lat,
        lon: point.lon,
        pointElevationMeters: context.pointElevationMeters,
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
        vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      });
      points.push({
        ...point,
        insideBuilding: false,
        indoorBuildingId: null,
        outdoorIndex,
        pointElevationMeters: context.pointElevationMeters,
      });
    }

    if (
      params.cooperativeYieldEveryPoints &&
      params.cooperativeYieldEveryPoints > 0 &&
      rawPointIndex > 0 &&
      (rawPointIndex + 1) % params.cooperativeYieldEveryPoints === 0
    ) {
      params.onProgress?.({
        stage: "prepare-points",
        completed: rawPointIndex + 1,
        total: rawTilePoints.length,
        pointCountTotal: rawTilePoints.length,
        pointCountOutdoor: preparedOutdoorPoints.length,
        frameCountTotal: 0,
        frameIndex: null,
        elapsedMs: performance.now() - started,
      });
      await yieldToEventLoop();
      throwIfAborted(params.signal);
    }
  }
  phaseMs.pointContexts = performance.now() - pointsT0;

  // Abort if terrain data is missing — producing tiles without elevation
  // creates invalid cache entries (building shadows skipped, wrong results).
  if (preparedOutdoorPoints.length > 0 && pointsWithElevation === 0) {
    throw new Error(
      `Terrain data unavailable for tile ${params.tile.tileId}: 0/${preparedOutdoorPoints.length} outdoor points have elevation. ` +
      `Download terrain with: npx tsx scripts/ingest/download-terrain.ts --region=${params.region}`,
    );
  }

  params.onProgress?.({
    stage: "prepare-points",
    completed: rawTilePoints.length,
    total: rawTilePoints.length,
    pointCountTotal: rawTilePoints.length,
    pointCountOutdoor: preparedOutdoorPoints.length,
    frameCountTotal: 0,
    frameIndex: null,
    elapsedMs: performance.now() - started,
  });

  const evalsT0 = performance.now();
  const frames: PrecomputedSunlightTileArtifact["frames"] = [];
  const totalFrameEvaluations = preparedOutdoorPoints.length * samples.length;
  let completedFrameEvaluations = 0;
  const tileCenterWgs84 = lv95ToWgs84(
    (params.tile.minEasting + params.tile.maxEasting) / 2,
    (params.tile.minNorthing + params.tile.maxNorthing) / 2,
  );

  // ── WebGPU batch path: prepare point array once for all frames ──────
  const webgpuBackend = sharedSources.webgpuComputeBackend;
  const useBatchPath = webgpuBackend != null && isBatchBackend(webgpuBackend);
  let batchPointsF32: Float32Array | null = null;
  if (useBatchPath) {
    const origin = webgpuBackend.getOrigin();
    batchPointsF32 = new Float32Array(preparedOutdoorPoints.length * 4);
    for (let i = 0; i < preparedOutdoorPoints.length; i++) {
      const pt = preparedOutdoorPoints[i];
      const lv95 = wgs84ToLv95(pt.lon, pt.lat);
      // Backend expects centered coords: x = easting - originX, y = elevation, z = northing - originY
      batchPointsF32[i * 4 + 0] = lv95.easting - origin.x;
      batchPointsF32[i * 4 + 1] = pt.pointElevationMeters ?? 0;
      batchPointsF32[i * 4 + 2] = lv95.northing - origin.y;
      batchPointsF32[i * 4 + 3] = 0; // padding for vec4f alignment
    }
  }

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    throwIfAborted(params.signal);
    const sampleDate = samples[sampleIndex];
    const frameLocalDateTime = formatDateTimeLocal(sampleDate, params.timezone);
    const frameSunPosition = SunCalc.getPosition(sampleDate, tileCenterWgs84.lat, tileCenterWgs84.lon);
    const frameSolarPosition = {
      altitudeDeg: frameSunPosition.altitude * RAD_TO_DEG,
      azimuthDeg: ((frameSunPosition.azimuth * RAD_TO_DEG) + 180) % 360,
    };
    if (frameSolarPosition.azimuthDeg < 0) {
      frameSolarPosition.azimuthDeg += 360;
    }
    const localTime = frameLocalDateTime.slice(11, 16);
    const maskByteLen = Math.ceil(preparedOutdoorPoints.length / 8);

    // ── Fast path: skip per-point evaluation when sun is below horizon ─
    if (frameSolarPosition.altitudeDeg <= 0) {
      // Sun below horizon → everything is dark, all masks are zero
      frames.push({
        index: sampleIndex,
        localTime,
        utcTime: sampleDate.toISOString(),
        sunnyCount: 0,
        sunnyCountNoVegetation: 0,
        sunMaskBase64: Buffer.from(new Uint8Array(maskByteLen)).toString("base64"),
        sunMaskNoVegetationBase64: Buffer.from(new Uint8Array(maskByteLen)).toString("base64"),
        terrainBlockedMaskBase64: Buffer.from(new Uint8Array(maskByteLen)).toString("base64"),
        buildingsBlockedMaskBase64: Buffer.from(new Uint8Array(maskByteLen)).toString("base64"),
        vegetationBlockedMaskBase64: Buffer.from(new Uint8Array(maskByteLen)).toString("base64"),
        diagnostics: {
          horizonAngleDegByPoint: [],
          buildingBlockerIdByPoint: [],
          buildingBlockerDistanceMetersByPoint: [],
          vegetationBlockerDistanceMetersByPoint: [],
        },
      });
      completedFrameEvaluations += preparedOutdoorPoints.length;
      continue;
    }

    const sunnyMask = new Uint8Array(maskByteLen);
    const sunnyMaskNoVegetation = new Uint8Array(maskByteLen);
    const terrainMask = new Uint8Array(maskByteLen);
    const buildingsMask = new Uint8Array(maskByteLen);
    const vegetationMask = new Uint8Array(maskByteLen);
    const horizonAngleDegByPoint: Array<number | null> = [];
    const buildingBlockerIdByPoint: Array<string | null> = [];
    let sunnyCount = 0;
    let sunnyCountNoVegetation = 0;

    // ── GPU batch building shadow evaluation ─────────────────────────
    let batchBuildingBlockedMask: Uint32Array | null = null;
    if (useBatchPath && batchPointsF32) {
      batchBuildingBlockedMask = await webgpuBackend.evaluateBatch(
        batchPointsF32,
        preparedOutdoorPoints.length,
        frameSolarPosition.azimuthDeg,
        frameSolarPosition.altitudeDeg,
      );
    }

    for (let pointIndex = 0; pointIndex < preparedOutdoorPoints.length; pointIndex += 1) {
      throwIfAborted(params.signal);
      const point = preparedOutdoorPoints[pointIndex];

      // When using batch path, override building shadow with GPU result
      const batchBuildingsBlocked = batchBuildingBlockedMask
        ? ((batchBuildingBlockedMask[pointIndex >>> 5] >>> (pointIndex & 31)) & 1) === 1
        : false;

      const sample = useBatchPath
        ? evaluateInstantSunlight({
            lat: point.lat,
            lon: point.lon,
            utcDate: sampleDate,
            timeZone: params.timezone,
            localDateTimeOverride: frameLocalDateTime,
            horizonMask: point.horizonMask,
            // Skip per-point building shadow — already computed in batch
            buildingShadowEvaluator: undefined,
            vegetationShadowEvaluator: point.vegetationShadowEvaluator,
            solarPositionOverride: frameSolarPosition,
          })
        : evaluateInstantSunlight({
            lat: point.lat,
            lon: point.lon,
            utcDate: sampleDate,
            timeZone: params.timezone,
            localDateTimeOverride: frameLocalDateTime,
            horizonMask: point.horizonMask,
            buildingShadowEvaluator: point.buildingShadowEvaluator,
            vegetationShadowEvaluator: point.vegetationShadowEvaluator,
            solarPositionOverride: frameSolarPosition,
          });

      // Merge batch building result with per-point result
      const buildingsBlocked = useBatchPath ? batchBuildingsBlocked : sample.buildingsBlocked;

      horizonAngleDegByPoint.push(
        sample.horizonAngleDeg === null ? null : Math.round(sample.horizonAngleDeg * 1000) / 1000,
      );
      buildingBlockerIdByPoint.push(useBatchPath ? null : sample.buildingBlockerId);

      const isSunnyNoVegetation =
        sample.aboveAstronomicalHorizon &&
        !sample.terrainBlocked &&
        !buildingsBlocked;
      if (sample.terrainBlocked) {
        setMaskBit(terrainMask, pointIndex);
      }
      if (buildingsBlocked) {
        setMaskBit(buildingsMask, pointIndex);
      }
      if (sample.vegetationBlocked) {
        setMaskBit(vegetationMask, pointIndex);
      }
      if (isSunnyNoVegetation) {
        setMaskBit(sunnyMaskNoVegetation, pointIndex);
        sunnyCountNoVegetation += 1;
      }
      const isSunny = isSunnyNoVegetation && !sample.vegetationBlocked;
      if (isSunny) {
        setMaskBit(sunnyMask, pointIndex);
        sunnyCount += 1;
      }
      if (
        params.cooperativeYieldEveryPoints &&
        params.cooperativeYieldEveryPoints > 0 &&
        pointIndex > 0 &&
        pointIndex % params.cooperativeYieldEveryPoints === 0
      ) {
        params.onProgress?.({
          stage: "evaluate-frames",
          completed: completedFrameEvaluations,
          total: totalFrameEvaluations,
          pointCountTotal: rawTilePoints.length,
          pointCountOutdoor: preparedOutdoorPoints.length,
          frameCountTotal: samples.length,
          frameIndex: sampleIndex + 1,
          elapsedMs: performance.now() - started,
        });
        await yieldToEventLoop();
        throwIfAborted(params.signal);
      }
      completedFrameEvaluations += 1;
    }

    frames.push({
      index: sampleIndex,
      localTime,
      utcTime: sampleDate.toISOString(),
      sunnyCount,
      sunnyCountNoVegetation,
      sunMaskBase64: Buffer.from(sunnyMask).toString("base64"),
      sunMaskNoVegetationBase64: Buffer.from(sunnyMaskNoVegetation).toString("base64"),
      terrainBlockedMaskBase64: Buffer.from(terrainMask).toString("base64"),
      buildingsBlockedMaskBase64: Buffer.from(buildingsMask).toString("base64"),
      vegetationBlockedMaskBase64: Buffer.from(vegetationMask).toString("base64"),
      diagnostics: {
        horizonAngleDegByPoint,
        buildingBlockerIdByPoint,
        buildingBlockerDistanceMetersByPoint: [],
        vegetationBlockerDistanceMetersByPoint: [],
      },
    });

    params.onProgress?.({
      stage: "evaluate-frames",
      completed: completedFrameEvaluations,
      total: totalFrameEvaluations,
      pointCountTotal: rawTilePoints.length,
      pointCountOutdoor: preparedOutdoorPoints.length,
      frameCountTotal: samples.length,
      frameIndex: sampleIndex + 1,
      elapsedMs: performance.now() - started,
    });
  }

  phaseMs.evaluations = performance.now() - evalsT0;
  const totalMs = performance.now() - started;
  const evals = preparedOutdoorPoints.length * frames.length;
  console.log(
    `[tile ${params.tile.tileId}] ${(totalMs / 1000).toFixed(1)}s total` +
      ` \u2014 horizon ${(phaseMs.adaptiveHorizon / 1000).toFixed(1)}s` +
      `, sources ${(phaseMs.sharedSources / 1000).toFixed(1)}s` +
      `, points ${(phaseMs.pointContexts / 1000).toFixed(1)}s` +
      `, eval ${(phaseMs.evaluations / 1000).toFixed(1)}s` +
      ` (${evals} evals, ${evals > 0 ? Math.round((phaseMs.evaluations * 1000) / evals) : 0} \u00b5s/eval)` +
      ` — ${rawTilePoints.length} grid pts, ${preparedOutdoorPoints.length} outdoor, ${indoorPointsExcluded} indoor`,
  );

  return {
    artifactFormatVersion: 2,
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    timezone: params.timezone,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tile: params.tile,
    points,
    frames,
    model: {
      terrainHorizonMethod: terrainMethod,
      buildingsShadowMethod: buildingsMethod,
      vegetationShadowMethod: vegetationMethod,
      algorithmVersion: `${params.algorithmVersion}|${adaptiveHorizonSharingConfig.version}`,
      shadowCalibration: params.shadowCalibration,
    },
    warnings: Array.from(new Set(warnings)),
    stats: {
      gridPointCount: rawTilePoints.length,
      pointCount: preparedOutdoorPoints.length,
      indoorPointsExcluded,
      pointsWithElevation,
      pointsWithoutElevation: preparedOutdoorPoints.length - pointsWithElevation,
      totalEvaluations: preparedOutdoorPoints.length * frames.length,
      elapsedMs: Math.round(totalMs * 1000) / 1000,
    },
  };
}

async function getOrCreateTileArtifact(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: RegionTileSpec;
  shadowCalibration: ShadowCalibration;
  persistMissingTiles: boolean;
  skipMemoryCache?: boolean;
  onProgress?: (progress: SunlightTileComputeProgress) => void;
}) {
  const loadParams = {
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tileId: params.tile.tileId,
  };
  const existing = params.skipMemoryCache
    ? await loadTileDiskOnly({ ...loadParams, stripDiagnostics: true })
    : await loadTileCached(loadParams);
  if (existing.artifact) {
    return existing;
  }

  const dedupKey = JSON.stringify({
    kind: "tile-artifact",
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tileId: params.tile.tileId,
    shadowCalibration: params.shadowCalibration,
  });

  const artifact = await runWithInFlightDedup(dedupKey, async () => {
    // Load pre-computed grid metadata (zenith indoor mask + elevations)
    let gridMetadata: TileGridMetadata | null | undefined;
    try {
      const { loadTileGridMetadata } = await import("@/lib/precompute/tile-grid-metadata");
      gridMetadata = await loadTileGridMetadata(
        params.region, params.modelVersionHash, params.gridStepMeters, params.tile.tileId,
      );
    } catch (e) {
      process.stderr.write(`[grid-metadata] FAILED to load: ${e}\n`);
    }
    process.stderr.write(`[grid-metadata] tile=${params.tile.tileId} loaded=${!!gridMetadata} indoor=${gridMetadata?.indoorCount ?? '?'}\n`);

    const computed = await computeSunlightTileArtifact({
      region: params.region,
      modelVersionHash: params.modelVersionHash,
      algorithmVersion: params.algorithmVersion,
      date: params.date,
      timezone: params.timezone,
      sampleEveryMinutes: params.sampleEveryMinutes,
      gridStepMeters: params.gridStepMeters,
      startLocalTime: params.startLocalTime,
      endLocalTime: params.endLocalTime,
      tile: params.tile,
      shadowCalibration: params.shadowCalibration,
      cooperativeYieldEveryPoints: 5000,
      onProgress: params.onProgress,
      gridMetadata,
    });
    if (params.persistMissingTiles) {
      await writePrecomputedSunlightTile(computed);
      await upsertManifest({
        region: params.region,
        modelVersionHash: params.modelVersionHash,
        date: params.date,
        timezone: params.timezone,
        gridStepMeters: params.gridStepMeters,
        sampleEveryMinutes: params.sampleEveryMinutes,
        startLocalTime: params.startLocalTime,
        endLocalTime: params.endLocalTime,
        tileSizeMeters: params.tile.tileSizeMeters,
        succeededTileIds: [params.tile.tileId],
        failedTileIds: [],
      });
    }
    return computed;
  });

  if (!params.skipMemoryCache) {
    tileMemoryCache.set(
      JSON.stringify({
        region: params.region,
        modelVersionHash: params.modelVersionHash,
        date: params.date,
        gridStepMeters: params.gridStepMeters,
        sampleEveryMinutes: params.sampleEveryMinutes,
        startLocalTime: params.startLocalTime,
        endLocalTime: params.endLocalTime,
        tileId: params.tile.tileId,
      }),
      artifact,
    );
  }
  return {
    artifact: params.skipMemoryCache ? stripArtifactDiagnostics(artifact) : artifact,
    layer: "MISS" as const,
  };
}

export interface TileComputeProgressEvent {
  phase: "tile-computation";
  tileIndex: number;
  totalTiles: number;
  tileId: string;
  stage: "prepare-points" | "evaluate-frames";
  stageCompleted: number;
  stageTotal: number;
  percent: number;
  elapsedMs: number;
}

export interface StreamTileResult {
  tileId: string;
  tileIndex: number;
  totalTiles: number;
  artifact: PrecomputedSunlightTileArtifact;
  layer: "L1" | "L2" | "MISS";
}

export interface StreamTilesInit {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  totalTiles: number;
  tileSizeMeters: number;
  sampleCount: number;
}

export async function* streamTilesForBbox(params: {
  bbox: RegionBbox;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  shadowCalibration: ShadowCalibration;
  cacheOnly?: boolean;
  onTileComputeProgress?: (event: TileComputeProgressEvent) => void;
}): AsyncGenerator<StreamTileResult, StreamTilesInit | null> {
  const region = resolveRegionForBbox(params.bbox);
  process.stderr.write(`[stream] bbox=${JSON.stringify(params.bbox)} region=${region} cacheOnly=${params.cacheOnly}\n`);
  if (!region) {
    return null;
  }

  // In cache-only mode, resolve modelVersionHash from existing cache
  // to avoid loading GPU/shared sources (which is slow and memory-heavy).
  let modelVersionHash: string;
  let algorithmVersion = "";
  let cachedTimeWindows: Array<{ startLocalTime: string; endLocalTime: string }> = [];
  let effectiveStartLocalTime = params.startLocalTime;
  let effectiveEndLocalTime = params.endLocalTime;
  if (params.cacheOnly) {
    const cached = await findCachedModelVersionHash({
      region,
      date: params.date,
      gridStepMeters: params.gridStepMeters,
      sampleEveryMinutes: params.sampleEveryMinutes,
      startLocalTime: params.startLocalTime,
      endLocalTime: params.endLocalTime,
    });
    if (!cached) return null;
    modelVersionHash = cached.modelVersionHash;
    cachedTimeWindows = cached.timeWindows;
    // Use the first time window as default for manifest loading
    effectiveStartLocalTime = cached.timeWindows[0].startLocalTime;
    effectiveEndLocalTime = cached.timeWindows[0].endLocalTime;
  } else {
    const modelVersion = await getSunlightModelVersion(region, params.shadowCalibration);
    modelVersionHash = modelVersion.modelVersionHash;
    algorithmVersion = modelVersion.algorithmVersion;
  }

  const manifest = await loadManifestCached({
    region,
    modelVersionHash,
    date: params.date,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: effectiveStartLocalTime,
    endLocalTime: effectiveEndLocalTime,
  });
  const tileSizeMeters = manifest?.tileSizeMeters ?? DEFAULT_CACHE_TILE_SIZE_METERS;
  const allTiles = buildRegionTiles(region, tileSizeMeters);
  const tileById = new Map(allTiles.map((tile) => [tile.tileId, tile]));
  const requiredTileIds = getIntersectingTileIds({
    region,
    tileSizeMeters,
    bbox: params.bbox,
  });
  const requiredTiles = requiredTileIds
    .map((tileId) => tileById.get(tileId) ?? null)
    .filter((tile): tile is RegionTileSpec => tile !== null);

  const samples = createUtcSamples(
    params.date,
    params.timezone,
    params.sampleEveryMinutes,
    effectiveStartLocalTime,
    effectiveEndLocalTime,
  );

  const resolveStartedAt = performance.now();
  let maxPercent = 0;

  for (let tileIdx = 0; tileIdx < requiredTiles.length; tileIdx++) {
    const tile = requiredTiles[tileIdx];

    if (params.cacheOnly) {
      // Try all cached time windows until we find this tile
      for (const tw of cachedTimeWindows) {
        const loaded = await loadTileDiskOnly({
          region,
          modelVersionHash,
          date: params.date,
          gridStepMeters: params.gridStepMeters,
          sampleEveryMinutes: params.sampleEveryMinutes,
          startLocalTime: tw.startLocalTime,
          endLocalTime: tw.endLocalTime,
          tileId: tile.tileId,
          stripDiagnostics: true,
        });
        if (loaded.artifact) {
          yield {
            tileId: tile.tileId,
            tileIndex: tileIdx,
            totalTiles: requiredTiles.length,
            artifact: loaded.artifact,
            layer: loaded.layer,
          };
          break;
        }
      }
      continue;
    }

    const onProgress = params.onTileComputeProgress
      ? (progress: SunlightTileComputeProgress) => {
          const tileBase = tileIdx / requiredTiles.length;
          const tileWeight = 1 / requiredTiles.length;
          const stagePercent =
            progress.total > 0 ? progress.completed / progress.total : 0;
          const rawPercent = Math.round((tileBase + tileWeight * stagePercent) * 1000) / 10;
          maxPercent = Math.max(maxPercent, rawPercent);
          params.onTileComputeProgress!({
            phase: "tile-computation",
            tileIndex: tileIdx + 1,
            totalTiles: requiredTiles.length,
            tileId: tile.tileId,
            stage: progress.stage,
            stageCompleted: progress.completed,
            stageTotal: progress.total,
            percent: maxPercent,
            elapsedMs: performance.now() - resolveStartedAt,
          });
        }
      : undefined;
    const resolved = await getOrCreateTileArtifact({
      region,
      modelVersionHash,
      algorithmVersion,
      date: params.date,
      timezone: params.timezone,
      sampleEveryMinutes: params.sampleEveryMinutes,
      gridStepMeters: params.gridStepMeters,
      startLocalTime: params.startLocalTime,
      endLocalTime: params.endLocalTime,
      tile,
      shadowCalibration: params.shadowCalibration,
      persistMissingTiles: true,
      skipMemoryCache: true,
      onProgress,
    });
    if (resolved.artifact) {
      yield {
        tileId: tile.tileId,
        tileIndex: tileIdx,
        totalTiles: requiredTiles.length,
        artifact: resolved.artifact,
        layer: resolved.layer,
      };
    }
  }

  return {
    region,
    modelVersionHash,
    totalTiles: requiredTiles.length,
    tileSizeMeters,
    sampleCount: samples.length,
  };
}

export async function resolveSunlightTilesForBbox(params: {
  bbox: RegionBbox;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  shadowCalibration: ShadowCalibration;
  persistMissingTiles?: boolean;
  stripDiagnostics?: boolean;
  onTileComputeProgress?: (event: TileComputeProgressEvent) => void;
}): Promise<ResolvedSunlightTiles | null> {
  const region = resolveRegionForBbox(params.bbox);
  if (!region) {
    return null;
  }

  const modelVersion = await getSunlightModelVersion(region, params.shadowCalibration);
  const manifest = await loadManifestCached({
    region,
    modelVersionHash: modelVersion.modelVersionHash,
    date: params.date,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
  });
  const tileSizeMeters = manifest?.tileSizeMeters ?? DEFAULT_CACHE_TILE_SIZE_METERS;
  const allTiles = buildRegionTiles(region, tileSizeMeters);
  const tileById = new Map(allTiles.map((tile) => [tile.tileId, tile]));
  const requiredTileIds = getIntersectingTileIds({
    region,
    tileSizeMeters,
    bbox: params.bbox,
  });
  const requiredTiles = requiredTileIds
    .map((tileId) => tileById.get(tileId) ?? null)
    .filter((tile): tile is RegionTileSpec => tile !== null);

  const artifacts: PrecomputedSunlightTileArtifact[] = [];
  let tilesFromL1 = 0;
  let tilesFromL2 = 0;
  let tilesComputed = 0;
  const resolveStartedAt = performance.now();
  let maxPercent = 0;

  for (let tileIdx = 0; tileIdx < requiredTiles.length; tileIdx++) {
    const tile = requiredTiles[tileIdx];
    const onProgress = params.onTileComputeProgress
      ? (progress: SunlightTileComputeProgress) => {
          const tileBase = tileIdx / requiredTiles.length;
          const tileWeight = 1 / requiredTiles.length;
          const stagePercent =
            progress.total > 0 ? progress.completed / progress.total : 0;
          const rawPercent = Math.round((tileBase + tileWeight * stagePercent) * 1000) / 10;
          maxPercent = Math.max(maxPercent, rawPercent);
          params.onTileComputeProgress!({
            phase: "tile-computation",
            tileIndex: tileIdx + 1,
            totalTiles: requiredTiles.length,
            tileId: tile.tileId,
            stage: progress.stage,
            stageCompleted: progress.completed,
            stageTotal: progress.total,
            percent: maxPercent,
            elapsedMs: performance.now() - resolveStartedAt,
          });
        }
      : undefined;
    const resolved = await getOrCreateTileArtifact({
      region,
      modelVersionHash: modelVersion.modelVersionHash,
      algorithmVersion: modelVersion.algorithmVersion,
      date: params.date,
      timezone: params.timezone,
      sampleEveryMinutes: params.sampleEveryMinutes,
      gridStepMeters: params.gridStepMeters,
      startLocalTime: params.startLocalTime,
      endLocalTime: params.endLocalTime,
      tile,
      shadowCalibration: params.shadowCalibration,
      persistMissingTiles: params.persistMissingTiles ?? true,
      skipMemoryCache: params.stripDiagnostics,
      onProgress,
    });
    if (resolved.layer === "L1") {
      tilesFromL1 += 1;
    } else if (resolved.layer === "L2") {
      tilesFromL2 += 1;
    } else {
      tilesComputed += 1;
    }
    if (!resolved.artifact) {
      continue;
    }
    artifacts.push(resolved.artifact);
  }

  const hit = tilesComputed === 0 && requiredTiles.length > 0;
  const layer =
    tilesComputed > 0
      ? tilesFromL1 + tilesFromL2 > 0
        ? "PARTIAL"
        : "MISS"
      : tilesFromL1 > 0
        ? "L1"
        : "L2";

  return {
    region,
    modelVersionHash: modelVersion.modelVersionHash,
    artifacts,
    tileSizeMeters,
    cache: {
      hit,
      layer,
      region,
      modelVersionHash: modelVersion.modelVersionHash,
      fullyCovered: hit,
      tilesRequested: requiredTiles.length,
      tilesFromL1,
      tilesFromL2,
      tilesComputed,
    },
  };
}

function getFrameForLocalTime(
  artifact: PrecomputedSunlightTileArtifact,
  localTime: string,
): PrecomputedSunlightTileArtifact["frames"][number] | null {
  return artifact.frames.find((frame) => frame.localTime === localTime) ?? null;
}

export function aggregateInstantAreaFromArtifacts(params: {
  artifacts: PrecomputedSunlightTileArtifact[];
  bbox: RegionBbox;
  date: string;
  timezone: string;
  localTime: string;
  maxPoints: number;
  ignoreVegetation: boolean;
}) {
  const utcDate = zonedDateTimeToUtc(params.date, params.localTime, params.timezone);
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
  const warnings = new Set<string>();
  let gridPointCount = 0;
  let indoorPointsExcluded = 0;
  let pointsWithElevation = 0;

  for (const artifact of params.artifacts) {
    const frame = getFrameForLocalTime(artifact, params.localTime);
    if (!frame) {
      return null;
    }
    const sunnyMask = decodeBase64Bytes(frame.sunMaskBase64);
    const sunnyMaskNoVegetation = decodeBase64Bytes(frame.sunMaskNoVegetationBase64);
    const terrainMask = decodeBase64Bytes(frame.terrainBlockedMaskBase64);
    const buildingsMask = decodeBase64Bytes(frame.buildingsBlockedMaskBase64);
    const vegetationMask = decodeBase64Bytes(frame.vegetationBlockedMaskBase64);

    for (const point of artifact.points) {
      if (!pointInBbox(point.lon, point.lat, params.bbox)) {
        continue;
      }
      gridPointCount += 1;
      if (point.insideBuilding || point.outdoorIndex === null) {
        indoorPointsExcluded += 1;
        continue;
      }
      if (points.length >= params.maxPoints) {
        return {
          error: "Outdoor grid exceeds maxPoints limit.",
          detail: `Computed ${points.length + 1} outdoor points (from ${gridPointCount} raw points and ${indoorPointsExcluded} indoor exclusions), but maxPoints is ${params.maxPoints}.`,
        };
      }

      const outdoorIndex = point.outdoorIndex;
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
        isSunny: params.ignoreVegetation
          ? isMaskBitSet(sunnyMaskNoVegetation, outdoorIndex)
          : isMaskBitSet(sunnyMask, outdoorIndex),
        terrainBlocked: isMaskBitSet(terrainMask, outdoorIndex),
        buildingsBlocked: isMaskBitSet(buildingsMask, outdoorIndex),
        vegetationBlocked: params.ignoreVegetation
          ? false
          : isMaskBitSet(vegetationMask, outdoorIndex),
        altitudeDeg: Math.round(solarGeometry.altitudeDeg * 1000) / 1000,
        azimuthDeg: Math.round(solarGeometry.azimuthDeg * 1000) / 1000,
        horizonAngleDeg: frame.diagnostics.horizonAngleDegByPoint[outdoorIndex] ?? null,
        buildingBlockerId: frame.diagnostics.buildingBlockerIdByPoint[outdoorIndex] ?? null,
        insideBuilding: false,
        indoorBuildingId: null,
      });
    }

    for (const warning of artifact.warnings) {
      warnings.add(warning);
    }
  }

  return {
    utcTime: utcDate.toISOString(),
    gridPointCount,
    pointCount: points.length,
    points,
    warnings: Array.from(warnings),
    stats: {
      pointsWithElevation,
      pointsWithoutElevation: points.length - pointsWithElevation,
      indoorPointsExcluded,
    },
    model: {
      terrainHorizonMethod: params.artifacts[0]?.model.terrainHorizonMethod ?? "none",
      buildingsShadowMethod: params.artifacts[0]?.model.buildingsShadowMethod ?? "none",
      vegetationShadowMethod: params.artifacts[0]?.model.vegetationShadowMethod ?? "none",
      terrainHorizonDebug: null,
      shadowCalibration: params.artifacts[0]?.model.shadowCalibration ?? {
        buildingHeightBiasMeters: 0,
      },
    },
  };
}

export function aggregateDailyAreaFromArtifacts(params: {
  artifacts: PrecomputedSunlightTileArtifact[];
  bbox: RegionBbox;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  maxPoints: number;
  ignoreVegetation: boolean;
}) {
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
  const warnings = new Set<string>();
  let gridPointCount = 0;
  let indoorPointsExcluded = 0;
  let pointsWithElevation = 0;

  for (const artifact of params.artifacts) {
    const frameMasks = artifact.frames.map((frame) => ({
      full: decodeBase64Bytes(frame.sunMaskBase64),
      noVegetation: decodeBase64Bytes(frame.sunMaskNoVegetationBase64),
      utcTime: frame.utcTime,
    }));

    for (const point of artifact.points) {
      if (!pointInBbox(point.lon, point.lat, params.bbox)) {
        continue;
      }
      gridPointCount += 1;
      if (point.insideBuilding || point.outdoorIndex === null) {
        indoorPointsExcluded += 1;
        continue;
      }
      if (points.length >= params.maxPoints) {
        return {
          error: "Outdoor grid exceeds maxPoints limit.",
          detail: `Computed ${points.length + 1} outdoor points (from ${gridPointCount} raw points and ${indoorPointsExcluded} indoor exclusions), but maxPoints is ${params.maxPoints}.`,
        };
      }

      const outdoorIndex = point.outdoorIndex;
      const states = frameMasks.map((frame) => ({
        localTime: formatDateTimeLocal(new Date(frame.utcTime), params.timezone),
        isSunny: params.ignoreVegetation
          ? isMaskBitSet(frame.noVegetation, outdoorIndex)
          : isMaskBitSet(frame.full, outdoorIndex),
      }));
      const sunnyWindows = buildSunnyWindowsFromFrameStates(
        states,
        params.sampleEveryMinutes,
        params.timezone,
        frameMasks.at(-1)?.utcTime ?? null,
      );
      const sunnyMinutes = sunnyWindows.reduce(
        (total, window) => total + window.durationMinutes,
        0,
      );
      const noonUtc = zonedDateTimeToUtc(params.date, "12:00", params.timezone);
      const times = SunCalc.getTimes(noonUtc, point.lat, point.lon);
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
        sunriseLocalTime: safeFormatDateTimeLocal(times.sunrise, params.timezone),
        sunsetLocalTime: safeFormatDateTimeLocal(times.sunset, params.timezone),
        sunnyMinutes,
        sunnyWindows,
        insideBuilding: false,
        indoorBuildingId: null,
      });
    }

    for (const warning of artifact.warnings) {
      warnings.add(warning);
    }
  }

  return {
    gridPointCount,
    pointCount: points.length,
    points,
    warnings: Array.from(warnings),
    stats: {
      pointsWithElevation,
      pointsWithoutElevation: points.length - pointsWithElevation,
      indoorPointsExcluded,
    },
    model: {
      terrainHorizonMethod: params.artifacts[0]?.model.terrainHorizonMethod ?? "none",
      buildingsShadowMethod: params.artifacts[0]?.model.buildingsShadowMethod ?? "none",
      vegetationShadowMethod: params.artifacts[0]?.model.vegetationShadowMethod ?? "none",
      terrainHorizonDebug: null,
      shadowCalibration: params.artifacts[0]?.model.shadowCalibration ?? {
        buildingHeightBiasMeters: 0,
      },
    },
  };
}

export function buildTimelineFromArtifacts(params: {
  artifacts: PrecomputedSunlightTileArtifact[];
  bbox: RegionBbox;
  timezone: string;
}) {
  const outdoorPoints: Array<{
    id: string;
    lat: number;
    lon: number;
    artifactIndex: number;
    outdoorIndex: number;
  }> = [];
  let gridPointCount = 0;
  let indoorPointsExcluded = 0;
  let pointsWithElevation = 0;

  params.artifacts.forEach((artifact, artifactIndex) => {
    for (const point of artifact.points) {
      if (!pointInBbox(point.lon, point.lat, params.bbox)) {
        continue;
      }
      gridPointCount += 1;
      if (point.insideBuilding || point.outdoorIndex === null) {
        indoorPointsExcluded += 1;
        continue;
      }
      if (point.pointElevationMeters !== null) {
        pointsWithElevation += 1;
      }
      outdoorPoints.push({
        id: point.id,
        lat: point.lat,
        lon: point.lon,
        artifactIndex,
        outdoorIndex: point.outdoorIndex,
      });
    }
  });

  const decodedFramesByArtifact = params.artifacts.map((artifact) =>
    artifact.frames.map((frame) => ({
      ...frame,
      fullMask: decodeBase64Bytes(frame.sunMaskBase64),
      noVegetationMask: decodeBase64Bytes(frame.sunMaskNoVegetationBase64),
    })),
  );
  const frameCount = params.artifacts[0]?.frames.length ?? 0;
  const frames = Array.from({ length: frameCount }, (_, frameIndex) => {
    const sunnyMask = new Uint8Array(Math.ceil(outdoorPoints.length / 8));
    const sunnyMaskNoVegetation = new Uint8Array(Math.ceil(outdoorPoints.length / 8));
    let sunnyCount = 0;
    let sunnyCountNoVegetation = 0;
    let localTime = "";

    outdoorPoints.forEach((point, outputIndex) => {
      const frame = decodedFramesByArtifact[point.artifactIndex][frameIndex];
      localTime = localTime || frame.localTime;
      if (isMaskBitSet(frame.fullMask, point.outdoorIndex)) {
        setMaskBit(sunnyMask, outputIndex);
        sunnyCount += 1;
      }
      if (isMaskBitSet(frame.noVegetationMask, point.outdoorIndex)) {
        setMaskBit(sunnyMaskNoVegetation, outputIndex);
        sunnyCountNoVegetation += 1;
      }
    });

    return {
      index: frameIndex,
      localTime,
      sunnyCount,
      sunnyCountNoVegetation,
      sunMaskBase64: Buffer.from(sunnyMask).toString("base64"),
      sunMaskNoVegetationBase64: Buffer.from(sunnyMaskNoVegetation).toString("base64"),
    };
  });

  const warnings = Array.from(
    new Set(params.artifacts.flatMap((artifact) => artifact.warnings)),
  );

  return {
    gridPointCount,
    pointCount: outdoorPoints.length,
    indoorPointsExcluded,
    pointsWithElevation,
    pointsWithoutElevation: outdoorPoints.length - pointsWithElevation,
    points: outdoorPoints.map((point) => ({
      id: point.id,
      lat: point.lat,
      lon: point.lon,
    })),
    frames,
    warnings,
    model: {
      terrainHorizonMethod: params.artifacts[0]?.model.terrainHorizonMethod ?? "none",
      buildingsShadowMethod: params.artifacts[0]?.model.buildingsShadowMethod ?? "none",
      vegetationShadowMethod: params.artifacts[0]?.model.vegetationShadowMethod ?? "none",
      terrainHorizonDebug: null,
      shadowCalibration: params.artifacts[0]?.model.shadowCalibration ?? {
        buildingHeightBiasMeters: 0,
      },
    },
  };
}
