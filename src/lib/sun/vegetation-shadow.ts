import fs from "node:fs/promises";
import path from "node:path";

import { fromFile } from "geotiff";

import { RAW_VEGETATION_SURFACE_DIR } from "@/lib/storage/data-paths";

type TypedRaster = Float32Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

interface VegetationSurfaceTile {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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

let vegetationTilesCachePromise: Promise<VegetationSurfaceTile[] | null> | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function valueIsNoData(value: number, nodata: number | null): boolean {
  if (nodata === null) {
    return false;
  }
  return Math.abs(value - nodata) < 1e-6;
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

export async function loadVegetationSurfaceTiles(): Promise<VegetationSurfaceTile[] | null> {
  if (vegetationTilesCachePromise) {
    return vegetationTilesCachePromise;
  }

  vegetationTilesCachePromise = (async () => {
    try {
      await fs.access(RAW_VEGETATION_SURFACE_DIR);
    } catch {
      return null;
    }

    const tifFiles = await listTifsRecursively(RAW_VEGETATION_SURFACE_DIR);
    if (tifFiles.length === 0) {
      return null;
    }

    const tiles: VegetationSurfaceTile[] = [];
    for (const filePath of tifFiles) {
      const tiff = await fromFile(filePath);
      const image = await tiff.getImage();
      const bbox = image.getBoundingBox();
      const raster = (await image.readRasters({
        interleave: true,
        pool: null,
      })) as TypedRaster;
      const noDataRaw = image.getGDALNoData();
      const noDataParsed =
        noDataRaw === null || noDataRaw === undefined
          ? null
          : Number.parseFloat(String(noDataRaw));

      tiles.push({
        minX: bbox[0],
        minY: bbox[1],
        maxX: bbox[2],
        maxY: bbox[3],
        width: image.getWidth(),
        height: image.getHeight(),
        nodata: Number.isFinite(noDataParsed) ? noDataParsed : null,
        raster,
      });
    }

    return tiles;
  })();

  return vegetationTilesCachePromise;
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

  return (sample: VegetationShadowEvaluatorInput): VegetationShadowResult => {
    if (sample.altitudeDeg <= 0) {
      return {
        blocked: false,
        blockerDistanceMeters: null,
        blockerAltitudeAngleDeg: null,
        blockerSurfaceElevationMeters: null,
        blockerClearanceMeters: null,
        checkedSamplesCount: 0,
      };
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
      const sampleX = params.pointX + dirX * distanceMeters;
      const sampleY = params.pointY + dirY * distanceMeters;
      const surfaceElevation = sampleSurfaceElevationLv95(
        params.tiles,
        sampleX,
        sampleY,
      );
      if (surfaceElevation === null) {
        continue;
      }

      checkedSamplesCount += 1;

      // V1 approximation: local canopy/top clearance is estimated against point elevation.
      const clearanceMeters = surfaceElevation - params.pointElevation;
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
          blockerSurfaceElevationMeters: Math.round(surfaceElevation * 1000) / 1000,
          blockerClearanceMeters: Math.round(clearanceMeters * 1000) / 1000,
          checkedSamplesCount,
        };
      }
    }

    return {
      blocked: false,
      blockerDistanceMeters: null,
      blockerAltitudeAngleDeg: null,
      blockerSurfaceElevationMeters: null,
      blockerClearanceMeters: null,
      checkedSamplesCount,
    };
  };
}

export const vegetationShadowMethod = METHOD;
