/**
 * Load pre-computed tile grid metadata (indoor/outdoor classification
 * and terrain elevation). Generated once per building model version.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

export interface TileGridMetadata {
  tileId: string;
  modelVersionHash: string;
  gridStepMeters: number;
  totalPoints: number;
  outdoorCount: number;
  indoorCount: number;
  /** Per raw grid point: elevation in meters (null = indoor, skipped) */
  elevations: (number | null)[];
  /** Per raw grid point: true = inside a building (under a roof) */
  indoor: boolean[];
}

export function getTileGridMetadataPath(region: string, modelVersionHash: string, gridStepMeters: number, tileId: string): string {
  return path.join("data", "cache", "tile-grid-metadata", region, modelVersionHash, `g${gridStepMeters}`, `${tileId}.json.gz`);
}

export async function loadTileGridMetadata(region: string, modelVersionHash: string, gridStepMeters: number, tileId: string): Promise<TileGridMetadata | null> {
  const filePath = getTileGridMetadataPath(region, modelVersionHash, gridStepMeters, tileId);
  try {
    const compressed = await fs.readFile(filePath);
    const json = zlib.gunzipSync(compressed).toString("utf8");
    return JSON.parse(json) as TileGridMetadata;
  } catch {
    return null;
  }
}
