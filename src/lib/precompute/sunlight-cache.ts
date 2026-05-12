import fs from "node:fs/promises";
import { promisify } from "node:util";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import path from "node:path";

import { LAUSANNE_CONFIG } from "@/lib/config/lausanne";
import { NYON_CONFIG } from "@/lib/config/nyon";
import { MORGES_CONFIG } from "@/lib/config/morges";
import { GENEVE_CONFIG } from "@/lib/config/geneve";
import { VEVEY_CONFIG } from "@/lib/config/vevey";
import { VEVEY_CITY_CONFIG } from "@/lib/config/vevey_city";
import { NEUCHATEL_CONFIG } from "@/lib/config/neuchatel";
import { lv95ToWgs84Precise, wgs84ToLv95Precise } from "@/lib/geo/projection";
import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";
import { getSunlightCacheStorage } from "./sunlight-cache-storage";
import { SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION } from "./model-version";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export type PrecomputedRegionName = "lausanne" | "nyon" | "morges" | "geneve" | "vevey" | "vevey_city" | "neuchatel";

export interface RegionBbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface RegionTileSpec {
  tileId: string;
  tileSizeMeters: number;
  minEasting: number;
  minNorthing: number;
  maxEasting: number;
  maxNorthing: number;
  bbox: RegionBbox;
}

export interface PrecomputedSunlightPoint {
  id: string;
  lat: number;
  lon: number;
  lv95Easting: number;
  lv95Northing: number;
  ix: number;
  iy: number;
  insideBuilding: boolean;
  indoorBuildingId: string | null;
  outdoorIndex: number | null;
  pointElevationMeters: number | null;
}

export interface PrecomputedSunlightFrameDiagnostics {
  horizonAngleDegByPoint: Array<number | null>;
  buildingBlockerIdByPoint: Array<string | null>;
  buildingBlockerDistanceMetersByPoint: Array<number | null>;
  vegetationBlockerDistanceMetersByPoint: Array<number | null>;
}

export interface PrecomputedSunlightFrame {
  index: number;
  localTime: string;
  utcTime: string;
  sunnyCount: number;
  sunnyCountNoVegetation: number;
  sunMask: Uint8Array;
  sunMaskNoVegetation: Uint8Array;
  terrainBlockedMask: Uint8Array;
  buildingsBlockedMask: Uint8Array;
  vegetationBlockedMask: Uint8Array;
  diagnostics: PrecomputedSunlightFrameDiagnostics;
}

export interface PrecomputedSunlightTileArtifact {
  artifactFormatVersion: number;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: RegionTileSpec;
  points: PrecomputedSunlightPoint[];
  frames: PrecomputedSunlightFrame[];
  model: {
    terrainHorizonMethod: string;
    buildingsShadowMethod: string;
    vegetationShadowMethod: string;
    algorithmVersion: string;
    shadowCalibration: {
      buildingHeightBiasMeters: number;
    };
  };
  warnings: string[];
  stats: {
    gridPointCount: number;
    pointCount: number;
    indoorPointsExcluded: number;
    pointsWithElevation: number;
    pointsWithoutElevation: number;
    totalEvaluations: number;
    elapsedMs: number;
  };
}

export interface PrecomputedSunlightManifest {
  artifactFormatVersion: number;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileSizeMeters: number;
  tileIds: string[];
  failedTileIds: string[];
  bbox: RegionBbox;
  generatedAt: string;
  complete: boolean;
}

