import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import SunCalc from "suncalc";

import { LAUSANNE_CENTER } from "@/lib/config/lausanne";
import { NYON_CENTER } from "@/lib/config/nyon";
import { lv95ToWgs84 } from "@/lib/geo/projection";
import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import {
  buildRegionTiles,
  buildTilePoints,
  type PrecomputedRegionName,
  type RegionTileSpec,
} from "@/lib/precompute/sunlight-cache";
import { createUtcSamples } from "@/lib/precompute/sunlight-tile-service";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
import { DEFAULT_SHADOW_CALIBRATION } from "@/lib/sun/shadow-calibration";
import {
  evaluateInstantSunlight,
  type InstantSunlightProfiler,
} from "@/lib/sun/solar";
import { resolveAdaptiveTerrainHorizonForTile } from "@/lib/sun/adaptive-horizon-sharing";

interface ParsedArgs {
  region: PrecomputedRegionName;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tileCount: number;
  maxPointsPerTile: number;
}

interface TileProfile {
  tileId: string;
  gridPointCount: number;
  outdoorPointCount: number;
  indoorPointCount: number;
  sampleCount: number;
  evaluationCount: number;
  phaseMs: {
    adaptiveHorizon: number;
    sharedSources: number;
    pointContexts: number;
    evaluations: number;
    total: number;
  };
  instantProfiler: InstantSunlightProfiler;
  shadowEvaluators: {
    buildingCalls: number;
    buildingBlockedCalls: number;
    buildingCheckedObstaclesTotal: number;
    vegetationCalls: number;
    vegetationBlockedCalls: number;
    vegetationCheckedSamplesTotal: number;
  };
  blockerOutcomes: {
    terrainBlocked: number;
    buildingsBlocked: number;
    vegetationBlocked: number;
    sunny: number;
  };
  adaptiveHorizon: {
    strategy: string;
    warnings: string[];
  };
}

const OUTPUT_DIR = path.join(process.cwd(), "docs", "progress", "benchmarks");
const FIXED_TILE_SIZE_METERS = 250;
const BUILDING_SHADOW_MAX_DISTANCE_METERS = 2500;

const DEFAULT_ARGS: ParsedArgs = {
  region: "lausanne",
  date: "2026-03-08",
  timezone: "Europe/Zurich",
  sampleEveryMinutes: 15,
  gridStepMeters: 5,
  startLocalTime: "08:00",
  endLocalTime: "12:00",
  tileCount: 8,
  maxPointsPerTile: 0,
};

