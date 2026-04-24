import { performance } from "node:perf_hooks";

import SunCalc from "suncalc";

import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
  disposeWebGpuBackend,
} from "@/lib/sun/evaluation-context";
import { buildLocalTerrainShadowEvaluator } from "@/lib/sun/terrain-shadow";
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
import { lv95ToWgs84 } from "@/lib/geo/projection";
import {
  adaptiveHorizonSharingConfig,
  resolveAdaptiveTerrainHorizonForTile,
} from "@/lib/sun/adaptive-horizon-sharing";
import type { ShadowCalibration } from "@/lib/sun/shadow-calibration";
import {
  getMaxHorizonAngle,
  TERRAIN_HORIZON_SKIP_MARGIN_DEG,
} from "@/lib/sun/solar";
import {
  getHorizonAngleForAzimuth,
  isTerrainBlockedByHorizon,
  type HorizonMask,
} from "@/lib/sun/horizon-mask";
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
  type PrecomputedSunlightPoint,
  type PrecomputedSunlightTileArtifact,
  type RegionBbox,
  type RegionTileSpec,
} from "./sunlight-cache";
import {
  loadPrecomputedSunlightTileBinary,
  type BinaryTileArtifact,
} from "./sunlight-cache-binary";
import {
  ATLAS_READ_FALLBACK_RESOLUTIONS_DEG,
  loadPrecomputedTileAtlas,
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasByAngle,
  type BinaryTileAtlas,
} from "./sunlight-cache-atlas";
export type { BinaryTileAtlas } from "./sunlight-cache-atlas";
export { lookupAtlasByAngle } from "./sunlight-cache-atlas";

export async function disposeSunlightTileEvaluationBackends(): Promise<void> {
  // Sync dispose on this branch; kept async-signed to match cache-admin expectations
  // and stay compatible with async backends added later (e.g. rust-wgpu-vulkan).
  disposeWebGpuBackend();
}

const DEFAULT_CACHE_TILE_SIZE_METERS = 250;
const RAD_TO_DEG = 180 / Math.PI;
const BUILDING_SHADOW_MAX_DISTANCE_METERS = 2500;
const BUILDING_TILE_ALLOWLIST_VERSION = "tile-allowlist-v1";
const PRECOMPUTED_REGIONS: PrecomputedRegionName[] = ["lausanne", "nyon", "morges", "geneve"];
const manifestMemoryCache = new TtlCache<PrecomputedSunlightManifest | null>(60_000, 64);
const tileMemoryCache = new TtlCache<PrecomputedSunlightTileArtifact | null>(60_000, 128);
const tileBinaryMemoryCache = new TtlCache<BinaryTileArtifact | null>(60_000, 128);
const tileAtlasMemoryCache = new TtlCache<BinaryTileAtlas | BinaryTileAtlas[] | null>(300_000, 64);

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
  // Carry LV95 through to the GPU batch upload so we don't round-trip via
  // wgs84ToLv95. See ADR-0014.
  lv95Easting: number;
  lv95Northing: number;
  pointElevationMeters: number | null;
  horizonMask: Awaited<ReturnType<typeof buildPointEvaluationContext>>["horizonMask"];
  buildingShadowEvaluator: Awaited<ReturnType<typeof buildPointEvaluationContext>>["buildingShadowEvaluator"];
  vegetationShadowEvaluator: Awaited<ReturnType<typeof buildPointEvaluationContext>>["vegetationShadowEvaluator"];
  terrainShadowEvaluator: Awaited<ReturnType<typeof buildPointEvaluationContext>>["terrainShadowEvaluator"];
}

