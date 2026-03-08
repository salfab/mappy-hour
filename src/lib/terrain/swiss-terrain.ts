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

let metadataCache: Promise<TerrainTileMetadata[]> | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function findContainingTile(
  tiles: TerrainTileMetadata[],
  easting: number,
  northing: number,
): TerrainTileMetadata | null {
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

  const tiff = await fromFile(tile.filePath);
  const image = await tiff.getImage();
  const raster = (await image.readRasters({
    window: [x, y, x + 1, y + 1],
    interleave: true,
    pool: null,
  })) as Float32Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

  const value = Number(raster[0]);
  if (!Number.isFinite(value) || valueIsNoData(value, tile.nodata)) {
    return null;
  }

  return value;
}
