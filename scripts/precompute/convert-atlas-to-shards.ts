import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const ATLAS_HEADER_BYTES = 48;
const ATLAS_POINT_STRIDE = 32;
const ATLAS_BUCKET_INDEX_ENTRY_BYTES = 8;
const ATLAS_MASK_KINDS = 5;
const SHARD_MANIFEST_VERSION = 1;

type Args = {
  atlas?: string;
  root: string;
  bucketsPerShard: number;
  zstdLevel: number;
  limit: number;
  dryRun: boolean;
  overwrite: boolean;
  deleteSourceAfterConvert: boolean;
};

type ShardManifest = {
  format: "mappy-atlas-shards";
  version: number;
  sourceAtlas: string;
  compression: "zstd";
  zstdLevel: number;
  bucketsPerShard: number;
  pointCount: number;
  outdoorPointCount: number;
  bucketCount: number;
  maskBytesPerBucket: number;
  resolutionDegAz: number;
  resolutionDegAlt: number;
  baseFile: string;
  baseRawBytes: number;
  baseCompressedBytes: number;
  shards: Array<{
    file: string;
    startBucket: number;
    bucketCount: number;
    rawBytes: number;
    compressedBytes: number;
  }>;
};

function parseArgs(): Args {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const keyOnly = arg.match(/^--([^=]+)$/);
    if (keyOnly) {
      args.set(keyOnly[1], "true");
      continue;
    }
    const keyValue = arg.match(/^--([^=]+)=(.*)$/);
    if (keyValue) args.set(keyValue[1], keyValue[2]);
  }
  const root = args.get("root") ?? path.join(process.env.MAPPY_DATA_ROOT ?? "C:\\mappy-data", "cache", "sunlight");
  return {
    atlas: args.get("atlas"),
    root,
    bucketsPerShard: Number(args.get("buckets-per-shard") ?? "16"),
    zstdLevel: Number(args.get("zstd-level") ?? "10"),
    limit: Number(args.get("limit") ?? "0"),
    dryRun: args.get("dry-run") === "true",
    overwrite: args.get("overwrite") === "true",
    deleteSourceAfterConvert: args.get("delete-source-after-convert") === "true",
  };
}

async function walkAtlases(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".atlas.bin.gz")) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found.sort();
}

async function writeFileAtomic(targetPath: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, targetPath);
}

async function decompressAtlas(buf: Buffer): Promise<Buffer> {
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
    return await zstd.decompress(buf);
  }
  throw new Error(`Unknown atlas compression magic: ${[...buf.subarray(0, 4)].map((b) => b.toString(16)).join(" ")}`);
}

async function compressZstd(buf: Buffer, level: number): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zstd = require("@mongodb-js/zstd") as {
    compress(buffer: Buffer, level?: number): Promise<Buffer>;
  };
  return await zstd.compress(buf, level);
}

function parseAtlasLayout(raw: Buffer) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const jsonMetaBytes = view.getUint32(8, true);
  const pointCount = view.getUint32(12, true);
  const bucketCount = view.getUint32(16, true);
  const outdoorPointCount = view.getUint32(20, true);
  const maskBytesPerBucket = view.getUint32(24, true);
  const pointStride = view.getUint32(28, true);
  if (pointStride !== ATLAS_POINT_STRIDE) {
    throw new Error(`Unsupported atlas point stride: ${pointStride}`);
  }
  const resolutionDegAz = view.getFloat32(32, true);
  const resolutionDegAlt = view.getFloat32(36, true);
  const pointsOffset = ATLAS_HEADER_BYTES + jsonMetaBytes;
  const bucketIndexOffset = pointsOffset + pointCount * pointStride;
  const bucketDataOffset = bucketIndexOffset + bucketCount * ATLAS_BUCKET_INDEX_ENTRY_BYTES;
  const perBucketBytes = ATLAS_MASK_KINDS * maskBytesPerBucket;
  return {
    pointCount,
    bucketCount,
    outdoorPointCount,
    maskBytesPerBucket,
    resolutionDegAz,
    resolutionDegAlt,
    bucketDataOffset,
    perBucketBytes,
  };
}

function shardPathForAtlas(atlasPath: string, suffix: string): string {
  return atlasPath.replace(/\.atlas\.bin\.gz$/, suffix);
}

function indexPathForAtlas(atlasPath: string): string {
  return atlasPath.replace(/\.atlas\.bin\.gz$/, ".atlas.idx");
}

