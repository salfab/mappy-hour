/**
 * Package atlas + (optionally) grid-metadata for a region into release tar(s).
 *
 * Produces by default TWO archives per call:
 *   {out-dir}/{region}-atlas.tar           ← sharded atlas (.atlas.idx + .atlas.shards.json + .zst)
 *   {out-dir}/{region}-grid-metadata.tar   ← per-tile preflight grid metadata
 *
 * Plus a .sha256 sidecar per archive (or per part, when split into 1.8 GB chunks).
 *
 * The atlas tar is sharded-only by design (ADR-0024): no legacy `.atlas.bin.gz`
 * monolith is packed. Callers must run `convert-atlas-to-shards.ts` over the
 * region's cache before invoking this script.
 *
 * Grid-metadata files are filtered by the current tile-selection (the
 * `tile-grid-metadata/<region>/<gridMetadataHash>/g{N}/` directory accumulates
 * historical preflight runs; we only ship what the selection actually needs).
 *
 * Usage:
 *   tsx scripts/release/package-atlas-region.ts \
 *     --region=lausanne \
 *     [--model-version-hash=auto] \
 *     [--grid-metadata-hash=auto] \
 *     [--tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json] \
 *     [--no-grid-metadata]  # skip the grid-metadata tar (atlas only)
 *     [--no-atlas]          # skip the atlas tar (grid-metadata only)
 *     [--out-dir=dist/releases]
 *
 * Returns a JSON summary on stdout (consumed by build-release-manifest.ts).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CACHE_SUNLIGHT_DIR =
  process.env.MAPPY_CACHE_SUNLIGHT_DIR?.trim() ||
  path.join(process.cwd(), "data", "cache", "sunlight");

const TILE_GRID_METADATA_DIR =
  process.env.MAPPY_CACHE_TILE_GRID_METADATA_DIR?.trim() ||
  path.join(process.cwd(), "data", "cache", "tile-grid-metadata");

const ATLAS_RESOLUTION_DEG = "0.75";
const GRID_STEP = "1";
const MAX_PART_BYTES = 1.8 * 1024 * 1024 * 1024; // 1.8 GB

function tileIdFromAtlasFile(fileName: string): string | null {
  const match = fileName.match(/^(.*)\.atlas\.(?:idx|shards\.json|base\.bin\.zst|shard-\d+\.bin\.zst)$/);
  return match?.[1] ?? null;
}

function tileIdFromGridMetaFile(fileName: string): string | null {
  const match = fileName.match(/^(.+)\.json\.gz$/);
  return match?.[1] ?? null;
}

function countAtlasTiles(files: string[]): number {
  const ids = new Set<string>();
  for (const file of files) {
    const id = tileIdFromAtlasFile(file);
    if (id) ids.add(id);
  }
  return ids.size;
}

function isPackagedAtlasFile(fileName: string): boolean {
  // Sharded only — legacy `.atlas.bin.gz` monoliths are deliberately excluded
  // (see ADR-0024 + user decision 2026-05-11).
  return (
    fileName.endsWith(".atlas.idx") ||
    fileName.endsWith(".atlas.shards.json") ||
    fileName.endsWith(".atlas.base.bin.zst") ||
    /^.+\.atlas\.shard-\d+\.bin\.zst$/.test(fileName)
  );
}

interface Args {
  region: string | null;
  modelVersionHash: string;
  gridMetadataHash: string;
  tileSelectionFile: string | null;
  outDir: string;
  dryRun: boolean;
  includeAtlas: boolean;
  includeGridMetadata: boolean;
}

function parseArgs(): Args {
  const flags = new Set<string>();
  const kv: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--")) {
      const idx = a.indexOf("=");
      if (idx === -1) flags.add(a.slice(2));
      else kv[a.slice(2, idx)] = a.slice(idx + 1);
    }
  }
  return {
    region: kv["region"] ?? null,
    modelVersionHash: kv["model-version-hash"] ?? "auto",
    gridMetadataHash: kv["grid-metadata-hash"] ?? "auto",
    tileSelectionFile: kv["tile-selection-file"] ?? null,
    outDir: kv["out-dir"] ?? path.join(process.cwd(), "dist", "releases"),
    dryRun: flags.has("dry-run") || kv["dry-run"] === "true",
    includeAtlas: !flags.has("no-atlas"),
    includeGridMetadata: !flags.has("no-grid-metadata"),
  };
}

async function findBestModelVersionHash(region: string): Promise<{ hash: string; tileCount: number } | null> {
  const regionDir = path.join(CACHE_SUNLIGHT_DIR, region);
  let entries: string[];
  try {
    entries = await fsp.readdir(regionDir);
  } catch {
    return null;
  }
  let best: { hash: string; tileCount: number } | null = null;
  for (const hash of entries) {
    const atlasDir = path.join(regionDir, hash, `g${GRID_STEP}`, "atlas", `r${ATLAS_RESOLUTION_DEG}`);
    try {
      const files = await fsp.readdir(atlasDir);
      const count = countAtlasTiles(files);
      if (!best || count > best.tileCount) best = { hash, tileCount: count };
    } catch {
      /* no atlas dir for this hash */
    }
  }
  return best;
}

