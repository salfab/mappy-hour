import SunCalc from "suncalc";

import { lv95ToWgs84 } from "@/lib/geo/projection";
import type { ShadowCalibration } from "@/lib/sun/shadow-calibration";
import {
  computeSunlightTileArtifact,
  createUtcSamples,
  type SunlightTileComputeProgress,
} from "./sunlight-tile-service";
import type { TileGridMetadata } from "./tile-grid-metadata";
import type { PrecomputedRegionName, RegionTileSpec } from "./sunlight-cache";
import {
  getAtlasBucketKeySet,
  loadPrecomputedTileAtlas,
  mergeBucketsIntoAtlas,
  packBucketKey,
  writePrecomputedTileAtlas,
  type AtlasBucketEntry,
  type TileAtlasMetadata,
} from "./sunlight-cache-atlas";

const DEFAULT_ATLAS_RESOLUTION_DEG = 0.75;
const RAD_TO_DEG = 180 / Math.PI;

export type AtlasComputeState = "computed" | "skipped";

export interface AtlasComputeResult {
  state: AtlasComputeState;
  pointCountTotal: number | null;
  pointCountOutdoor: number | null;
  bucketCountTotal: number;
}

export interface AtlasComputeParams {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: RegionTileSpec;
  shadowCalibration: ShadowCalibration;
  /** Angular bucket size in degrees (az and alt). Defaults to 0.75°. */
  resolutionDeg?: number;
  cooperativeYieldEveryPoints?: number;
  onProgress?: (progress: SunlightTileComputeProgress) => void;
  signal?: AbortSignal;
  gridMetadata?: TileGridMetadata | null;
}

/**
 * Resolves which (az, alt) buckets the supplied date window targets at the tile center.
 * Snaps each sample's sun position to a bucket of the specified resolution and dedupes.
 * Skips below-horizon samples.
 */
export function resolveTargetBuckets(
  params: Pick<AtlasComputeParams, "date" | "timezone" | "sampleEveryMinutes" | "startLocalTime" | "endLocalTime">,
  tileCenterLat: number,
  tileCenterLon: number,
  resolutionDeg: number = DEFAULT_ATLAS_RESOLUTION_DEG,
): Array<{ azBucket: number; altBucket: number }> {
  const samples = createUtcSamples(
    params.date,
    params.timezone,
    params.sampleEveryMinutes,
    params.startLocalTime,
    params.endLocalTime,
  );
  const map = new Map<number, { azBucket: number; altBucket: number }>();
  for (const d of samples) {
    const pos = SunCalc.getPosition(d, tileCenterLat, tileCenterLon);
    const altDeg = pos.altitude * RAD_TO_DEG;
    if (altDeg <= 0) continue;
    let azDeg = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (azDeg < 0) azDeg += 360;
    const azB = Math.floor(azDeg / resolutionDeg);
    const altB = Math.floor(altDeg / resolutionDeg);
    const key = packBucketKey(azB, altB);
    if (!map.has(key)) {
      map.set(key, { azBucket: azB, altBucket: altB });
    }
  }
  return Array.from(map.values());
}

/**
 * Bucket-centered atlas compute (ADR-0013):
 *  1. Resolve target (az, alt) buckets from the date/time window at the tile center.
 *  2. Load existing atlas; filter out buckets already covered.
 *  3. If nothing missing → return state="skipped".
 *  4. Otherwise, call computeSunlightTileArtifact with sunOverride = missing bucket centers.
 *  5. Merge new bucket masks into the atlas (existing entries win) and persist.
 */
