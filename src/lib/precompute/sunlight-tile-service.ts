import { performance } from "node:perf_hooks";

import SunCalc from "suncalc";

import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
import type { ShadowCalibration } from "@/lib/sun/shadow-calibration";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "@/lib/time/zoned-date";

import { getSunlightModelVersion } from "./model-version";
import { TtlCache, runWithInFlightDedup } from "./runtime-cache";
import {
  buildRegionTiles,
  buildTilePoints,
  decodeBase64Bytes,
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
const PRECOMPUTED_REGIONS: PrecomputedRegionName[] = ["lausanne", "nyon"];
const manifestMemoryCache = new TtlCache<PrecomputedSunlightManifest | null>(60_000, 64);
const tileMemoryCache = new TtlCache<PrecomputedSunlightTileArtifact | null>(60_000, 128);

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

function resolveRegionForBbox(bbox: RegionBbox): PrecomputedRegionName | null {
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
}): Promise<PrecomputedSunlightTileArtifact> {
  const started = performance.now();
  throwIfAborted(params.signal);
  const rawTilePoints = buildTilePoints(params.tile, params.gridStepMeters);
  const warnings: string[] = [];
  let terrainMethod = "none";
  let buildingsMethod = "none";
  let vegetationMethod = "none";
  let indoorPointsExcluded = 0;
  let pointsWithElevation = 0;
  let terrainHorizonOverride:
    | Awaited<ReturnType<typeof buildDynamicHorizonMask>>
    | undefined;

  try {
    const tileCenterLat = (params.tile.bbox.minLat + params.tile.bbox.maxLat) / 2;
    const tileCenterLon = (params.tile.bbox.minLon + params.tile.bbox.maxLon) / 2;
    const dynamicMask = await buildDynamicHorizonMask({
      lat: tileCenterLat,
      lon: tileCenterLon,
    });
    if (dynamicMask) {
      terrainHorizonOverride = dynamicMask;
      terrainMethod = dynamicMask.method;
    } else {
      warnings.push(`Dynamic terrain horizon unavailable for tile ${params.tile.tileId}.`);
    }
  } catch (error) {
    warnings.push(
      `Dynamic terrain horizon build failed for tile ${params.tile.tileId} (${error instanceof Error ? error.message : "unknown error"}).`,
    );
  }

  const points: PrecomputedSunlightTileArtifact["points"] = [];
  const preparedOutdoorPoints: PreparedOutdoorPoint[] = [];
  const sharedSources = await buildSharedPointEvaluationSources({
    terrainHorizonOverride: terrainHorizonOverride ?? undefined,
    lv95Bounds: {
      minX: params.tile.minEasting,
      minY: params.tile.minNorthing,
      maxX: params.tile.maxEasting,
      maxY: params.tile.maxNorthing,
    },
  });

  for (let rawPointIndex = 0; rawPointIndex < rawTilePoints.length; rawPointIndex += 1) {
    throwIfAborted(params.signal);
    const point = rawTilePoints[rawPointIndex];
    const context = await buildPointEvaluationContext(point.lat, point.lon, {
      skipTerrainSamplingWhenIndoor: true,
      terrainHorizonOverride: terrainHorizonOverride ?? undefined,
      shadowCalibration: params.shadowCalibration,
      sharedSources,
    });
    terrainMethod = context.terrainHorizonMethod;
    buildingsMethod = context.buildingsShadowMethod;
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
      });
      await yieldToEventLoop();
      throwIfAborted(params.signal);
    }
  }

  params.onProgress?.({
    stage: "prepare-points",
    completed: rawTilePoints.length,
    total: rawTilePoints.length,
    pointCountTotal: rawTilePoints.length,
    pointCountOutdoor: preparedOutdoorPoints.length,
    frameCountTotal: 0,
    frameIndex: null,
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

  const frames: PrecomputedSunlightTileArtifact["frames"] = [];
  const totalFrameEvaluations = preparedOutdoorPoints.length * samples.length;
  let completedFrameEvaluations = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    throwIfAborted(params.signal);
    const sampleDate = samples[sampleIndex];
    const sunnyMask = new Uint8Array(Math.ceil(preparedOutdoorPoints.length / 8));
    const sunnyMaskNoVegetation = new Uint8Array(Math.ceil(preparedOutdoorPoints.length / 8));
    const terrainMask = new Uint8Array(Math.ceil(preparedOutdoorPoints.length / 8));
    const buildingsMask = new Uint8Array(Math.ceil(preparedOutdoorPoints.length / 8));
    const vegetationMask = new Uint8Array(Math.ceil(preparedOutdoorPoints.length / 8));
    const horizonAngleDegByPoint: Array<number | null> = [];
    const buildingBlockerIdByPoint: Array<string | null> = [];
    const buildingBlockerDistanceMetersByPoint: Array<number | null> = [];
    const vegetationBlockerDistanceMetersByPoint: Array<number | null> = [];
    let sunnyCount = 0;
    let sunnyCountNoVegetation = 0;
    let localTime = "";

    for (let pointIndex = 0; pointIndex < preparedOutdoorPoints.length; pointIndex += 1) {
      throwIfAborted(params.signal);
      const point = preparedOutdoorPoints[pointIndex];
      const sample = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate: sampleDate,
        timeZone: params.timezone,
        horizonMask: point.horizonMask,
        buildingShadowEvaluator: point.buildingShadowEvaluator,
        vegetationShadowEvaluator: point.vegetationShadowEvaluator,
      });
      localTime = localTime || sample.localTime.slice(11, 16);
      horizonAngleDegByPoint.push(
        sample.horizonAngleDeg === null ? null : Math.round(sample.horizonAngleDeg * 1000) / 1000,
      );
      buildingBlockerIdByPoint.push(sample.buildingBlockerId);
      buildingBlockerDistanceMetersByPoint.push(
        sample.buildingBlockerDistanceMeters === null
          ? null
          : Math.round(sample.buildingBlockerDistanceMeters * 1000) / 1000,
      );
      vegetationBlockerDistanceMetersByPoint.push(
        sample.vegetationBlockerDistanceMeters === null
          ? null
          : Math.round(sample.vegetationBlockerDistanceMeters * 1000) / 1000,
      );

      const isSunnyNoVegetation =
        sample.aboveAstronomicalHorizon &&
        !sample.terrainBlocked &&
        !sample.buildingsBlocked;
      if (sample.terrainBlocked) {
        setMaskBit(terrainMask, pointIndex);
      }
      if (sample.buildingsBlocked) {
        setMaskBit(buildingsMask, pointIndex);
      }
      if (sample.vegetationBlocked) {
        setMaskBit(vegetationMask, pointIndex);
      }
      if (isSunnyNoVegetation) {
        setMaskBit(sunnyMaskNoVegetation, pointIndex);
        sunnyCountNoVegetation += 1;
      }
      if (sample.isSunny) {
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
        buildingBlockerDistanceMetersByPoint,
        vegetationBlockerDistanceMetersByPoint,
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
    });
  }

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
      algorithmVersion: params.algorithmVersion,
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
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
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
}) {
  const existing = await loadTileCached({
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tileId: params.tile.tileId,
  });
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
  return {
    artifact,
    layer: "MISS" as const,
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

  for (const tile of requiredTiles) {
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
        observerHeightMeters: 0,
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
        observerHeightMeters: 0,
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
        observerHeightMeters: 0,
        buildingHeightBiasMeters: 0,
      },
    },
  };
}
