import fs from "node:fs/promises";
import path from "node:path";

import { fromFile } from "geotiff";

import { RAW_TERRAIN_CH_DIR } from "@/lib/storage/data-paths";

interface TerrainTileMetadata {
  filePath: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  nodata: number | null;
}

type TerrainRaster = Float32Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

interface TerrainTileRaster {
  nodata: number | null;
  raster: TerrainRaster;
}

export interface TerrainTileSource {
  filePath: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  nodata: number | null;
  raster: TerrainRaster;
}

let metadataCache: Promise<TerrainTileMetadata[]> | null = null;
const terrainRasterCache = new Map<string, Promise<TerrainTileRaster>>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function closeGeoTiff(tiff: Awaited<ReturnType<typeof fromFile>>): Promise<void> {
  const closeFn = (tiff as { close?: () => false | Promise<void> }).close;
  if (typeof closeFn === "function") {
    await closeFn.call(tiff);
  }
}

async function listTerrainTifsRecursively(rootDirectory: string): Promise<string[]> {
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

async function loadTerrainMetadata(): Promise<TerrainTileMetadata[]> {
  if (metadataCache) {
    return metadataCache;
  }

  metadataCache = (async () => {
    const tifs = await listTerrainTifsRecursively(RAW_TERRAIN_CH_DIR);
    const metadata: TerrainTileMetadata[] = [];

    for (const filePath of tifs) {
      const tiff = await fromFile(filePath);
      try {
        const image = await tiff.getImage();
        const bbox = image.getBoundingBox();
        const noDataRaw = image.getGDALNoData();
        const noDataParsed =
          noDataRaw === null || noDataRaw === undefined
            ? null
            : Number.parseFloat(String(noDataRaw));

        metadata.push({
          filePath,
          minX: bbox[0],
          minY: bbox[1],
          maxX: bbox[2],
          maxY: bbox[3],
          width: image.getWidth(),
          height: image.getHeight(),
          nodata: Number.isFinite(noDataParsed) ? noDataParsed : null,
        });
      } finally {
        await closeGeoTiff(tiff);
      }
    }

    return metadata;
  })();

  return metadataCache;
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
  tile: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  },
): boolean {
  return !(
    tile.maxX < bounds.minX ||
    tile.minX > bounds.maxX ||
    tile.maxY < bounds.minY ||
    tile.minY > bounds.maxY
  );
}

function findContainingTile<T extends {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>(
  tiles: T[],
  easting: number,
  northing: number,
): T | null {
  for (const tile of tiles) {
    if (
      easting >= tile.minX &&
      easting <= tile.maxX &&
      northing >= tile.minY &&
      northing <= tile.maxY
    ) {
      return tile;
    }
  }

  return null;
}

async function loadTerrainTileRaster(
  tile: TerrainTileMetadata,
): Promise<TerrainTileRaster> {
  const cached = terrainRasterCache.get(tile.filePath);
  if (cached) {
    return cached;
  }

  const rasterPromise = (async () => {
    const tiff = await fromFile(tile.filePath);
    try {
      const image = await tiff.getImage();
      const raster = (await image.readRasters({
        interleave: true,
        pool: null,
      })) as TerrainRaster;
      const noDataRaw = image.getGDALNoData();
      const noDataParsed =
        noDataRaw === null || noDataRaw === undefined
          ? null
          : Number.parseFloat(String(noDataRaw));

      return {
        raster,
        nodata: Number.isFinite(noDataParsed) ? noDataParsed : tile.nodata,
      };
    } finally {
      await closeGeoTiff(tiff);
    }
  })();

  terrainRasterCache.set(tile.filePath, rasterPromise);
  return rasterPromise;
}

export async function loadTerrainTilesForBounds(bounds: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): Promise<TerrainTileSource[] | null> {
  const metadata = await loadTerrainMetadata();
  if (metadata.length === 0) {
    return null;
  }

  const selected = metadata.filter((tile) => boundsIntersect(bounds, tile));
  if (selected.length === 0) {
    return [];
  }

  const withRasters = await Promise.all(
    selected.map(async (tile) => {
      const raster = await loadTerrainTileRaster(tile);
      return {
        filePath: tile.filePath,
        minX: tile.minX,
        minY: tile.minY,
        maxX: tile.maxX,
        maxY: tile.maxY,
        width: tile.width,
        height: tile.height,
        nodata: raster.nodata,
        raster: raster.raster,
      } satisfies TerrainTileSource;
    }),
  );

  return withRasters;
}

export function sampleSwissTerrainElevationLv95FromTiles(
  tiles: TerrainTileSource[],
  easting: number,
  northing: number,
): number | null {
  const tile = findContainingTile(tiles, easting, northing);
  if (!tile) {
    return null;
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

export async function sampleSwissTerrainElevationLv95(
  easting: number,
  northing: number,
): Promise<number | null> {
  const tiles = await loadTerrainMetadata();
  const tile = findContainingTile(tiles, easting, northing);
  if (!tile) {
    return null;
  }

  const xRatio = (easting - tile.minX) / (tile.maxX - tile.minX);
  const yRatio = (tile.maxY - northing) / (tile.maxY - tile.minY);
  const x = clamp(Math.floor(xRatio * tile.width), 0, tile.width - 1);
  const y = clamp(Math.floor(yRatio * tile.height), 0, tile.height - 1);

  const terrainTile = await loadTerrainTileRaster(tile);
  const index = y * tile.width + x;
  const value = Number(terrainTile.raster[index]);
  if (!Number.isFinite(value) || valueIsNoData(value, terrainTile.nodata)) {
    return null;
  }

  return value;
}