const REGION_BBOXES: Record<PrecomputedRegionName, RegionBbox> = {
  lausanne: {
    minLon: LAUSANNE_CONFIG.localBbox[0],
    minLat: LAUSANNE_CONFIG.localBbox[1],
    maxLon: LAUSANNE_CONFIG.localBbox[2],
    maxLat: LAUSANNE_CONFIG.localBbox[3],
  },
  nyon: {
    minLon: NYON_CONFIG.localBbox[0],
    minLat: NYON_CONFIG.localBbox[1],
    maxLon: NYON_CONFIG.localBbox[2],
    maxLat: NYON_CONFIG.localBbox[3],
  },
  morges: {
    minLon: MORGES_CONFIG.localBbox[0],
    minLat: MORGES_CONFIG.localBbox[1],
    maxLon: MORGES_CONFIG.localBbox[2],
    maxLat: MORGES_CONFIG.localBbox[3],
  },
  geneve: {
    minLon: GENEVE_CONFIG.localBbox[0],
    minLat: GENEVE_CONFIG.localBbox[1],
    maxLon: GENEVE_CONFIG.localBbox[2],
    maxLat: GENEVE_CONFIG.localBbox[3],
  },
  vevey: {
    minLon: VEVEY_CONFIG.localBbox[0],
    minLat: VEVEY_CONFIG.localBbox[1],
    maxLon: VEVEY_CONFIG.localBbox[2],
    maxLat: VEVEY_CONFIG.localBbox[3],
  },
  vevey_city: {
    minLon: VEVEY_CITY_CONFIG.localBbox[0],
    minLat: VEVEY_CITY_CONFIG.localBbox[1],
    maxLon: VEVEY_CITY_CONFIG.localBbox[2],
    maxLat: VEVEY_CITY_CONFIG.localBbox[3],
  },
  neuchatel: {
    minLon: NEUCHATEL_CONFIG.localBbox[0],
    minLat: NEUCHATEL_CONFIG.localBbox[1],
    maxLon: NEUCHATEL_CONFIG.localBbox[2],
    maxLat: NEUCHATEL_CONFIG.localBbox[3],
  },
};

export function getPrecomputedRegionBbox(region: PrecomputedRegionName): RegionBbox {
  return REGION_BBOXES[region];
}

export function bboxContains(container: RegionBbox, inner: RegionBbox): boolean {
  return (
    container.minLon <= inner.minLon &&
    container.minLat <= inner.minLat &&
    container.maxLon >= inner.maxLon &&
    container.maxLat >= inner.maxLat
  );
}

/**
 * Scan the cache directory to find an existing modelVersionHash and time window
 * for this region, without needing to load the GPU backend or compute the hash.
 * Returns the hash + the actual startLocalTime/endLocalTime found in cache.
 */
/**
 * Returns ALL cached model version hash candidates for the given region,
 * ordered by quality (most complete precompute first):
 *
 * 1. Hashes that have the exact requested date in m15 (primary match).
 * 2. All other hashes sorted by m15 date count descending (atlas fallback).
 *
 * Callers iterate the array and try each hash in turn — stopping as soon
 * as tiles are found for the requested bbox. An empty array means no cache.
 */
