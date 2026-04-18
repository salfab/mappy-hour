import { promisify } from "node:util";
import { gzip as gzipCb, gunzip as gunzipCb } from "node:zlib";
import path from "node:path";

import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";
import { getSunlightCacheStorage } from "./sunlight-cache-storage";
import type { PrecomputedRegionName, RegionTileSpec } from "./sunlight-cache";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

// Binary atlas format (angle-keyed cache, ADR-0013).
// One file per tile, all (az, alt) buckets inside.
//
// Layout (little-endian):
//   [0..4)   magic u32  = 0x4154534C ('ATSL' — Atlas Sun LV95)
//   [4..6)   version u16 = 1
//   [6..8)   flags u16 (reserved)
//   [8..12)  jsonMetaBytes u32
//   [12..16) pointCount u32
//   [16..20) bucketCount u32
//   [20..24) outdoorPointCount u32 (bits per mask)
//   [24..28) maskBytesPerBucket u32 (size of ONE mask)
//   [28..32) pointStride u32 (= 32 for v1)
//   [32..36) resolutionDegAz f32
//   [36..40) resolutionDegAlt f32
//   [40..44) (padding / reserved)
//   [44..48) (padding / reserved)
//   [48..48+jsonMetaBytes) UTF-8 JSON metadata
//   [pointsOffset..+pointCount*pointStride) packed points (identical to tile binary)
//       per point (32 bytes): lon f64, lat f64, ix i32, iy i32, outdoorIndex i32, flags u32
//   [bucketIndexOffset..+bucketCount*8) bucket index, sorted by (altBucket asc, azBucket asc)
//       per entry (8 bytes): azBucket u16, altBucket u16, dataIndex u32
//   [bucketDataOffset..+bucketCount*maskBytesPerBucket*5) masks
//       for each bucket in index order: 5 masks × maskBytesPerBucket
//       kinds in order: 0=sun, 1=sunNoVeg, 2=terrainBlocked, 3=buildings, 4=vegetation

export const ATLAS_MAGIC = 0x4154534c;
export const ATLAS_VERSION = 1;
export const ATLAS_HEADER_BYTES = 48;
export const ATLAS_POINT_STRIDE = 32;
export const ATLAS_MASK_KINDS = 5;
export const ATLAS_BUCKET_INDEX_ENTRY_BYTES = 8;

export const ATLAS_MASK_KIND_SUN = 0;
export const ATLAS_MASK_KIND_SUN_NO_VEG = 1;
export const ATLAS_MASK_KIND_TERRAIN_BLOCKED = 2;
export const ATLAS_MASK_KIND_BUILDINGS_BLOCKED = 3;
export const ATLAS_MASK_KIND_VEGETATION_BLOCKED = 4;

export interface TileAtlasMetadata {
  atlasFormatVersion: number;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  resolutionDegAz: number;
  resolutionDegAlt: number;
  tile: RegionTileSpec;
  model?: Record<string, unknown>;
  warnings: string[];
  stats: {
    bucketCount: number;
    pointCount: number;
    outdoorPointCount: number;
    sourceFramesTotal: number;
    sourceDateRange?: { startDate: string; endDate: string; dayCount: number };
  };
  pointIds?: string[];
  indoorBuildingIds?: Array<string | null>;
  pointElevationMeters?: Array<number | null>;
  pointLv95Easting?: number[];
  pointLv95Northing?: number[];
}

export interface BinaryTileAtlas {
  meta: TileAtlasMetadata;
  pointCount: number;
  bucketCount: number;
  outdoorPointCount: number;
  maskBytesPerBucket: number;
  resolutionDegAz: number;
  resolutionDegAlt: number;
  // Points (typed arrays, same layout as BinaryTileArtifact)
  pointLon: Float64Array;
  pointLat: Float64Array;
  pointIx: Int32Array;
  pointIy: Int32Array;
  pointOutdoorIndex: Int32Array;
  pointFlags: Uint32Array;
  // Bucket index (sorted by altBucket asc, azBucket asc)
  bucketAz: Uint16Array;
  bucketAlt: Uint16Array;
  bucketDataIndex: Uint32Array;
  /** Concatenated masks: bucketCount * 5 * maskBytesPerBucket bytes. */
  maskBuffer: Uint8Array;
}

export interface AtlasBucketEntry {
  azBucket: number;
  altBucket: number;
  sunMask: Uint8Array;
  sunNoVegMask: Uint8Array;
  terrainMask: Uint8Array;
  buildingsMask: Uint8Array;
  vegetationMask: Uint8Array;
}

