import { promisify } from "node:util";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import path from "node:path";

import { LAUSANNE_CONFIG } from "@/lib/config/lausanne";
import { NYON_CONFIG } from "@/lib/config/nyon";
import { lv95ToWgs84, wgs84ToLv95 } from "@/lib/geo/projection";
import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";
import { getSunlightCacheStorage } from "./sunlight-cache-storage";
import { SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION } from "./model-version";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export type PrecomputedRegionName = "lausanne" | "nyon";

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
  sunMaskBase64: string;
  sunMaskNoVegetationBase64: string;
  terrainBlockedMaskBase64: string;
  buildingsBlockedMaskBase64: string;
  vegetationBlockedMaskBase64: string;
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
      observerHeightMeters: number;
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
  const targetPath = getPrecomputedSunlightTilePath({
    region: artifact.region,
    modelVersionHash: artifact.modelVersionHash,
    date: artifact.date,
    gridStepMeters: artifact.gridStepMeters,
    sampleEveryMinutes: artifact.sampleEveryMinutes,
    startLocalTime: artifact.startLocalTime,
    endLocalTime: artifact.endLocalTime,
    tileId: artifact.tile.tileId,
  });
  await writeCompressedJson(targetPath, artifact);
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

function getLv95BoundsForRegion(region: PrecomputedRegionName) {
  const bbox = getPrecomputedRegionBbox(region);
  const corners = [
    wgs84ToLv95(bbox.minLon, bbox.minLat),
    wgs84ToLv95(bbox.minLon, bbox.maxLat),
    wgs84ToLv95(bbox.maxLon, bbox.minLat),
    wgs84ToLv95(bbox.maxLon, bbox.maxLat),
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
      const southWest = lv95ToWgs84(minEasting, minNorthing);
      const northEast = lv95ToWgs84(maxEasting, maxNorthing);
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

      const wgs84 = lv95ToWgs84(easting, northing);
      if (!pointInBbox(wgs84.lon, wgs84.lat, tile.bbox)) {
        continue;
      }

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