/** Prefer the CURRENT modelVersionHash (computed from live inputs:
 *  buildings index, terrain manifest, vegetation manifest, horizon
 *  manifest, calibration). Fall back to the highest-tile-count hash
 *  on disk with a loud warning if the current hash isn't present —
 *  that fallback only makes sense if the operator knows the current
 *  inputs match an older precompute, which is rare. Avoids the
 *  silent bug where a region whose bbox / data was widened gets
 *  packaged from the obsolete pre-widening hash because it has
 *  more tiles. */
async function resolveAtlasHash(region: string): Promise<{ hash: string; tileCount: number; source: "current" | "fallback-best" } | null> {
  let currentHash: string | null = null;
  try {
    const { getSunlightModelVersion } = await import("../../src/lib/precompute/model-version");
    const { DEFAULT_SHADOW_CALIBRATION } = await import("../../src/lib/sun/shadow-calibration");
    const mv = await getSunlightModelVersion(region as never, DEFAULT_SHADOW_CALIBRATION);
    currentHash = mv.modelVersionHash;
  } catch (err) {
    console.error(
      `[package-atlas] ⚠ unable to compute current modelVersionHash for ${region} (${(err as Error).message}). Falling back to highest-tile-count hash on disk.`,
    );
  }
  if (currentHash) {
    const atlasDir = path.join(CACHE_SUNLIGHT_DIR, region, currentHash, `g${GRID_STEP}`, "atlas", `r${ATLAS_RESOLUTION_DEG}`);
    try {
      const files = await fsp.readdir(atlasDir);
      const count = countAtlasTiles(files);
      return { hash: currentHash, tileCount: count, source: "current" };
    } catch {
      // Current hash dir doesn't exist on disk yet (precompute not run since the
      // last manifest change). Fall back to the best on-disk hash so we ship
      // SOMETHING — but warn loudly because the result may be using obsolete
      // building/terrain data.
      console.error(
        `\x1b[1;33m[package-atlas] ⚠ current modelVersionHash for ${region} is ${currentHash} but no atlas dir exists for it. Falling back to highest-tile-count on-disk hash. The packaged release may reflect an OBSOLETE precompute (older buildings/terrain/horizon manifests). Re-run precompute for ${region} to get a fresh ${currentHash} build.\x1b[0m`,
      );
    }
  }
  const best = await findBestModelVersionHash(region);
  return best ? { ...best, source: "fallback-best" } : null;
}

async function findBestGridMetadataHash(region: string): Promise<{ hash: string; tileCount: number } | null> {
  const regionDir = path.join(TILE_GRID_METADATA_DIR, region);
  let entries: string[];
  try {
    entries = await fsp.readdir(regionDir);
  } catch {
    return null;
  }
  let best: { hash: string; tileCount: number } | null = null;
  for (const hash of entries) {
    const dir = path.join(regionDir, hash, `g${GRID_STEP}`);
    try {
      const files = await fsp.readdir(dir);
      const count = files.filter((f) => f.endsWith(".json.gz")).length;
      if (!best || count > best.tileCount) best = { hash, tileCount: count };
    } catch {
      /* no g{N} dir */
    }
  }
  return best;
}

