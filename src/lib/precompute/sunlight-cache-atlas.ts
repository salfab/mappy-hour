import fs from "node:fs/promises";
import { promisify } from "node:util";
import { gzip as gzipCb, gunzip as gunzipCb } from "node:zlib";
import path from "node:path";

// Lazy-loaded: native binary may not be compiled in dev/CI without build tools.
// Falls back to gzip when unavailable (see compressAtlasPayload / decompressAtlasPayload).
let _zstd: { compress: typeof import("@mongodb-js/zstd").compress; decompress: typeof import("@mongodb-js/zstd").decompress } | null | undefined;
function getZstd() {
  if (_zstd === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _zstd = require("@mongodb-js/zstd");
    } catch {
      _zstd = null;
    }
  }
  return _zstd;
}

import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";
import { getSunlightCacheStorage } from "./sunlight-cache-storage";
import type { PrecomputedRegionName, RegionTileSpec } from "./sunlight-cache";
import { recordAtlasDrift } from "./atlas-drift-sink";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

// Atlas compression: zstd is 3-5× faster to decompress than gzip for ~similar
// ratio. Old atlases on disk are still gzip — the reader detects the format
// via magic bytes (gzip: 1F 8B / zstd: 28 B5 2F FD) so existing files keep
// working until next overwrite. Override via MAPPY_ATLAS_COMPRESSION=gzip|zstd.
function getAtlasCompressionMode(): "zstd" | "gzip" {
  const raw = (process.env.MAPPY_ATLAS_COMPRESSION ?? "").trim().toLowerCase();
  return raw === "gzip" ? "gzip" : "zstd";
}

async function compressAtlasPayload(bin: Buffer): Promise<Buffer> {
  if (getAtlasCompressionMode() === "gzip") {
    return (await gzip(bin, { level: 1 })) as Buffer;
  }
  const zstd = getZstd();
  if (!zstd) {
    // Native zstd unavailable (no build tools); fall back to gzip.
    return (await gzip(bin, { level: 1 })) as Buffer;
  }
  // zstd level 3: default sweet spot. Bench (130 MB raw atlas) shows ~50ms
  // compress + ~400ms decompress vs gzip-1's 89ms / 2400ms. Wall-time win is
  // dominated by decompress (read-heavy hot path).
  return await zstd.compress(bin, 3);
}

async function decompressAtlasPayload(buf: Buffer): Promise<Buffer> {
  // Magic bytes: gzip = 1F 8B, zstd = 28 B5 2F FD
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return (await gunzip(buf)) as Buffer;
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x28 &&
    buf[1] === 0xb5 &&
    buf[2] === 0x2f &&
    buf[3] === 0xfd
  ) {
    const zstd = getZstd();
    if (!zstd) throw new Error("[atlas-decompress] zstd binary unavailable; reinstall with build tools or set MAPPY_ATLAS_COMPRESSION=gzip");
    return await zstd.decompress(buf);
  }
  throw new Error(
    `[atlas-decompress] unknown compression format (first bytes ${[...buf.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ")})`,
  );
}

/**
 * Atomic write: writes to a temporary file then renames into place. On POSIX
 * rename is atomic. On Windows, `fs.rename` uses MoveFileEx with
 * MOVEFILE_REPLACE_EXISTING so the target is replaced atomically too.
 *
 * Guarantees that readers never observe a half-written file — either the old
 * content or the new content, never a truncated/corrupted payload. This is the
 * crash-consistency foundation the atlas + sidecar pair relies on.
 *
 * Retries on EPERM/EBUSY/EACCES because Windows AV (Defender, etc.) opens
 * freshly-written files for scanning and briefly holds a handle that blocks
 * the rename. The race window is short — a short backoff is enough.
 */
