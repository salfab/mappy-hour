import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import {
  PROCESSED_BUILDINGS_INDEX_PATH,
  PROCESSED_HORIZON_MASK_PATH,
  PROCESSED_LAUSANNE_PLACES_PATH,
  RAW_BUILDINGS_DIR,
  RAW_HORIZON_DEM_DIR,
  RAW_LAUSANNE_PLACES_PATH,
  RAW_TERRAIN_CH_DIR,
  RAW_VEGETATION_SURFACE_DIR,
} from "@/lib/storage/data-paths";

export const runtime = "nodejs";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countFilesRecursively(directory: string): Promise<number> {
  if (!(await fileExists(directory))) {
    return 0;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      count += await countFilesRecursively(fullPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }

  return count;
}

export async function GET() {
  const [
    buildingsFiles,
    terrainFiles,
    vegetationSurfaceFiles,
    horizonDemFiles,
    horizonMaskExists,
    buildingsIndexExists,
    rawPlacesExists,
    processedPlacesExists,
  ] = await Promise.all([
    countFilesRecursively(RAW_BUILDINGS_DIR),
    countFilesRecursively(RAW_TERRAIN_CH_DIR),
    countFilesRecursively(RAW_VEGETATION_SURFACE_DIR),
    countFilesRecursively(RAW_HORIZON_DEM_DIR),
    fileExists(PROCESSED_HORIZON_MASK_PATH),
    fileExists(PROCESSED_BUILDINGS_INDEX_PATH),
    fileExists(RAW_LAUSANNE_PLACES_PATH),
    fileExists(PROCESSED_LAUSANNE_PLACES_PATH),
  ]);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    datasets: {
      lausanneBuildings: {
        directory: RAW_BUILDINGS_DIR,
        fileCount: buildingsFiles,
      },
      swissTerrainLocal: {
        directory: RAW_TERRAIN_CH_DIR,
        fileCount: terrainFiles,
      },
      swissSurfaceVegetation: {
        directory: RAW_VEGETATION_SURFACE_DIR,
        fileCount: vegetationSurfaceFiles,
      },
      transborderHorizonDem: {
        directory: RAW_HORIZON_DEM_DIR,
        fileCount: horizonDemFiles,
      },
      horizonMask: {
        filePath: PROCESSED_HORIZON_MASK_PATH,
        exists: horizonMaskExists,
      },
      buildingsIndex: {
        filePath: PROCESSED_BUILDINGS_INDEX_PATH,
        exists: buildingsIndexExists,
      },
      placesRaw: {
        filePath: RAW_LAUSANNE_PLACES_PATH,
        exists: rawPlacesExists,
      },
      placesProcessed: {
        filePath: PROCESSED_LAUSANNE_PLACES_PATH,
        exists: processedPlacesExists,
      },
    },
  });
}
