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

/**
 * Strategy used to pick a single SwissALTI3D TIF when multiple exist for the
 * same km cell on disk (multiple acquisition years × resolutions). Bumped via
 * model-version.ts so atlases produced under different strategies are stored
 * under distinct modelVersionHash directories.
 */
export const TERRAIN_SELECTION_STRATEGY = "max-year-best-res-v1";

interface ParsedTerrainTifName {
  kmE: number;
  kmN: number;
  year: number;
  resolutionMeters: number;
}

/**
 * Extract (year, kmCell, resolution) from a SwissALTI3D filename.
 *
 * Expected: `swissalti3d_{year}_{kmE}-{kmN}_{resolution}_2056_5728.tif`
 * e.g. `swissalti3d_2021_2527-1150_0.5_2056_5728.tif` → 2021, 2527, 1150, 0.5
 *
 * Returns null when the filename does not match (older formats, custom drops).
 * The caller falls back to including such files unconditionally so existing
 * non-conforming layouts keep working.
 */
function parseTerrainTifName(filePath: string): ParsedTerrainTifName | null {
  const base = path.basename(filePath).toLowerCase();
  const match = base.match(
    /^swissalti3d_(\d{4})_(\d+)-(\d+)_([\d.]+)_2056_5728\.tif$/,
  );
  if (!match) return null;
  const year = Number(match[1]);
  const kmE = Number(match[2]);
  const kmN = Number(match[3]);
  const resolutionMeters = Number(match[4]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(kmE) ||
    !Number.isFinite(kmN) ||
    !Number.isFinite(resolutionMeters)
  ) {
    return null;
  }
  return { year, kmE, kmN, resolutionMeters };
}

/**
 * Pick a single canonical TIF per km cell:
 *   1. Latest acquisition year wins.
 *   2. Within that year, finest resolution wins (smallest resolution in m).
 *
 * Files that do not match the SwissALTI3D naming convention are kept as-is
 * (one entry per file) so custom or legacy drops still load.
 *
 * Without this dedup, every (kmCell × year × resolution) combination is
 * concatenated into the GPU's terrain_data buffer (binding 13). Border
 * tiles on Morges-west pushed it past wgpu's default
 * max_storage_buffer_binding_size (128 MiB) on Intel Arc, see commit 7856ee7.
 * The fix lifted the limit; this dedup reclaims the redundancy upstream and
 * makes the sample reads deterministic (no longer depends on fs.readdir order).
 */
function dedupTerrainTifs(allPaths: string[]): string[] {
  const grouped = new Map<string, ParsedTerrainTifName & { filePath: string }>();
  const unparseable: string[] = [];

  for (const filePath of allPaths) {
    const parsed = parseTerrainTifName(filePath);
    if (!parsed) {
      unparseable.push(filePath);
      continue;
    }
    const key = `${parsed.kmE}-${parsed.kmN}`;
    const existing = grouped.get(key);
    if (
      !existing ||
      parsed.year > existing.year ||
      (parsed.year === existing.year &&
        parsed.resolutionMeters < existing.resolutionMeters)
    ) {
      grouped.set(key, { ...parsed, filePath });
    }
  }

  const picked = Array.from(grouped.values()).map((entry) => entry.filePath);
  picked.sort();
  return [...picked, ...unparseable.sort()];
}

async function loadTerrainMetadata(): Promise<TerrainTileMetadata[]> {
  if (metadataCache) {
    return metadataCache;
  }

  metadataCache = (async () => {
    const tifsRaw = await listTerrainTifsRecursively(RAW_TERRAIN_CH_DIR);
    const tifs = dedupTerrainTifs(tifsRaw);
    if (tifs.length < tifsRaw.length) {
      console.error(
        `[swiss-terrain] dedup ${tifsRaw.length} → ${tifs.length} TIFs (${TERRAIN_SELECTION_STRATEGY})`,
      );
    }
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
