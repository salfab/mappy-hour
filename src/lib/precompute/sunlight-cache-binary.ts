import { promisify } from "node:util";
import { gzip as gzipCb, gunzip as gunzipCb } from "node:zlib";
import path from "node:path";

import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";
import { getSunlightCacheStorage } from "./sunlight-cache-storage";
import {
  type PrecomputedRegionName,
  type PrecomputedSunlightTileArtifact,
  type RegionTileSpec,
} from "./sunlight-cache";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

// Binary tile artifact format.
// Layout (little-endian):
//   [0..4)   magic u32  = 0x4D544C53 ('MTLS' — MappyHour Tile LV95 Sun)
//   [4..6)   version u16 = 1
//   [6..8)   flags u16 (reserved)
//   [8..12)  jsonMetaBytes u32
//   [12..16) pointCount u32
//   [16..20) frameCount u32
//   [20..24) outdoorPointCount u32 (bits per mask)
//   [24..28) maskBytesPerFrame u32 (size of ONE mask, not all 5)
//   [28..32) pointStride u32 (bytes per point, = 32 for v1)
//   [32..32+jsonMetaBytes) UTF-8 JSON metadata (small)
//   [pointsOffset..+pointCount*pointStride) packed points
//       u32-aligned. per point (32 bytes):
//         lon f64 (8)
//         lat f64 (8)
//         ix i32 (4)
//         iy i32 (4)
//         outdoorIndex i32 (4, -1 means null)
//         flags u32 (4, bit0 = insideBuilding)
//   [masksOffset..] frameCount * 5 * maskBytesPerFrame raw bit-packed masks
//       kinds in order: 0=sun, 1=sunNoVeg, 2=terrainBlocked, 3=buildings, 4=vegetation

export const BINARY_MAGIC = 0x4d544c53;
export const BINARY_VERSION = 1;
export const HEADER_BYTES = 32;
export const POINT_STRIDE = 32;
export const MASK_KINDS_PER_FRAME = 5;

export const MASK_KIND_SUN = 0;
export const MASK_KIND_SUN_NO_VEG = 1;
export const MASK_KIND_TERRAIN_BLOCKED = 2;
export const MASK_KIND_BUILDINGS_BLOCKED = 3;
export const MASK_KIND_VEGETATION_BLOCKED = 4;

export interface BinaryTileMetadata {
  artifactFormatVersion: number;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: RegionTileSpec;
  model: PrecomputedSunlightTileArtifact["model"];
  warnings: string[];
  stats: PrecomputedSunlightTileArtifact["stats"];
  framesMeta: Array<{
    index: number;
    localTime: string;
    utcTime: string;
    sunnyCount: number;
    sunnyCountNoVegetation: number;
  }>;
  // Stored point ids/indoorBuildingIds as parallel arrays (only present if non-empty).
  // Most cache-only callers never read these; keeping them as compact arrays
  // avoids bloating the per-point struct.
  pointIds?: string[];
  indoorBuildingIds?: Array<string | null>;
  pointElevationMeters?: Array<number | null>;
  pointLv95Easting?: Float64Array | number[];
  pointLv95Northing?: Float64Array | number[];
}

export interface BinaryTileArtifact {
  meta: BinaryTileMetadata;
  pointCount: number;
  frameCount: number;
  outdoorPointCount: number;
  maskBytesPerFrame: number;
  pointLon: Float64Array;
  pointLat: Float64Array;
  pointIx: Int32Array;
  pointIy: Int32Array;
  pointOutdoorIndex: Int32Array;
  pointFlags: Uint32Array;
  /** Concatenated masks: frameCount * 5 * maskBytesPerFrame bytes. */
  maskBuffer: Uint8Array;
}

const BASE64_DECODE_TABLE = (() => {
  const t = new Int8Array(256).fill(-1);
  const alpha =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alpha.length; i++) t[alpha.charCodeAt(i)] = i;
  return t;
})();