export async function findCachedModelVersionHash(params: {
  region: PrecomputedRegionName;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): Promise<Array<{ modelVersionHash: string; timeWindows: Array<{ startLocalTime: string; endLocalTime: string }> }>> {
  const regionDir = path.join(CACHE_SUNLIGHT_DIR, params.region);
  let hashEntries: string[];
  try {
    hashEntries = await fs.readdir(regionDir);
  } catch {
    return [];
  }
  const gridSamplePath = path.join(`g${params.gridStepMeters}`, `m${params.sampleEveryMinutes}`);

  type Candidate = { modelVersionHash: string; timeWindows: Array<{ startLocalTime: string; endLocalTime: string }>; dateCount: number };
  const primary: Candidate[] = [];
  const fallback: Candidate[] = [];

  for (const hash of hashEntries) {
    const gridDir = path.join(regionDir, hash, gridSamplePath);
    let dates: string[];
    try {
      dates = await fs.readdir(gridDir);
    } catch {
      // gridSamplePath absent (e.g. atlas-only deploy has no m{sample}/ dir) —
      // don't skip: fall through so dateCount stays 0 and the atlas check runs.
      dates = [];
    }

    let dateCount = 0;
    let exactTimeWindows: Array<{ startLocalTime: string; endLocalTime: string }> = [];
    let firstTimeWindows: Array<{ startLocalTime: string; endLocalTime: string }> = [];

    for (const d of dates) {
      const dateDir = path.join(gridDir, d);
      try {
        const twEntries = await fs.readdir(dateDir);
        for (const tw of twEntries) {
          const match = /^t(\d{4})-(\d{4})$/.exec(tw);
          if (!match) continue;
          const parsed = {
            startLocalTime: `${match[1].slice(0, 2)}:${match[1].slice(2)}`,
            endLocalTime: `${match[2].slice(0, 2)}:${match[2].slice(2)}`,
          };
          dateCount++;
          if (d === params.date) exactTimeWindows.push(parsed);
          if (firstTimeWindows.length === 0) firstTimeWindows.push(parsed);
        }
      } catch { /* unreadable date dir */ }
    }

    if (exactTimeWindows.length > 0) {
      primary.push({ modelVersionHash: hash, timeWindows: exactTimeWindows, dateCount });
    } else if (dateCount > 0) {
      fallback.push({ modelVersionHash: hash, timeWindows: firstTimeWindows, dateCount });
    } else {
      // No m{sample} tiles — check for atlas-format files (g{step}/atlas/r{res}/).
      // Atlas is date-agnostic, so use the requested time window as a stand-in.
      const ATLAS_RESOLUTIONS = ["0.5", "0.75", "1"] as const;
      let hasAtlas = false;
      for (const res of ATLAS_RESOLUTIONS) {
        const atlasDir = path.join(regionDir, hash, `g${params.gridStepMeters}`, "atlas", `r${res}`);
        try {
          const entries = await fs.readdir(atlasDir);
          if (entries.some(isAtlasCacheFileName)) {
            hasAtlas = true;
            break;
          }
        } catch { /* directory absent */ }
      }
      if (hasAtlas) {
        fallback.push({
          modelVersionHash: hash,
          timeWindows: [{ startLocalTime: params.startLocalTime, endLocalTime: params.endLocalTime }],
          dateCount: 1,
        });
      }
    }
  }

  // Primary: sort by dateCount desc (most complete first)
  primary.sort((a, b) => b.dateCount - a.dateCount);
  // Fallback: same sort; callers use atlas which is date-agnostic
  fallback.sort((a, b) => b.dateCount - a.dateCount);

  return [...primary, ...fallback].map(({ modelVersionHash, timeWindows }) => ({ modelVersionHash, timeWindows }));
}

function isAtlasCacheFileName(fileName: string): boolean {
  return (
    fileName.endsWith(".atlas.bin.gz") ||
    fileName.endsWith(".atlas.shards.json") ||
    fileName.endsWith(".atlas.base.bin.zst") ||
    /^.+\.atlas\.shard-\d+\.bin\.zst$/.test(fileName)
  );
}

function createCacheRunKey(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): string {
  return path.join(
    CACHE_SUNLIGHT_DIR,
    params.region,
    params.modelVersionHash,
    `g${params.gridStepMeters}`,
    `m${params.sampleEveryMinutes}`,
    params.date,
    `t${params.startLocalTime.replace(":", "")}-${params.endLocalTime.replace(":", "")}`,
  );
}

export function getPrecomputedSunlightManifestPath(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): string {
  return path.join(createCacheRunKey(params), "manifest.json");
}

export function getPrecomputedSunlightTilePath(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileId: string;
}): string {
  return path.join(createCacheRunKey(params), "tiles", `${params.tileId}.json.gz`);
}

async function readCompressedJson<T>(filePath: string): Promise<T> {
  const storage = getSunlightCacheStorage();
  const compressed = await storage.readBuffer(filePath);
  const jsonBuffer = await gunzip(compressed);
  return JSON.parse(jsonBuffer.toString("utf8")) as T;
}

async function writeCompressedJson<T>(filePath: string, value: T): Promise<void> {
  const storage = getSunlightCacheStorage();
  const compressed = await gzip(Buffer.from(JSON.stringify(value)));
  await storage.writeBuffer(filePath, Buffer.from(compressed));
}

export async function writePrecomputedSunlightManifest(
  manifest: PrecomputedSunlightManifest,
): Promise<void> {
  const storage = getSunlightCacheStorage();
  const targetPath = getPrecomputedSunlightManifestPath({
    region: manifest.region,
    modelVersionHash: manifest.modelVersionHash,
    date: manifest.date,
    gridStepMeters: manifest.gridStepMeters,
    sampleEveryMinutes: manifest.sampleEveryMinutes,
    startLocalTime: manifest.startLocalTime,
    endLocalTime: manifest.endLocalTime,
  });
  await storage.writeText(targetPath, JSON.stringify(manifest, null, 2));
}

export async function writePrecomputedSunlightTile(
  artifact: PrecomputedSunlightTileArtifact,
): Promise<void> {
  // Dynamic import to avoid a module cycle (sunlight-cache-binary imports
  // type PrecomputedSunlightTileArtifact from this file).
  const { writePrecomputedSunlightTileBinary } = await import(
    "./sunlight-cache-binary"
  );
  await writePrecomputedSunlightTileBinary(artifact);
}