function parseIntegerArg(value: string, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  if (parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { ...DEFAULT_ARGS };
  for (const arg of argv) {
    if (arg.startsWith("--region=")) {
      const region = arg.slice("--region=".length);
      if (region === "lausanne" || region === "nyon") {
        args.region = region;
      }
      continue;
    }
    if (arg.startsWith("--date=")) {
      args.date = arg.slice("--date=".length);
      continue;
    }
    if (arg.startsWith("--timezone=")) {
      args.timezone = arg.slice("--timezone=".length);
      continue;
    }
    if (arg.startsWith("--sample-every-minutes=")) {
      const parsed = parseIntegerArg(arg.slice("--sample-every-minutes=".length), 1, 60);
      if (parsed !== null) {
        args.sampleEveryMinutes = parsed;
      }
      continue;
    }
    if (arg.startsWith("--grid-step-meters=")) {
      const parsed = parseIntegerArg(arg.slice("--grid-step-meters=".length), 1, 2000);
      if (parsed !== null) {
        args.gridStepMeters = parsed;
      }
      continue;
    }
    if (arg.startsWith("--start-local-time=")) {
      args.startLocalTime = arg.slice("--start-local-time=".length);
      continue;
    }
    if (arg.startsWith("--end-local-time=")) {
      args.endLocalTime = arg.slice("--end-local-time=".length);
      continue;
    }
    if (arg.startsWith("--tile-count=")) {
      const parsed = parseIntegerArg(arg.slice("--tile-count=".length), 1, 5000);
      if (parsed !== null) {
        args.tileCount = parsed;
      }
      continue;
    }
    if (arg.startsWith("--max-points-per-tile=")) {
      const parsed = parseIntegerArg(arg.slice("--max-points-per-tile=".length), 0, 1_000_000);
      if (parsed !== null) {
        args.maxPointsPerTile = parsed;
      }
      continue;
    }
  }
  return args;
}

function centerForRegion(region: PrecomputedRegionName): { lat: number; lon: number } {
  return region === "lausanne" ? LAUSANNE_CENTER : NYON_CENTER;
}

function distanceSquaredMeters(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const dLatMeters = (latB - latA) * 111_320;
  const avgLat = (latA + latB) / 2;
  const dLonMeters = (lonB - lonA) * (111_320 * Math.cos((avgLat * Math.PI) / 180));
  return dLatMeters * dLatMeters + dLonMeters * dLonMeters;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

type BuildingsIndex = NonNullable<
  Awaited<ReturnType<typeof buildSharedPointEvaluationSources>>["buildingsIndex"]
>;
type BuildingObstacle = BuildingsIndex["obstacles"][number];
type BuildingSpatialGrid = NonNullable<BuildingsIndex["spatialGrid"]>;

function computeSolarGeometry(
  lat: number,
  lon: number,
  utcDate: Date,
): { altitudeDeg: number; azimuthDeg: number } {
  const position = SunCalc.getPosition(utcDate, lat, lon);
  const fromNorth = ((position.azimuth * 180) / Math.PI + 180) % 360;
  return {
    altitudeDeg: (position.altitude * 180) / Math.PI,
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

  for (const sampleDate of params.samples) {
    const solarGeometry = computeSolarGeometry(centerWgs84.lat, centerWgs84.lon, sampleDate);
    if (solarGeometry.altitudeDeg <= 0) {
      continue;
    }

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

  if (allowedBlockerIds.size === 0) {
    return undefined;
  }
  return allowedBlockerIds;
}

function createInstantProfiler(): InstantSunlightProfiler {
  return {
    evaluations: 0,
    totalMs: 0,
    solarPositionMs: 0,
    terrainMs: 0,
    buildingsMs: 0,
    vegetationMs: 0,
    finalizeMs: 0,
    belowAstronomicalHorizonCount: 0,
    terrainCheckNeededCount: 0,
    terrainBlockedCount: 0,
    secondarySkippedByTerrainCount: 0,
    buildingsSkippedByAzimuthGuardCount: 0,
    buildingsEvaluatorCalls: 0,
    vegetationEvaluatorCalls: 0,
  };
}

function pickTiles(args: ParsedArgs): RegionTileSpec[] {
  const center = centerForRegion(args.region);
  return buildRegionTiles(args.region, FIXED_TILE_SIZE_METERS)
    .map((tile) => {
      const centerLat = (tile.bbox.minLat + tile.bbox.maxLat) / 2;
      const centerLon = (tile.bbox.minLon + tile.bbox.maxLon) / 2;
      return {
        tile,
        distance2: distanceSquaredMeters(center.lat, center.lon, centerLat, centerLon),
      };
    })
    .sort((left, right) => left.distance2 - right.distance2)
    .slice(0, args.tileCount)
    .map((entry) => entry.tile);
}

async function profileTile(params: {
  args: ParsedArgs;
  tile: RegionTileSpec;
  modelVersionHash: string;
  utcSamples: Date[];
}): Promise<TileProfile> {
  const tileStartedAt = performance.now();

  const adaptiveStartedAt = performance.now();
  const adaptiveHorizon = await resolveAdaptiveTerrainHorizonForTile({
    region: params.args.region,
    modelVersionHash: params.modelVersionHash,
    tile: params.tile,
    date: params.args.date,
    timezone: params.args.timezone,
    sampleEveryMinutes: params.args.sampleEveryMinutes,
    startLocalTime: params.args.startLocalTime,
    endLocalTime: params.args.endLocalTime,
    gridStepMeters: params.args.gridStepMeters,
  });
  const adaptiveHorizonMs = performance.now() - adaptiveStartedAt;

  const sharedStartedAt = performance.now();
  const sharedSources = await buildSharedPointEvaluationSources({
    terrainHorizonOverride: adaptiveHorizon.horizonMask ?? undefined,
    lv95Bounds: {
      minX: params.tile.minEasting,
      minY: params.tile.minNorthing,
      maxX: params.tile.maxEasting,
      maxY: params.tile.maxNorthing,
    },
  });
  const sharedSourcesMs = performance.now() - sharedStartedAt;

  const rawPoints = buildTilePoints(params.tile, params.args.gridStepMeters);
  const selectedPoints =
    params.args.maxPointsPerTile > 0
      ? rawPoints.slice(0, params.args.maxPointsPerTile)
      : rawPoints;
  const gridPointCount = selectedPoints.length;

  const contextStartedAt = performance.now();
  const preparedOutdoorPoints: Array<{
    lat: number;
    lon: number;
    horizonMask: Awaited<ReturnType<typeof buildPointEvaluationContext>>["horizonMask"];
    buildingShadowAzimuthGuard: Awaited<
      ReturnType<typeof buildPointEvaluationContext>
    >["buildingShadowAzimuthGuard"];
    buildingShadowEvaluator?: (sample: {
      azimuthDeg: number;
      altitudeDeg: number;
      utcDate: Date;
    }) => {
      blocked: boolean;
      blockerId: string | null;
      blockerDistanceMeters: number | null;
      blockerAltitudeAngleDeg: number | null;
      checkedObstaclesCount: number;
    };
    vegetationShadowEvaluator?: (sample: {
      azimuthDeg: number;
      altitudeDeg: number;
      utcDate: Date;
    }) => {
      blocked: boolean;
      blockerDistanceMeters: number | null;
      blockerAltitudeAngleDeg: number | null;
      blockerSurfaceElevationMeters: number | null;
      blockerClearanceMeters: number | null;
      checkedSamplesCount: number;
    };
  }> = [];

  let indoorPointCount = 0;
  const tileBuildingAllowlist = collectTileWindowBuildingAllowlist({
    tile: params.tile,
    samples: params.utcSamples,
    buildingsIndex: sharedSources.buildingsIndex,
  });
  for (const point of selectedPoints) {
    const context = await buildPointEvaluationContext(point.lat, point.lon, {
      skipTerrainSamplingWhenIndoor: true,
      terrainHorizonOverride: adaptiveHorizon.horizonMask ?? undefined,
      shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
      sharedSources,
      buildingShadowAllowedIds: tileBuildingAllowlist,
    });
    if (context.insideBuilding) {
      indoorPointCount += 1;
      continue;
    }
    preparedOutdoorPoints.push({
      lat: point.lat,
      lon: point.lon,
      horizonMask: context.horizonMask,
      buildingShadowAzimuthGuard: context.buildingShadowAzimuthGuard,
      buildingShadowEvaluator: context.buildingShadowEvaluator,
      vegetationShadowEvaluator: context.vegetationShadowEvaluator,
    });
  }
  const pointContextsMs = performance.now() - contextStartedAt;

  const instantProfiler = createInstantProfiler();
  const shadowEvaluators = {
    buildingCalls: 0,
    buildingBlockedCalls: 0,
    buildingCheckedObstaclesTotal: 0,
    vegetationCalls: 0,
    vegetationBlockedCalls: 0,
    vegetationCheckedSamplesTotal: 0,
  };
  const blockerOutcomes = {
    terrainBlocked: 0,
    buildingsBlocked: 0,
    vegetationBlocked: 0,
    sunny: 0,
  };

  const wrappedPoints = preparedOutdoorPoints.map((point) => {
    const wrappedBuilding =
      point.buildingShadowEvaluator === undefined
        ? undefined
        : (sample: { azimuthDeg: number; altitudeDeg: number; utcDate: Date }) => {
            const result = point.buildingShadowEvaluator!(sample);
            shadowEvaluators.buildingCalls += 1;
            shadowEvaluators.buildingCheckedObstaclesTotal += result.checkedObstaclesCount;
            if (result.blocked) {
              shadowEvaluators.buildingBlockedCalls += 1;
            }
            return result;
          };

    const wrappedVegetation =
      point.vegetationShadowEvaluator === undefined
        ? undefined
        : (sample: { azimuthDeg: number; altitudeDeg: number; utcDate: Date }) => {
            const result = point.vegetationShadowEvaluator!(sample);
            shadowEvaluators.vegetationCalls += 1;
            shadowEvaluators.vegetationCheckedSamplesTotal += result.checkedSamplesCount;
            if (result.blocked) {
              shadowEvaluators.vegetationBlockedCalls += 1;
            }
            return result;
          };

    return {
      lat: point.lat,
      lon: point.lon,
      horizonMask: point.horizonMask,
      buildingShadowAzimuthGuard: point.buildingShadowAzimuthGuard,
      buildingShadowEvaluator: wrappedBuilding,
      vegetationShadowEvaluator: wrappedVegetation,
    };
  });

  const evaluationStartedAt = performance.now();
  const localDateTimeFormatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: params.args.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  for (const utcSample of params.utcSamples) {
    const localDateTimeOverride = localDateTimeFormatter.format(utcSample);
    for (const point of wrappedPoints) {
      const sample = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate: utcSample,
        timeZone: params.args.timezone,
        localDateTimeOverride,
        horizonMask: point.horizonMask,
        buildingShadowAzimuthGuard: point.buildingShadowAzimuthGuard,
        buildingShadowEvaluator: point.buildingShadowEvaluator,
        vegetationShadowEvaluator: point.vegetationShadowEvaluator,
        profiler: instantProfiler,
      });
      if (sample.terrainBlocked) {
        blockerOutcomes.terrainBlocked += 1;
      }
      if (sample.buildingsBlocked) {
        blockerOutcomes.buildingsBlocked += 1;
      }
      if (sample.vegetationBlocked) {
        blockerOutcomes.vegetationBlocked += 1;
      }
      if (sample.isSunny) {
        blockerOutcomes.sunny += 1;
      }
    }
  }
  const evaluationsMs = performance.now() - evaluationStartedAt;

  return {
    tileId: params.tile.tileId,
    gridPointCount,
    outdoorPointCount: wrappedPoints.length,
    indoorPointCount,
    sampleCount: params.utcSamples.length,
    evaluationCount: wrappedPoints.length * params.utcSamples.length,
    phaseMs: {
      adaptiveHorizon: round3(adaptiveHorizonMs),
      sharedSources: round3(sharedSourcesMs),
      pointContexts: round3(pointContextsMs),
      evaluations: round3(evaluationsMs),
      total: round3(performance.now() - tileStartedAt),
    },
    instantProfiler: {
      ...instantProfiler,
      totalMs: round3(instantProfiler.totalMs),
      solarPositionMs: round3(instantProfiler.solarPositionMs),
      terrainMs: round3(instantProfiler.terrainMs),
      buildingsMs: round3(instantProfiler.buildingsMs),
      vegetationMs: round3(instantProfiler.vegetationMs),
      finalizeMs: round3(instantProfiler.finalizeMs),
    },
    shadowEvaluators,
    blockerOutcomes,
    adaptiveHorizon: {
      strategy: adaptiveHorizon.strategy,
      warnings: adaptiveHorizon.warnings,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectedTiles = pickTiles(args);
  if (selectedTiles.length === 0) {
    throw new Error("No tile selected for profiling.");
  }

  const utcSamples = createUtcSamples(
    args.date,
    args.timezone,
    args.sampleEveryMinutes,
    args.startLocalTime,
    args.endLocalTime,
  );
  if (utcSamples.length === 0) {
    throw new Error("No UTC samples produced for selected date/time window.");
  }

  const modelVersion = await getSunlightModelVersion(args.region, DEFAULT_SHADOW_CALIBRATION);
  console.log(
    `[profile:cpu-breakdown] region=${args.region} date=${args.date} tiles=${selectedTiles.length} grid=${args.gridStepMeters}m samples=${utcSamples.length} model=${modelVersion.modelVersionHash}`,
  );

  const profiles: TileProfile[] = [];
  for (let index = 0; index < selectedTiles.length; index += 1) {
    const tile = selectedTiles[index];
    console.log(
      `[profile:cpu-breakdown] tile ${index + 1}/${selectedTiles.length} -> ${tile.tileId}`,
    );
    const profile = await profileTile({
      args,
      tile,
      modelVersionHash: modelVersion.modelVersionHash,
      utcSamples,
    });
    profiles.push(profile);
  }

  const aggregate = profiles.reduce(
    (acc, tile) => {
      acc.gridPointCount += tile.gridPointCount;
      acc.outdoorPointCount += tile.outdoorPointCount;
      acc.indoorPointCount += tile.indoorPointCount;
      acc.evaluationCount += tile.evaluationCount;
      acc.phaseMs.adaptiveHorizon += tile.phaseMs.adaptiveHorizon;
      acc.phaseMs.sharedSources += tile.phaseMs.sharedSources;
      acc.phaseMs.pointContexts += tile.phaseMs.pointContexts;
      acc.phaseMs.evaluations += tile.phaseMs.evaluations;
      acc.phaseMs.total += tile.phaseMs.total;
      acc.instantProfiler.evaluations += tile.instantProfiler.evaluations;
      acc.instantProfiler.totalMs += tile.instantProfiler.totalMs;
      acc.instantProfiler.solarPositionMs += tile.instantProfiler.solarPositionMs;
      acc.instantProfiler.terrainMs += tile.instantProfiler.terrainMs;
      acc.instantProfiler.buildingsMs += tile.instantProfiler.buildingsMs;
      acc.instantProfiler.vegetationMs += tile.instantProfiler.vegetationMs;
      acc.instantProfiler.finalizeMs += tile.instantProfiler.finalizeMs;
      acc.instantProfiler.belowAstronomicalHorizonCount +=
        tile.instantProfiler.belowAstronomicalHorizonCount;
      acc.instantProfiler.terrainCheckNeededCount +=
        tile.instantProfiler.terrainCheckNeededCount;
      acc.instantProfiler.terrainBlockedCount += tile.instantProfiler.terrainBlockedCount;
      acc.instantProfiler.secondarySkippedByTerrainCount +=
        tile.instantProfiler.secondarySkippedByTerrainCount;
      acc.instantProfiler.buildingsSkippedByAzimuthGuardCount +=
        tile.instantProfiler.buildingsSkippedByAzimuthGuardCount;
      acc.instantProfiler.buildingsEvaluatorCalls +=
        tile.instantProfiler.buildingsEvaluatorCalls;
      acc.instantProfiler.vegetationEvaluatorCalls +=
        tile.instantProfiler.vegetationEvaluatorCalls;
      acc.shadowEvaluators.buildingCalls += tile.shadowEvaluators.buildingCalls;
      acc.shadowEvaluators.buildingBlockedCalls += tile.shadowEvaluators.buildingBlockedCalls;
      acc.shadowEvaluators.buildingCheckedObstaclesTotal +=
        tile.shadowEvaluators.buildingCheckedObstaclesTotal;
      acc.shadowEvaluators.vegetationCalls += tile.shadowEvaluators.vegetationCalls;
      acc.shadowEvaluators.vegetationBlockedCalls +=
        tile.shadowEvaluators.vegetationBlockedCalls;
      acc.shadowEvaluators.vegetationCheckedSamplesTotal +=
        tile.shadowEvaluators.vegetationCheckedSamplesTotal;
      acc.blockerOutcomes.terrainBlocked += tile.blockerOutcomes.terrainBlocked;
      acc.blockerOutcomes.buildingsBlocked += tile.blockerOutcomes.buildingsBlocked;
      acc.blockerOutcomes.vegetationBlocked += tile.blockerOutcomes.vegetationBlocked;
      acc.blockerOutcomes.sunny += tile.blockerOutcomes.sunny;
      return acc;
    },
    {
      gridPointCount: 0,
      outdoorPointCount: 0,
      indoorPointCount: 0,
      evaluationCount: 0,
      phaseMs: {
        adaptiveHorizon: 0,
        sharedSources: 0,
        pointContexts: 0,
        evaluations: 0,
        total: 0,
      },
      instantProfiler: createInstantProfiler(),
      shadowEvaluators: {
        buildingCalls: 0,
        buildingBlockedCalls: 0,
        buildingCheckedObstaclesTotal: 0,
        vegetationCalls: 0,
        vegetationBlockedCalls: 0,
        vegetationCheckedSamplesTotal: 0,
      },
      blockerOutcomes: {
        terrainBlocked: 0,
        buildingsBlocked: 0,
        vegetationBlocked: 0,
        sunny: 0,
      },
    },
  );

  const totalEvaluations = Math.max(aggregate.evaluationCount, 1);
  const totalEvaluationMs = Math.max(aggregate.phaseMs.evaluations, 1e-9);
  const totalRunMs = Math.max(aggregate.phaseMs.total, 1e-9);
  const report = {
    generatedAt: new Date().toISOString(),
    params: args,
    modelVersionHash: modelVersion.modelVersionHash,
    buildingsShadowMode: process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(default)",
    selectedTileIds: selectedTiles.map((tile) => tile.tileId),
    aggregate: {
      counts: {
        gridPoints: aggregate.gridPointCount,
        outdoorPoints: aggregate.outdoorPointCount,
        indoorPoints: aggregate.indoorPointCount,
        utcSamples: utcSamples.length,
        evaluations: aggregate.evaluationCount,
      },
      phaseMs: {
        adaptiveHorizon: round3(aggregate.phaseMs.adaptiveHorizon),
        sharedSources: round3(aggregate.phaseMs.sharedSources),
        pointContexts: round3(aggregate.phaseMs.pointContexts),
        evaluations: round3(aggregate.phaseMs.evaluations),
        total: round3(aggregate.phaseMs.total),
      },
      phasePctOfTotal: {
        adaptiveHorizon: round3((aggregate.phaseMs.adaptiveHorizon / totalRunMs) * 100),
        sharedSources: round3((aggregate.phaseMs.sharedSources / totalRunMs) * 100),
        pointContexts: round3((aggregate.phaseMs.pointContexts / totalRunMs) * 100),
        evaluations: round3((aggregate.phaseMs.evaluations / totalRunMs) * 100),
      },
      instantProfilerMs: {
        total: round3(aggregate.instantProfiler.totalMs),
        solarPosition: round3(aggregate.instantProfiler.solarPositionMs),
        terrain: round3(aggregate.instantProfiler.terrainMs),
        buildings: round3(aggregate.instantProfiler.buildingsMs),
        vegetation: round3(aggregate.instantProfiler.vegetationMs),
        finalize: round3(aggregate.instantProfiler.finalizeMs),
      },
      instantProfilerPctOfEvalLoop: {
        total: round3((aggregate.instantProfiler.totalMs / totalEvaluationMs) * 100),
        solarPosition: round3(
          (aggregate.instantProfiler.solarPositionMs / totalEvaluationMs) * 100,
        ),
        terrain: round3((aggregate.instantProfiler.terrainMs / totalEvaluationMs) * 100),
        buildings: round3((aggregate.instantProfiler.buildingsMs / totalEvaluationMs) * 100),
        vegetation: round3((aggregate.instantProfiler.vegetationMs / totalEvaluationMs) * 100),
        finalize: round3((aggregate.instantProfiler.finalizeMs / totalEvaluationMs) * 100),
      },
      instantProfilerCounts: aggregate.instantProfiler,
      perEvaluationMicros: {
        total: round3((aggregate.instantProfiler.totalMs * 1000) / totalEvaluations),
        solarPosition: round3(
          (aggregate.instantProfiler.solarPositionMs * 1000) / totalEvaluations,
        ),
        terrain: round3((aggregate.instantProfiler.terrainMs * 1000) / totalEvaluations),
        buildings: round3((aggregate.instantProfiler.buildingsMs * 1000) / totalEvaluations),
        vegetation: round3((aggregate.instantProfiler.vegetationMs * 1000) / totalEvaluations),
        finalize: round3((aggregate.instantProfiler.finalizeMs * 1000) / totalEvaluations),
      },
      shadowEvaluators: {
        ...aggregate.shadowEvaluators,
        avgCheckedObstaclesPerBuildingCall:
          aggregate.shadowEvaluators.buildingCalls === 0
            ? 0
            : round3(
                aggregate.shadowEvaluators.buildingCheckedObstaclesTotal /
                  aggregate.shadowEvaluators.buildingCalls,
              ),
        avgCheckedVegetationSamplesPerCall:
          aggregate.shadowEvaluators.vegetationCalls === 0
            ? 0
            : round3(
                aggregate.shadowEvaluators.vegetationCheckedSamplesTotal /
                  aggregate.shadowEvaluators.vegetationCalls,
              ),
      },
      blockerOutcomes: aggregate.blockerOutcomes,
    },
    tiles: profiles,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(
    OUTPUT_DIR,
    `precompute-cpu-breakdown-${args.region}-${args.date}-t${args.startLocalTime.replace(":", "")}-${args.endLocalTime.replace(":", "")}-g${args.gridStepMeters}-tiles${selectedTiles.length}.json`,
  );
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[profile:cpu-breakdown] wrote ${outputPath}`);
}

void main().catch((error) => {
  console.error(
    `[profile:cpu-breakdown] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