function decodeBase64ToUint8Array(s: string): Uint8Array {
  // Buffer.from(s, 'base64') is fast in Node; use it directly.
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function encodeTileArtifactToBinary(
  artifact: PrecomputedSunlightTileArtifact,
): Buffer {
  const pointCount = artifact.points.length;
  const frameCount = artifact.frames.length;

  // The mask buffer length is always ceil(outdoor/8), so the buffer-implied count
  // rounds UP to the next byte boundary — which introduces up to 7 "phantom bits"
  // (e.g. 28818 real outdoor points → 3603 bytes → 28824 implied bits, 6 phantom).
  // Use the authoritative count from artifact.stats.pointCount, which matches
  // max(pointOutdoorIndex)+1 and count(pointOutdoorIndex != -1).
  const outdoorPointCount = artifact.stats.pointCount;
  const maskBytesPerFrame =
    frameCount > 0
      ? decodeBase64ToUint8Array(artifact.frames[0].sunMaskBase64).length
      : 0;

  const pointIds: string[] = new Array(pointCount);
  const indoorBuildingIds: Array<string | null> = new Array(pointCount);
  const pointElevationMeters: Array<number | null> = new Array(pointCount);
  const pointLv95Easting = new Float64Array(pointCount);
  const pointLv95Northing = new Float64Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    const p = artifact.points[i];
    pointIds[i] = p.id;
    indoorBuildingIds[i] = p.indoorBuildingId;
    pointElevationMeters[i] = p.pointElevationMeters;
    pointLv95Easting[i] = p.lv95Easting;
    pointLv95Northing[i] = p.lv95Northing;
  }

  const metadata: BinaryTileMetadata = {
    artifactFormatVersion: artifact.artifactFormatVersion,
    region: artifact.region,
    modelVersionHash: artifact.modelVersionHash,
    date: artifact.date,
    timezone: artifact.timezone,
    gridStepMeters: artifact.gridStepMeters,
    sampleEveryMinutes: artifact.sampleEveryMinutes,
    startLocalTime: artifact.startLocalTime,
    endLocalTime: artifact.endLocalTime,
    tile: artifact.tile,
    model: artifact.model,
    warnings: artifact.warnings,
    stats: artifact.stats,
    framesMeta: artifact.frames.map((f) => ({
      index: f.index,
      localTime: f.localTime,
      utcTime: f.utcTime,
      sunnyCount: f.sunnyCount,
      sunnyCountNoVegetation: f.sunnyCountNoVegetation,
    })),
    pointIds,
    indoorBuildingIds,
    pointElevationMeters,
    pointLv95Easting: Array.from(pointLv95Easting),
    pointLv95Northing: Array.from(pointLv95Northing),
  };

  const metaJson = JSON.stringify(metadata);
  const metaBytes = Buffer.from(metaJson, "utf8");

  const pointsBytes = pointCount * POINT_STRIDE;
  const masksBytes = frameCount * MASK_KINDS_PER_FRAME * maskBytesPerFrame;
  const total = HEADER_BYTES + metaBytes.length + pointsBytes + masksBytes;

  const buf = Buffer.alloc(total);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Header
  view.setUint32(0, BINARY_MAGIC, true);
  view.setUint16(4, BINARY_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, metaBytes.length, true);
  view.setUint32(12, pointCount, true);
  view.setUint32(16, frameCount, true);
  view.setUint32(20, outdoorPointCount, true);
  view.setUint32(24, maskBytesPerFrame, true);
  view.setUint32(28, POINT_STRIDE, true);

  // Metadata JSON
  metaBytes.copy(buf, HEADER_BYTES);

  // Points
  const pointsOffset = HEADER_BYTES + metaBytes.length;
  for (let i = 0; i < pointCount; i++) {
    const p = artifact.points[i];
    const base = pointsOffset + i * POINT_STRIDE;
    view.setFloat64(base + 0, p.lon, true);
    view.setFloat64(base + 8, p.lat, true);
    view.setInt32(base + 16, p.ix, true);
    view.setInt32(base + 20, p.iy, true);
    view.setInt32(base + 24, p.outdoorIndex ?? -1, true);
    view.setUint32(base + 28, p.insideBuilding ? 1 : 0, true);
  }

  // Masks
  const masksOffset = pointsOffset + pointsBytes;
  let writeCursor = masksOffset;
  for (const f of artifact.frames) {
    const masks = [
      f.sunMaskBase64,
      f.sunMaskNoVegetationBase64,
      f.terrainBlockedMaskBase64,
      f.buildingsBlockedMaskBase64,
      f.vegetationBlockedMaskBase64,
    ];
    for (const b64 of masks) {
      const bytes = decodeBase64ToUint8Array(b64);
      if (bytes.length !== maskBytesPerFrame) {
        throw new Error(
          `Mask size mismatch: expected ${maskBytesPerFrame}, got ${bytes.length} on frame ${f.index}`,
        );
      }
      buf.set(bytes, writeCursor);
      writeCursor += maskBytesPerFrame;
    }
  }

  return buf;
}