export async function loadPrecomputedSunlightManifest(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): Promise<PrecomputedSunlightManifest | null> {
  const storage = getSunlightCacheStorage();
  const targetPath = getPrecomputedSunlightManifestPath(params);
  try {
    const raw = await storage.readText(targetPath);
    const parsed = JSON.parse(raw) as PrecomputedSunlightManifest;
    if (parsed.artifactFormatVersion !== SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION) {
      return null;
    }
    if (parsed.modelVersionHash !== params.modelVersionHash) {
      return null;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadPrecomputedSunlightTile(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileId: string;
}): Promise<PrecomputedSunlightTileArtifact | null> {
  // Prefer the binary format when available; reconstruct the legacy shape
  // for callers that still expect object-graph points/frames (admin tools,
  // tests, non-cache-only precompute flow). The cache-only stream reads
  // binary directly and never comes through this function.
  const {
    loadPrecomputedSunlightTileBinary,
    binaryTileToLegacyArtifact,
  } = await import("./sunlight-cache-binary");
  const binary = await loadPrecomputedSunlightTileBinary(params);
  if (binary) {
    if (
      binary.meta.artifactFormatVersion !== SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION
    ) {
      return null;
    }
    if (binary.meta.modelVersionHash !== params.modelVersionHash) {
      return null;
    }
    return binaryTileToLegacyArtifact(binary);
  }

  const targetPath = getPrecomputedSunlightTilePath(params);
  try {
    const parsed = await readCompressedJson<PrecomputedSunlightTileArtifact>(targetPath);
    if (parsed.artifactFormatVersion !== SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION) {
      return null;
    }
    if (parsed.modelVersionHash !== params.modelVersionHash) {
      return null;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * List tile IDs already cached for a given cache run (date + params).
 * Uses a single readdir instead of per-tile gunzip+parse — ~1000× faster
 * for skip-existing checks.
 */
export async function listCachedTileIds(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): Promise<Set<string>> {
  const tilesDir = path.join(createCacheRunKey(params), "tiles");
  try {
    const entries = await fs.readdir(tilesDir);
    const tileIds = new Set<string>();
    for (const entry of entries) {
      // Precompute now writes .tile.bin.gz; legacy cache still has .json.gz.
      // Both count as "already computed" for skip-existing.
      if (entry.endsWith(".tile.bin.gz")) {
        tileIds.add(entry.slice(0, -".tile.bin.gz".length));
      } else if (entry.endsWith(".json.gz")) {
        tileIds.add(entry.slice(0, -".json.gz".length));
      }
    }
    return tileIds;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

function getLv95BoundsForRegion(region: PrecomputedRegionName) {
  const bbox = getPrecomputedRegionBbox(region);
  const corners = [
    wgs84ToLv95Precise(bbox.minLon, bbox.minLat),
    wgs84ToLv95Precise(bbox.minLon, bbox.maxLat),
    wgs84ToLv95Precise(bbox.maxLon, bbox.minLat),
    wgs84ToLv95Precise(bbox.maxLon, bbox.maxLat),
  ];

  return {
    minEasting: Math.min(...corners.map((corner) => corner.easting)),
    maxEasting: Math.max(...corners.map((corner) => corner.easting)),
    minNorthing: Math.min(...corners.map((corner) => corner.northing)),
    maxNorthing: Math.max(...corners.map((corner) => corner.northing)),
  };
}

export function buildRegionTiles(
  region: PrecomputedRegionName,
  tileSizeMeters: number,
): RegionTileSpec[] {
  const regionBbox = getPrecomputedRegionBbox(region);
  const bounds = getLv95BoundsForRegion(region);
  const alignedMinEasting =
    Math.floor(bounds.minEasting / tileSizeMeters) * tileSizeMeters;
  const alignedMaxEasting =
    Math.ceil(bounds.maxEasting / tileSizeMeters) * tileSizeMeters;
  const alignedMinNorthing =
    Math.floor(bounds.minNorthing / tileSizeMeters) * tileSizeMeters;
  const alignedMaxNorthing =
    Math.ceil(bounds.maxNorthing / tileSizeMeters) * tileSizeMeters;
  const tiles: RegionTileSpec[] = [];

  for (
    let minNorthing = alignedMinNorthing;
    minNorthing < alignedMaxNorthing;
    minNorthing += tileSizeMeters
  ) {
    for (
      let minEasting = alignedMinEasting;
      minEasting < alignedMaxEasting;
      minEasting += tileSizeMeters
    ) {
      const maxEasting = minEasting + tileSizeMeters;
      const maxNorthing = minNorthing + tileSizeMeters;
      const southWest = lv95ToWgs84Precise(minEasting, minNorthing);
      const northEast = lv95ToWgs84Precise(maxEasting, maxNorthing);
      const bbox = {
        minLon: Math.min(southWest.lon, northEast.lon),
        minLat: Math.min(southWest.lat, northEast.lat),
        maxLon: Math.max(southWest.lon, northEast.lon),
        maxLat: Math.max(southWest.lat, northEast.lat),
      };

      if (!bboxIntersects(regionBbox, bbox)) {
        continue;
      }

      tiles.push({
        tileId: `e${Math.round(minEasting)}_n${Math.round(minNorthing)}_s${tileSizeMeters}`,
        tileSizeMeters,
        minEasting,
        minNorthing,
        maxEasting,
        maxNorthing,
        bbox,
      });
    }
  }

  return tiles;
}

export function buildTilePoints(tile: RegionTileSpec, gridStepMeters: number) {
  const points: Array<Omit<PrecomputedSunlightPoint, "insideBuilding" | "indoorBuildingId" | "outdoorIndex">> = [];
  const startIx = Math.floor(tile.minEasting / gridStepMeters);
  const endIxExclusive = Math.ceil(tile.maxEasting / gridStepMeters);
  const startIy = Math.floor(tile.minNorthing / gridStepMeters);
  const endIyExclusive = Math.ceil(tile.maxNorthing / gridStepMeters);

  for (let iy = startIy; iy < endIyExclusive; iy += 1) {
    for (let ix = startIx; ix < endIxExclusive; ix += 1) {
      const easting = ix * gridStepMeters + gridStepMeters / 2;
      const northing = iy * gridStepMeters + gridStepMeters / 2;
      if (
        easting < tile.minEasting ||
        easting >= tile.maxEasting ||
        northing < tile.minNorthing ||
        northing >= tile.maxNorthing
      ) {
        continue;
      }

      // Swisstopo rigorous algorithm: sub-mm delta vs proj4, 6.2x faster.
      // See ADR-0014 and scripts/diag/bench-lv95-3algos.ts.
      // LV95 bounds check above is sufficient — no WGS84 bbox filter needed.
      const wgs84 = lv95ToWgs84Precise(easting, northing);

      points.push({
        id: `ix${ix}-iy${iy}`,
        lat: Math.round(wgs84.lat * 1_000_000) / 1_000_000,
        lon: Math.round(wgs84.lon * 1_000_000) / 1_000_000,
        lv95Easting: Math.round(easting * 1000) / 1000,
        lv95Northing: Math.round(northing * 1000) / 1000,
        ix,
        iy,
        pointElevationMeters: null,
      });
    }
  }

  return points;
}

export function pointInBbox(lon: number, lat: number, bbox: RegionBbox): boolean {
  return (
    lon >= bbox.minLon &&
    lon <= bbox.maxLon &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  );
}

export function bboxIntersects(left: RegionBbox, right: RegionBbox): boolean {
  return !(
    left.maxLon < right.minLon ||
    left.minLon > right.maxLon ||
    left.maxLat < right.minLat ||
    left.minLat > right.maxLat
  );
}

export function getIntersectingTileIds(params: {
  region: PrecomputedRegionName;
  tileSizeMeters: number;
  bbox: RegionBbox;
}): string[] {
  return buildRegionTiles(params.region, params.tileSizeMeters)
    .filter((tile) => bboxIntersects(tile.bbox, params.bbox))
    .map((tile) => tile.tileId);
}

export function decodeBase64Bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export function isMaskBitSet(mask: Uint8Array, index: number): boolean {
  return ((mask[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

export function setMaskBit(mask: Uint8Array, index: number): void {
  mask[index >> 3] |= 1 << (index & 7);
}
