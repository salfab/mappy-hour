import fs from "node:fs/promises";
import path from "node:path";

import {
  loadPrecomputedSunlightTile,
  type PrecomputedRegionName,
  type PrecomputedSunlightManifest,
} from "@/lib/precompute/sunlight-cache";
import { getSunlightCacheStorage } from "@/lib/precompute/sunlight-cache-storage";
import { SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION } from "@/lib/precompute/model-version";
import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";

export interface CacheAdminFilters {
  region?: PrecomputedRegionName;
  modelVersionHash?: string;
  startDate?: string;
  endDate?: string;
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

function dateInRange(date: string, startDate?: string, endDate?: string): boolean {
  if (startDate && date < startDate) {
    return false;
  }
  if (endDate && date > endDate) {
    return false;
  }
  return true;
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
): Promise<CacheRunsOverview> {
  const manifests = await listMatchingManifests(filters);
  const runs = await Promise.all(manifests.map((manifest) => toRunSummary(manifest)));

  return {
    generatedAt: new Date().toISOString(),
    root: CACHE_SUNLIGHT_DIR,
    filters,
    summary: {
      runCount: runs.length,
      totalTiles: runs.reduce((total, run) => total + run.tileCount, 0),
      totalFailedTiles: runs.reduce(
        (total, run) => total + run.failedTileCount,
        0,
      ),
      completeRuns: runs.filter((run) => run.complete).length,
      totalSizeBytes: runs.reduce((total, run) => total + run.sizeBytes, 0),
      totalFiles: runs.reduce((total, run) => total + run.fileCount, 0),
    },
    runs,
  };
}

export async function verifyCacheRuns(
  filters: CacheAdminFilters = {},
): Promise<CacheVerifyResult> {
  const manifests = await listMatchingManifests(filters);
  const problems: string[] = [];
  let tilesVerified = 0;

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
      tilesVerified += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    root: CACHE_SUNLIGHT_DIR,
    filters,
    manifestsMatched: manifests.length,
    tilesVerified,
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
