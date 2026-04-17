import fs from "node:fs/promises";
import path from "node:path";

import { fromFile } from "geotiff";

import { RAW_VEGETATION_SURFACE_DIR } from "@/lib/storage/data-paths";

type TypedRaster = Float32Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

interface VegetationSurfaceTileMetadata {
  filePath: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface VegetationSurfaceTile extends VegetationSurfaceTileMetadata {
  width: number;
  height: number;
  nodata: number | null;
  raster: TypedRaster;
}

export interface VegetationShadowResult {
  blocked: boolean;
  blockerDistanceMeters: number | null;
  blockerAltitudeAngleDeg: number | null;
  blockerSurfaceElevationMeters: number | null;
  blockerClearanceMeters: number | null;
  checkedSamplesCount: number;
}

export interface VegetationShadowEvaluatorInput {
  azimuthDeg: number;
  altitudeDeg: number;
}

export interface VegetationShadowEvaluator {
  (sample: VegetationShadowEvaluatorInput): VegetationShadowResult;
}

const METHOD = "swisssurface3d-raster-step-ray-v1";
const DEFAULT_MAX_DISTANCE_METERS = 120;
const DEFAULT_STEP_METERS = 2;
const DEFAULT_MIN_CLEARANCE_METERS = 4;
const VEGETATION_TILE_SIZE_METERS = 1000;
export const DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS =
  DEFAULT_MAX_DISTANCE_METERS;

let vegetationTileMetadataCachePromise:
  | Promise<VegetationSurfaceTileMetadata[] | null>
  | null = null;
const vegetationTileRasterCache = new Map<
  string,
  Promise<VegetationSurfaceTile>
>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function closeGeoTiff(tiff: Awaited<ReturnType<typeof fromFile>>): Promise<void> {
  const closeFn = (tiff as { close?: () => false | Promise<void> }).close;
  if (typeof closeFn === "function") {
    await closeFn.call(tiff);
  }
}

function valueIsNoData(value: number, nodata: number | null): boolean {
  if (nodata === null) {
    return false;
  }
  return Math.abs(value - nodata) < 1e-6;
}

function boundsIntersect(
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  },
  tile: VegetationSurfaceTileMetadata,
): boolean {
  return !(
    tile.maxX < bounds.minX ||
    tile.minX > bounds.maxX ||
    tile.maxY < bounds.minY ||
    tile.minY > bounds.maxY
  );
}

function parseTileBoundsFromFilename(
  filePath: string,
): Pick<VegetationSurfaceTileMetadata, "minX" | "minY" | "maxX" | "maxY"> | null {
  const fileName = path.basename(filePath);
  // Match either the original SwissSURFACE3D naming
  //   swisssurface3d-raster_2019_2502-1141_0.5_2056_5728.tif
  // or the VHM pre-composed naming
  //   swisssurface3d-raster_vhm_2502-1141.tif
  const match =
    /_(\d+)-(\d+)_0(?:\.0|\.5)?_2056_5728\.tif$/i.exec(fileName) ??
    /_vhm_(\d+)-(\d+)\.tif$/i.exec(fileName);
  if (!match) {
    return null;
  }

  const tileEastingKm = Number(match[1]);
  const tileNorthingKm = Number(match[2]);
  if (!Number.isFinite(tileEastingKm) || !Number.isFinite(tileNorthingKm)) {
    return null;
  }

  const minX = tileEastingKm * 1000;
  const minY = tileNorthingKm * 1000;
  return {
    minX,
    minY,
    maxX: minX + VEGETATION_TILE_SIZE_METERS,
    maxY: minY + VEGETATION_TILE_SIZE_METERS,
  };
}

function isVhmTile(filePath: string): boolean {
  return /_vhm_/i.test(path.basename(filePath));
}

async function listTifsRecursively(rootDirectory: string): Promise<string[]> {
  const stack = [rootDirectory];
  const result: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".tif")) {
        result.push(fullPath);
      }
    }
  }

  result.sort();
  return result;
}

async function loadVegetationTileMetadata(): Promise<
  VegetationSurfaceTileMetadata[] | null
