import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { fromFile } from "geotiff";

import {
  LAUSANNE_CENTER,
  LAUSANNE_HORIZON_RADIUS_KM,
} from "../../src/lib/config/lausanne";
import {
  PROCESSED_HORIZON_MASK_PATH,
  RAW_HORIZON_DEM_DIR,
} from "../../src/lib/storage/data-paths";

const EARTH_RADIUS_METERS = 6_371_000;
const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;

interface BuildArgs {
  stepMeters: number;
  radiusKm: number;
  refractionCoefficient: number;
}

interface DemTile {
  name: string;
  filePath: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  width: number;
  height: number;
  nodata: number | null;
  raster: Float32Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
}

interface DestinationPoint {
  lat: number;
  lon: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseCliArgs(argv: string[]): BuildArgs {
  let stepMeters = 250;
  let radiusKm = LAUSANNE_HORIZON_RADIUS_KM;
  let refractionCoefficient = 0.13;

  for (const arg of argv) {
    if (arg.startsWith("--step-meters=")) {
      const parsed = Number(arg.slice("--step-meters=".length));
      if (Number.isFinite(parsed) && parsed > 0) {
        stepMeters = parsed;
      }
      continue;
    }

    if (arg.startsWith("--radius-km=")) {
      const parsed = Number(arg.slice("--radius-km=".length));
      if (Number.isFinite(parsed) && parsed > 0) {
        radiusKm = parsed;
      }
      continue;
    }

    if (arg.startsWith("--refraction-k=")) {
      const parsed = Number(arg.slice("--refraction-k=".length));
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 0.5) {
        refractionCoefficient = parsed;
      }
    }
  }

  return {
    stepMeters,
    radiusKm,
    refractionCoefficient,
  };
}

function radians(value: number): number {
  return value * RAD_PER_DEG;
}

function degrees(value: number): number {
  return value * DEG_PER_RAD;
}

function normalizeLongitude(lonDeg: number): number {
  let value = lonDeg;
  while (value > 180) {
    value -= 360;
  }
  while (value < -180) {
    value += 360;
  }
  return value;
}

function destinationPoint(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distanceMeters: number,
): DestinationPoint {
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const latitude = radians(latDeg);
  const longitude = radians(lonDeg);
  const bearing = radians(bearingDeg);

  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinAngular = Math.sin(angularDistance);
  const cosAngular = Math.cos(angularDistance);

  const targetLat = Math.asin(
    sinLat * cosAngular + cosLat * sinAngular * Math.cos(bearing),
  );

  const targetLon =
    longitude +
    Math.atan2(
      Math.sin(bearing) * sinAngular * cosLat,
      cosAngular - sinLat * Math.sin(targetLat),
    );

  return {
    lat: degrees(targetLat),
    lon: normalizeLongitude(degrees(targetLon)),
  };
}

async function loadDemTiles(directoryPath: string): Promise<DemTile[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const tifFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".tif"))
    .map((entry) => path.join(directoryPath, entry.name))
    .sort();

  if (tifFiles.length === 0) {
    throw new Error(
      `No DEM .tif files found in ${directoryPath}. Run ingest:lausanne:terrain:horizon first.`,
    );
  }

  const tiles: DemTile[] = [];

  for (const filePath of tifFiles) {
    const tiff = await fromFile(filePath);
    const image = await tiff.getImage();
    const bbox = image.getBoundingBox();
    const raster = (await image.readRasters({
      interleave: true,
      pool: null,
    })) as DemTile["raster"];
    const nodataRaw = image.getGDALNoData();
    const nodata =
      nodataRaw === null || nodataRaw === undefined
        ? null
        : Number.parseFloat(String(nodataRaw));

    tiles.push({
      name: path.basename(filePath),
      filePath,
      minLon: bbox[0],
      minLat: bbox[1],
      maxLon: bbox[2],
      maxLat: bbox[3],
      width: image.getWidth(),
      height: image.getHeight(),
      nodata: Number.isFinite(nodata) ? nodata : null,
      raster,
    });
  }

  return tiles;
}

function valueIsNoData(value: number, nodata: number | null): boolean {
  if (nodata === null) {
    return false;
  }

  return Math.abs(value - nodata) < 1e-6;
}

function sampleElevationMeters(
  tiles: DemTile[],
  latDeg: number,
  lonDeg: number,
): number | null {
  for (const tile of tiles) {
    if (
      lonDeg < tile.minLon ||
      lonDeg > tile.maxLon ||
      latDeg < tile.minLat ||
      latDeg > tile.maxLat
    ) {
      continue;
    }

    const xRatio = (lonDeg - tile.minLon) / (tile.maxLon - tile.minLon);
    const yRatio = (tile.maxLat - latDeg) / (tile.maxLat - tile.minLat);

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

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const outputPath = PROCESSED_HORIZON_MASK_PATH;
  const startedAt = performance.now();

  const tiles = await loadDemTiles(RAW_HORIZON_DEM_DIR);
  const centerElevation = sampleElevationMeters(
    tiles,
    LAUSANNE_CENTER.lat,
    LAUSANNE_CENTER.lon,
  );

  if (centerElevation === null) {
    throw new Error("Could not sample center elevation for Lausanne.");
  }

  const radiusMeters = args.radiusKm * 1000;
  const binsDeg: number[] = [];
  let sampledPoints = 0;
  let missingSamples = 0;

  for (let azimuthDeg = 0; azimuthDeg < 360; azimuthDeg += 1) {
    let maxElevationAngle = -90;

    for (
      let distanceMeters = args.stepMeters;
      distanceMeters <= radiusMeters;
      distanceMeters += args.stepMeters
    ) {
      sampledPoints += 1;

      const point = destinationPoint(
        LAUSANNE_CENTER.lat,
        LAUSANNE_CENTER.lon,
        azimuthDeg,
        distanceMeters,
      );
      const elevation = sampleElevationMeters(tiles, point.lat, point.lon);

      if (elevation === null) {
        missingSamples += 1;
        continue;
      }

      const curvatureDropMeters =
        (distanceMeters * distanceMeters) / (2 * EARTH_RADIUS_METERS);
      const correctedDrop = curvatureDropMeters * (1 - args.refractionCoefficient);
      const relativeHeight = elevation - centerElevation - correctedDrop;
      const angleDeg = degrees(Math.atan2(relativeHeight, distanceMeters));

      if (angleDeg > maxElevationAngle) {
        maxElevationAngle = angleDeg;
      }
    }

    binsDeg.push(round3(maxElevationAngle));
  }

  const elapsedSeconds = round3((performance.now() - startedAt) / 1000);
  const payload = {
    generatedAt: new Date().toISOString(),
    method: "copernicus-dem30-raycast-v1",
    center: LAUSANNE_CENTER,
    radiusKm: args.radiusKm,
    centerElevationM: round3(centerElevation),
    stepMeters: args.stepMeters,
    refractionCoefficient: args.refractionCoefficient,
    binsDeg,
    demTiles: tiles.map((tile) => tile.name),
    sampleStats: {
      sampledPoints,
      missingSamples,
      missingRatio: sampledPoints > 0 ? round3(missingSamples / sampledPoints) : 0,
      elapsedSeconds,
    },
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(`[horizon-mask] Loaded ${tiles.length} DEM tiles.`);
  console.log(
    `[horizon-mask] Center elevation: ${payload.centerElevationM} m, step: ${args.stepMeters} m, radius: ${args.radiusKm} km.`,
  );
  console.log(`[horizon-mask] Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(
    `[horizon-mask] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
