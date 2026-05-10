import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";

import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "@/lib/geo/projection";
import { decodeTileAtlasFromBinary, packBucketKey } from "@/lib/precompute/sunlight-cache-atlas";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "@/lib/time/zoned-date";

const ATLAS_HEADER_BYTES = 48;
const ATLAS_POINT_STRIDE = 32;
const ATLAS_BUCKET_INDEX_ENTRY_BYTES = 8;
const ATLAS_MASK_KINDS = 5;
const RAD_TO_DEG = 180 / Math.PI;

type CliArgs = {
  atlas?: string;
  date: string;
  timezone: string;
  startLocalTime: string;
  endLocalTime: string;
  sampleEveryMinutes: number;
  shardBuckets: number[];
  zstdLevels: number[];
  iterations: number;
};

function parseArgs(): CliArgs {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) args.set(m[1], m[2]);
  }
  return {
    atlas: args.get("atlas"),
    date: args.get("date") ?? "2026-05-10",
    timezone: args.get("timezone") ?? "Europe/Zurich",
    startLocalTime: args.get("start") ?? "08:00",
    endLocalTime: args.get("end") ?? "12:00",
    sampleEveryMinutes: Number(args.get("sample") ?? "15"),
    shardBuckets: (args.get("shards") ?? "8,16,32,64")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0),
    zstdLevels: (args.get("zstd-levels") ?? "3,10")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0),
    iterations: Number(args.get("iterations") ?? "5"),
  };
}

async function findDefaultAtlas(): Promise<string> {
  const root = process.env.MAPPY_DATA_ROOT ?? "C:\\mappy-data";
  const preferred = path.join(
    root,
    "cache",
    "sunlight",
    "lausanne",
    "bff55b407db8426b",
    "g1",
    "atlas",
    "r0.75",
    "e2537250_n1152000_s250.atlas.bin.gz",
  );
  try {
    await fs.access(preferred);
    return preferred;
  } catch {
    // Fall through.
  }

  async function walk(dir: string): Promise<string | null> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      } else if (entry.name.endsWith(".atlas.bin.gz")) {
        return full;
      }
    }
    return null;
  }

  const found = await walk(path.join(root, "cache", "sunlight"));
  if (!found) throw new Error(`No .atlas.bin.gz found under ${root}`);
  return found;
}

function decompressPayload(buf: Buffer): Buffer {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf);
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x28 &&
    buf[1] === 0xb5 &&
    buf[2] === 0x2f &&
    buf[3] === 0xfd
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zstd = require("@mongodb-js/zstd") as {
      decompress(buffer: Buffer): Promise<Buffer>;
    };
    throw new Error("zstd payloads must be decompressed through decompressZstdPayload()");
  }
  throw new Error("Unknown atlas compression magic.");
}

async function decompressZstdPayload(buf: Buffer): Promise<Buffer> {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zstd = require("@mongodb-js/zstd") as {
    decompress(buffer: Buffer): Promise<Buffer>;
  };
  return await zstd.decompress(buf);
}

async function compressLikeAtlas(buf: Buffer, level: number): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zstd = require("@mongodb-js/zstd") as {
    compress(buffer: Buffer, level?: number): Promise<Buffer>;
  };
  return await zstd.compress(buf, level);
}

function parseTileCenterFromAtlasPath(atlasPath: string): { e: number; n: number } {
  const m = path.basename(atlasPath).match(/^e(\d+)_n(\d+)_s(\d+)\.atlas\.bin\.gz$/);
  if (!m) throw new Error(`Cannot parse tile id from ${atlasPath}`);
  const minE = Number(m[1]);
  const minN = Number(m[2]);
  const size = Number(m[3]);
  return { e: minE + size / 2, n: minN + size / 2 };
}

