import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  buildRegionTiles,
  loadPrecomputedSunlightTile,
  writePrecomputedSunlightManifest,
  writePrecomputedSunlightTile,
  type PrecomputedRegionName,
  type PrecomputedSunlightManifest,
} from "@/lib/precompute/sunlight-cache";
import { getSunlightModelVersion, SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION } from "@/lib/precompute/model-version";
import { computeSunlightTileArtifact } from "@/lib/precompute/sunlight-tile-service";
import { getSunlightCacheStorage } from "@/lib/precompute/sunlight-cache-storage";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";
import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";

export interface CacheAdminFilters {
  region?: PrecomputedRegionName;
  modelVersionHash?: string;
  startDate?: string;
  endDate?: string;
}

export type CacheRunSortField =
  | "date"
  | "generatedAt"
  | "sizeBytes"
  | "tileCount"
  | "failedTileCount"
  | "gridStepMeters"
  | "sampleEveryMinutes";

export interface CacheListOptions {
  sortBy?: CacheRunSortField;
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface CacheRunSummary {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileSizeMeters: number;
  tileCount: number;
  failedTileCount: number;
  complete: boolean;
  generatedAt: string;
  runDir: string;
  sizeBytes: number;
  fileCount: number;
}

export interface CacheRunsOverview {
  generatedAt: string;
  root: string;
  filters: CacheAdminFilters;
  pagination: {
    page: number;
    pageSize: number;
    totalRuns: number;
    totalPages: number;
    sortBy: CacheRunSortField;
    sortOrder: "asc" | "desc";
  };
  summary: {
    runCount: number;
    totalTiles: number;
    totalFailedTiles: number;
    completeRuns: number;
    totalSizeBytes: number;
    totalFiles: number;
  };
  runs: CacheRunSummary[];
}

export interface CacheVerifyResult {
  generatedAt: string;
  root: string;
  filters: CacheAdminFilters;
  manifestsMatched: number;
  tilesVerified: number;
  strictChecks: {
    expectedFrameCountChecks: number;
    expectedMaskSizeChecks: number;
    pointIndexChecks: number;
  };
  problems: string[];
}

export interface CachePurgeResult {
  generatedAt: string;
  root: string;
  filters: CacheAdminFilters;
  dryRun: boolean;
  runsMatched: number;
  removedRunDirs: string[];
  runs: CacheRunSummary[];
}

export interface CachePrecomputeRequest {
  region: PrecomputedRegionName;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  tileSizeMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  observerHeightMeters?: number;
  buildingHeightBiasMeters?: number;
}

export interface CachePrecomputeResult {
  generatedAt: string;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  totalTiles: number;
  totalDates: number;
  params: Omit<CachePrecomputeRequest, "observerHeightMeters" | "buildingHeightBiasMeters"> & {
    observerHeightMeters: number;
    buildingHeightBiasMeters: number;
  };
  dates: Array<{
    date: string;
    succeededTiles: number;
    failedTiles: number;
    complete: boolean;
    elapsedMs: number;
  }>;
}

function dateInRange(date: string, startDate?: string, endDate?: string): boolean {
  if (startDate && date < startDate) {
    return false;
  }
  if (endDate && date > endDate) {
    return false;
  }
  return true;
}

function addDays(dateInput: string, days: number): string {
  const date = new Date(`${dateInput}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date input: ${dateInput}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function manifestMatches(
  manifest: PrecomputedSunlightManifest,
  filters: CacheAdminFilters,
): boolean {
  if (filters.region && manifest.region !== filters.region) {
    return false;
  }
  if (
    filters.modelVersionHash &&
    manifest.modelVersionHash !== filters.modelVersionHash
  ) {
    return false;
  }
  return dateInRange(manifest.date, filters.startDate, filters.endDate);
}

async function findManifestFiles(rootPath: string): Promise<string[]> {
  const storage = getSunlightCacheStorage();
  const files = await storage.listFiles(rootPath);
  return files.filter((filePath) => path.basename(filePath) === "manifest.json");
}

async function loadManifestFromPath(
  filePath: string,
): Promise<PrecomputedSunlightManifest | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PrecomputedSunlightManifest;
  } catch {
    return null;
  }
}

function getRunDir(manifest: PrecomputedSunlightManifest): string {
  return path.dirname(
    path.join(
      CACHE_SUNLIGHT_DIR,
      manifest.region,
      manifest.modelVersionHash,
      `g${manifest.gridStepMeters}`,
      `m${manifest.sampleEveryMinutes}`,
      manifest.date,
      `t${manifest.startLocalTime.replace(":", "")}-${manifest.endLocalTime.replace(":", "")}`,
      "manifest.json",
    ),
  );
}

async function computeRunStorageStats(
  runDir: string,
): Promise<{ sizeBytes: number; fileCount: number }> {
  const storage = getSunlightCacheStorage();
  const files = await storage.listFiles(runDir);
  if (files.length === 0) {
    return {
      sizeBytes: 0,
      fileCount: 0,
    };
  }

  const stats = await Promise.all(
    files.map(async (filePath) => {
      const fileStat = await fs.stat(filePath);
      return fileStat.size;
    }),
  );

  return {
    sizeBytes: stats.reduce((total, size) => total + size, 0),
    fileCount: files.length,
  };
}

function compareRuns(
  left: CacheRunSummary,
  right: CacheRunSummary,
  sortBy: CacheRunSortField,
): number {
  if (sortBy === "date") {
    return `${left.date}|${left.region}|${left.modelVersionHash}`.localeCompare(
      `${right.date}|${right.region}|${right.modelVersionHash}`,
    );
  }
  if (sortBy === "generatedAt") {
    return left.generatedAt.localeCompare(right.generatedAt);
  }
  if (sortBy === "sizeBytes") {
    return left.sizeBytes - right.sizeBytes;
  }
  if (sortBy === "tileCount") {
    return left.tileCount - right.tileCount;
  }
  if (sortBy === "failedTileCount") {
    return left.failedTileCount - right.failedTileCount;
  }
  if (sortBy === "gridStepMeters") {
    return left.gridStepMeters - right.gridStepMeters;
  }
  return left.sampleEveryMinutes - right.sampleEveryMinutes;
}

async function listMatchingManifests(
  filters: CacheAdminFilters,
): Promise<PrecomputedSunlightManifest[]> {
  const manifestFiles = await findManifestFiles(CACHE_SUNLIGHT_DIR);
  const manifests = (
    await Promise.all(manifestFiles.map((filePath) => loadManifestFromPath(filePath)))
  ).filter((manifest): manifest is PrecomputedSunlightManifest => manifest !== null);

  return manifests
    .filter((manifest) => manifestMatches(manifest, filters))
    .sort((left, right) =>
      [
        left.region,
        left.date,
        left.startLocalTime,
        left.endLocalTime,
        left.gridStepMeters,
        left.sampleEveryMinutes,
        left.modelVersionHash,
      ]
        .join("|")
        .localeCompare(
          [
            right.region,
            right.date,
            right.startLocalTime,
            right.endLocalTime,
            right.gridStepMeters,
            right.sampleEveryMinutes,
            right.modelVersionHash,
          ].join("|"),
        ),
    );
}

async function toRunSummary(
  manifest: PrecomputedSunlightManifest,
): Promise<CacheRunSummary> {
  const runDir = getRunDir(manifest);
  const storageStats = await computeRunStorageStats(runDir);

  return {
    region: manifest.region,
    modelVersionHash: manifest.modelVersionHash,
    date: manifest.date,
    timezone: manifest.timezone,
    gridStepMeters: manifest.gridStepMeters,
    sampleEveryMinutes: manifest.sampleEveryMinutes,
    startLocalTime: manifest.startLocalTime,
    endLocalTime: manifest.endLocalTime,
    tileSizeMeters: manifest.tileSizeMeters,
    tileCount: manifest.tileIds.length,
    failedTileCount: manifest.failedTileIds.length,
    complete: manifest.complete,
    generatedAt: manifest.generatedAt,
    runDir,
    sizeBytes: storageStats.sizeBytes,
    fileCount: storageStats.fileCount,
  };
}

export async function listCacheRuns(
  filters: CacheAdminFilters = {},
  options: CacheListOptions = {},
): Promise<CacheRunsOverview> {
  const manifests = await listMatchingManifests(filters);
  const allRuns = await Promise.all(manifests.map((manifest) => toRunSummary(manifest)));

  const sortBy = options.sortBy ?? "date";
  const sortOrder = options.sortOrder ?? "desc";
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 200);
  const page = Math.max(options.page ?? 1, 1);
  const totalRuns = allRuns.length;
  const totalPages = Math.max(1, Math.ceil(totalRuns / pageSize));
  const boundedPage = Math.min(page, totalPages);

  const sortedRuns = [...allRuns].sort((left, right) => {
    const result = compareRuns(left, right, sortBy);
    return sortOrder === "asc" ? result : -result;
  });
  const startIndex = (boundedPage - 1) * pageSize;
  const runs = sortedRuns.slice(startIndex, startIndex + pageSize);

  return {
    generatedAt: new Date().toISOString(),
    root: CACHE_SUNLIGHT_DIR,
    filters,
    pagination: {
      page: boundedPage,
      pageSize,
      totalRuns,
      totalPages,
      sortBy,
      sortOrder,
    },
    summary: {
      runCount: allRuns.length,
      totalTiles: allRuns.reduce((total, run) => total + run.tileCount, 0),
      totalFailedTiles: allRuns.reduce(
        (total, run) => total + run.failedTileCount,
        0,
      ),
      completeRuns: allRuns.filter((run) => run.complete).length,
      totalSizeBytes: allRuns.reduce((total, run) => total + run.sizeBytes, 0),
      totalFiles: allRuns.reduce((total, run) => total + run.fileCount, 0),
    },
    runs,
  };
}

function expectedMaskByteLength(pointCount: number): number {
  return Math.ceil(pointCount / 8);
}

export async function verifyCacheRuns(
  filters: CacheAdminFilters = {},
): Promise<CacheVerifyResult> {
  const manifests = await listMatchingManifests(filters);
  const problems: string[] = [];
  let tilesVerified = 0;
  let expectedFrameCountChecks = 0;
  let expectedMaskSizeChecks = 0;
  let pointIndexChecks = 0;

  for (const manifest of manifests) {
    if (manifest.artifactFormatVersion !== SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION) {
      problems.push(
        `Manifest ${manifest.region}/${manifest.date} uses format ${manifest.artifactFormatVersion}, expected ${SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION}.`,
      );
      continue;
    }

    for (const tileId of manifest.tileIds) {
      const tile = await loadPrecomputedSunlightTile({
        region: manifest.region,
        modelVersionHash: manifest.modelVersionHash,
        date: manifest.date,
        gridStepMeters: manifest.gridStepMeters,
        sampleEveryMinutes: manifest.sampleEveryMinutes,
        startLocalTime: manifest.startLocalTime,
        endLocalTime: manifest.endLocalTime,
        tileId,
      });
      if (!tile) {
        problems.push(
          `Missing or incompatible tile ${tileId} for ${manifest.region}/${manifest.date}/${manifest.modelVersionHash}.`,
        );
        continue;
      }
      if (tile.tile.tileId !== tileId) {
        problems.push(
          `Tile id mismatch: manifest expected ${tileId}, artifact contains ${tile.tile.tileId}.`,
        );
      }
      if (tile.modelVersionHash !== manifest.modelVersionHash) {
        problems.push(
          `Tile ${tileId} has model version ${tile.modelVersionHash}, expected ${manifest.modelVersionHash}.`,
        );
      }
      if (tile.artifactFormatVersion !== manifest.artifactFormatVersion) {
        problems.push(
          `Tile ${tileId} has format ${tile.artifactFormatVersion}, expected ${manifest.artifactFormatVersion}.`,
        );
      }
      if (tile.frames.length === 0) {
        problems.push(`Tile ${tileId} has no frames.`);
      }

      const expectedFrames = tile.frames.length;
      expectedFrameCountChecks += 1;
      const outdoorPointCount = tile.points.filter((point) => point.outdoorIndex !== null).length;

      for (const frame of tile.frames) {
        if (frame.index < 0 || frame.index >= expectedFrames) {
          problems.push(
            `Tile ${tileId} frame index ${frame.index} is out of range [0, ${expectedFrames - 1}].`,
          );
        }

        const expectedMaskSize = expectedMaskByteLength(outdoorPointCount);
        const maskEntries: Array<{ name: string; base64: string }> = [
          { name: "sunMaskBase64", base64: frame.sunMaskBase64 },
          { name: "sunMaskNoVegetationBase64", base64: frame.sunMaskNoVegetationBase64 },
          { name: "terrainBlockedMaskBase64", base64: frame.terrainBlockedMaskBase64 },
          { name: "buildingsBlockedMaskBase64", base64: frame.buildingsBlockedMaskBase64 },
          { name: "vegetationBlockedMaskBase64", base64: frame.vegetationBlockedMaskBase64 },
        ];

        for (const maskEntry of maskEntries) {
          expectedMaskSizeChecks += 1;
          const byteLength = Buffer.from(maskEntry.base64, "base64").length;
          if (byteLength !== expectedMaskSize) {
            problems.push(
              `Tile ${tileId} frame ${frame.index} ${maskEntry.name} byteLength=${byteLength}, expected=${expectedMaskSize}.`,
            );
          }
        }

        if (frame.diagnostics.horizonAngleDegByPoint.length !== outdoorPointCount) {
          problems.push(
            `Tile ${tileId} frame ${frame.index} horizon diagnostics length mismatch (${frame.diagnostics.horizonAngleDegByPoint.length} vs ${outdoorPointCount}).`,
          );
        }
        if (frame.diagnostics.buildingBlockerIdByPoint.length !== outdoorPointCount) {
          problems.push(
            `Tile ${tileId} frame ${frame.index} building blocker id length mismatch (${frame.diagnostics.buildingBlockerIdByPoint.length} vs ${outdoorPointCount}).`,
          );
        }
      }

      const seenOutdoorIndexes = new Set<number>();
      for (const point of tile.points) {
        if (point.outdoorIndex === null) {
          continue;
        }
        pointIndexChecks += 1;
        if (point.outdoorIndex < 0 || point.outdoorIndex >= outdoorPointCount) {
          problems.push(
            `Tile ${tileId} has outdoorIndex ${point.outdoorIndex} outside [0, ${outdoorPointCount - 1}].`,
          );
        }
        if (seenOutdoorIndexes.has(point.outdoorIndex)) {
          problems.push(
            `Tile ${tileId} has duplicated outdoorIndex ${point.outdoorIndex}.`,
          );
        }
        seenOutdoorIndexes.add(point.outdoorIndex);
      }
      if (seenOutdoorIndexes.size !== outdoorPointCount) {
        problems.push(
          `Tile ${tileId} outdoor index cardinality mismatch (${seenOutdoorIndexes.size} vs ${outdoorPointCount}).`,
        );
      }

      tilesVerified += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    root: CACHE_SUNLIGHT_DIR,
    filters,
    manifestsMatched: manifests.length,
    tilesVerified,
    strictChecks: {
      expectedFrameCountChecks,
      expectedMaskSizeChecks,
      pointIndexChecks,
    },
    problems,
  };
}

export async function purgeCacheRuns(
  filters: CacheAdminFilters = {},
  options: { dryRun?: boolean } = {},
): Promise<CachePurgeResult> {
  const manifests = await listMatchingManifests(filters);
  const runs = await Promise.all(manifests.map((manifest) => toRunSummary(manifest)));
  const removedRunDirs: string[] = [];

  if (!options.dryRun) {
    const storage = getSunlightCacheStorage();
    for (const run of runs) {
      await storage.removePrefix(run.runDir);
      removedRunDirs.push(run.runDir);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    root: CACHE_SUNLIGHT_DIR,
    filters,
    dryRun: options.dryRun ?? false,
    runsMatched: runs.length,
    removedRunDirs,
    runs,
  };
}

export async function precomputeCacheRuns(
  request: CachePrecomputeRequest,
): Promise<CachePrecomputeResult> {
  const shadowCalibration = normalizeShadowCalibration({
    observerHeightMeters: request.observerHeightMeters,
    buildingHeightBiasMeters: request.buildingHeightBiasMeters,
  });
  const modelVersion = await getSunlightModelVersion(request.region, shadowCalibration);
  const tiles = buildRegionTiles(request.region, request.tileSizeMeters);
  const dates: CachePrecomputeResult["dates"] = [];

  for (let dayOffset = 0; dayOffset < request.days; dayOffset += 1) {
    const date = addDays(request.startDate, dayOffset);
    const startedAt = performance.now();
    const succeededTileIds: string[] = [];
    const failedTileIds: string[] = [];

    for (const tile of tiles) {
      try {
        const artifact = await computeSunlightTileArtifact({
          region: request.region,
          modelVersionHash: modelVersion.modelVersionHash,
          algorithmVersion: modelVersion.algorithmVersion,
          date,
          timezone: request.timezone,
          sampleEveryMinutes: request.sampleEveryMinutes,
          gridStepMeters: request.gridStepMeters,
          startLocalTime: request.startLocalTime,
          endLocalTime: request.endLocalTime,
          tile,
          shadowCalibration,
        });
        await writePrecomputedSunlightTile(artifact);
        succeededTileIds.push(tile.tileId);
      } catch {
        failedTileIds.push(tile.tileId);
      }
    }

    const manifest: PrecomputedSunlightManifest = {
      artifactFormatVersion: modelVersion.artifactFormatVersion,
      region: request.region,
      modelVersionHash: modelVersion.modelVersionHash,
      date,
      timezone: request.timezone,
      gridStepMeters: request.gridStepMeters,
      sampleEveryMinutes: request.sampleEveryMinutes,
      startLocalTime: request.startLocalTime,
      endLocalTime: request.endLocalTime,
      tileSizeMeters: request.tileSizeMeters,
      tileIds: succeededTileIds.sort(),
      failedTileIds: failedTileIds.sort(),
      bbox: {
        minLon: Math.min(...tiles.map((tile) => tile.bbox.minLon)),
        minLat: Math.min(...tiles.map((tile) => tile.bbox.minLat)),
        maxLon: Math.max(...tiles.map((tile) => tile.bbox.maxLon)),
        maxLat: Math.max(...tiles.map((tile) => tile.bbox.maxLat)),
      },
      generatedAt: new Date().toISOString(),
      complete: failedTileIds.length === 0 && succeededTileIds.length === tiles.length,
    };

    await writePrecomputedSunlightManifest(manifest);
    dates.push({
      date,
      succeededTiles: succeededTileIds.length,
      failedTiles: failedTileIds.length,
      complete: manifest.complete,
      elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    region: request.region,
    modelVersionHash: modelVersion.modelVersionHash,
    algorithmVersion: modelVersion.algorithmVersion,
    totalTiles: tiles.length,
    totalDates: request.days,
    params: {
      region: request.region,
      startDate: request.startDate,
      days: request.days,
      timezone: request.timezone,
      sampleEveryMinutes: request.sampleEveryMinutes,
      gridStepMeters: request.gridStepMeters,
      tileSizeMeters: request.tileSizeMeters,
      startLocalTime: request.startLocalTime,
      endLocalTime: request.endLocalTime,
      observerHeightMeters: shadowCalibration.observerHeightMeters,
      buildingHeightBiasMeters: shadowCalibration.buildingHeightBiasMeters,
    },
    dates,
  };
}