export interface SunlightTileComputeProgress {
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
  sunPositions: Array<{ azimuthDeg: number; altitudeDeg: number }>;
  buildingsIndex: BuildingsIndex | null;
  maxDistanceMeters?: number;
}): ReadonlySet<string> | undefined {
  if (!params.buildingsIndex || params.sunPositions.length === 0) {
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
  const maxDistanceMeters = params.maxDistanceMeters ?? BUILDING_SHADOW_MAX_DISTANCE_METERS;
  const maxObstacleHalfDiagonalMeters = obstacles.reduce(
    (maxValue, obstacle) => Math.max(maxValue, obstacle.halfDiagonal),
    0,
  );
  const spatialGrid = params.buildingsIndex.spatialGrid;
  const allowedBlockerIds = new Set<string>();
  let aboveHorizonSamples = 0;

  for (const sunPosition of params.sunPositions) {
    if (sunPosition.altitudeDeg <= 0) {
      continue;
    }

    aboveHorizonSamples += 1;
    const azimuthRad = (sunPosition.azimuthDeg * Math.PI) / 180;
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
  // Prefer a region that fully contains the bbox (unambiguous match).
  const fullyContaining = PRECOMPUTED_REGIONS.find((region) => {
    const rb = getPrecomputedRegionBbox(region);
    return (
      rb.minLon <= bbox.minLon &&
      rb.minLat <= bbox.minLat &&
      rb.maxLon >= bbox.maxLon &&
      rb.maxLat >= bbox.maxLat
    );
  });
  if (fullyContaining) return fullyContaining;

  // Fallback: pick the region with the largest intersection area with the
  // requested bbox. This lets cache-only reads succeed when the user's bbox
  // slightly overhangs a region (e.g., a few hundred meters south of the
  // configured Lausanne bounds) — we serve whatever cached tiles fall in
  // the intersection instead of failing hard with "No tiles found".
  let best: { region: PrecomputedRegionName; area: number } | null = null;
  for (const region of PRECOMPUTED_REGIONS) {
    const rb = getPrecomputedRegionBbox(region);
    const lonOverlap = Math.max(0, Math.min(rb.maxLon, bbox.maxLon) - Math.max(rb.minLon, bbox.minLon));
    const latOverlap = Math.max(0, Math.min(rb.maxLat, bbox.maxLat) - Math.max(rb.minLat, bbox.minLat));
    const area = lonOverlap * latOverlap;
    if (area > 0 && (!best || area > best.area)) {
      best = { region, area };
    }
  }
  return best?.region ?? null;
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

async function loadTileBinaryDiskOnly(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileId: string;
}): Promise<BinaryTileArtifact | null> {
  const cacheKey = JSON.stringify({
    kind: "bin",
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tileId: params.tileId,
  });
  const cached = tileBinaryMemoryCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const loaded = await loadPrecomputedSunlightTileBinary(params);
  tileBinaryMemoryCache.set(cacheKey, loaded);
  return loaded;
}

async function loadAtlasDiskOnly(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg: number;
}): Promise<BinaryTileAtlas | null> {
  const cacheKey = JSON.stringify({ kind: "atlas", ...params });
  const cached = tileAtlasMemoryCache.get(cacheKey);
  if (cached !== undefined) return cached as BinaryTileAtlas | null;
  const loaded = await loadPrecomputedTileAtlas(params);
  tileAtlasMemoryCache.set(cacheKey, loaded);
  return loaded;
}

async function loadAtlasesDiskOnly(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
}): Promise<BinaryTileAtlas[]> {
  const cacheKey = JSON.stringify({ kind: "atlases", ...params });
  const cached = tileAtlasMemoryCache.get(cacheKey);
  if (cached !== undefined) return (cached as BinaryTileAtlas[]) ?? [];
  const loaded = await loadPrecomputedTileAtlasesInPrecisionOrder(params);
  tileAtlasMemoryCache.set(cacheKey, loaded);
  return loaded;
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
  // Use the shared memory cache to avoid re-parsing large JSON artifacts on
  // repeated requests — the 60s TTL covers a user clicking around the UI.
  //
  // IMPORTANT: the cache stores the stripped artifact (no per-frame
  // diagnostics arrays) — a full artifact is ~60 MB due to diagnostics
  // (62500 points × 60 frames × multiple typed arrays per frame) and 128
  // cached tiles would blow past the Node heap. We only need diagnostics
  // for precompute callers, never for cache-only reads.
  const cacheKey = JSON.stringify({
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tileId: params.tileId,
  });
  let stripped = tileMemoryCache.get(cacheKey);
  let layer: "L1" | "L2" | "MISS";
  if (stripped !== undefined) {
    layer = stripped ? "L1" : "MISS";
  } else {
    const raw = await loadPrecomputedSunlightTile(params);
    stripped = raw ? stripArtifactDiagnostics(raw) : null;
    tileMemoryCache.set(cacheKey, stripped);
    layer = stripped ? "L2" : "MISS";
  }
  return { artifact: stripped, layer };
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
  /** Bucket-centered atlas mode (ADR-0013): replace SunCalc-derived per-sample sun positions with the
   *  exact (az, alt) pairs supplied here. The number of entries defines the frame count; date / timezone /
   *  sampleEveryMinutes / startLocalTime / endLocalTime are only used for downstream metadata strings.
   *  Frame `localTime` / `utcTime` are tagged `bucket-az-alt` (not real clock times). */
  sunOverride?: Array<{ azimuthDeg: number; altitudeDeg: number }>;
}): Promise<PrecomputedSunlightTileArtifact> {
  const started = performance.now();
  const cpuT0 = process.cpuUsage();
  const phaseMs = {
    adaptiveHorizon: 0,
    sharedSources: 0,
    pointContexts: 0,
    evaluations: 0,
    evalSetup: 0,
    evalSetupPoints: 0,
    evalSetupHorizon: 0,
    evalSetupVegetation: 0,
    evalSetupPerFrame: 0,
    evalBatchDispatch: 0,
    evalFrameLoop: 0,
    // sub-phases of 'other' (time not accounted by any main phase)
    preHorizon: 0,
    postHorizonPreSources: 0,
    postSourcesPrePoints: 0,
    postPointsPreEvals: 0,
    postEvals: 0,
  };
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
  phaseMs.preHorizon = horizonT0 - started;
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

  const horizonEnd = performance.now();
  phaseMs.adaptiveHorizon = horizonEnd - horizonT0;

  const points: PrecomputedSunlightTileArtifact["points"] = [];
  const preparedOutdoorPoints: PreparedOutdoorPoint[] = [];
  const sourcesT0 = performance.now();
  phaseMs.postHorizonPreSources = sourcesT0 - horizonEnd;
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
  // In atlas mode (sunOverride set), samples[] is a placeholder array of synthetic dates —
  // positions come from sunOverride directly. Length = sunOverride.length.
  const atlasMode = params.sunOverride != null;
  const samples = atlasMode
    ? params.sunOverride!.map((_, i) => new Date(Date.UTC(1970, 0, 1, 0, i, 0)))
    : createUtcSamples(
        params.date,
        params.timezone,
        params.sampleEveryMinutes,
        params.startLocalTime,
        params.endLocalTime,
      );
  if (samples.length === 0) {
    throw new Error(
      atlasMode
        ? "sunOverride is empty — nothing to compute."
        : `No samples produced for ${params.date} ${params.startLocalTime}-${params.endLocalTime}.`,
    );
  }
  const allowlistTileCenterWgs84 = lv95ToWgs84(
    (params.tile.minEasting + params.tile.maxEasting) / 2,
    (params.tile.minNorthing + params.tile.maxNorthing) / 2,
  );
  // Sun positions used by the building allowlist heuristic — real SunCalc values for date mode,
  // bucket-center values for atlas mode.
  const allowlistSunPositions = atlasMode
    ? params.sunOverride!
    : samples.map((d) => {
        const p = SunCalc.getPosition(d, allowlistTileCenterWgs84.lat, allowlistTileCenterWgs84.lon);
        let az = (p.azimuth * RAD_TO_DEG + 180) % 360;
        if (az < 0) az += 360;
        return { azimuthDeg: az, altitudeDeg: p.altitude * RAD_TO_DEG };
      });
  const tileBuildingAllowlist = collectTileWindowBuildingAllowlist({
    tile: params.tile,
    sunPositions: allowlistSunPositions,
    buildingsIndex: sharedSources.buildingsIndex,
  });
  const buildingMethodSuffix = tileBuildingAllowlist
    ? `|${BUILDING_TILE_ALLOWLIST_VERSION}`
    : "";
  const sourcesEnd = performance.now();
  phaseMs.sharedSources = sourcesEnd - sourcesT0;

  const pointsT0 = performance.now();
  phaseMs.postSourcesPrePoints = pointsT0 - sourcesEnd;
  const gm = params.gridMetadata;
  // ── Niveau 3 fast path: skip buildPointEvaluationContext entirely ──
  // When the batch backend handles all evaluators on GPU and grid metadata
  // provides indoor/elevation, the 62 500 async calls per tile are pure
  // overhead (~5µs microtask each = ~310ms). Replace with a tight sync
  // loop that builds minimal PreparedOutdoorPoint entries directly.
  // Method strings are resolved via ONE async call on the first outdoor
  // point; all subsequent points reuse them.
  const batchSkipsAllEvaluators = gm && sharedSources.vegetationShadowHandledByBackend === true;
  let pointsContextCallMs = 0;
  let pointsIndoorCount = 0;
  let pointsOutdoorCount = 0;
  if (batchSkipsAllEvaluators) {
    const horizonMask = sharedSources.horizonMask;
    let methodsResolved = false;
    // Niveau 4 fast path: mutate rawTilePoints[i] in place (eliminating the
    // {...point, ...} spread) and pre-size `points`/`preparedOutdoorPoints`
    // so V8 doesn't grow-and-rehash. Saves ~50% of the loop body cost by
    // dropping ~62500 object allocations per tile. rawTilePoints is local
    // to this function — safe to mutate.
    const n = rawTilePoints.length;
    points.length = n;
    preparedOutdoorPoints.length = n; // over-sized, trimmed below
    let outdoorCursor = 0;
    for (let rawPointIndex = 0; rawPointIndex < n; rawPointIndex += 1) {
      const point = rawTilePoints[rawPointIndex] as PrecomputedSunlightPoint;
      if (gm.indoor[rawPointIndex]) {
        indoorPointsExcluded += 1;
        pointsIndoorCount += 1;
        point.insideBuilding = true;
        point.indoorBuildingId = null;
        point.outdoorIndex = null;
        point.pointElevationMeters = null;
        points[rawPointIndex] = point;
        continue;
      }
      // Resolve method strings once from the first outdoor point
      if (!methodsResolved) {
        const ctxT0 = performance.now();
        const context = await buildPointEvaluationContext(point.lat, point.lon, {
          skipTerrainSamplingWhenIndoor: true,
          terrainHorizonOverride: terrainHorizonOverride ?? undefined,
          shadowCalibration: params.shadowCalibration,
          sharedSources,
          buildingShadowAllowedIds: tileBuildingAllowlist,
          overrideElevation: gm.elevations[rawPointIndex],
          skipIndoorCheck: true,
        });
        pointsContextCallMs = performance.now() - ctxT0;
        terrainMethod = context.terrainHorizonMethod;
        buildingsMethod = `${context.buildingsShadowMethod}${buildingMethodSuffix}`;
        vegetationMethod = context.vegetationShadowMethod ?? "none";
        warnings.push(...context.warnings);
        methodsResolved = true;
      }
      pointsOutdoorCount += 1;
      const elev = gm.elevations[rawPointIndex];
      if (elev !== null) pointsWithElevation += 1;
      const outdoorIndex = outdoorCursor;
      // Build the local terrain ray-march evaluator inline (no async /
      // buildPointEvaluationContext call needed — it only captures the
      // point's LV95 coords + elevation + the already-loaded terrain
      // tiles). Covers the "hill casts shadow on its own foot" gap that
      // the batch backend's horizon mask misses (shortcut 2b.11).
      //
      // When the GPU backend exposes uploadTerrainRasters, the same
      // ray-march runs on GPU and is OR'd into batchTerrainBlockedMask
      // → skip the CPU closure construction (and the hot-loop call).
      const terrainEval =
        !sharedSources.terrainShadowHandledByBackend &&
        elev !== null && sharedSources.terrainTiles && sharedSources.terrainTiles.length > 0
          ? buildLocalTerrainShadowEvaluator({
              pointLv95Easting: point.lv95Easting,
              pointLv95Northing: point.lv95Northing,
              pointElevationMeters: elev,
              terrainTiles: sharedSources.terrainTiles,
            })
          : undefined;
      preparedOutdoorPoints[outdoorCursor++] = {
        lat: point.lat,
        lon: point.lon,
        lv95Easting: point.lv95Easting,
        lv95Northing: point.lv95Northing,
        pointElevationMeters: elev,
        horizonMask,
        buildingShadowEvaluator: undefined,
        vegetationShadowEvaluator: undefined,
        terrainShadowEvaluator: terrainEval,
      };
      point.insideBuilding = false;
      point.indoorBuildingId = null;
      point.outdoorIndex = outdoorIndex;
      point.pointElevationMeters = elev;
      points[rawPointIndex] = point;
      if (
        params.cooperativeYieldEveryPoints &&
        params.cooperativeYieldEveryPoints > 0 &&
        rawPointIndex > 0 &&
        (rawPointIndex + 1) % params.cooperativeYieldEveryPoints === 0
      ) {
        params.onProgress?.({
          stage: "prepare-points",
          completed: rawPointIndex + 1,
          total: n,
          pointCountTotal: n,
          pointCountOutdoor: outdoorCursor,
          frameCountTotal: 0,
          frameIndex: null,
          elapsedMs: performance.now() - started,
        });
        await yieldToEventLoop();
        throwIfAborted(params.signal);
      }
    }
    // Trim over-allocated preparedOutdoorPoints to actual outdoor count.
    preparedOutdoorPoints.length = outdoorCursor;
  } else {
    // ── Original loop: full buildPointEvaluationContext per point ────
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
          lv95Easting: point.lv95Easting,
          lv95Northing: point.lv95Northing,
          pointElevationMeters: gm.elevations[rawPointIndex],
          horizonMask: context.horizonMask,
          buildingShadowEvaluator: context.buildingShadowEvaluator,
          vegetationShadowEvaluator: context.vegetationShadowEvaluator,
          terrainShadowEvaluator: context.terrainShadowEvaluator,
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
          lv95Easting: point.lv95Easting,
          lv95Northing: point.lv95Northing,
          pointElevationMeters: context.pointElevationMeters,
          horizonMask: context.horizonMask,
          buildingShadowEvaluator: context.buildingShadowEvaluator,
          vegetationShadowEvaluator: context.vegetationShadowEvaluator,
          terrainShadowEvaluator: context.terrainShadowEvaluator,
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
  }
  const pointsEnd = performance.now();
  phaseMs.pointContexts = pointsEnd - pointsT0;

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
  phaseMs.postPointsPreEvals = evalsT0 - pointsEnd;
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
    const setupPointsT0 = performance.now();
    const origin = webgpuBackend.getOrigin();
    batchPointsF32 = new Float32Array(preparedOutdoorPoints.length * 4);
    for (let i = 0; i < preparedOutdoorPoints.length; i++) {
      const pt = preparedOutdoorPoints[i];
      // Use exact LV95 from the grid, not a round-trip via wgs84ToLv95 — see ADR-0014.
      // Backend expects centered coords: x = easting - originX, y = elevation, z = northing - originY
      batchPointsF32[i * 4 + 0] = pt.lv95Easting - origin.x;
      batchPointsF32[i * 4 + 1] = pt.pointElevationMeters ?? 0;
      batchPointsF32[i * 4 + 2] = pt.lv95Northing - origin.y;
      batchPointsF32[i * 4 + 3] = 0; // padding for vec4f alignment
    }
    phaseMs.evalSetupPoints += performance.now() - setupPointsT0;
  }

  // ── Phase B + C: build packed payloads for the GPU shadow compute ──
  // Horizon + vegetation payloads are passed to evaluateBatchWithShadows
  // on every frame; the backend dedups via content hash so only the first
  // frame of a (points, horizon, vegetation) triple actually uploads.
  let horizonPayload: { masks: Float32Array; pointMaskIndices: Uint32Array } | null = null;
  let vegetationPayload: {
    meta: Float32Array;
    data: Float32Array;
    nodata: number;
    stepMeters: number;
    maxDistanceMeters: number;
    minClearance: number;
    originX: number;
    originY: number;
    isRaw?: boolean;
  } | null = null;
  let terrainPayload: {
    meta: Float32Array;
    data: Float32Array;
    nodata: number;
    stepMeters: number;
    maxDistanceMeters: number;
    altitudeGateDeg: number;
    originX: number;
    originY: number;
  } | null = null;
  // ── Horizon mask dedup (always, not only for GPU batch paths) ──────
  // Most points in a tile share the same HorizonMask reference thanks to
  // adaptive horizon sharing. Deduping here lets us (a) build the GPU
  // payload for Phase B+ backends and (b) precompute per-frame per-mask
  // rounded horizon angles in the hot loop instead of recomputing them
  // 32K times per frame.
  let horizonMaskList: HorizonMask[] | null = null;
  let pointMaskIndices: Uint32Array | null = null;
  {
    const maskToIndex = new Map<object, number>();
    const list: HorizonMask[] = [];
    const indices = new Uint32Array(preparedOutdoorPoints.length);
    let allPointsHaveMask = true;
    for (let i = 0; i < preparedOutdoorPoints.length; i++) {
      const m = preparedOutdoorPoints[i].horizonMask;
      if (m === null || m === undefined) {
        allPointsHaveMask = false;
        break;
      }
      const existing = maskToIndex.get(m);
      if (existing !== undefined) {
        indices[i] = existing;
      } else {
        const idx = list.length;
        list.push(m);
        maskToIndex.set(m, idx);
        indices[i] = idx;
      }
    }
    if (allPointsHaveMask && list.length > 0) {
      horizonMaskList = list;
      pointMaskIndices = indices;
    }
  }

  const useBatchShadows =
    useBatchPath &&
    webgpuBackend != null &&
    typeof (webgpuBackend as { evaluateBatchWithShadows?: unknown })
      .evaluateBatchWithShadows === "function";
  if (useBatchShadows) {
    // ── Horizon (build GPU payload from the deduped masks) ──────────
    const setupHorizonT0 = performance.now();
    if (horizonMaskList && pointMaskIndices) {
      const masks = new Float32Array(horizonMaskList.length * 360);
      for (let i = 0; i < horizonMaskList.length; i++) {
        const bins = horizonMaskList[i].binsDeg;
        const offset = i * 360;
        for (let b = 0; b < 360; b++) masks[offset + b] = bins[b];
      }
      horizonPayload = { masks, pointMaskIndices };
    }
    phaseMs.evalSetupHorizon += performance.now() - setupHorizonT0;
    // ── Vegetation ──────────────────────────────────────────────────
    const setupVegetationT0 = performance.now();
    const vegTiles = sharedSources.vegetationSurfaceTiles;
    if (vegTiles && vegTiles.length > 0 && webgpuBackend) {
      const origin = webgpuBackend.getOrigin();
      // meta layout per tile (8 × 4 bytes): minX, minY, maxX, maxY,
      // width (u32), height (u32), data_offset (u32), nodata (f32).
      const meta = new Float32Array(vegTiles.length * 8);
      const metaU32 = new Uint32Array(meta.buffer);
      let totalFloats = 0;
      for (const tile of vegTiles) totalFloats += tile.width * tile.height;
      const data = new Float32Array(totalFloats);
      let offsetFloats = 0;
      for (let i = 0; i < vegTiles.length; i++) {
        const t = vegTiles[i];
        const slot = i * 8;
        meta[slot + 0] = t.minX;
        meta[slot + 1] = t.minY;
        meta[slot + 2] = t.maxX;
        meta[slot + 3] = t.maxY;
        metaU32[slot + 4] = t.width;
        metaU32[slot + 5] = t.height;
        metaU32[slot + 6] = offsetFloats;
        // nodata as f32; use NaN sentinel when tile has no nodata (won't match anything real)
        meta[slot + 7] = t.nodata === null ? Number.NaN : t.nodata;
        // Convert typed raster to f32 (GeoTIFF may return Int16/Uint16/etc)
        const n = t.width * t.height;
        if (t.raster instanceof Float32Array) {
          data.set(t.raster.subarray(0, n), offsetFloats);
        } else {
          for (let k = 0; k < n; k++) data[offsetFloats + k] = Number(t.raster[k]);
        }
        offsetFloats += n;
      }
      // Option B (ADR-0016): when the selected tiles are raw VHM (relative
      // heights), the shader composes canopy_abs = terrain + max(0, vhm)
      // at sample time instead of reading pre-composed canopy from disk.
      // We gate on tile kind rather than the env var directly: the
      // `swissSurfaceFindTilesForBounds` already applied the env-var-gated
      // priority selection, so kind=="vhm_raw" means raw was chosen.
      const rawTilesPresent = vegTiles.some((t) => t.kind === "vhm_raw");
      vegetationPayload = {
        meta,
        data,
        nodata: 0, // per-tile nodata is in meta; this param is unused by the shader now
        stepMeters: 2,
        maxDistanceMeters: 120,
        minClearance: 4,
        originX: origin.x,
        originY: origin.y,
        isRaw: rawTilesPresent,
      };
    }
    phaseMs.evalSetupVegetation += performance.now() - setupVegetationT0;
    // ── Local terrain DEM (SwissALTI3D) — same pack as vegetation ──────
    // Shortcut 2b.11 on GPU. Shader ray-marches the terrain raster
    // within 500m around each point, gated by altitudeDeg < 30°.
    const terrainTiles = sharedSources.terrainTiles;
    if (terrainTiles && terrainTiles.length > 0 && webgpuBackend) {
      const origin = webgpuBackend.getOrigin();
      const meta = new Float32Array(terrainTiles.length * 8);
      const metaU32 = new Uint32Array(meta.buffer);
      let totalFloats = 0;
      for (const tile of terrainTiles) totalFloats += tile.width * tile.height;
      const data = new Float32Array(totalFloats);
      let offsetFloats = 0;
      for (let i = 0; i < terrainTiles.length; i++) {
        const t = terrainTiles[i];
        const slot = i * 8;
        meta[slot + 0] = t.minX;
        meta[slot + 1] = t.minY;
        meta[slot + 2] = t.maxX;
        meta[slot + 3] = t.maxY;
        metaU32[slot + 4] = t.width;
        metaU32[slot + 5] = t.height;
        metaU32[slot + 6] = offsetFloats;
        meta[slot + 7] = t.nodata === null ? Number.NaN : t.nodata;
        const n = t.width * t.height;
        if (t.raster instanceof Float32Array) {
          data.set(t.raster.subarray(0, n), offsetFloats);
        } else {
          for (let k = 0; k < n; k++) data[offsetFloats + k] = Number(t.raster[k]);
        }
        offsetFloats += n;
      }
      terrainPayload = {
        meta,
        data,
        nodata: 0,
        stepMeters: 5,
        maxDistanceMeters: 500,
        altitudeGateDeg: 30,
        originX: origin.x,
        originY: origin.y,
      };
    }
  }

  // ── Phase D: batch-evaluate all lit frames in ONE GPU submission ────
  // Pre-compute sun positions for every sample, group the lit ones
  // (altitudeDeg > 0), call evaluateBatchFramesWithShadows once per
  // tile. For backends that don't expose the batch API (webgpu-compute,
  // gpu-raster slow path), this stays null and the frame loop falls
  // back to the per-frame path.
  type PerFrameSun = {
    sampleIndex: number;
    sampleDate: Date;
    frameLocalDateTime: string;
    altitudeDeg: number;
    azimuthDeg: number;
  };
  // Optional: round sun positions to the nearest `step` degrees before
  // dispatch. Used by the `sun-bucket-resolution-bench` script to measure
  // how much the shadow masks diverge when we key the cache on quantised
  // (az, alt) buckets instead of exact SunCalc values. Unset (default)
  // uses the exact angles. ADR-0013 discusses the trade-offs.
  const sunRoundEnv = process.env.MAPPY_SUN_POSITION_ROUND_DEG;
  const sunRoundStep = sunRoundEnv ? Number(sunRoundEnv) : 0;
  const roundToStep = (x: number): number =>
    sunRoundStep > 0 ? Math.round(x / sunRoundStep) * sunRoundStep : x;
  const setupPerFrameT0 = performance.now();
  const perFrame: PerFrameSun[] = new Array(samples.length);
  if (atlasMode) {
    // Bucket-centered atlas mode: positions come from the caller. samples[] is a
    // placeholder synthetic date array; frameLocalDateTime is tagged as bucket coords.
    for (let i = 0; i < samples.length; i++) {
      const p = params.sunOverride![i];
      const az = ((p.azimuthDeg % 360) + 360) % 360;
      perFrame[i] = {
        sampleIndex: i,
        sampleDate: samples[i],
        frameLocalDateTime: `bucket-az${az.toFixed(3)}-alt${p.altitudeDeg.toFixed(3)}`,
        altitudeDeg: p.altitudeDeg,
        azimuthDeg: az,
      };
    }
  } else {
    for (let i = 0; i < samples.length; i++) {
      const d = samples[i];
      const ft = formatDateTimeLocal(d, params.timezone);
      const pos = SunCalc.getPosition(d, tileCenterWgs84.lat, tileCenterWgs84.lon);
      let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
      if (az < 0) az += 360;
      perFrame[i] = {
        sampleIndex: i,
        sampleDate: d,
        frameLocalDateTime: ft,
        altitudeDeg: roundToStep(pos.altitude * RAD_TO_DEG),
        azimuthDeg: roundToStep(az),
      };
    }
  }
  phaseMs.evalSetupPerFrame += performance.now() - setupPerFrameT0;

  const useBatchFrames =
    useBatchShadows &&
    webgpuBackend != null &&
    typeof (webgpuBackend as { evaluateBatchFramesWithShadows?: unknown })
      .evaluateBatchFramesWithShadows === "function";
  // Results indexed by sampleIndex; null means "below horizon, no GPU work needed".
  type FrameMasks = {
    buildingsMask: Uint32Array | null;
    terrainMask: Uint32Array | null;
    vegetationMask: Uint32Array | null;
    sunnyMask: Uint32Array | null;
    sunnyNoVegMask: Uint32Array | null;
    sunnyCount: number;
    sunnyNoVegCount: number;
  };
  const batchFrameResults: Array<FrameMasks | null> = new Array(samples.length).fill(null);
  if (useBatchFrames && batchPointsF32) {
    const litIndices: number[] = [];
    const litFrames: Array<{ azimuthDeg: number; altitudeDeg: number }> = [];
    for (const f of perFrame) {
      if (f.altitudeDeg > 0) {
        litIndices.push(f.sampleIndex);
        litFrames.push({ azimuthDeg: f.azimuthDeg, altitudeDeg: f.altitudeDeg });
      }
    }
    if (litFrames.length > 0) {
      const dispatchT0 = performance.now();
      const litResults = await (webgpuBackend as {
        evaluateBatchFramesWithShadows: (
          frames: Array<{ azimuthDeg: number; altitudeDeg: number }>,
          points: Float32Array,
          pointCount: number,
          options?: {
            horizon?: { masks: Float32Array; pointMaskIndices: Uint32Array };
            vegetation?: typeof vegetationPayload;
            terrain?: typeof terrainPayload;
          },
        ) => Promise<Array<FrameMasks>>;
      }).evaluateBatchFramesWithShadows(
        litFrames,
        batchPointsF32,
        preparedOutdoorPoints.length,
        {
          horizon: horizonPayload ?? undefined,
          vegetation: vegetationPayload ?? undefined,
          terrain: terrainPayload ?? undefined,
        },
      );
      phaseMs.evalBatchDispatch += performance.now() - dispatchT0;
      for (let k = 0; k < litResults.length; k++) {
        batchFrameResults[litIndices[k]] = litResults[k];
      }
    }
  }

  const frameLoopT0 = performance.now();
  phaseMs.evalSetup = frameLoopT0 - evalsT0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    throwIfAborted(params.signal);
    const sampleDate = samples[sampleIndex];
    const frameLocalDateTime = perFrame[sampleIndex]!.frameLocalDateTime;
    const frameSolarPosition = {
      altitudeDeg: perFrame[sampleIndex]!.altitudeDeg,
      azimuthDeg: perFrame[sampleIndex]!.azimuthDeg,
    };
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
        sunMask: new Uint8Array(maskByteLen),
        sunMaskNoVegetation: new Uint8Array(maskByteLen),
        terrainBlockedMask: new Uint8Array(maskByteLen),
        buildingsBlockedMask: new Uint8Array(maskByteLen),
        vegetationBlockedMask: new Uint8Array(maskByteLen),
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
    let batchTerrainBlockedMask: Uint32Array | null = null;
    let batchVegetationBlockedMask: Uint32Array | null = null;
    // Phase D fast path: batch for this tile was pre-computed upfront.
    const preComputed = batchFrameResults[sampleIndex];
    if (preComputed) {
      batchBuildingBlockedMask = preComputed.buildingsMask;
      batchTerrainBlockedMask = preComputed.terrainMask;
      batchVegetationBlockedMask = preComputed.vegetationMask;

      // ── Phase E fast path: GPU already produced sunny + sunnyNoVeg.
      // Bulk-copy the 5 bitmasks from Uint32Array GPU output to the
      // Uint8Array artifact masks (little-endian byte layout matches).
      // Skip the per-point JS loop entirely for mask assignment +
      // sunny computation + counts. The per-frame horizon angle
      // diagnostic is still filled via the precomputed per-unique-mask
      // cache (vectorized assignment).
      // Phase E = GPU-assembled final masks (no per-point JS loop). But the
      // GPU only handles horizon terrain + buildings + vegetation. If any
      // prepared point has a CPU local terrain evaluator (shortcut 2b.11),
      // we need the hot loop to run it and OR-combine into terrainMask.
      // Disable Phase E in that case — falls through to the hot loop below.
      const hasLocalTerrainEvaluator =
        preparedOutdoorPoints.length > 0 &&
        preparedOutdoorPoints[0].terrainShadowEvaluator !== undefined;
      const phaseE =
        !hasLocalTerrainEvaluator &&
        preComputed.buildingsMask !== null &&
        preComputed.terrainMask !== null &&
        preComputed.vegetationMask !== null &&
        preComputed.sunnyMask !== null &&
        preComputed.sunnyNoVegMask !== null;
      if (phaseE) {
        const pointCount = preparedOutdoorPoints.length;
        // Helper: view a Uint32Array as Uint8Array of exactly maskByteLen
        // bytes (little-endian, bit-0-at-LSB matches our mask convention).
        const u8View = (u32: Uint32Array) =>
          new Uint8Array(u32.buffer, u32.byteOffset, Math.min(u32.byteLength, maskByteLen));
        buildingsMask.set(u8View(preComputed.buildingsMask!));
        terrainMask.set(u8View(preComputed.terrainMask!));
        vegetationMask.set(u8View(preComputed.vegetationMask!));
        sunnyMask.set(u8View(preComputed.sunnyMask!));
        sunnyMaskNoVegetation.set(u8View(preComputed.sunnyNoVegMask!));
        sunnyCount = preComputed.sunnyCount;
        sunnyCountNoVegetation = preComputed.sunnyNoVegCount;
        // Diagnostic horizon angle — per-unique-mask cache.
        horizonAngleDegByPoint.length = pointCount;
        buildingBlockerIdByPoint.length = pointCount;
        buildingBlockerIdByPoint.fill(null, 0, pointCount);
        if (pointMaskIndices !== null && horizonMaskList !== null) {
          // Precompute rounded unique horizon angles for this frame.
          const uniqueRounded = new Float64Array(horizonMaskList.length);
          for (let i = 0; i < horizonMaskList.length; i++) {
            uniqueRounded[i] =
              Math.round(getHorizonAngleForAzimuth(horizonMaskList[i], frameSolarPosition.azimuthDeg) * 1000) / 1000;
          }
          for (let i = 0; i < pointCount; i++) {
            horizonAngleDegByPoint[i] = uniqueRounded[pointMaskIndices[i]];
          }
        } else {
          // Fallback per-point (rare — some point had no mask).
          for (let i = 0; i < pointCount; i++) {
            const m = preparedOutdoorPoints[i].horizonMask;
            horizonAngleDegByPoint[i] = m === null
              ? null
              : Math.round(getHorizonAngleForAzimuth(m, frameSolarPosition.azimuthDeg) * 1000) / 1000;
          }
        }
        frames.push({
          index: sampleIndex,
          localTime,
          utcTime: sampleDate.toISOString(),
          sunnyCount,
          sunnyCountNoVegetation,
          sunMask: sunnyMask,
          sunMaskNoVegetation: sunnyMaskNoVegetation,
          terrainBlockedMask: terrainMask,
          buildingsBlockedMask: buildingsMask,
          vegetationBlockedMask: vegetationMask,
          diagnostics: {
            horizonAngleDegByPoint,
            buildingBlockerIdByPoint,
            buildingBlockerDistanceMetersByPoint: [],
            vegetationBlockerDistanceMetersByPoint: [],
          },
        });
        completedFrameEvaluations += pointCount;
        params.onProgress?.({
          stage: "evaluate-frames",
          completed: completedFrameEvaluations,
          total: totalFrameEvaluations,
          pointCountTotal: rawTilePoints.length,
          pointCountOutdoor: pointCount,
          frameCountTotal: samples.length,
          frameIndex: sampleIndex + 1,
          elapsedMs: performance.now() - started,
        });
        await yieldToEventLoop();
        throwIfAborted(params.signal);
        continue;
      }
    } else if (useBatchPath && batchPointsF32) {
      if (useBatchShadows && (horizonPayload || vegetationPayload || terrainPayload)) {
        const out = await (webgpuBackend as {
          evaluateBatchWithShadows: (
            points: Float32Array,
            pointCount: number,
            azimuthDeg: number,
            altitudeDeg: number,
            options?: {
              horizon?: { masks: Float32Array; pointMaskIndices: Uint32Array };
              vegetation?: typeof vegetationPayload;
              terrain?: typeof terrainPayload;
            },
          ) => Promise<{
            buildingsMask: Uint32Array;
            terrainMask: Uint32Array | null;
            vegetationMask: Uint32Array | null;
          }>;
        }).evaluateBatchWithShadows(
          batchPointsF32,
          preparedOutdoorPoints.length,
          frameSolarPosition.azimuthDeg,
          frameSolarPosition.altitudeDeg,
          {
            horizon: horizonPayload ?? undefined,
            vegetation: vegetationPayload ?? undefined,
            terrain: terrainPayload ?? undefined,
          },
        );
        batchBuildingBlockedMask = out.buildingsMask;
        batchTerrainBlockedMask = out.terrainMask;
        batchVegetationBlockedMask = out.vegetationMask;
      } else {
        batchBuildingBlockedMask = await webgpuBackend.evaluateBatch(
          batchPointsF32,
          preparedOutdoorPoints.length,
          frameSolarPosition.azimuthDeg,
          frameSolarPosition.altitudeDeg,
        );
      }
    }

    {
      // ── Unified fast-path: inline per-point work for all backends ──
      // Building shadow source (in priority order):
      //   1. batchBuildingBlockedMask (Vulkan / WebGPU batch backends)
      //   2. point.buildingShadowEvaluator (gpu-raster / two-level / detailed / prism)
      //   3. none → buildingsBlocked stays false (shouldn't happen in practice)
      // Semantics match evaluateInstantSunlight() which is the canonical reference:
      //   - aboveAstronomicalHorizon = true (frame-level skip above handles altitude <= 0)
      //   - vegetation + per-point building eval skipped when terrainBlocked (evaluateAllBlockers=false)
      //   - batch building is always read regardless of terrain (mask already computed for all points)
      const azimuthDeg = frameSolarPosition.azimuthDeg;
      const altitudeDeg = frameSolarPosition.altitudeDeg;
      const yieldEvery = params.cooperativeYieldEveryPoints ?? 0;
      const pointCount = preparedOutdoorPoints.length;
      const useBatchMask = useBatchPath && batchBuildingBlockedMask !== null;
      const buildingsMaskU32 = batchBuildingBlockedMask;
      // Pre-allocate diagnostic arrays to avoid pointCount × frames push() reallocations
      horizonAngleDegByPoint.length = pointCount;
      buildingBlockerIdByPoint.length = pointCount;
      // Default to null; per-point evaluator may overwrite below
      buildingBlockerIdByPoint.fill(null, 0, pointCount);

      // Per-frame pre-compute: for each unique horizon mask in this tile,
      // compute the (raw + rounded) horizon angles and the max-angle-plus-
      // margin used by the terrain skip-check. The per-point hot loop
      // then indexes into these small arrays (1-3 entries typically)
      // instead of calling getHorizonAngleForAzimuth + getMaxHorizonAngle +
      // Math.round per point. Saves ~32K × 3 function calls × 60 frames
      // per tile.
      let uniqueHorizonAnglesRaw: Float64Array | null = null;
      let uniqueHorizonAnglesRounded: Float64Array | null = null;
      let uniqueHorizonMaxPlusMargin: Float64Array | null = null;
      if (horizonMaskList !== null) {
        const count = horizonMaskList.length;
        uniqueHorizonAnglesRaw = new Float64Array(count);
        uniqueHorizonAnglesRounded = new Float64Array(count);
        uniqueHorizonMaxPlusMargin = new Float64Array(count);
        for (let i = 0; i < count; i++) {
          const m = horizonMaskList[i];
          const angle = getHorizonAngleForAzimuth(m, azimuthDeg);
          uniqueHorizonAnglesRaw[i] = angle;
          uniqueHorizonAnglesRounded[i] = Math.round(angle * 1000) / 1000;
          uniqueHorizonMaxPlusMargin[i] =
            getMaxHorizonAngle(m) + TERRAIN_HORIZON_SKIP_MARGIN_DEG;
        }
      }
      const maskIndices = pointMaskIndices;

      for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        // Throttle abort check (every 1024 points)
        if ((pointIndex & 1023) === 0) throwIfAborted(params.signal);

        const point = preparedOutdoorPoints[pointIndex];
        const horizonMask = point.horizonMask;

        // Inline horizon + terrain check.
        // Terrain boolean comes from the GPU bitmask when available,
        // otherwise from the cached per-unique-mask angle (no per-point
        // getHorizonAngleForAzimuth / getMaxHorizonAngle function call).
        let terrainBlocked = false;
        if (horizonMask !== null) {
          if (batchTerrainBlockedMask !== null) {
            terrainBlocked =
              ((batchTerrainBlockedMask[pointIndex >>> 5] >>> (pointIndex & 31)) & 1) === 1;
          } else if (uniqueHorizonAnglesRaw !== null && uniqueHorizonMaxPlusMargin !== null && maskIndices !== null) {
            // Fast path: cached per-unique-mask angle + max-plus-margin.
            const mi = maskIndices[pointIndex];
            if (altitudeDeg <= uniqueHorizonMaxPlusMargin[mi] && altitudeDeg <= uniqueHorizonAnglesRaw[mi]) {
              terrainBlocked = true;
            }
          } else if (altitudeDeg <= getMaxHorizonAngle(horizonMask) + TERRAIN_HORIZON_SKIP_MARGIN_DEG) {
            // Fallback: per-point compute (legacy path, rarely hit now).
            terrainBlocked = isTerrainBlockedByHorizon(horizonMask, azimuthDeg, altitudeDeg);
          }
        }
        // Local DEM self-shadowing (complements horizon mask, which only sees
        // distant relief > ~500m). Gated internally to altitudeDeg < 30°.
        if (!terrainBlocked && point.terrainShadowEvaluator !== undefined) {
          if (point.terrainShadowEvaluator({ azimuthDeg, altitudeDeg }).blocked) {
            terrainBlocked = true;
          }
        }

        // Vegetation: only when not terrain-blocked (matches evaluateInstantSunlight).
        // If the GPU computed a vegetation bitmask for this frame, read it
        // instead of running the CPU ray-march; otherwise fall back.
        let vegetationBlocked = false;
        if (batchVegetationBlockedMask !== null) {
          if (!terrainBlocked) {
            vegetationBlocked =
              ((batchVegetationBlockedMask[pointIndex >>> 5] >>> (pointIndex & 31)) & 1) === 1;
          }
        } else {
          const vegEval = point.vegetationShadowEvaluator;
          if (!terrainBlocked && vegEval !== undefined) {
            vegetationBlocked = vegEval({ azimuthDeg, altitudeDeg }).blocked;
          }
        }

        // Building: batch bitmask OR per-point evaluator OR none
        let buildingsBlocked = false;
        let buildingBlockerId: string | null = null;
        if (useBatchMask && buildingsMaskU32 !== null) {
          // Batch backends: bit already computed for this point
          buildingsBlocked =
            ((buildingsMaskU32[pointIndex >>> 5] >>> (pointIndex & 31)) & 1) === 1;
        } else if (!terrainBlocked && point.buildingShadowEvaluator !== undefined) {
          // Per-point evaluator: skip when terrain blocks (match slow-path semantic)
          const buildingResult = point.buildingShadowEvaluator({ azimuthDeg, altitudeDeg });
          buildingsBlocked = buildingResult.blocked;
          buildingBlockerId = buildingResult.blockerId ?? null;
        }

        // Inline setMaskBit
        const byteIndex = pointIndex >> 3;
        const bit = 1 << (pointIndex & 7);
        if (terrainBlocked) terrainMask[byteIndex] |= bit;
        if (buildingsBlocked) buildingsMask[byteIndex] |= bit;
        if (vegetationBlocked) vegetationMask[byteIndex] |= bit;

        const isSunnyNoVegetation = !terrainBlocked && !buildingsBlocked;
        if (isSunnyNoVegetation) {
          sunnyMaskNoVegetation[byteIndex] |= bit;
          sunnyCountNoVegetation += 1;
          if (!vegetationBlocked) {
            sunnyMask[byteIndex] |= bit;
            sunnyCount += 1;
          }
        }

        // Diagnostics (preserve API contract) — index assignment, not push.
        // Use pre-rounded per-unique-mask cache when available; otherwise
        // round per-point (only when the dedup didn't cover all points,
        // i.e. some point had no mask).
        if (uniqueHorizonAnglesRounded !== null && maskIndices !== null) {
          horizonAngleDegByPoint[pointIndex] = uniqueHorizonAnglesRounded[maskIndices[pointIndex]];
        } else if (horizonMask !== null) {
          horizonAngleDegByPoint[pointIndex] =
            Math.round(getHorizonAngleForAzimuth(horizonMask, azimuthDeg) * 1000) / 1000;
        } else {
          horizonAngleDegByPoint[pointIndex] = null;
        }
        if (!useBatchMask && buildingBlockerId !== null) {
          // Only overwrite the pre-filled null when we actually have a blocker id
          buildingBlockerIdByPoint[pointIndex] = buildingBlockerId;
        }

        // Cooperative yield
        if (yieldEvery > 0 && pointIndex > 0 && pointIndex % yieldEvery === 0) {
          params.onProgress?.({
            stage: "evaluate-frames",
            completed: completedFrameEvaluations,
            total: totalFrameEvaluations,
            pointCountTotal: rawTilePoints.length,
            pointCountOutdoor: pointCount,
            frameCountTotal: samples.length,
            frameIndex: sampleIndex + 1,
            elapsedMs: performance.now() - started,
          });
          await yieldToEventLoop();
          throwIfAborted(params.signal);
        }
        completedFrameEvaluations += 1;
      }
    }

    frames.push({
      index: sampleIndex,
      localTime,
      utcTime: sampleDate.toISOString(),
      sunnyCount,
      sunnyCountNoVegetation,
      sunMask: sunnyMask,
      sunMaskNoVegetation: sunnyMaskNoVegetation,
      terrainBlockedMask: terrainMask,
      buildingsBlockedMask: buildingsMask,
      vegetationBlockedMask: vegetationMask,
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

  const frameLoopEnd = performance.now();
  phaseMs.evalFrameLoop = frameLoopEnd - frameLoopT0;
  phaseMs.evaluations = frameLoopEnd - evalsT0;
  const totalMs = performance.now() - started;
  const cpuDelta = process.cpuUsage(cpuT0);
  const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
  const cpuPct = totalMs > 0 ? (cpuMs / totalMs) * 100 : 0;
  phaseMs.postEvals = totalMs - (frameLoopEnd - started);
  const phaseSum =
    phaseMs.adaptiveHorizon + phaseMs.sharedSources + phaseMs.pointContexts + phaseMs.evaluations;
  const otherMs = Math.max(0, totalMs - phaseSum);
  const evals = preparedOutdoorPoints.length * frames.length;
  console.log(
    `[tile ${params.tile.tileId}] ${(totalMs / 1000).toFixed(1)}s total (cpu ${cpuPct.toFixed(0)}%)` +
      ` \u2014 horizon ${(phaseMs.adaptiveHorizon / 1000).toFixed(1)}s` +
      `, sources ${(phaseMs.sharedSources / 1000).toFixed(1)}s` +
      `, points ${(phaseMs.pointContexts / 1000).toFixed(1)}s` +
      ` [ctx ${pointsContextCallMs.toFixed(0)}ms` +
      `, loop ${(phaseMs.pointContexts - pointsContextCallMs).toFixed(0)}ms` +
      ` for ${pointsOutdoorCount + pointsIndoorCount} pts (${pointsIndoorCount} in, ${pointsOutdoorCount} out)]` +
      `, eval ${(phaseMs.evaluations / 1000).toFixed(1)}s` +
      ` [setup ${(phaseMs.evalSetup / 1000).toFixed(2)}s` +
      ` (pts ${phaseMs.evalSetupPoints.toFixed(0)}ms` +
      `, horiz ${phaseMs.evalSetupHorizon.toFixed(0)}ms` +
      `, veg ${phaseMs.evalSetupVegetation.toFixed(0)}ms` +
      `, perFrame ${phaseMs.evalSetupPerFrame.toFixed(0)}ms)` +
      `, dispatch ${(phaseMs.evalBatchDispatch / 1000).toFixed(2)}s` +
      `, frameLoop ${(phaseMs.evalFrameLoop / 1000).toFixed(2)}s]` +
      `, other ${(otherMs / 1000).toFixed(2)}s` +
      ` [pre ${(phaseMs.preHorizon / 1000).toFixed(2)}s` +
      `, post-horizon ${(phaseMs.postHorizonPreSources / 1000).toFixed(2)}s` +
      `, post-sources ${(phaseMs.postSourcesPrePoints / 1000).toFixed(2)}s` +
      `, post-points ${(phaseMs.postPointsPreEvals / 1000).toFixed(2)}s` +
      `, post-eval ${(phaseMs.postEvals / 1000).toFixed(2)}s]` +
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
  /** Legacy JSON artifact. Absent when the tile was loaded from the binary
   * format (cache-only fast path) — consumers must then read `binary`. */
  artifact?: PrecomputedSunlightTileArtifact;
  /** Fast binary artifact with points and masks as typed arrays. */
  binary?: BinaryTileArtifact;
  /** Angle-keyed atlases (ADR-0013), ordered by precision (r0.5 → r0.75 → r1).
   * Consumers must cascade bucket lookup via `lookupAtlasByAngle` so coarser
   * resolutions cover the (az, alt) positions a finer one is missing. When
   * present, supersedes `binary`. */
  atlases?: BinaryTileAtlas[];
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
  let requiredTiles = requiredTileIds
    .map((tileId) => tileById.get(tileId) ?? null)
    .filter((tile): tile is RegionTileSpec => tile !== null);

  // Cache-only optimization: scan the cache directory ONCE to find which
  // tiles actually have an artifact, instead of probing the filesystem for
  // each intersecting tile × each time window (on a Lausanne-wide bbox this
  // was ~700 wasted ENOENT's).
  if (params.cacheOnly) {
    const dataPaths = await import("@/lib/storage/data-paths");
    const fsMod = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const cachedTileIds = new Set<string>();
    for (const tw of cachedTimeWindows) {
      const tilesDir = pathMod.join(
        dataPaths.CACHE_SUNLIGHT_DIR,
        region, modelVersionHash, `g${params.gridStepMeters}`, `m${params.sampleEveryMinutes}`,
        params.date, `t${tw.startLocalTime.replace(":", "")}-${tw.endLocalTime.replace(":", "")}`, "tiles",
      );
      try {
        for (const f of await fsMod.readdir(tilesDir)) {
          if (f.endsWith(".tile.bin.gz")) {
            cachedTileIds.add(f.slice(0, -".tile.bin.gz".length));
          } else if (f.endsWith(".json.gz")) {
            cachedTileIds.add(f.slice(0, -".json.gz".length));
          }
        }
      } catch { /* no tiles for this time window */ }
    }
    // Also include tiles covered by the atlas (ADR-0013): atlas is date-agnostic,
    // so tiles not in the date-keyed dirs may still be served via atlas fallback.
    // Probe every resolution in the read fallback chain (r0.5 → r0.75 → r1) — otherwise
    // tiles cached only at r0.75 would be filtered out before loadOneCached's fallback runs.
    for (const res of ATLAS_READ_FALLBACK_RESOLUTIONS_DEG) {
      const atlasDir = pathMod.join(
        dataPaths.CACHE_SUNLIGHT_DIR,
        region, modelVersionHash, `g${params.gridStepMeters}`, "atlas", `r${res}`,
      );
      try {
        for (const f of await fsMod.readdir(atlasDir)) {
          if (f.endsWith(".atlas.bin.gz")) {
            cachedTileIds.add(f.slice(0, -".atlas.bin.gz".length));
          }
        }
      } catch { /* no atlas at this resolution */ }
    }

    const before = requiredTiles.length;
    requiredTiles = requiredTiles.filter((t) => cachedTileIds.has(t.tileId));
    process.stderr.write(
      `[stream:cache-only] bbox intersects ${before} tiles, ${requiredTiles.length} in cache (skipping ${before - requiredTiles.length} misses)\n`,
    );
  }

  const samples = createUtcSamples(
    params.date,
    params.timezone,
    params.sampleEveryMinutes,
    effectiveStartLocalTime,
    effectiveEndLocalTime,
  );

  const resolveStartedAt = performance.now();
  let maxPercent = 0;

  // Prefetch window for cache-only reads: load the next N tiles from disk
  // in parallel while the consumer processes the current one. Each tile
  // artifact is 1-2MB (gzip-decompressed + JSON.parse ~200-400ms), so
  // sequential loading makes tiles arrive visibly "drop by drop". Prefetching
  // overlaps the disk + parse work with the SSE dispatch of the previous tile.
  const CACHE_PREFETCH = 16;
  type CachedTileLoad = {
    artifact: PrecomputedSunlightTileArtifact | null;
    binary?: BinaryTileArtifact;
    atlases?: BinaryTileAtlas[];
    layer: "L1" | "L2" | "MISS";
  };
  const loadOneCached = async (tile: RegionTileSpec): Promise<CachedTileLoad> => {
    // Atlas (ADR-0013): year-independent, angle-keyed. Load every available
    // resolution (r0.5 → r0.75 → r1) so bucket lookup can cascade — otherwise
    // a sparse r0.5 atlas (only some dates) shadowed a complete r0.75 corpus
    // and tiles rendered as "all shadow" for any date outside r0.5's coverage.
    const atlases = await loadAtlasesDiskOnly({
      region,
      modelVersionHash,
      gridStepMeters: params.gridStepMeters,
      tileId: tile.tileId,
    });
    if (atlases.length > 0) {
      // Strict cache-hit predicate (user decision): every requested sample must
      // resolve to a populated bucket across at least one resolution. If even
      // one frame has no bucket anywhere, treat the tile as a miss rather than
      // serving a timeline with silently-empty frames.
      const tileCenterE = (tile.minEasting + tile.maxEasting) / 2;
      const tileCenterN = (tile.minNorthing + tile.maxNorthing) / 2;
      const { lat: tileLat, lon: tileLon } = lv95ToWgs84(tileCenterE, tileCenterN);
      const RAD_TO_DEG = 180 / Math.PI;
      let allFramesCovered = true;
      for (const utc of samples) {
        const pos = SunCalc.getPosition(utc, tileLat, tileLon);
        const alt = pos.altitude * RAD_TO_DEG;
        if (alt <= 0) continue; // night frames never need an atlas bucket
        let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
        if (az < 0) az += 360;
        if (!lookupAtlasByAngle(atlases, az, alt)) {
          allFramesCovered = false;
          break;
        }
      }
      if (allFramesCovered) {
        return { artifact: null, atlases, layer: "L2" as const };
      }
    }

    for (const tw of cachedTimeWindows) {
      // Prefer the compact binary format when available — ~9x faster than
      // gunzip + JSON.parse on the hot path.
      const binary = await loadTileBinaryDiskOnly({
        region,
        modelVersionHash,
        date: params.date,
        gridStepMeters: params.gridStepMeters,
        sampleEveryMinutes: params.sampleEveryMinutes,
        startLocalTime: tw.startLocalTime,
        endLocalTime: tw.endLocalTime,
        tileId: tile.tileId,
      });
      if (binary) {
        return { artifact: null, binary, layer: "L2" as const };
      }
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
        return { artifact: loaded.artifact, layer: loaded.layer };
      }
    }
    return { artifact: null, layer: "MISS" as const };
  };
  const inflight: Array<Promise<CachedTileLoad>> = [];
  const cacheStreamStarted = params.cacheOnly ? performance.now() : 0;
  let firstTileAt = 0;
  let cacheTilesYielded = 0;
  let cacheTilesMissed = 0;

  for (let tileIdx = 0; tileIdx < requiredTiles.length; tileIdx++) {
    const tile = requiredTiles[tileIdx];

    if (params.cacheOnly) {
      // Top up the prefetch queue to CACHE_PREFETCH in-flight reads.
      while (inflight.length < CACHE_PREFETCH && tileIdx + inflight.length < requiredTiles.length) {
        inflight.push(loadOneCached(requiredTiles[tileIdx + inflight.length]));
      }
      const loaded = await inflight.shift()!;
      if (loaded.atlases || loaded.binary || loaded.artifact) {
        if (firstTileAt === 0) firstTileAt = performance.now() - cacheStreamStarted;
        cacheTilesYielded += 1;
        yield {
          tileId: tile.tileId,
          tileIndex: tileIdx,
          totalTiles: requiredTiles.length,
          artifact: loaded.artifact ?? undefined,
          binary: loaded.binary,
          atlases: loaded.atlases,
          layer: loaded.layer,
        };
      } else {
        cacheTilesMissed += 1;
      }
      if (tileIdx === requiredTiles.length - 1) {
        const total = performance.now() - cacheStreamStarted;
        process.stderr.write(
          `[stream:cache-only] ${cacheTilesYielded}/${requiredTiles.length} tiles ` +
          `(${cacheTilesMissed} miss) in ${total.toFixed(0)}ms ` +
          `(first tile at ${firstTileAt.toFixed(0)}ms, prefetch=${CACHE_PREFETCH})\n`,
        );
      }
      continue;
    }

    // Non-cache-only path: probe the atlas first (ADR-0013, cascade r0.5 → r0.75 → r1).
    // Without this, every tile missing from the per-date cache would fall through to
    // computeSunlightTileArtifact even when the atlas already covers the requested (az, alt).
    // Strict: every requested sample must resolve to a populated bucket across
    // at least one resolution, else fall through to re-compute.
    const atlasHits = await loadAtlasesDiskOnly({
      region,
      modelVersionHash,
      gridStepMeters: params.gridStepMeters,
      tileId: tile.tileId,
    });
    if (atlasHits.length > 0) {
      const tileCenterE = (tile.minEasting + tile.maxEasting) / 2;
      const tileCenterN = (tile.minNorthing + tile.maxNorthing) / 2;
      const { lat: tileLat, lon: tileLon } = lv95ToWgs84(tileCenterE, tileCenterN);
      const RAD_TO_DEG = 180 / Math.PI;
      let allFramesCovered = true;
      for (const utc of samples) {
        const pos = SunCalc.getPosition(utc, tileLat, tileLon);
        const alt = pos.altitude * RAD_TO_DEG;
        if (alt <= 0) continue;
        let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
        if (az < 0) az += 360;
        if (!lookupAtlasByAngle(atlasHits, az, alt)) {
          allFramesCovered = false;
          break;
        }
      }
      if (allFramesCovered) {
        yield {
          tileId: tile.tileId,
          tileIndex: tileIdx,
          totalTiles: requiredTiles.length,
          atlases: atlasHits,
          layer: "L2" as const,
        };
        continue;
      }
    }
    if (tileIdx < 3 || tileIdx % 25 === 0) {
      const mem = process.memoryUsage();
      process.stderr.write(
        `[stream:compute] tile=${tile.tileId} idx=${tileIdx}/${requiredTiles.length} ` +
        `heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB ` +
        `rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB external=${(mem.external / 1024 / 1024).toFixed(0)}MB\n`,
      );
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
    const sunnyMask = frame.sunMask;
    const sunnyMaskNoVegetation = frame.sunMaskNoVegetation;
    const terrainMask = frame.terrainBlockedMask;
    const buildingsMask = frame.buildingsBlockedMask;
    const vegetationMask = frame.vegetationBlockedMask;

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
      full: frame.sunMask,
      noVegetation: frame.sunMaskNoVegetation,
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
      fullMask: frame.sunMask,
      noVegetationMask: frame.sunMaskNoVegetation,
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