export async function computeAndMergeAtlasForTile(
  params: AtlasComputeParams,
): Promise<AtlasComputeResult> {
  const resolutionDeg = params.resolutionDeg ?? DEFAULT_ATLAS_RESOLUTION_DEG;
  const centerE = (params.tile.minEasting + params.tile.maxEasting) / 2;
  const centerN = (params.tile.minNorthing + params.tile.maxNorthing) / 2;
  const tileCenter = lv95ToWgs84(centerE, centerN);

  const targetBuckets = resolveTargetBuckets(
    params,
    tileCenter.lat,
    tileCenter.lon,
    resolutionDeg,
  );

  const existingAtlas = await loadPrecomputedTileAtlas({
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    gridStepMeters: params.gridStepMeters,
    tileId: params.tile.tileId,
    resolutionDeg,
  });

  const existingKeys = existingAtlas ? getAtlasBucketKeySet(existingAtlas) : new Set<number>();
  const missing = targetBuckets.filter(
    (b) => !existingKeys.has(packBucketKey(b.azBucket, b.altBucket)),
  );

  if (missing.length === 0) {
    return {
      state: "skipped",
      pointCountTotal: existingAtlas?.pointCount ?? null,
      pointCountOutdoor: existingAtlas?.outdoorPointCount ?? null,
      bucketCountTotal: existingAtlas?.bucketCount ?? 0,
    };
  }

  const sunOverride = missing.map((b) => ({
    azimuthDeg: (b.azBucket + 0.5) * resolutionDeg,
    altitudeDeg: (b.altBucket + 0.5) * resolutionDeg,
  }));

  const artifact = await computeSunlightTileArtifact({
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    algorithmVersion: params.algorithmVersion,
    date: params.date,
    timezone: params.timezone,
    sampleEveryMinutes: params.sampleEveryMinutes,
    gridStepMeters: params.gridStepMeters,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tile: params.tile,
    shadowCalibration: params.shadowCalibration,
    cooperativeYieldEveryPoints: params.cooperativeYieldEveryPoints,
    signal: params.signal,
    gridMetadata: params.gridMetadata,
    sunOverride,
    onProgress: params.onProgress,
  });

  const pointCount = artifact.points.length;
  const pointLon = new Float64Array(pointCount);
  const pointLat = new Float64Array(pointCount);
  const pointIx = new Int32Array(pointCount);
  const pointIy = new Int32Array(pointCount);
  const pointOutdoorIndex = new Int32Array(pointCount);
  const pointFlags = new Uint32Array(pointCount);
  const pointIds: string[] = new Array(pointCount);
  const indoorBuildingIds: Array<string | null> = new Array(pointCount);
  const pointElevationMeters: Array<number | null> = new Array(pointCount);
  const pointLv95Easting: number[] = new Array(pointCount);
  const pointLv95Northing: number[] = new Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    const p = artifact.points[i];
    pointLon[i] = p.lon;
    pointLat[i] = p.lat;
    pointIx[i] = p.ix;
    pointIy[i] = p.iy;
    pointOutdoorIndex[i] = p.outdoorIndex ?? -1;
    pointFlags[i] = p.insideBuilding ? 1 : 0;
    pointIds[i] = p.id;
    indoorBuildingIds[i] = p.indoorBuildingId;
    pointElevationMeters[i] = p.pointElevationMeters;
    pointLv95Easting[i] = p.lv95Easting;
    pointLv95Northing[i] = p.lv95Northing;
  }
  const outdoorPointCount = artifact.stats.pointCount;
  const maskBytesPerBucket = Math.ceil(outdoorPointCount / 8);

  const newBuckets: AtlasBucketEntry[] = [];
  for (let i = 0; i < artifact.frames.length; i++) {
    const frame = artifact.frames[i];
    const bucket = missing[i];
    newBuckets.push({
      azBucket: bucket.azBucket,
      altBucket: bucket.altBucket,
      sunMask: Buffer.from(frame.sunMaskBase64, "base64"),
      sunNoVegMask: Buffer.from(frame.sunMaskNoVegetationBase64, "base64"),
      terrainMask: Buffer.from(frame.terrainBlockedMaskBase64, "base64"),
      buildingsMask: Buffer.from(frame.buildingsBlockedMaskBase64, "base64"),
      vegetationMask: Buffer.from(frame.vegetationBlockedMaskBase64, "base64"),
    });
  }

  const meta: TileAtlasMetadata = {
    atlasFormatVersion: 1,
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    gridStepMeters: params.gridStepMeters,
    resolutionDegAz: resolutionDeg,
    resolutionDegAlt: resolutionDeg,
    tile: params.tile,
    model: artifact.model as unknown as Record<string, unknown>,
    warnings: artifact.warnings,
    stats: {
      bucketCount: 0,
      pointCount,
      outdoorPointCount,
      sourceFramesTotal:
        (existingAtlas?.meta.stats.sourceFramesTotal ?? 0) + artifact.frames.length,
    },
    pointIds,
    indoorBuildingIds,
    pointElevationMeters,
    pointLv95Easting,
    pointLv95Northing,
  };

  const merged = mergeBucketsIntoAtlas({
    existing: existingAtlas,
    meta,
    pointCount,
    outdoorPointCount,
    maskBytesPerBucket,
    resolutionDegAz: resolutionDeg,
    resolutionDegAlt: resolutionDeg,
    pointLon,
    pointLat,
    pointIx,
    pointIy,
    pointOutdoorIndex,
    pointFlags,
    newBuckets,
  });

  await writePrecomputedTileAtlas(merged, {
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    gridStepMeters: params.gridStepMeters,
    tileId: params.tile.tileId,
    resolutionDeg,
  });

  return {
    state: "computed",
    pointCountTotal: pointCount,
    pointCountOutdoor: outdoorPointCount,
    bucketCountTotal: merged.bucketCount,
  };
}