async function assertIndexSidecarExists(atlasPath: string): Promise<void> {
  const indexPath = indexPathForAtlas(atlasPath);
  try {
    await fs.access(indexPath);
  } catch {
    throw new Error(`Refusing to delete monolith without index sidecar: ${indexPath}`);
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

async function convertAtlas(atlasPath: string, args: Args) {
  const manifestPath = shardPathForAtlas(atlasPath, ".atlas.shards.json");
  const basePath = shardPathForAtlas(atlasPath, ".atlas.base.bin.zst");

  if (!args.overwrite) {
    let manifestExists = false;
    try {
      await fs.access(manifestPath);
      manifestExists = true;
    } catch {
      manifestExists = false;
    }
    if (manifestExists) {
      if (args.deleteSourceAfterConvert && !args.dryRun) {
        await assertIndexSidecarExists(atlasPath);
        await fs.unlink(atlasPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
      console.log(`[skip] ${atlasPath} (manifest exists)`);
      return { skipped: true, compressedBytes: 0, shardCount: 0 };
    }
  }

  const compressed = await fs.readFile(atlasPath);
  const raw = await decompressAtlas(compressed);
  const layout = parseAtlasLayout(raw);
  const baseRaw = raw.subarray(0, layout.bucketDataOffset);
  const baseCompressed = await compressZstd(baseRaw, args.zstdLevel);

  const shards: ShardManifest["shards"] = [];
  let totalCompressedBytes = baseCompressed.byteLength;
  for (let startBucket = 0; startBucket < layout.bucketCount; startBucket += args.bucketsPerShard) {
    const bucketCount = Math.min(args.bucketsPerShard, layout.bucketCount - startBucket);
    const start = layout.bucketDataOffset + startBucket * layout.perBucketBytes;
    const end = start + bucketCount * layout.perBucketBytes;
    const shardRaw = raw.subarray(start, end);
    const shardCompressed = await compressZstd(shardRaw, args.zstdLevel);
    const shardFile = `${path.basename(atlasPath, ".atlas.bin.gz")}.atlas.shard-${String(shards.length).padStart(4, "0")}.bin.zst`;
    totalCompressedBytes += shardCompressed.byteLength;
    shards.push({
      file: shardFile,
      startBucket,
      bucketCount,
      rawBytes: shardRaw.byteLength,
      compressedBytes: shardCompressed.byteLength,
    });
    if (!args.dryRun) {
      await writeFileAtomic(path.join(path.dirname(atlasPath), shardFile), shardCompressed);
    }
  }

  const manifest: ShardManifest = {
    format: "mappy-atlas-shards",
    version: SHARD_MANIFEST_VERSION,
    sourceAtlas: path.basename(atlasPath),
    compression: "zstd",
    zstdLevel: args.zstdLevel,
    bucketsPerShard: args.bucketsPerShard,
    pointCount: layout.pointCount,
    outdoorPointCount: layout.outdoorPointCount,
    bucketCount: layout.bucketCount,
    maskBytesPerBucket: layout.maskBytesPerBucket,
    resolutionDegAz: layout.resolutionDegAz,
    resolutionDegAlt: layout.resolutionDegAlt,
    baseFile: path.basename(basePath),
    baseRawBytes: baseRaw.byteLength,
    baseCompressedBytes: baseCompressed.byteLength,
    shards,
  };

  if (!args.dryRun) {
    await writeFileAtomic(basePath, baseCompressed);
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (args.deleteSourceAfterConvert) {
      await assertIndexSidecarExists(atlasPath);
      await fs.unlink(atlasPath);
    }
  }

  console.log(
    `[convert] ${atlasPath} buckets=${layout.bucketCount} shards=${shards.length} ` +
      `mono=${(compressed.byteLength / 1_000_000).toFixed(1)}MB sharded=${(totalCompressedBytes / 1_000_000).toFixed(1)}MB`,
  );

  return { skipped: false, compressedBytes: totalCompressedBytes, shardCount: shards.length };
}

async function main() {
  const args = parseArgs();
  if (!Number.isFinite(args.bucketsPerShard) || args.bucketsPerShard <= 0) {
    throw new Error(`Invalid --buckets-per-shard=${args.bucketsPerShard}`);
  }
  if (!Number.isFinite(args.zstdLevel) || args.zstdLevel <= 0) {
    throw new Error(`Invalid --zstd-level=${args.zstdLevel}`);
  }

  const atlases = args.atlas ? [args.atlas] : await walkAtlases(args.root);
  const selected = args.limit > 0 ? atlases.slice(0, args.limit) : atlases;
  console.log(
    `[atlas-shards] atlases=${selected.length}/${atlases.length} bucketsPerShard=${args.bucketsPerShard} ` +
      `zstdLevel=${args.zstdLevel} dryRun=${args.dryRun} overwrite=${args.overwrite} ` +
      `deleteSourceAfterConvert=${args.deleteSourceAfterConvert}`,
  );

  let converted = 0;
  let skipped = 0;
  let shards = 0;
  let compressedBytes = 0;
  const startedAt = Date.now();
  for (let i = 0; i < selected.length; i++) {
    const atlas = selected[i];
    const atlasStartedAt = Date.now();
    const result = await convertAtlas(atlas, args);
    const atlasMs = Date.now() - atlasStartedAt;
    if (result.skipped) {
      skipped += 1;
    } else {
      converted += 1;
      shards += result.shardCount;
      compressedBytes += result.compressedBytes;
    }
    const processed = i + 1;
    const elapsedMs = Date.now() - startedAt;
    const avgMs = elapsedMs / processed;
    const etaMs = avgMs * (selected.length - processed);
    console.log(
      `[atlas-shards:progress] ${processed}/${selected.length} converted=${converted} skipped=${skipped} ` +
        `last=${formatDuration(atlasMs)} avg=${formatDuration(avgMs)} eta=${formatDuration(etaMs)}`,
    );
  }

  console.log(
    `[atlas-shards] done converted=${converted} skipped=${skipped} shards=${shards} ` +
      `written=${(compressedBytes / 1_000_000).toFixed(1)}MB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