async function writeFileAtomic(targetPath: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, data);

    const transientCodes = new Set(["EPERM", "EBUSY", "EACCES"]);
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await fs.rename(tmpPath, targetPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !transientCodes.has(code) || attempt === maxAttempts) {
          throw error;
        }
        const delayMs = 50 * 2 ** (attempt - 1); // 50, 100, 200, 400, 800, 1600
        console.warn(
          `[atlas-write] rename ${code} on ${path.basename(targetPath)} (attempt ${attempt}/${maxAttempts}) — retry in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

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

// Atlas sidecar index — lightweight, uncompressed companion file holding
// just the bucket presence info needed for precompute skip-checks. Avoids
// gunzipping ~350KB of masks when we only need ~2KB of (az,alt) pairs.
// Layout (little-endian):
//   [0..4)   magic u32 = 0x49445841 ('IDXA')
//   [4..6)   version u16 = 1
//   [6..8)   flags u16 (reserved)
//   [8..12)  pointCount u32
//   [12..16) outdoorPointCount u32
//   [16..20) bucketCount u32
//   [20..24) resolutionDegAz f32
//   [24..28) resolutionDegAlt f32
//   [28..)   bucketCount × { azBucket u16, altBucket u16 }
export const ATLAS_IDX_MAGIC = 0x49445841;
export const ATLAS_IDX_VERSION = 1;
export const ATLAS_IDX_HEADER_BYTES = 28;
export const ATLAS_IDX_ENTRY_BYTES = 4;

export interface TileAtlasIndex {
  pointCount: number;
  outdoorPointCount: number;
  bucketCount: number;
  resolutionDegAz: number;
  resolutionDegAlt: number;
  bucketAz: Uint16Array;
  bucketAlt: Uint16Array;
}

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

/**
 * Lookup by sun position (degrees). Cascades through the provided atlases in
 * order (typically r0.5 → r0.75 → r1 per `ATLAS_READ_FALLBACK_RESOLUTIONS_DEG`)
 * and returns the first atlas that has an exact bucket match. Returns null if
 * no atlas covers the requested (az, alt) — the caller must treat that as a
 * cache miss rather than "no sun".
 */
export function lookupAtlasByAngle(
  atlases: BinaryTileAtlas[],
  azimuthDeg: number,
  altitudeDeg: number,
): AtlasBucketEntry | null {
  if (altitudeDeg <= 0) return null;
  for (const atlas of atlases) {
    const azB = Math.floor(azimuthDeg / atlas.resolutionDegAz);
    const altB = Math.floor(altitudeDeg / atlas.resolutionDegAlt);
    const hit = lookupAtlasBucket(atlas, azB, altB);
    if (hit) return hit;
  }
  return null;
}

export function getAtlasPath(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg?: number;
}): string {
  const resSuffix = params.resolutionDeg != null ? `r${params.resolutionDeg}` : "r0.75";
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

export function getAtlasIndexPath(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg?: number;
}): string {
  const resSuffix = params.resolutionDeg != null ? `r${params.resolutionDeg}` : "r0.75";
  return path.join(
    CACHE_SUNLIGHT_DIR,
    params.region,
    params.modelVersionHash,
    `g${params.gridStepMeters}`,
    "atlas",
    resSuffix,
    `${params.tileId}.atlas.idx`,
  );
}

export function encodeTileAtlasIndex(index: TileAtlasIndex): Buffer {
  const total = ATLAS_IDX_HEADER_BYTES + index.bucketCount * ATLAS_IDX_ENTRY_BYTES;
  const buf = Buffer.alloc(total);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(0, ATLAS_IDX_MAGIC, true);
  view.setUint16(4, ATLAS_IDX_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, index.pointCount, true);
  view.setUint32(12, index.outdoorPointCount, true);
  view.setUint32(16, index.bucketCount, true);
  view.setFloat32(20, index.resolutionDegAz, true);
  view.setFloat32(24, index.resolutionDegAlt, true);
  for (let i = 0; i < index.bucketCount; i++) {
    const base = ATLAS_IDX_HEADER_BYTES + i * ATLAS_IDX_ENTRY_BYTES;
    view.setUint16(base + 0, index.bucketAz[i], true);
    view.setUint16(base + 2, index.bucketAlt[i], true);
  }
  return buf;
}

export function decodeTileAtlasIndex(raw: Uint8Array): TileAtlasIndex {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== ATLAS_IDX_MAGIC) {
    throw new Error(`Bad magic in atlas index sidecar: 0x${magic.toString(16)}`);
  }
  const version = view.getUint16(4, true);
  if (version !== ATLAS_IDX_VERSION) {
    throw new Error(`Unsupported atlas index version: ${version}`);
  }
  const pointCount = view.getUint32(8, true);
  const outdoorPointCount = view.getUint32(12, true);
  const bucketCount = view.getUint32(16, true);
  const resolutionDegAz = view.getFloat32(20, true);
  const resolutionDegAlt = view.getFloat32(24, true);
  const bucketAz = new Uint16Array(bucketCount);
  const bucketAlt = new Uint16Array(bucketCount);
  for (let i = 0; i < bucketCount; i++) {
    const base = ATLAS_IDX_HEADER_BYTES + i * ATLAS_IDX_ENTRY_BYTES;
    bucketAz[i] = view.getUint16(base + 0, true);
    bucketAlt[i] = view.getUint16(base + 2, true);
  }
  return {
    pointCount,
    outdoorPointCount,
    bucketCount,
    resolutionDegAz,
    resolutionDegAlt,
    bucketAz,
    bucketAlt,
  };
}

export function atlasToIndex(atlas: BinaryTileAtlas): TileAtlasIndex {
  return {
    pointCount: atlas.pointCount,
    outdoorPointCount: atlas.outdoorPointCount,
    bucketCount: atlas.bucketCount,
    resolutionDegAz: atlas.resolutionDegAz,
    resolutionDegAlt: atlas.resolutionDegAlt,
    bucketAz: atlas.bucketAz,
    bucketAlt: atlas.bucketAlt,
  };
}

export async function writeTileAtlasIndex(
  index: TileAtlasIndex,
  params: {
    region: PrecomputedRegionName;
    modelVersionHash: string;
    gridStepMeters: number;
    tileId: string;
    resolutionDeg?: number;
  },
): Promise<void> {
  const targetPath = getAtlasIndexPath(params);
  const buf = encodeTileAtlasIndex(index);
  await writeFileAtomic(targetPath, buf);
}

export async function loadTileAtlasIndex(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg?: number;
}): Promise<TileAtlasIndex | null> {
  const storage = getSunlightCacheStorage();
  const targetPath = getAtlasIndexPath(params);
  let raw: Buffer;
  try {
    raw = await storage.readBuffer(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // Tolerate a corrupt/partially-written sidecar (e.g. from a pre-atomic-write
  // crash, or a writer crash on another platform). Caller falls back to the
  // full-atlas load, which rewrites a fresh sidecar.
  try {
    return decodeTileAtlasIndex(raw);
  } catch (error) {
    console.warn(
      `[atlas-idx] corrupt sidecar ignored at ${targetPath}: ${(error as Error).message}`,
    );
    return null;
  }
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
  const targetPath = getAtlasPath(params);
  const bin = encodeTileAtlasToBinary(atlas);
  // Compression mode toggle (zstd default, gzip fallback via env). zstd level 3
  // is the default sweet spot — see compressAtlasPayload for rationale.
  const compressed = await compressAtlasPayload(bin);
  // Atlas first, then sidecar. Order matters for crash consistency: a stale
  // sidecar under-reports coverage → safe fallback to full atlas load. The
  // inverse (sidecar claiming buckets missing from atlas) would silently
  // corrupt skip decisions.
  await writeFileAtomic(targetPath, compressed);
  await writeTileAtlasIndex(atlasToIndex(atlas), params);
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
    const raw = await decompressAtlasPayload(compressed);
    return decodeTileAtlasFromBinary(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolution fallback order for read-side atlas lookups.
 * r0.5 is the highest precision (rare, expensive to compute); r0.75 is the current default;
 * r1 is the legacy corpus that predates angle-keyed caching. Read the first one that exists.
 */
export const ATLAS_READ_FALLBACK_RESOLUTIONS_DEG = [0.5, 0.75, 1] as const;

/**
 * Loads every available atlas for a tile in precision order (r0.5 → r0.75 → r1).
 * Returns an array — possibly empty — ordered so that bucket lookup can cascade:
 * try the highest precision first, fall through to coarser resolutions when the
 * exact (az, alt) bucket is missing. An r0.5 atlas that only covers a partial
 * date range will no longer mask a complete r0.75 corpus.
 */
export async function loadPrecomputedTileAtlasesInPrecisionOrder(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
}): Promise<BinaryTileAtlas[]> {
  const atlases: BinaryTileAtlas[] = [];
  for (const resolutionDeg of ATLAS_READ_FALLBACK_RESOLUTIONS_DEG) {
    const atlas = await loadPrecomputedTileAtlas({ ...params, resolutionDeg });
    if (atlas) atlases.push(atlas);
  }
  return atlases;
}

/** Returns a Set of packed bucket keys (altBucket << 16 | azBucket) for fast membership tests. */
export function getAtlasBucketKeySet(atlas: BinaryTileAtlas): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < atlas.bucketCount; i++) {
    s.add((atlas.bucketAlt[i] << 16) | atlas.bucketAz[i]);
  }
  return s;
}

/** Pack an (az, alt) bucket pair into the same key format as getAtlasBucketKeySet. */
export function packBucketKey(azBucket: number, altBucket: number): number {
  return (altBucket << 16) | azBucket;
}

/**
 * Merges a set of new (az, alt) buckets into an existing atlas (or creates a fresh atlas if
 * existing is null). When a bucket key (az, alt) exists in both, the NEW bucket wins —
 * the existing stale value is overwritten. Duplicates within newBuckets itself keep the
 * first occurrence. Returns a fresh BinaryTileAtlas with all buckets sorted by
 * (altBucket asc, azBucket asc).
 *
 * Tile points are copied from the existing atlas when present; otherwise taken from the
 * params (they are assumed identical per tile geometry).
 */
export function mergeBucketsIntoAtlas(params: {
  existing: BinaryTileAtlas | null;
  meta: TileAtlasMetadata;
  pointCount: number;
  outdoorPointCount: number;
  maskBytesPerBucket: number;
  resolutionDegAz: number;
  resolutionDegAlt: number;
  pointLon: Float64Array;
  pointLat: Float64Array;
  pointIx: Int32Array;
  pointIy: Int32Array;
  pointOutdoorIndex: Int32Array;
  pointFlags: Uint32Array;
  newBuckets: AtlasBucketEntry[];
}): BinaryTileAtlas {
  const { existing, newBuckets, maskBytesPerBucket } = params;
  const perBucketBytes = ATLAS_MASK_KINDS * maskBytesPerBucket;

  if (existing != null && existing.maskBytesPerBucket !== maskBytesPerBucket) {
    // Outdoor-count drift detected: the existing atlas was written with a
    // different `outdoorCount` (typically ±1-5 points caused by the gpu-raster
    // zenith non-determinism on building edges). The two bitmask layouts are
    // indexed on different point sets, so they cannot be merged. We invalidate
    // the stale atlas, emit a drift record so the orchestrator can produce a
    // patch script (see atlas-drift-sink.ts), and write fresh with the new
    // buckets only.
    console.warn(
      `[atlas-merge] outdoor count drift on ${params.meta.tile.tileId}: ` +
        `existing=${existing.outdoorPointCount} (${existing.maskBytesPerBucket} B/bucket, ` +
        `${existing.bucketCount} buckets), ` +
        `new=${params.outdoorPointCount} (${maskBytesPerBucket} B/bucket). ` +
        `Invalidating stale atlas, writing fresh.`,
    );
    recordAtlasDrift({
      region: params.meta.region,
      modelVersionHash: params.meta.modelVersionHash,
      gridStepMeters: params.meta.gridStepMeters,
      tileId: params.meta.tile.tileId,
      resolutionDeg: params.meta.resolutionDegAz,
      previousOutdoorCount: existing.outdoorPointCount,
      newOutdoorCount: params.outdoorPointCount,
      previousMaskBytesPerBucket: existing.maskBytesPerBucket,
      newMaskBytesPerBucket: maskBytesPerBucket,
      previousBucketCount: existing.bucketCount,
      detectedAt: new Date().toISOString(),
    });
    return mergeBucketsIntoAtlas({ ...params, existing: null });
  }

  type Slot = { azBucket: number; altBucket: number; maskSource: Uint8Array; maskSourceOffset: number };
  const slots: Slot[] = [];
  const seen = new Set<number>();

  // Priorité aux nouveaux buckets : s'ils existent dans l'existant avec la
  // même clé (az, alt), les nouveaux écrasent les anciens. Si on précalcule,
  // l'intention est d'écrire ; le skip silencieux masquait des bugs de
  // régénération (les buckets corrompus d'un ancien run survivaient à
  // l'éternité, seule la suppression manuelle du fichier pouvait forcer
  // un recalcul). Voir diag/check-vulkan-vs-gpuraster.ts.
  for (const b of newBuckets) {
    const key = packBucketKey(b.azBucket, b.altBucket);
    if (seen.has(key)) continue; // doublon au sein de newBuckets lui-même
    seen.add(key);
    const block = new Uint8Array(perBucketBytes);
    block.set(b.sunMask, 0 * maskBytesPerBucket);
    block.set(b.sunNoVegMask, 1 * maskBytesPerBucket);
    block.set(b.terrainMask, 2 * maskBytesPerBucket);
    block.set(b.buildingsMask, 3 * maskBytesPerBucket);
    block.set(b.vegetationMask, 4 * maskBytesPerBucket);
    slots.push({
      azBucket: b.azBucket,
      altBucket: b.altBucket,
      maskSource: block,
      maskSourceOffset: 0,
    });
  }

  if (existing != null) {
    for (let i = 0; i < existing.bucketCount; i++) {
      const azB = existing.bucketAz[i];
      const altB = existing.bucketAlt[i];
      const key = packBucketKey(azB, altB);
      if (seen.has(key)) continue; // un nouveau bucket a priorité
      seen.add(key);
      const dataIndex = existing.bucketDataIndex[i];
      slots.push({
        azBucket: azB,
        altBucket: altB,
        maskSource: existing.maskBuffer,
        maskSourceOffset: dataIndex * perBucketBytes,
      });
    }
  }

  slots.sort((a, b) => {
    if (a.altBucket !== b.altBucket) return a.altBucket - b.altBucket;
    return a.azBucket - b.azBucket;
  });

  const bucketCount = slots.length;
  const bucketAz = new Uint16Array(bucketCount);
  const bucketAlt = new Uint16Array(bucketCount);
  const bucketDataIndex = new Uint32Array(bucketCount);
  const maskBuffer = new Uint8Array(bucketCount * perBucketBytes);

  for (let i = 0; i < bucketCount; i++) {
    const s = slots[i];
    bucketAz[i] = s.azBucket;
    bucketAlt[i] = s.altBucket;
    bucketDataIndex[i] = i;
    maskBuffer.set(
      s.maskSource.subarray(s.maskSourceOffset, s.maskSourceOffset + perBucketBytes),
      i * perBucketBytes,
    );
  }

  const meta: TileAtlasMetadata = {
    ...params.meta,
    stats: {
      ...params.meta.stats,
      bucketCount,
    },
  };

  return {
    meta,
    pointCount: params.pointCount,
    bucketCount,
    outdoorPointCount: params.outdoorPointCount,
    maskBytesPerBucket,
    resolutionDegAz: params.resolutionDegAz,
    resolutionDegAlt: params.resolutionDegAlt,
    pointLon: existing?.pointLon ?? params.pointLon,
    pointLat: existing?.pointLat ?? params.pointLat,
    pointIx: existing?.pointIx ?? params.pointIx,
    pointIy: existing?.pointIy ?? params.pointIy,
    pointOutdoorIndex: existing?.pointOutdoorIndex ?? params.pointOutdoorIndex,
    pointFlags: existing?.pointFlags ?? params.pointFlags,
    bucketAz,
    bucketAlt,
    bucketDataIndex,
    maskBuffer,
  };
}
