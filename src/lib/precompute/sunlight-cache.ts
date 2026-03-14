import fs from "node:fs/promises";
import path from "node:path";

import { LAUSANNE_CONFIG } from "@/lib/config/lausanne";
import { NYON_CONFIG } from "@/lib/config/nyon";
import { lv95ToWgs84, wgs84ToLv95 } from "@/lib/geo/projection";
import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";

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
  pointElevationMeters: number | null;
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
}

export interface PrecomputedSunlightTileArtifact {
  version: 1;
  region: PrecomputedRegionName;
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
  version: 1;
  region: PrecomputedRegionName;
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
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
}): string {
  return path.join(
    CACHE_SUNLIGHT_DIR,
    params.region,
    `g${params.gridStepMeters}`,
    `m${params.sampleEveryMinutes}`,
    params.date,
  );
}

export function getPrecomputedSunlightManifestPath(params: {
  region: PrecomputedRegionName;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
}): string {
  return path.join(createCacheRunKey(params), "manifest.json");
}

export function getPrecomputedSunlightTilePath(params: {
  region: PrecomputedRegionName;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  tileId: string;
}): string {
  return path.join(createCacheRunKey(params), "tiles", `${params.tileId}.json`);
}

export async function writePrecomputedSunlightManifest(
  manifest: PrecomputedSunlightManifest,
): Promise<void> {
  const targetPath = getPrecomputedSunlightManifestPath({
    region: manifest.region,
    date: manifest.date,
    gridStepMeters: manifest.gridStepMeters,
    sampleEveryMinutes: manifest.sampleEveryMinutes,
  });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(manifest, null, 2), "utf8");
}

export async function writePrecomputedSunlightTile(
  artifact: PrecomputedSunlightTileArtifact,
): Promise<void> {
  const targetPath = getPrecomputedSunlightTilePath({
    region: artifact.region,
    date: artifact.date,
    gridStepMeters: artifact.gridStepMeters,
    sampleEveryMinutes: artifact.sampleEveryMinutes,
    tileId: artifact.tile.tileId,
  });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(artifact), "utf8");
}

export async function loadPrecomputedSunlightManifest(params: {
  region: PrecomputedRegionName;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
}): Promise<PrecomputedSunlightManifest | null> {
  const targetPath = getPrecomputedSunlightManifestPath(params);
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw) as PrecomputedSunlightManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadPrecomputedSunlightTile(params: {
  region: PrecomputedRegionName;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  tileId: string;
}): Promise<PrecomputedSunlightTileArtifact | null> {
  const targetPath = getPrecomputedSunlightTilePath(params);
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw) as PrecomputedSunlightTileArtifact;
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
  const points: Array<PrecomputedSunlightPoint> = [];
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