export function decodeTileArtifactFromBinary(raw: Uint8Array): BinaryTileArtifact {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== BINARY_MAGIC) {
    throw new Error(`Bad magic in binary tile artifact: 0x${magic.toString(16)}`);
  }
  const version = view.getUint16(4, true);
  if (version !== BINARY_VERSION) {
    throw new Error(`Unsupported binary tile version: ${version}`);
  }
  const jsonMetaBytes = view.getUint32(8, true);
  const pointCount = view.getUint32(12, true);
  const frameCount = view.getUint32(16, true);
  const outdoorPointCount = view.getUint32(20, true);
  const maskBytesPerFrame = view.getUint32(24, true);
  const pointStride = view.getUint32(28, true);
  if (pointStride !== POINT_STRIDE) {
    throw new Error(`Unexpected pointStride: ${pointStride}`);
  }

  const metaStart = HEADER_BYTES;
  const metaEnd = metaStart + jsonMetaBytes;
  const metaJson = Buffer.from(
    raw.buffer,
    raw.byteOffset + metaStart,
    jsonMetaBytes,
  ).toString("utf8");
  const meta = JSON.parse(metaJson) as BinaryTileMetadata;

  // Points: create separate typed arrays by copying from the packed buffer.
  // We read each field as its own typed array so the consumer gets fast indexed
  // access without computing offsets into the packed struct.
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

  // Masks: single contiguous view (zero-copy).
  const masksOffset = pointsOffset + pointCount * pointStride;
  const masksLength = frameCount * MASK_KINDS_PER_FRAME * maskBytesPerFrame;
  const maskBuffer = new Uint8Array(
    raw.buffer,
    raw.byteOffset + masksOffset,
    masksLength,
  );

  return {
    meta,
    pointCount,
    frameCount,
    outdoorPointCount,
    maskBytesPerFrame,
    pointLon,
    pointLat,
    pointIx,
    pointIy,
    pointOutdoorIndex,
    pointFlags,
    maskBuffer,
  };
}

export function getFrameMask(
  art: BinaryTileArtifact,
  frameIdx: number,
  kind: number,
): Uint8Array {
  const { maskBytesPerFrame, maskBuffer } = art;
  const offset =
    (frameIdx * MASK_KINDS_PER_FRAME + kind) * maskBytesPerFrame;
  return maskBuffer.subarray(offset, offset + maskBytesPerFrame);
}

/** Reconstruct the legacy JSON-shaped artifact from a binary one.
 *  Used only by legacy callers that still expect the object-graph form
 *  (tests, admin tools, non-cache-only precompute). The cache-only hot
 *  path reads binary directly. */