function createUtcSamples(args: CliArgs): Date[] {
  const { startUtc: dayStartUtc, endUtc: dayEndUtc } = getZonedDayRangeUtc(args.date, args.timezone);
  const rangeStartUtc = zonedDateTimeToUtc(args.date, args.startLocalTime, args.timezone);
  const rangeEndUtc = zonedDateTimeToUtc(args.date, args.endLocalTime, args.timezone);
  const startUtc = new Date(Math.max(dayStartUtc.getTime(), rangeStartUtc.getTime()));
  const endUtc = new Date(Math.min(dayEndUtc.getTime(), rangeEndUtc.getTime()));
  const result: Date[] = [];
  for (
    let cursor = startUtc.getTime();
    cursor < endUtc.getTime();
    cursor += args.sampleEveryMinutes * 60_000
  ) {
    result.push(new Date(cursor));
  }
  return result;
}

function parseAtlasRaw(raw: Buffer) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const jsonMetaBytes = view.getUint32(8, true);
  const pointCount = view.getUint32(12, true);
  const bucketCount = view.getUint32(16, true);
  const outdoorPointCount = view.getUint32(20, true);
  const maskBytesPerBucket = view.getUint32(24, true);
  const pointStride = view.getUint32(28, true);
  const resolutionDegAz = view.getFloat32(32, true);
  const resolutionDegAlt = view.getFloat32(36, true);
  const pointsOffset = ATLAS_HEADER_BYTES + jsonMetaBytes;
  const bucketIndexOffset = pointsOffset + pointCount * pointStride;
  const bucketDataOffset = bucketIndexOffset + bucketCount * ATLAS_BUCKET_INDEX_ENTRY_BYTES;
  const perBucketBytes = ATLAS_MASK_KINDS * maskBytesPerBucket;
  const bucketKeys: number[] = [];
  const bucketIndexByKey = new Map<number, number>();
  for (let i = 0; i < bucketCount; i++) {
    const base = bucketIndexOffset + i * ATLAS_BUCKET_INDEX_ENTRY_BYTES;
    const az = view.getUint16(base, true);
    const alt = view.getUint16(base + 2, true);
    const key = packBucketKey(az, alt);
    bucketKeys.push(key);
    bucketIndexByKey.set(key, i);
  }
  return {
    pointCount,
    bucketCount,
    outdoorPointCount,
    maskBytesPerBucket,
    resolutionDegAz,
    resolutionDegAlt,
    bucketDataOffset,
    perBucketBytes,
    bucketKeys,
    bucketIndexByKey,
  };
}

function requiredBucketKeysForTimeline(atlasPath: string, atlas: ReturnType<typeof parseAtlasRaw>, args: CliArgs): Set<number> {
  const center = parseTileCenterFromAtlasPath(atlasPath);
  const { lat, lon } = lv95ToWgs84Precise(center.e, center.n);
  const required = new Set<number>();
  for (const utc of createUtcSamples(args)) {
    const pos = SunCalc.getPosition(utc, lat, lon);
    const alt = pos.altitude * RAD_TO_DEG;
    if (alt <= 0) continue;
    let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (az < 0) az += 360;
    const azBucket = Math.floor(az / atlas.resolutionDegAz);
    const altBucket = Math.floor(alt / atlas.resolutionDegAlt);
    const key = packBucketKey(azBucket, altBucket);
    if (atlas.bucketIndexByKey.has(key)) required.add(key);
  }
  return required;
}

async function measure<T>(label: string, iterations: number, fn: () => Promise<T> | T): Promise<{ label: string; avgMs: number; minMs: number; maxMs: number; last: T }> {
  const values: number[] = [];
  let last!: T;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    last = await fn();
    values.push(performance.now() - t0);
  }
  return {
    label,
    avgMs: values.reduce((a, b) => a + b, 0) / values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    last,
  };
}