async function loadTileSelectionIds(filePath: string, region: string): Promise<Set<string>> {
  const raw = await fsp.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as { tiles: Array<{ region: string; tileId: string }> };
  const ids = new Set<string>();
  for (const t of parsed.tiles) {
    if (t.region === region) ids.add(t.tileId);
  }
  return ids;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function writeWithBackpressure(writer: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (!writer.write(chunk)) {
    await new Promise<void>((resolve) => writer.once("drain", resolve));
  }
}

async function endWriter(writer: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

async function splitFile(inputPath: string, outDir: string, baseName: string): Promise<string[]> {
  const totalSize = (await fsp.stat(inputPath)).size;
  if (totalSize <= MAX_PART_BYTES) {
    const dest = path.join(outDir, baseName);
    await fsp.rename(inputPath, dest);
    return [dest];
  }

  // Streaming split with backpressure (see git history for rationale —
  // unbuffered writes blew the heap on big regions).
  const fh = await fsp.open(inputPath, "r");
  const partPaths: string[] = [];
  const READ_BLOCK = 16 * 1024 * 1024;
  const buffer = Buffer.allocUnsafe(READ_BLOCK);

  let partIndex = 1;
  let bytesWrittenInPart = 0;
  let writer: fs.WriteStream | null = null;

  const openNextPart = (): fs.WriteStream => {
    const partPath = path.join(outDir, `${baseName}.part${partIndex}`);
    partPaths.push(partPath);
    partIndex++;
    bytesWrittenInPart = 0;
    return fs.createWriteStream(partPath, { highWaterMark: 8 * 1024 * 1024 });
  };

  try {
    writer = openNextPart();
    let totalRead = 0;
    while (totalRead < totalSize) {
      const { bytesRead } = await fh.read(buffer, 0, READ_BLOCK, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;

      let offset = 0;
      while (offset < bytesRead) {
        const remainingInPart = MAX_PART_BYTES - bytesWrittenInPart;
        const sliceLen = Math.min(bytesRead - offset, remainingInPart);
        const slice = Buffer.from(buffer.subarray(offset, offset + sliceLen));
        await writeWithBackpressure(writer, slice);
        bytesWrittenInPart += sliceLen;
        offset += sliceLen;

        if (bytesWrittenInPart >= MAX_PART_BYTES && (offset < bytesRead || totalRead < totalSize)) {
          await endWriter(writer);
          writer = openNextPart();
        }
      }
    }
    if (writer) await endWriter(writer);
  } finally {
    await fh.close();
  }

  await fsp.unlink(inputPath);
  return partPaths;
}

interface PartInfo {
  name: string;
  sha256: string;
  bytes: number;
}

interface ArchiveSummary {
  archiveName: string;
  isSplit: boolean;
  parts: PartInfo[];
  /** Convenience fields when not split */
  assetName?: string;
  sha256?: string;
  bytes?: number;
}

async function packageStagingToArchive(
  stagingDir: string,
  outDir: string,
  archiveBaseName: string,
): Promise<ArchiveSummary> {
  const tmpTar = path.join(outDir, `${archiveBaseName}.tmp`);
  console.error(`[package-atlas] Création de l'archive ${archiveBaseName}...`);
  const tarResult = spawnSync("tar", ["-cf", tmpTar, "-C", stagingDir, "."], { stdio: "inherit" });
  if (tarResult.status !== 0) {
    throw new Error(`tar failed (code ${tarResult.status}) for ${archiveBaseName}`);
  }
  await fsp.rm(stagingDir, { recursive: true });

  const parts = await splitFile(tmpTar, outDir, archiveBaseName);
  const isSplit = parts.length > 1;
  if (isSplit) console.error(`[package-atlas] ${archiveBaseName} splittée en ${parts.length} parts.`);

  const partInfos: PartInfo[] = [];
  for (const partPath of parts) {
    const sha = await sha256File(partPath);
    const bytes = (await fsp.stat(partPath)).size;
    const name = path.basename(partPath);
    await fsp.writeFile(`${partPath}.sha256`, `${sha}  ${name}\n`);
    partInfos.push({ name, sha256: sha, bytes });
    console.error(`[package-atlas]   ${name} — ${(bytes / 1e6).toFixed(1)} MB  sha256=${sha.slice(0, 12)}…`);
  }

  return {
    archiveName: archiveBaseName,
    isSplit,
    parts: partInfos,
    assetName: isSplit ? undefined : archiveBaseName,
    sha256: isSplit ? undefined : partInfos[0].sha256,
    bytes: isSplit ? undefined : partInfos[0].bytes,
  };
}

async function packageAtlas(args: {
  region: string;
  modelVersionHash: string;
  gridMetadataHash: string;
  tileCount: number;
  selectionIds: Set<string> | null;
  outDir: string;
}): Promise<ArchiveSummary | null> {
  const atlasDir = path.join(
    CACHE_SUNLIGHT_DIR,
    args.region,
    args.modelVersionHash,
    `g${GRID_STEP}`,
    "atlas",
    `r${ATLAS_RESOLUTION_DEG}`,
  );

  const files = await fsp.readdir(atlasDir);
  const atlasFiles = files.filter(isPackagedAtlasFile);

  // Drop any legacy monoliths from the file list (defensive — convert-atlas-to-shards
  // is supposed to be run before this script, but we don't want a hybrid release).
  const monolithCount = files.filter((f) => f.endsWith(".atlas.bin.gz")).length;
  if (monolithCount > 0) {
    console.error(
      `[package-atlas] ⚠ ${monolithCount} legacy .atlas.bin.gz file(s) present in ${atlasDir} — NOT packaged (shards-only release). Run convert-atlas-to-shards.ts to remove them.`,
    );
  }

  if (atlasFiles.length === 0) {
    console.error(`[package-atlas] Aucun fichier shardé pour ${args.region} — atlas tar non créé.`);
    return null;
  }

  // Optional tile-selection filter
  let filtered = atlasFiles;
  let skippedByFilter = 0;
  if (args.selectionIds) {
    filtered = atlasFiles.filter((f) => {
      const id = tileIdFromAtlasFile(f);
      return id !== null && args.selectionIds!.has(id);
    });
    skippedByFilter = atlasFiles.length - filtered.length;
    if (skippedByFilter > 0) {
      console.error(
        `[package-atlas] tile-selection filter: ${filtered.length}/${atlasFiles.length} atlas files kept (${skippedByFilter} not in selection)`,
      );
    }
  }

  const stagingDir = path.join(args.outDir, `_staging_${args.region}_atlas`);
  await fsp.mkdir(path.join(stagingDir, "atlas", `r${ATLAS_RESOLUTION_DEG}`), { recursive: true });

  const releaseInfo = {
    region: args.region,
    modelVersionHash: args.modelVersionHash,
    gridMetadataHash: args.gridMetadataHash,
    algorithmVersion: "sunlight-cache-v9",
    artifactFormatVersion: 2,
    atlasResolutionDeg: parseFloat(ATLAS_RESOLUTION_DEG),
    gridStepMeters: parseInt(GRID_STEP),
    tileCount: args.tileCount,
    atlasStorage: "sharded",
    bucketsPerShard: 16,
    zstdLevel: 10,
    generatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(
    path.join(stagingDir, "release-info.json"),
    JSON.stringify(releaseInfo, null, 2),
  );

  for (const f of filtered) {
    await fsp.copyFile(
      path.join(atlasDir, f),
      path.join(stagingDir, "atlas", `r${ATLAS_RESOLUTION_DEG}`, f),
    );
  }

  return packageStagingToArchive(stagingDir, args.outDir, `${args.region}-atlas.tar`);
}

async function packageGridMetadata(args: {
  region: string;
  modelVersionHash: string;
  gridMetadataHash: string;
  selectionIds: Set<string> | null;
  outDir: string;
}): Promise<{ summary: ArchiveSummary | null; tileCount: number }> {
  const sourceDir = path.join(
    TILE_GRID_METADATA_DIR,
    args.region,
    args.gridMetadataHash,
    `g${GRID_STEP}`,
  );

  let files: string[];
  try {
    files = await fsp.readdir(sourceDir);
  } catch {
    console.error(`[package-grid-meta] Répertoire introuvable : ${sourceDir} — grid-metadata tar non créé.`);
    return { summary: null, tileCount: 0 };
  }

  const allMetaFiles = files.filter((f) => f.endsWith(".json.gz"));
  let kept = allMetaFiles;
  let skippedByFilter = 0;
  if (args.selectionIds) {
    kept = allMetaFiles.filter((f) => {
      const id = tileIdFromGridMetaFile(f);
      return id !== null && args.selectionIds!.has(id);
    });
    skippedByFilter = allMetaFiles.length - kept.length;
    if (skippedByFilter > 0) {
      console.error(
        `[package-grid-meta] tile-selection filter: ${kept.length}/${allMetaFiles.length} grid-metadata files kept (${skippedByFilter} not in selection — historical exploration runs)`,
      );
    }
  }

  if (kept.length === 0) {
    console.error(`[package-grid-meta] Aucun fichier grid-metadata applicable pour ${args.region}.`);
    return { summary: null, tileCount: 0 };
  }

  const stagingDir = path.join(args.outDir, `_staging_${args.region}_grid_meta`);
  await fsp.mkdir(path.join(stagingDir, "tile-grid-metadata", `g${GRID_STEP}`), { recursive: true });

  const releaseInfo = {
    region: args.region,
    modelVersionHash: args.modelVersionHash,
    gridMetadataHash: args.gridMetadataHash,
    algorithmVersion: "sunlight-cache-v9",
    artifactFormatVersion: 2,
    gridStepMeters: parseInt(GRID_STEP),
    tileCount: kept.length,
    generatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(
    path.join(stagingDir, "release-info.json"),
    JSON.stringify(releaseInfo, null, 2),
  );

  for (const f of kept) {
    await fsp.copyFile(
      path.join(sourceDir, f),
      path.join(stagingDir, "tile-grid-metadata", `g${GRID_STEP}`, f),
    );
  }

  const summary = await packageStagingToArchive(
    stagingDir,
    args.outDir,
    `${args.region}-grid-metadata.tar`,
  );
  return { summary, tileCount: kept.length };
}

async function main() {
  const args = parseArgs();
  if (!args.region) {
    console.error(
      "Usage: tsx package-atlas-region.ts --region=<name> [--tile-selection-file=...] [--no-grid-metadata] [--no-atlas] [--out-dir=dist/releases]",
    );
    process.exit(1);
  }
  if (!args.includeAtlas && !args.includeGridMetadata) {
    console.error("[package-atlas] --no-atlas + --no-grid-metadata : rien à faire.");
    process.exit(1);
  }

  const region = args.region;
  console.error(`\n[package-atlas] Région : ${region}`);

  // Resolve atlas modelVersionHash. Prefers the CURRENT hash computed
  // from live inputs (so a release packaged right after a widening uses
  // the post-widening atlas, not the obsolete one with more tiles).
  let modelVersionHash = args.modelVersionHash;
  let atlasTileCount = 0;
  if (args.includeAtlas) {
    if (modelVersionHash === "auto") {
      const resolved = await resolveAtlasHash(region);
      if (!resolved) {
        console.error(`[package-atlas] Aucun atlas trouvé pour ${region} dans ${CACHE_SUNLIGHT_DIR}`);
        process.exit(1);
      }
      modelVersionHash = resolved.hash;
      atlasTileCount = resolved.tileCount;
      const sourceLabel = resolved.source === "current" ? "current" : "fallback (highest-count on disk)";
      console.error(`[package-atlas] modelVersionHash auto (${sourceLabel}) : ${modelVersionHash} (${atlasTileCount} tuiles)`);
    } else {
      const atlasDir = path.join(CACHE_SUNLIGHT_DIR, region, modelVersionHash, `g${GRID_STEP}`, "atlas", `r${ATLAS_RESOLUTION_DEG}`);
      const files = await fsp.readdir(atlasDir).catch(() => [] as string[]);
      atlasTileCount = countAtlasTiles(files);
    }
  }

  // Resolve gridMetadataHash (newest hash dir with the most tiles)
  let gridMetadataHash = args.gridMetadataHash;
  if (gridMetadataHash === "auto") {
    const best = await findBestGridMetadataHash(region);
    if (best) {
      gridMetadataHash = best.hash;
      console.error(`[package-atlas] gridMetadataHash auto : ${gridMetadataHash} (${best.tileCount} tuiles)`);
    } else if (args.includeGridMetadata) {
      console.error(`[package-atlas] ⚠ Aucun tile-grid-metadata pour ${region} — la sous-archive ne sera pas créée.`);
      gridMetadataHash = "";
    }
  }

  // Optional tile-selection filter (preferred when shipping a release)
  let selectionIds: Set<string> | null = null;
  if (args.tileSelectionFile) {
    selectionIds = await loadTileSelectionIds(args.tileSelectionFile, region);
    console.error(
      `[package-atlas] tile-selection : ${selectionIds.size} tuile(s) listée(s) pour region=${region}`,
    );
  }

  await fsp.mkdir(args.outDir, { recursive: true });

  if (args.dryRun) {
    process.stdout.write(
      JSON.stringify({
        region,
        modelVersionHash,
        gridMetadataHash,
        atlasTileCount,
        selectionCount: selectionIds?.size ?? null,
        dryRun: true,
      }),
    );
    return;
  }

  const result: {
    region: string;
    modelVersionHash: string;
    gridMetadataHash: string;
    tileCount: number;
    atlas: ArchiveSummary | null;
    gridMetadata: ArchiveSummary | null;
    gridMetadataTileCount: number;
  } = {
    region,
    modelVersionHash,
    gridMetadataHash,
    tileCount: atlasTileCount,
    atlas: null,
    gridMetadata: null,
    gridMetadataTileCount: 0,
  };

  if (args.includeAtlas) {
    result.atlas = await packageAtlas({
      region,
      modelVersionHash,
      gridMetadataHash,
      tileCount: atlasTileCount,
      selectionIds,
      outDir: args.outDir,
    });
  }

  if (args.includeGridMetadata && gridMetadataHash) {
    const gm = await packageGridMetadata({
      region,
      modelVersionHash,
      gridMetadataHash,
      selectionIds,
      outDir: args.outDir,
    });
    result.gridMetadata = gm.summary;
    result.gridMetadataTileCount = gm.tileCount;
  }

  console.error(`[package-atlas] ✓ ${region} packagé.`);
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  console.error("[package-atlas] Erreur fatale :", err);
  process.exit(1);
});