> {
  if (vegetationTileMetadataCachePromise) {
    const cached = await vegetationTileMetadataCachePromise;
    if (cached) {
      return cached;
    }
    // Retry on next call when previous attempt found no data.
    vegetationTileMetadataCachePromise = null;
  }

  const loadPromise = (async () => {
    try {
      await fs.access(RAW_VEGETATION_SURFACE_DIR);
    } catch {
      return null;
    }

    const tifFiles = await listTifsRecursively(RAW_VEGETATION_SURFACE_DIR);
    if (tifFiles.length === 0) {
      return null;
    }

    const metadata: VegetationSurfaceTileMetadata[] = [];
    for (const filePath of tifFiles) {
      const parsedBounds = parseTileBoundsFromFilename(filePath);
      if (parsedBounds) {
        metadata.push({
          filePath,
          ...parsedBounds,
        });
        continue;
      }

      // Fallback when filename doesn't follow expected swisssurface3d pattern.
      const tiff = await fromFile(filePath);
      try {
        const image = await tiff.getImage();
        const bbox = image.getBoundingBox();
        metadata.push({
          filePath,
          minX: bbox[0],
          minY: bbox[1],
          maxX: bbox[2],
          maxY: bbox[3],
        });
      } finally {
        await closeGeoTiff(tiff);
      }
    }

    // Deduplicate by tile key (minX-minY in km). When both the legacy DSM and
    // the pre-composed VHM are present for the same tile, prefer the VHM: it
    // has buildings masked out, giving a cleaner vegetation-only ray-march.
    const byKey = new Map<string, VegetationSurfaceTileMetadata>();
    for (const entry of metadata) {
      const key = `${Math.round(entry.minX / 1000)}-${Math.round(entry.minY / 1000)}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, entry);
      } else if (isVhmTile(entry.filePath) && !isVhmTile(existing.filePath)) {
        byKey.set(key, entry); // VHM wins over DSM
      }
    }
    return Array.from(byKey.values());
  })();
  vegetationTileMetadataCachePromise = loadPromise;

  const loaded = await loadPromise;
  if (loaded === null) {
    // Do not keep a permanent null cache to allow late ingestion without restart.
    vegetationTileMetadataCachePromise = null;
  }

  return loaded;
}

async function loadVegetationTileRaster(
  metadata: VegetationSurfaceTileMetadata,
): Promise<VegetationSurfaceTile> {
  const cachedPromise = vegetationTileRasterCache.get(metadata.filePath);
  if (cachedPromise) {
    return cachedPromise;
  }

  const rasterPromise = (async () => {
    const tiff = await fromFile(metadata.filePath);
    try {
      const image = await tiff.getImage();
      const raster = (await image.readRasters({
        interleave: true,
        pool: null,
      })) as TypedRaster;
      const noDataRaw = image.getGDALNoData();
      const noDataParsed =
        noDataRaw === null || noDataRaw === undefined
          ? null
          : Number.parseFloat(String(noDataRaw));

      return {
        ...metadata,
        width: image.getWidth(),
        height: image.getHeight(),
        nodata: Number.isFinite(noDataParsed) ? noDataParsed : null,
        raster,
      };
    } finally {
      await closeGeoTiff(tiff);
    }
  })();

  vegetationTileRasterCache.set(metadata.filePath, rasterPromise);
  return rasterPromise;
}

async function loadVegetationSurfaceTilesInBounds(bounds: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): Promise<VegetationSurfaceTile[] | null> {
  const metadata = await loadVegetationTileMetadata();
  if (!metadata || metadata.length === 0) {
    return null;
  }

  const selectedMetadata = metadata.filter((tile) => boundsIntersect(bounds, tile));
  if (selectedMetadata.length === 0) {
    return [];
  }

  return Promise.all(selectedMetadata.map((tile) => loadVegetationTileRaster(tile)));
}

export async function loadVegetationSurfaceTilesForBounds(bounds: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): Promise<VegetationSurfaceTile[] | null> {
  return loadVegetationSurfaceTilesInBounds(bounds);
}

export async function loadVegetationSurfaceTiles(): Promise<
  VegetationSurfaceTile[] | null
> {
  const metadata = await loadVegetationTileMetadata();
  if (!metadata || metadata.length === 0) {
    return null;
  }

  return Promise.all(metadata.map((tile) => loadVegetationTileRaster(tile)));
}

export async function loadVegetationSurfaceTilesForPoint(
  pointX: number,
  pointY: number,
  maxDistanceMeters = DEFAULT_MAX_DISTANCE_METERS,
): Promise<VegetationSurfaceTile[] | null> {
  return loadVegetationSurfaceTilesInBounds({
    minX: pointX - maxDistanceMeters,
    maxX: pointX + maxDistanceMeters,
    minY: pointY - maxDistanceMeters,
    maxY: pointY + maxDistanceMeters,
  });
}

function sampleSurfaceElevationLv95(
  tiles: VegetationSurfaceTile[],
  easting: number,
  northing: number,
): number | null {
  for (const tile of tiles) {
    if (
      easting < tile.minX ||
      easting > tile.maxX ||
      northing < tile.minY ||
      northing > tile.maxY
    ) {
      continue;
    }

    const xRatio = (easting - tile.minX) / (tile.maxX - tile.minX);
    const yRatio = (tile.maxY - northing) / (tile.maxY - tile.minY);
    const x = clamp(Math.floor(xRatio * tile.width), 0, tile.width - 1);
    const y = clamp(Math.floor(yRatio * tile.height), 0, tile.height - 1);
    const index = y * tile.width + x;
    const value = Number(tile.raster[index]);

    if (!Number.isFinite(value) || valueIsNoData(value, tile.nodata)) {
      return null;
    }
    return value;
  }

  return null;
}

function emptyVegetationShadowResult(checkedSamplesCount = 0): VegetationShadowResult {
  return {
    blocked: false,
    blockerDistanceMeters: null,
    blockerAltitudeAngleDeg: null,
    blockerSurfaceElevationMeters: null,
    blockerClearanceMeters: null,
    checkedSamplesCount,
  };
}

export function createVegetationShadowEvaluator(params: {
  tiles: VegetationSurfaceTile[];
  pointX: number;
  pointY: number;
  pointElevation: number;
  maxDistanceMeters?: number;
  stepMeters?: number;
  minClearanceMeters?: number;
}): VegetationShadowEvaluator {
  const maxDistanceMeters = params.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE_METERS;
  const stepMeters = params.stepMeters ?? DEFAULT_STEP_METERS;
  const minClearanceMeters = params.minClearanceMeters ?? DEFAULT_MIN_CLEARANCE_METERS;
  const pointX = params.pointX;
  const pointY = params.pointY;
  const pointElevation = params.pointElevation;

  // ── Pre-filter to candidate tiles within maxDistanceMeters of the point ─
  // The ray-march never reaches further than maxDistanceMeters from the
  // point. Tiles outside that radius can never contribute to any sample.
  // For most outdoor points in dense urban contexts, this leaves 0-2 tiles
  // out of potentially many loaded for the whole bbox.
  const candidateTiles: VegetationSurfaceTile[] = [];
  for (const tile of params.tiles) {
    if (
      pointX + maxDistanceMeters < tile.minX ||
      pointX - maxDistanceMeters > tile.maxX ||
      pointY + maxDistanceMeters < tile.minY ||
      pointY - maxDistanceMeters > tile.maxY
    ) {
      continue;
    }
    candidateTiles.push(tile);
  }

  // No candidate tile → evaluator is a no-op (saves the ray-march entirely).
  if (candidateTiles.length === 0) {
    return (sample) =>
      sample.altitudeDeg <= 0 ? emptyVegetationShadowResult() : emptyVegetationShadowResult();
  }

  // Last-hit tile cache. Subsequent ray-march steps usually fall in the
  // same tile (rays advance by stepMeters, tiles are typically much larger).
  let lastHitTile: VegetationSurfaceTile | null = null;

  return (sample: VegetationShadowEvaluatorInput): VegetationShadowResult => {
    if (sample.altitudeDeg <= 0) {
      return emptyVegetationShadowResult();
    }

    const azimuthRad = (sample.azimuthDeg * Math.PI) / 180;
    const dirX = Math.sin(azimuthRad);
    const dirY = Math.cos(azimuthRad);
    let checkedSamplesCount = 0;

    for (
      let distanceMeters = stepMeters;
      distanceMeters <= maxDistanceMeters;
      distanceMeters += stepMeters
    ) {
      const sampleX = pointX + dirX * distanceMeters;
      const sampleY = pointY + dirY * distanceMeters;

      // Try cached tile first; fall back to scanning candidates on miss.
      let hitTile: VegetationSurfaceTile | null = null;
      if (
        lastHitTile !== null &&
        sampleX >= lastHitTile.minX &&
        sampleX <= lastHitTile.maxX &&
        sampleY >= lastHitTile.minY &&
        sampleY <= lastHitTile.maxY
      ) {
        hitTile = lastHitTile;
      } else {
        for (const tile of candidateTiles) {
          if (
            sampleX < tile.minX ||
            sampleX > tile.maxX ||
            sampleY < tile.minY ||
            sampleY > tile.maxY
          ) {
            continue;
          }
          hitTile = tile;
          lastHitTile = tile;
          break;
        }
      }

      if (hitTile === null) {
        continue;
      }

      const xRatio = (sampleX - hitTile.minX) / (hitTile.maxX - hitTile.minX);
      const yRatio = (hitTile.maxY - sampleY) / (hitTile.maxY - hitTile.minY);
      const x = clamp(Math.floor(xRatio * hitTile.width), 0, hitTile.width - 1);
      const y = clamp(Math.floor(yRatio * hitTile.height), 0, hitTile.height - 1);
      const index = y * hitTile.width + x;
      const value = Number(hitTile.raster[index]);

      if (!Number.isFinite(value) || valueIsNoData(value, hitTile.nodata)) {
        continue;
      }

      checkedSamplesCount += 1;

      // V1 approximation: local canopy/top clearance is estimated against point elevation.
      const clearanceMeters = value - pointElevation;
      if (clearanceMeters < minClearanceMeters) {
        continue;
      }

      const blockerAltitudeAngleDeg =
        (Math.atan2(clearanceMeters, distanceMeters) * 180) / Math.PI;
      if (sample.altitudeDeg <= blockerAltitudeAngleDeg) {
        return {
          blocked: true,
          blockerDistanceMeters: Math.round(distanceMeters * 1000) / 1000,
          blockerAltitudeAngleDeg:
            Math.round(blockerAltitudeAngleDeg * 1000) / 1000,
          blockerSurfaceElevationMeters: Math.round(value * 1000) / 1000,
          blockerClearanceMeters: Math.round(clearanceMeters * 1000) / 1000,
          checkedSamplesCount,
        };
      }
    }

    return emptyVegetationShadowResult(checkedSamplesCount);
  };
}

export const vegetationShadowMethod = METHOD;
