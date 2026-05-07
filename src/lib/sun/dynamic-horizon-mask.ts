import fs from "node:fs/promises";
import path from "node:path";

import { fromFile } from "geotiff";

import type { HorizonMask } from "@/lib/sun/horizon-mask";
import { RAW_HORIZON_DEM_DIR, PROCESSED_ROOT } from "@/lib/storage/data-paths";

const EARTH_RADIUS_METERS = 6_371_000;
const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;
const DEFAULT_RADIUS_KM = 120;
const DEFAULT_STEP_METERS = 500;
const DEFAULT_REFRACTION_COEFFICIENT = 0.13;
const CACHE_KEY_PRECISION = 3;
const MASK_CACHE_MAX_ENTRIES = 64;

interface DynamicHorizonOptions {
  lat: number;
  lon: number;
  radiusKm?: number;
  stepMeters?: number;
  refractionCoefficient?: number;
}

interface DemTile {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  width: number;
  height: number;
  nodata: number | null;
  raster: Float32Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
}

let demTilesCachePromise: Promise<DemTile[] | null> | null = null;
const maskCache = new Map<string, HorizonMask>();

function radians(value: number): number {
  return value * RAD_PER_DEG;
}

function degrees(value: number): number {
  return value * DEG_PER_RAD;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function closeGeoTiff(tiff: Awaited<ReturnType<typeof fromFile>>): Promise<void> {
  const closeFn = (tiff as { close?: () => false | Promise<void> }).close;
  if (typeof closeFn === "function") {
    await closeFn.call(tiff);
  }
}

function buildCacheKey(
  lat: number,
  lon: number,
  radiusKm: number,
  stepMeters: number,
  refractionCoefficient: number,
): string {
  const latRounded = lat.toFixed(CACHE_KEY_PRECISION);
  const lonRounded = lon.toFixed(CACHE_KEY_PRECISION);
  return `${latRounded}|${lonRounded}|${radiusKm}|${stepMeters}|${refractionCoefficient}`;
}

function setMaskCache(key: string, mask: HorizonMask): void {
  if (maskCache.size >= MASK_CACHE_MAX_ENTRIES) {
    const firstKey = maskCache.keys().next().value;
    if (firstKey) {
      maskCache.delete(firstKey);
    }
  }
  maskCache.set(key, mask);
}

function valueIsNoData(value: number, nodata: number | null): boolean {
  if (nodata === null) {
    return false;
  }
  return Math.abs(value - nodata) < 1e-6;
}

function destinationPoint(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distanceMeters: number,
): { lat: number; lon: number } {
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

async function loadDemTiles(): Promise<DemTile[] | null> {
  if (demTilesCachePromise) {
    return demTilesCachePromise;
  }

  demTilesCachePromise = (async () => {
    try {
      await fs.access(RAW_HORIZON_DEM_DIR);
    } catch {
      return null;
    }

    const entries = await fs.readdir(RAW_HORIZON_DEM_DIR, { withFileTypes: true });
    const tifFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".tif"))
      .map((entry) => path.join(RAW_HORIZON_DEM_DIR, entry.name))
      .sort();

    if (tifFiles.length === 0) {
      return null;
    }

    const tiles: DemTile[] = [];
    for (const filePath of tifFiles) {
      const tiff = await fromFile(filePath);
      try {
        const image = await tiff.getImage();
        const bbox = image.getBoundingBox();
        const raster = (await image.readRasters({
          interleave: true,
          pool: null,
        })) as DemTile["raster"];
        const nodataRaw = image.getGDALNoData();
        const nodataParsed =
          nodataRaw === null || nodataRaw === undefined
            ? null
            : Number.parseFloat(String(nodataRaw));

        tiles.push({
          minLon: bbox[0],
          minLat: bbox[1],
          maxLon: bbox[2],
          maxLat: bbox[3],
          width: image.getWidth(),
          height: image.getHeight(),
          nodata: Number.isFinite(nodataParsed) ? nodataParsed : null,
          raster,
        });
      } finally {
        await closeGeoTiff(tiff);
      }
    }

    return tiles;
  })();

  return demTilesCachePromise;
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

// ── Disk persistence for horizon masks ───────────────────────────────────
const HORIZON_MASK_CACHE_DIR = path.join(PROCESSED_ROOT, "horizon-masks");

function diskCachePath(cacheKey: string): string {
  return path.join(HORIZON_MASK_CACHE_DIR, `${cacheKey.replace(/\|/g, "_")}.json`);
}

async function loadMaskFromDisk(cacheKey: string): Promise<HorizonMask | null> {
  try {
    const raw = await fs.readFile(diskCachePath(cacheKey), "utf-8");
    return JSON.parse(raw) as HorizonMask;
  } catch {
    return null;
  }
}

async function saveMaskToDisk(cacheKey: string, mask: HorizonMask): Promise<void> {
  await fs.mkdir(HORIZON_MASK_CACHE_DIR, { recursive: true });
  await fs.writeFile(diskCachePath(cacheKey), JSON.stringify(mask));
}

export async function buildDynamicHorizonMask(
  options: DynamicHorizonOptions,
): Promise<HorizonMask | null> {
  const radiusKm = options.radiusKm ?? DEFAULT_RADIUS_KM;
  const stepMeters = options.stepMeters ?? DEFAULT_STEP_METERS;
  const refractionCoefficient =
    options.refractionCoefficient ?? DEFAULT_REFRACTION_COEFFICIENT;
  const cacheKey = buildCacheKey(
    options.lat,
    options.lon,
    radiusKm,
    stepMeters,
    refractionCoefficient,
  );

  // L1: in-memory cache
  const cached = maskCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // L2: disk cache (persisted from previous runs)
  const diskCached = await loadMaskFromDisk(cacheKey);
  if (diskCached) {
    setMaskCache(cacheKey, diskCached);
    return diskCached;
  }

  const tiles = await loadDemTiles();
  if (!tiles || tiles.length === 0) {
    return null;
  }

  const centerElevation = sampleElevationMeters(tiles, options.lat, options.lon);
  if (centerElevation === null) {
    return null;
  }

  const radiusMeters = radiusKm * 1000;
  const binsDeg: number[] = [];
  const ridgePoints: NonNullable<HorizonMask["ridgePoints"]> = [];

  for (let azimuthDeg = 0; azimuthDeg < 360; azimuthDeg += 1) {
    let maxElevationAngle = -90;
    let bestPoint: {
      lat: number;
      lon: number;
      distanceMeters: number;
      horizonAngleDeg: number;
      peakElevationMeters: number;
    } | null = null;

    for (
      let distanceMeters = stepMeters;
      distanceMeters <= radiusMeters;
      distanceMeters += stepMeters
    ) {
      const point = destinationPoint(
        options.lat,
        options.lon,
        azimuthDeg,
        distanceMeters,
      );
      const elevation = sampleElevationMeters(tiles, point.lat, point.lon);
      if (elevation === null) {
        continue;
      }

      const curvatureDropMeters =
        (distanceMeters * distanceMeters) / (2 * EARTH_RADIUS_METERS);
      const correctedDrop = curvatureDropMeters * (1 - refractionCoefficient);
      const relativeHeight = elevation - centerElevation - correctedDrop;
      const angleDeg = degrees(Math.atan2(relativeHeight, distanceMeters));
      if (angleDeg > maxElevationAngle) {
        maxElevationAngle = angleDeg;
        bestPoint = {
          lat: point.lat,
          lon: point.lon,
          distanceMeters,
          horizonAngleDeg: angleDeg,
          peakElevationMeters: elevation,
        };
      }
    }

    binsDeg.push(round3(maxElevationAngle));
    if (bestPoint) {
      ridgePoints.push({
        azimuthDeg,
        lat: round6(bestPoint.lat),
        lon: round6(bestPoint.lon),
        distanceMeters: round3(bestPoint.distanceMeters),
        horizonAngleDeg: round3(bestPoint.horizonAngleDeg),
        peakElevationMeters: round3(bestPoint.peakElevationMeters),
      });
    }
  }

  const mask: HorizonMask = {
    generatedAt: new Date().toISOString(),
    method: "copernicus-dem30-runtime-raycast-v1",
    center: {
      lat: round3(options.lat),
      lon: round3(options.lon),
    },
    radiusKm,
    binsDeg,
    ridgePoints,
    notes: `runtime dynamic horizon (step=${stepMeters}m, k=${refractionCoefficient})`,
  };
  setMaskCache(cacheKey, mask);
  saveMaskToDisk(cacheKey, mask).catch(() => {});
  return mask;
}