async function main() {
  const args = parseArgs();
  const atlasPath = args.atlas ?? await findDefaultAtlas();
  const compressed = await fs.readFile(atlasPath);
  const raw = await decompressZstdPayload(compressed);
  const atlas = parseAtlasRaw(raw);
  const requiredKeys = requiredBucketKeysForTimeline(atlasPath, atlas, args);
  const requiredIndexes = [...requiredKeys]
    .map((key) => atlas.bucketIndexByKey.get(key))
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);

  const currentDecompress = await measure("current: decompress full atlas", args.iterations, async () => {
    const out = await decompressZstdPayload(compressed);
    return out.byteLength;
  });
  const currentDecode = await measure("current: partial decode after full decompress", args.iterations, () => {
    const decoded = decodeTileAtlasFromBinary(raw, requiredKeys);
    return decoded.bucketCount;
  });

  console.log("=== Atlas ===");
  console.log(`path=${atlasPath}`);
  console.log(`compressedMB=${(compressed.byteLength / 1_000_000).toFixed(1)} rawMB=${(raw.byteLength / 1_000_000).toFixed(1)}`);
  console.log(`pointCount=${atlas.pointCount} outdoorPointCount=${atlas.outdoorPointCount} bucketCount=${atlas.bucketCount} maskBytesPerBucket=${atlas.maskBytesPerBucket}`);
  console.log(`timeline=${args.date} ${args.startLocalTime}-${args.endLocalTime} every ${args.sampleEveryMinutes}min requiredBuckets=${requiredKeys.size}`);
  console.log("");

  console.log("=== Current ===");
  for (const row of [currentDecompress, currentDecode]) {
    console.log(`${row.label}: avg=${row.avgMs.toFixed(1)}ms min=${row.minMs.toFixed(1)}ms max=${row.maxMs.toFixed(1)}ms result=${row.last}`);
  }
  console.log("");

  console.log("=== Zstd full-atlas recompress ===");
  for (const level of args.zstdLevels) {
    const t0 = performance.now();
    const recompressed = await compressLikeAtlas(raw, level);
    const compressMs = performance.now() - t0;
    const recompressedDecompress = await measure(`full zstd-${level}`, args.iterations, async () => {
      const out = await decompressZstdPayload(recompressed);
      return out.byteLength;
    });
    console.log(
      `level=${level} compressedMB=${(recompressed.byteLength / 1_000_000).toFixed(1)} ` +
        `compressMs=${compressMs.toFixed(1)} decompressAvg=${recompressedDecompress.avgMs.toFixed(1)}ms ` +
        `min=${recompressedDecompress.minMs.toFixed(1)}ms max=${recompressedDecompress.maxMs.toFixed(1)}ms`,
    );
  }
  console.log("");

  console.log("=== Simulated sharding ===");
  for (const level of args.zstdLevels) {
    for (const shardBucketCount of args.shardBuckets) {
      const baseRaw = raw.subarray(0, atlas.bucketDataOffset);
      const baseCompressed = await compressLikeAtlas(baseRaw, level);
      const shardIds = new Set(requiredIndexes.map((idx) => Math.floor(idx / shardBucketCount)));
      const compressedShards: Buffer[] = [];
      let shardRawBytes = 0;
      let compressMs = 0;
      for (const shardId of shardIds) {
        const startBucket = shardId * shardBucketCount;
        const endBucket = Math.min(atlas.bucketCount, startBucket + shardBucketCount);
        const start = atlas.bucketDataOffset + startBucket * atlas.perBucketBytes;
        const end = atlas.bucketDataOffset + endBucket * atlas.perBucketBytes;
        const shardRaw = raw.subarray(start, end);
        shardRawBytes += shardRaw.byteLength;
        const t0 = performance.now();
        compressedShards.push(await compressLikeAtlas(shardRaw, level));
        compressMs += performance.now() - t0;
      }
      const compressedBytes = baseCompressed.byteLength + compressedShards.reduce((sum, buf) => sum + buf.byteLength, 0);
      const shardedDecompress = await measure(`shard ${shardBucketCount} zstd-${level}`, args.iterations, async () => {
        let bytes = (await decompressZstdPayload(baseCompressed)).byteLength;
        for (const shard of compressedShards) {
          bytes += (await decompressZstdPayload(shard)).byteLength;
        }
        return bytes;
      });
      console.log(
        `level=${level} bucketsPerShard=${shardBucketCount} shardsHit=${shardIds.size} ` +
          `compressedMB=${(compressedBytes / 1_000_000).toFixed(1)} rawMB=${((baseRaw.byteLength + shardRawBytes) / 1_000_000).toFixed(1)} ` +
          `compressMs=${compressMs.toFixed(1)} decompressAvg=${shardedDecompress.avgMs.toFixed(1)}ms ` +
          `min=${shardedDecompress.minMs.toFixed(1)}ms max=${shardedDecompress.maxMs.toFixed(1)}ms`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