export function encodeTileAtlasToBinary(atlas: BinaryTileAtlas): Buffer {
  const {
    pointCount,
    bucketCount,
    outdoorPointCount,
    maskBytesPerBucket,
    resolutionDegAz,
    resolutionDegAlt,
  } = atlas;

  const metaJson = JSON.stringify(atlas.meta);
  const metaBytes = Buffer.from(metaJson, "utf8");

  const pointsBytes = pointCount * ATLAS_POINT_STRIDE;
  const bucketIndexBytes = bucketCount * ATLAS_BUCKET_INDEX_ENTRY_BYTES;
  const masksBytes = bucketCount * ATLAS_MASK_KINDS * maskBytesPerBucket;
  const total =
    ATLAS_HEADER_BYTES + metaBytes.length + pointsBytes + bucketIndexBytes + masksBytes;

  const buf = Buffer.alloc(total);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  view.setUint32(0, ATLAS_MAGIC, true);
  view.setUint16(4, ATLAS_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, metaBytes.length, true);
  view.setUint32(12, pointCount, true);
  view.setUint32(16, bucketCount, true);
  view.setUint32(20, outdoorPointCount, true);
  view.setUint32(24, maskBytesPerBucket, true);
  view.setUint32(28, ATLAS_POINT_STRIDE, true);
  view.setFloat32(32, resolutionDegAz, true);
  view.setFloat32(36, resolutionDegAlt, true);
  view.setUint32(40, 0, true);
  view.setUint32(44, 0, true);

  metaBytes.copy(buf, ATLAS_HEADER_BYTES);

  const pointsOffset = ATLAS_HEADER_BYTES + metaBytes.length;
  for (let i = 0; i < pointCount; i++) {
    const base = pointsOffset + i * ATLAS_POINT_STRIDE;
    view.setFloat64(base + 0, atlas.pointLon[i], true);
    view.setFloat64(base + 8, atlas.pointLat[i], true);
    view.setInt32(base + 16, atlas.pointIx[i], true);
    view.setInt32(base + 20, atlas.pointIy[i], true);
    view.setInt32(base + 24, atlas.pointOutdoorIndex[i], true);
    view.setUint32(base + 28, atlas.pointFlags[i], true);
  }

  const bucketIndexOffset = pointsOffset + pointsBytes;
  for (let i = 0; i < bucketCount; i++) {
    const base = bucketIndexOffset + i * ATLAS_BUCKET_INDEX_ENTRY_BYTES;
    view.setUint16(base + 0, atlas.bucketAz[i], true);
    view.setUint16(base + 2, atlas.bucketAlt[i], true);
    view.setUint32(base + 4, atlas.bucketDataIndex[i], true);
  }

  const bucketDataOffset = bucketIndexOffset + bucketIndexBytes;
  buf.set(atlas.maskBuffer, bucketDataOffset);

  return buf;
}

export function decodeTileAtlasFromBinary(raw: Uint8Array): BinaryTileAtlas {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== ATLAS_MAGIC) {
    throw new Error(`Bad magic in binary tile atlas: 0x${magic.toString(16)}`);
  }
  const version = view.getUint16(4, true);
  if (version !== ATLAS_VERSION) {
    throw new Error(`Unsupported atlas version: ${version}`);
  }
  const jsonMetaBytes = view.getUint32(8, true);
  const pointCount = view.getUint32(12, true);
  const bucketCount = view.getUint32(16, true);
  const outdoorPointCount = view.getUint32(20, true);
  const maskBytesPerBucket = view.getUint32(24, true);
  const pointStride = view.getUint32(28, true);
  if (pointStride !== ATLAS_POINT_STRIDE) {
    throw new Error(`Unexpected pointStride: ${pointStride}`);
  }
  const resolutionDegAz = view.getFloat32(32, true);
  const resolutionDegAlt = view.getFloat32(36, true);

  const metaStart = ATLAS_HEADER_BYTES;
  const metaEnd = metaStart + jsonMetaBytes;
  const metaJson = Buffer.from(raw.buffer, raw.byteOffset + metaStart, jsonMetaBytes).toString("utf8");
  const meta = JSON.parse(metaJson) as TileAtlasMetadata;

  const pointLon = new Float64Array(pointCount);
  const pointLat = new Float64Array(pointCount);
  const pointIx = new Int32Array(pointCount);
  const pointIy = new Int32Array(pointCount);
  const pointOutdoorIndex = new Int32Array(pointCount);
  const pointFlags = new Uint32Array(pointCount);
  const pointsOffset = metaEnd;
  for (let i = 0; i < pointCount; i++) {
    const base = pointsOffset + i * pointStride;
    pointLon[i] = view.getFloat64(base + 0, true);
    pointLat[i] = view.getFloat64(base + 8, true);
    pointIx[i] = view.getInt32(base + 16, true);
    pointIy[i] = view.getInt32(base + 20, true);
    pointOutdoorIndex[i] = view.getInt32(base + 24, true);
    pointFlags[i] = view.getUint32(base + 28, true);
  }

  const bucketIndexOffset = pointsOffset + pointCount * pointStride;
  const bucketAz = new Uint16Array(bucketCount);
  const bucketAlt = new Uint16Array(bucketCount);
  const bucketDataIndex = new Uint32Array(bucketCount);
  for (let i = 0; i < bucketCount; i++) {
    const base = bucketIndexOffset + i * ATLAS_BUCKET_INDEX_ENTRY_BYTES;
    bucketAz[i] = view.getUint16(base + 0, true);
    bucketAlt[i] = view.getUint16(base + 2, true);
    bucketDataIndex[i] = view.getUint32(base + 4, true);
  }

  const bucketDataOffset = bucketIndexOffset + bucketCount * ATLAS_BUCKET_INDEX_ENTRY_BYTES;
  const masksLength = bucketCount * ATLAS_MASK_KINDS * maskBytesPerBucket;
  const maskBuffer = new Uint8Array(raw.buffer, raw.byteOffset + bucketDataOffset, masksLength);

  return {
    meta,
    pointCount,
    bucketCount,
    outdoorPointCount,
    maskBytesPerBucket,
    resolutionDegAz,
    resolutionDegAlt,
    pointLon,
    pointLat,
    pointIx,
    pointIy,
    pointOutdoorIndex,
    pointFlags,
    bucketAz,
    bucketAlt,
    bucketDataIndex,
    maskBuffer,
  };
}

