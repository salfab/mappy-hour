import crypto from "node:crypto";
import fs from "node:fs/promises";

import type { ShadowCalibration } from "@/lib/sun/shadow-calibration";
import {
  RAW_BUILDINGS_MANIFEST_LAUSANNE_PATH,
  RAW_BUILDINGS_MANIFEST_NYON_PATH,
  RAW_HORIZON_DEM_MANIFEST_LAUSANNE_PATH,
  RAW_HORIZON_DEM_MANIFEST_NYON_PATH,
  RAW_TERRAIN_CH_MANIFEST_LAUSANNE_PATH,
  RAW_TERRAIN_CH_MANIFEST_NYON_PATH,
  RAW_VEGETATION_SURFACE_MANIFEST_LAUSANNE_PATH,
  RAW_VEGETATION_SURFACE_MANIFEST_NYON_PATH,
} from "@/lib/storage/data-paths";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";
import type { PrecomputedRegionName } from "./sunlight-cache";
import { TtlCache } from "./runtime-cache";

export const SUNLIGHT_CACHE_ALGORITHM_VERSION = "sunlight-cache-v2";
export const SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION = 2;

interface ManifestSummary {
  path: string;
  exists: boolean;
  generatedAt?: string;
  method?: string;
  collection?: string;
  source?: string;
  itemsFetched?: number;
  pagesFetched?: number;
  zipFilesProcessed?: number;
  downloadSummary?: unknown;
  counts?: unknown;
}

export interface SunlightModelVersion {
  modelVersionHash: string;
  algorithmVersion: string;
  artifactFormatVersion: number;
  inputs: {
    region: PrecomputedRegionName;
    calibration: ShadowCalibration;
    buildings: Record<string, unknown>;
    terrainManifest: ManifestSummary;
    vegetationManifest: ManifestSummary;
    horizonManifest: ManifestSummary;
  };
}

const manifestCache = new TtlCache<ManifestSummary>(5 * 60_000, 32);
const modelVersionCache = new TtlCache<SunlightModelVersion>(5 * 60_000, 32);

function manifestPathForRegion(region: PrecomputedRegionName, kind: "buildings" | "terrain" | "vegetation" | "horizon"): string {
  if (kind === "buildings") {
    return region === "lausanne"
      ? RAW_BUILDINGS_MANIFEST_LAUSANNE_PATH
      : RAW_BUILDINGS_MANIFEST_NYON_PATH;
  }
  if (kind === "terrain") {
    return region === "lausanne"
      ? RAW_TERRAIN_CH_MANIFEST_LAUSANNE_PATH
      : RAW_TERRAIN_CH_MANIFEST_NYON_PATH;
  }
  if (kind === "vegetation") {
    return region === "lausanne"
      ? RAW_VEGETATION_SURFACE_MANIFEST_LAUSANNE_PATH
      : RAW_VEGETATION_SURFACE_MANIFEST_NYON_PATH;
  }
  return region === "lausanne"
    ? RAW_HORIZON_DEM_MANIFEST_LAUSANNE_PATH
    : RAW_HORIZON_DEM_MANIFEST_NYON_PATH;
}

async function readManifestSummary(filePath: string): Promise<ManifestSummary> {
  const cached = manifestCache.get(filePath);
  if (cached) {
    return cached;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary: ManifestSummary = {
      path: filePath,
      exists: true,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : undefined,
      method: typeof parsed.method === "string" ? parsed.method : undefined,
      collection: typeof parsed.collection === "string" ? parsed.collection : undefined,
      source: typeof parsed.source === "string" ? parsed.source : undefined,
      itemsFetched: typeof parsed.itemsFetched === "number" ? parsed.itemsFetched : undefined,
      pagesFetched: typeof parsed.pagesFetched === "number" ? parsed.pagesFetched : undefined,
      zipFilesProcessed:
        typeof parsed.zipFilesProcessed === "number" ? parsed.zipFilesProcessed : undefined,
      downloadSummary: parsed.downloadSummary,
      counts: parsed.counts,
    };
    manifestCache.set(filePath, summary);
    return summary;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const summary: ManifestSummary = {
        path: filePath,
        exists: false,
      };
      manifestCache.set(filePath, summary);
      return summary;
    }
    throw error;
  }
}

export async function getSunlightModelVersion(
  region: PrecomputedRegionName,
  shadowCalibration: ShadowCalibration,
): Promise<SunlightModelVersion> {
  const cacheKey = JSON.stringify({ region, shadowCalibration });
  const cached = modelVersionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const [buildingsIndex, terrainManifest, vegetationManifest, horizonManifest] =
    await Promise.all([
      loadBuildingsObstacleIndex(),
      readManifestSummary(manifestPathForRegion(region, "terrain")),
      readManifestSummary(manifestPathForRegion(region, "vegetation")),
      readManifestSummary(manifestPathForRegion(region, "horizon")),
    ]);

  const payload = {
    artifactFormatVersion: SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
    algorithmVersion: SUNLIGHT_CACHE_ALGORITHM_VERSION,
    region,
    calibration: shadowCalibration,
    buildings: buildingsIndex
      ? {
          generatedAt: buildingsIndex.generatedAt,
          method: buildingsIndex.method,
          zipFilesProcessed: buildingsIndex.zipFilesProcessed,
          rawObstaclesCount: buildingsIndex.rawObstaclesCount,
          uniqueObstaclesCount: buildingsIndex.uniqueObstaclesCount,
        }
      : {
          exists: false,
        },
    terrainManifest,
    vegetationManifest,
    horizonManifest,
  };

  const modelVersion: SunlightModelVersion = {
    modelVersionHash: crypto
      .createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 16),
    algorithmVersion: SUNLIGHT_CACHE_ALGORITHM_VERSION,
    artifactFormatVersion: SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
    inputs: {
      region,
      calibration: shadowCalibration,
      buildings: payload.buildings,
      terrainManifest,
      vegetationManifest,
      horizonManifest,
    },
  };

  modelVersionCache.set(cacheKey, modelVersion);
  return modelVersion;
}
