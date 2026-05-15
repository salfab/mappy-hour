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
import { adaptiveHorizonSharingConfig } from "@/lib/sun/adaptive-horizon-sharing";
import { TERRAIN_SELECTION_STRATEGY } from "@/lib/terrain/swiss-terrain";
import type { PrecomputedRegionName } from "./sunlight-cache";
import { TtlCache } from "./runtime-cache";

export const SUNLIGHT_CACHE_ALGORITHM_VERSION = "sunlight-cache-v10";
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

/** Only the manifest fields that actually affect tile computation. Excludes
 *  download-time metadata (generatedAt, method, source, itemsFetched, …)
 *  which change every time the manifest is regenerated without touching the
 *  underlying data files. */
function manifestHashPayload(m: ManifestSummary): { exists: boolean; counts?: unknown } {
  return { exists: m.exists, counts: m.counts };
}

export interface SunlightModelVersion {
  /**
   * Full payload hash. Bumps on ANY input change. Drives the atlas cache
   * directory (`data/cache/sunlight/{region}/{modelVersionHash}/...`) and the
   * adaptive horizon sharing cache.
   */
  modelVersionHash: string;
  /**
   * Narrower hash, scoped to inputs that actually affect the per-tile zenith
   * indoor mask + per-point elevation produced by the preflight (see
   * `precompute-tile-grid-metadata.ts`). Excludes vegetation/horizon manifests
   * and the adaptive horizon sharing config — those don't influence the
   * zenith shadow render. Allows the heavy preflight (~4s/tile gpu-raster)
   * to be reused across atlas-only bumps (VHM re-ingest, algorithm bump on
   * the binary atlas format, etc.).
   *
   * Conservative on what it includes: buildings + terrain manifest + terrain
   * selection strategy + calibration + algorithm version. A change to any
   * of these legitimately invalidates the grid metadata.
   */
  gridMetadataHash: string;
  algorithmVersion: string;
  artifactFormatVersion: number;
  inputs: {
    region: PrecomputedRegionName;
    calibration: ShadowCalibration;
    buildings: Record<string, unknown>;
    terrainManifest: ManifestSummary;
    terrainSelectionStrategy: string;
    vegetationManifest: ManifestSummary;
    horizonManifest: ManifestSummary;
    adaptiveHorizonSharing: Record<string, unknown>;
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

  const buildingsHashPayload = buildingsIndex
    ? {
        indexVersion: buildingsIndex.indexVersion ?? 1,
        rawObstaclesCount: buildingsIndex.rawObstaclesCount,
        uniqueObstaclesCount: buildingsIndex.uniqueObstaclesCount,
        spatialGrid: buildingsIndex.spatialGrid
          ? {
              version: buildingsIndex.spatialGrid.version,
              cellSizeMeters: buildingsIndex.spatialGrid.cellSizeMeters,
              cellCount: buildingsIndex.spatialGrid.stats?.cellCount ?? null,
              maxObstaclesPerCell:
                buildingsIndex.spatialGrid.stats?.maxObstaclesPerCell ?? null,
            }
          : null,
      }
    : { exists: false };

  const payload = {
    artifactFormatVersion: SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
    algorithmVersion: SUNLIGHT_CACHE_ALGORITHM_VERSION,
    region,
    calibration: shadowCalibration,
    buildings: buildingsHashPayload,
    terrainManifest: manifestHashPayload(terrainManifest),
    terrainSelectionStrategy: TERRAIN_SELECTION_STRATEGY,
    vegetationManifest: manifestHashPayload(vegetationManifest),
    horizonManifest: manifestHashPayload(horizonManifest),
    adaptiveHorizonSharing: adaptiveHorizonSharingConfig,
  };

  const gridMetadataPayload = {
    algorithmVersion: SUNLIGHT_CACHE_ALGORITHM_VERSION,
    region,
    calibration: shadowCalibration,
    buildings: buildingsHashPayload,
    terrainManifest: manifestHashPayload(terrainManifest),
    terrainSelectionStrategy: TERRAIN_SELECTION_STRATEGY,
  };

  const modelVersion: SunlightModelVersion = {
    modelVersionHash: crypto
      .createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 16),
    gridMetadataHash: crypto
      .createHash("sha256")
      .update(JSON.stringify(gridMetadataPayload))
      .digest("hex")
      .slice(0, 16),
    algorithmVersion: SUNLIGHT_CACHE_ALGORITHM_VERSION,
    artifactFormatVersion: SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
    inputs: {
      region,
      calibration: shadowCalibration,
      buildings: buildingsIndex
        ? {
            generatedAt: buildingsIndex.generatedAt,
            method: buildingsIndex.method,
            ...buildingsHashPayload,
          }
        : buildingsHashPayload,
      terrainManifest,
      terrainSelectionStrategy: TERRAIN_SELECTION_STRATEGY,
      vegetationManifest,
      horizonManifest,
      adaptiveHorizonSharing: adaptiveHorizonSharingConfig,
    },
  };

  modelVersionCache.set(cacheKey, modelVersion);
  return modelVersion;
}