export function getAtlasBucketMasks(atlas: BinaryTileAtlas, dataIndex: number): {
  sunMask: Uint8Array;
  sunNoVegMask: Uint8Array;
  terrainMask: Uint8Array;
  buildingsMask: Uint8Array;
  vegetationMask: Uint8Array;
} {
  const { maskBytesPerBucket, maskBuffer } = atlas;
  const base = dataIndex * ATLAS_MASK_KINDS * maskBytesPerBucket;
  return {
    sunMask: maskBuffer.subarray(base + 0 * maskBytesPerBucket, base + 1 * maskBytesPerBucket),
    sunNoVegMask: maskBuffer.subarray(base + 1 * maskBytesPerBucket, base + 2 * maskBytesPerBucket),
    terrainMask: maskBuffer.subarray(base + 2 * maskBytesPerBucket, base + 3 * maskBytesPerBucket),
    buildingsMask: maskBuffer.subarray(base + 3 * maskBytesPerBucket, base + 4 * maskBytesPerBucket),
    vegetationMask: maskBuffer.subarray(base + 4 * maskBytesPerBucket, base + 5 * maskBytesPerBucket),
  };
}

/** Binary search for a bucket by (azBucket, altBucket). Returns data index or -1. */
export function lookupAtlasBucket(
  atlas: BinaryTileAtlas,
  azBucket: number,
  altBucket: number,
): AtlasBucketEntry | null {
  const { bucketCount, bucketAz, bucketAlt, bucketDataIndex } = atlas;
  // Sorted by altBucket asc, then azBucket asc
  let lo = 0;
  let hi = bucketCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midAlt = bucketAlt[mid];
    const midAz = bucketAz[mid];
    if (midAlt < altBucket || (midAlt === altBucket && midAz < azBucket)) {
      lo = mid + 1;
    } else if (midAlt > altBucket || (midAlt === altBucket && midAz > azBucket)) {
      hi = mid - 1;
    } else {
      const di = bucketDataIndex[mid];
      return { azBucket, altBucket, ...getAtlasBucketMasks(atlas, di) };
    }
  }
  return null;
}

/** Lookup by sun position (degrees). Falls back to nearest bucket if exact not found. */
export function lookupAtlasByAngle(
  atlas: BinaryTileAtlas,
  azimuthDeg: number,
  altitudeDeg: number,
): AtlasBucketEntry | null {
  if (altitudeDeg <= 0) return null;
  const azB = Math.floor(azimuthDeg / atlas.resolutionDegAz);
  const altB = Math.floor(altitudeDeg / atlas.resolutionDegAlt);
  return lookupAtlasBucket(atlas, azB, altB);
}

export function getAtlasPath(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg?: number;
}): string {
  const resSuffix = params.resolutionDeg != null ? `r${params.resolutionDeg}` : "r1";
  return path.join(
    CACHE_SUNLIGHT_DIR,
    params.region,
    params.modelVersionHash,
    `g${params.gridStepMeters}`,
    "atlas",
    resSuffix,
    `${params.tileId}.atlas.bin.gz`,
  );
}

export async function writePrecomputedTileAtlas(
  atlas: BinaryTileAtlas,
  params: {
    region: PrecomputedRegionName;
    modelVersionHash: string;
    gridStepMeters: number;
    tileId: string;
    resolutionDeg?: number;
  },
): Promise<void> {
  const storage = getSunlightCacheStorage();
  const targetPath = getAtlasPath(params);
  const bin = encodeTileAtlasToBinary(atlas);
  const compressed = (await gzip(bin)) as Buffer;
  await storage.writeBuffer(targetPath, compressed);
}

export async function loadPrecomputedTileAtlas(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg?: number;
}): Promise<BinaryTileAtlas | null> {
  const storage = getSunlightCacheStorage();
  const targetPath = getAtlasPath(params);
  try {
    const compressed = await storage.readBuffer(targetPath);
    const raw = (await gunzip(compressed)) as Buffer;
    return decodeTileAtlasFromBinary(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