export function binaryTileToLegacyArtifact(
  bin: BinaryTileArtifact,
): PrecomputedSunlightTileArtifact {
  const m = bin.meta;
  const points: PrecomputedSunlightTileArtifact["points"] = new Array(bin.pointCount);
  const ids = m.pointIds ?? [];
  const indoorIds = m.indoorBuildingIds ?? [];
  const elev = m.pointElevationMeters ?? [];
  const easting = m.pointLv95Easting ?? [];
  const northing = m.pointLv95Northing ?? [];
  for (let i = 0; i < bin.pointCount; i++) {
    const oi = bin.pointOutdoorIndex[i];
    points[i] = {
      id: ids[i] ?? `i${i}`,
      lat: bin.pointLat[i],
      lon: bin.pointLon[i],
      lv95Easting: (easting as number[])[i] ?? 0,
      lv95Northing: (northing as number[])[i] ?? 0,
      ix: bin.pointIx[i],
      iy: bin.pointIy[i],
      insideBuilding: (bin.pointFlags[i] & 1) !== 0,
      indoorBuildingId: indoorIds[i] ?? null,
      outdoorIndex: oi < 0 ? null : oi,
      pointElevationMeters: elev[i] ?? null,
    };
  }
  const frames: PrecomputedSunlightTileArtifact["frames"] = m.framesMeta.map(
    (fm, f) => ({
      index: fm.index,
      localTime: fm.localTime,
      utcTime: fm.utcTime,
      sunnyCount: fm.sunnyCount,
      sunnyCountNoVegetation: fm.sunnyCountNoVegetation,
      sunMaskBase64: Buffer.from(getFrameMask(bin, f, MASK_KIND_SUN)).toString("base64"),
      sunMaskNoVegetationBase64: Buffer.from(
        getFrameMask(bin, f, MASK_KIND_SUN_NO_VEG),
      ).toString("base64"),
      terrainBlockedMaskBase64: Buffer.from(
        getFrameMask(bin, f, MASK_KIND_TERRAIN_BLOCKED),
      ).toString("base64"),
      buildingsBlockedMaskBase64: Buffer.from(
        getFrameMask(bin, f, MASK_KIND_BUILDINGS_BLOCKED),
      ).toString("base64"),
      vegetationBlockedMaskBase64: Buffer.from(
        getFrameMask(bin, f, MASK_KIND_VEGETATION_BLOCKED),
      ).toString("base64"),
      // Diagnostics are not persisted in the binary format — callers that
      // need them must hold onto the live artifact produced at compute time.
      diagnostics: {
        horizonAngleDegByPoint: [],
        buildingBlockerIdByPoint: [],
        buildingBlockerDistanceMetersByPoint: [],
        vegetationBlockerDistanceMetersByPoint: [],
      },
    }),
  );
  return {
    artifactFormatVersion: m.artifactFormatVersion,
    region: m.region,
    modelVersionHash: m.modelVersionHash,
    date: m.date,
    timezone: m.timezone,
    gridStepMeters: m.gridStepMeters,
    sampleEveryMinutes: m.sampleEveryMinutes,
    startLocalTime: m.startLocalTime,
    endLocalTime: m.endLocalTime,
    tile: m.tile,
    points,
    frames,
    model: m.model,
    warnings: m.warnings,
    stats: m.stats,
  };
}

function createCacheRunKeyForBinary(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): string {
  return path.join(
    CACHE_SUNLIGHT_DIR,
    params.region,
    params.modelVersionHash,
    `g${params.gridStepMeters}`,
    `m${params.sampleEveryMinutes}`,
    params.date,
    `t${params.startLocalTime.replace(":", "")}-${params.endLocalTime.replace(":", "")}`,
  );
}

export function getPrecomputedSunlightTileBinaryPath(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileId: string;
}): string {
  return path.join(
    createCacheRunKeyForBinary(params),
    "tiles",
    `${params.tileId}.tile.bin.gz`,
  );
}

export async function writePrecomputedSunlightTileBinary(
  artifact: PrecomputedSunlightTileArtifact,
): Promise<void> {
  const storage = getSunlightCacheStorage();
  const targetPath = getPrecomputedSunlightTileBinaryPath({
    region: artifact.region,
    modelVersionHash: artifact.modelVersionHash,
    date: artifact.date,
    gridStepMeters: artifact.gridStepMeters,
    sampleEveryMinutes: artifact.sampleEveryMinutes,
    startLocalTime: artifact.startLocalTime,
    endLocalTime: artifact.endLocalTime,
    tileId: artifact.tile.tileId,
  });
  const bin = encodeTileArtifactToBinary(artifact);
  const compressed = (await gzip(bin)) as Buffer;
  await storage.writeBuffer(targetPath, compressed);
}

export async function loadPrecomputedSunlightTileBinary(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileId: string;
}): Promise<BinaryTileArtifact | null> {
  const storage = getSunlightCacheStorage();
  const targetPath = getPrecomputedSunlightTileBinaryPath(params);
  try {
    const compressed = await storage.readBuffer(targetPath);
    const raw = (await gunzip(compressed)) as Buffer;
    return decodeTileArtifactFromBinary(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
