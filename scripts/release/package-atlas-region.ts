/**
 * Package atlas files for a region into a tar archive ready for GitHub Release.
 *
 * Usage:
 *   tsx scripts/release/package-atlas-region.ts --region=lausanne [--model-version-hash=auto] [--out-dir=dist/releases]
 *
 * Output:
 *   dist/releases/{region}-atlas.tar             (or .tar.part1, .tar.part2, ... if > 1.8 GB)
 *   dist/releases/{region}-atlas.tar.sha256      (or per-part sha256s)
 *
 * Returns a JSON summary on stdout (for aggregation by build-release-manifest.ts).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CACHE_SUNLIGHT_DIR =
  process.env.MAPPY_CACHE_SUNLIGHT_DIR?.trim() ||
  path.join(process.cwd(), "data", "cache", "sunlight");

const ATLAS_RESOLUTION_DEG = "0.75";
const GRID_STEP = "1";
const MAX_PART_BYTES = 1.8 * 1024 * 1024 * 1024; // 1.8 GB

function parseArgs() {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.slice(2).split("=");
        return [k, v ?? "true"];
      }),
  );
  return {
    region: args["region"] ?? null,
    modelVersionHash: args["model-version-hash"] ?? "auto",
    outDir: args["out-dir"] ?? path.join(process.cwd(), "dist", "releases"),
    dryRun: args["dry-run"] === "true",
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
      const count = files.filter((f) => f.endsWith(".atlas.bin.gz")).length;
      if (!best || count > best.tileCount) best = { hash, tileCount: count };
    } catch {
      // no atlas dir for this hash
    }
  }
  return best;
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

async function splitFile(inputPath: string, outDir: string, baseName: string): Promise<string[]> {
  const totalSize = (await fsp.stat(inputPath)).size;
  if (totalSize <= MAX_PART_BYTES) {
    const dest = path.join(outDir, baseName);
    await fsp.rename(inputPath, dest);
    return [dest];
  }

  const partPaths: string[] = [];
  const reader = fs.createReadStream(inputPath, { highWaterMark: 64 * 1024 * 1024 });
  let partIndex = 1;
  let bytesWritten = 0;
  let writer: fs.WriteStream | null = null;

  const nextWriter = () => {
    const partPath = path.join(outDir, `${baseName}.part${partIndex}`);
    partPaths.push(partPath);
    partIndex++;
    bytesWritten = 0;
    writer = fs.createWriteStream(partPath);
    return writer;
  };

  writer = nextWriter();

  for await (const chunk of reader) {
    const buf = chunk as Buffer;
    let offset = 0;
    while (offset < buf.length) {
      const remaining = MAX_PART_BYTES - bytesWritten;
      const slice = buf.subarray(offset, offset + remaining);
      writer!.write(slice);
      bytesWritten += slice.length;
      offset += slice.length;
      if (bytesWritten >= MAX_PART_BYTES && offset < buf.length) {
        await new Promise<void>((r) => writer!.end(r));
        writer = nextWriter();
      }
    }
  }
  await new Promise<void>((r) => writer!.end(r));
  await fsp.unlink(inputPath);
  return partPaths;
}

async function main() {
  const args = parseArgs();
  if (!args.region) {
    console.error("Usage: tsx package-atlas-region.ts --region=<name> [--model-version-hash=auto] [--out-dir=dist/releases]");
    process.exit(1);
  }

  const region = args.region;
  console.error(`\n[package-atlas] Région : ${region}`);

  // Resolve hash
  let modelVersionHash = args.modelVersionHash;
  let tileCount = 0;
  if (modelVersionHash === "auto") {
    const best = await findBestModelVersionHash(region);
    if (!best) {
      console.error(`[package-atlas] Aucun atlas trouvé pour ${region} dans ${CACHE_SUNLIGHT_DIR}`);
      process.exit(1);
    }
    modelVersionHash = best.hash;
    tileCount = best.tileCount;
    console.error(`[package-atlas] Hash sélectionné : ${modelVersionHash} (${tileCount} tuiles)`);
  } else {
    const atlasDir = path.join(CACHE_SUNLIGHT_DIR, region, modelVersionHash, `g${GRID_STEP}`, "atlas", `r${ATLAS_RESOLUTION_DEG}`);
    const files = await fsp.readdir(atlasDir).catch(() => [] as string[]);
    tileCount = files.filter((f) => f.endsWith(".atlas.bin.gz")).length;
  }

  const atlasDir = path.join(
    CACHE_SUNLIGHT_DIR,
    region,
    modelVersionHash,
    `g${GRID_STEP}`,
    "atlas",
    `r${ATLAS_RESOLUTION_DEG}`,
  );

  // Verify atlas dir exists
  const atlasStat = await fsp.stat(atlasDir).catch(() => null);
  if (!atlasStat?.isDirectory()) {
    console.error(`[package-atlas] Répertoire atlas introuvable : ${atlasDir}`);
    process.exit(1);
  }

  const files = await fsp.readdir(atlasDir);
  const binFiles = files.filter((f) => f.endsWith(".atlas.bin.gz"));
  const idxFiles = files.filter((f) => f.endsWith(".atlas.idx"));
  console.error(`[package-atlas] ${binFiles.length} .atlas.bin.gz, ${idxFiles.length} .atlas.idx`);

  await fsp.mkdir(args.outDir, { recursive: true });

  // Write release-info.json inside the archive staging dir
  const stagingDir = path.join(args.outDir, `_staging_${region}`);
  await fsp.mkdir(stagingDir, { recursive: true });
  await fsp.mkdir(path.join(stagingDir, "atlas", `r${ATLAS_RESOLUTION_DEG}`), { recursive: true });

  const releaseInfo = {
    region,
    modelVersionHash,
    algorithmVersion: "sunlight-cache-v9",
    artifactFormatVersion: 2,
    atlasResolutionDeg: parseFloat(ATLAS_RESOLUTION_DEG),
    gridStepMeters: parseInt(GRID_STEP),
    tileCount: binFiles.length,
    generatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(
    path.join(stagingDir, "release-info.json"),
    JSON.stringify(releaseInfo, null, 2),
  );

  // Copy atlas files into staging
  console.error(`[package-atlas] Copie des fichiers atlas...`);
  for (const f of [...binFiles, ...idxFiles]) {
    await fsp.copyFile(
      path.join(atlasDir, f),
      path.join(stagingDir, "atlas", `r${ATLAS_RESOLUTION_DEG}`, f),
    );
  }

  if (args.dryRun) {
    console.error(`[package-atlas] Dry-run — staging préparé dans ${stagingDir}`);
    await fsp.rm(stagingDir, { recursive: true });
    process.stdout.write(JSON.stringify({ region, modelVersionHash, tileCount: binFiles.length, dryRun: true }));
    return;
  }

  // Create tar
  const tmpTar = path.join(args.outDir, `${region}-atlas.tar.tmp`);
  console.error(`[package-atlas] Création de l'archive tar...`);
  const tarResult = spawnSync("tar", ["-cf", tmpTar, "-C", stagingDir, "."], { stdio: "inherit" });
  if (tarResult.status !== 0) {
    console.error(`[package-atlas] Erreur tar (code ${tarResult.status})`);
    process.exit(1);
  }
  await fsp.rm(stagingDir, { recursive: true });

  // Split if needed
  const parts = await splitFile(tmpTar, args.outDir, `${region}-atlas.tar`);
  const isSplit = parts.length > 1;

  if (isSplit) {
    console.error(`[package-atlas] Archive splittée en ${parts.length} parts :`);
  }

  // SHA256 per part
  const partInfos: Array<{ name: string; sha256: string; bytes: number }> = [];
  for (const partPath of parts) {
    const sha = await sha256File(partPath);
    const bytes = (await fsp.stat(partPath)).size;
    const name = path.basename(partPath);
    await fsp.writeFile(`${partPath}.sha256`, `${sha}  ${name}\n`);
    partInfos.push({ name, sha256: sha, bytes });
    console.error(`[package-atlas]   ${name} — ${(bytes / 1e6).toFixed(1)} MB  sha256=${sha.slice(0, 12)}...`);
  }

  const summary = {
    region,
    modelVersionHash,
    tileCount: binFiles.length,
    isSplit,
    parts: partInfos,
    assetName: isSplit ? undefined : `${region}-atlas.tar`,
    sha256: isSplit ? undefined : partInfos[0].sha256,
    bytes: isSplit ? undefined : partInfos[0].bytes,
  };

  console.error(`[package-atlas] ✓ ${region} packagé.`);
  process.stdout.write(JSON.stringify(summary));
}

main().catch((err) => {
  console.error("[package-atlas] Erreur fatale :", err);
  process.exit(1);
});
