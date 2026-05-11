/**
 * Package the global buildings obstacle index into a shared release archive.
 *
 * The buildings index (`data/processed/buildings/lausanne-buildings-index.json`)
 * is GLOBAL (~70-90 MB) and used by every region's shadow precompute. Shipping
 * it once per release (not per-region) saves ~6× redundancy.
 *
 * Note on the filename: the on-disk name is `lausanne-buildings-index.json`
 * for historical reasons; it actually covers every region (Pierre Schmid built
 * it from the full Swiss SwissBuildings3D ingest). The shipped name is kept
 * identical so the unpack drops it into `data/processed/buildings/` and the
 * runtime's `PROCESSED_BUILDINGS_INDEX_PATH` finds it without indirection.
 *
 * Usage:
 *   tsx scripts/release/package-buildings-shared.ts [--out-dir=dist/releases]
 *
 * Returns a JSON summary on stdout (consumed by build-release-manifest.ts).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROCESSED_BUILDINGS_DIR =
  process.env.MAPPY_PROCESSED_BUILDINGS_DIR?.trim() ||
  path.join(process.cwd(), "data", "processed", "buildings");

const INDEX_FILENAME = "lausanne-buildings-index.json";

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

interface Args {
  outDir: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const kv: Record<string, string> = {};
  const flags = new Set<string>();
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--")) {
      const idx = a.indexOf("=");
      if (idx === -1) flags.add(a.slice(2));
      else kv[a.slice(2, idx)] = a.slice(idx + 1);
    }
  }
  return {
    outDir: kv["out-dir"] ?? path.join(process.cwd(), "dist", "releases"),
    dryRun: flags.has("dry-run") || kv["dry-run"] === "true",
  };
}

async function main() {
  const args = parseArgs();
  const indexPath = path.join(PROCESSED_BUILDINGS_DIR, INDEX_FILENAME);

  const stat = await fsp.stat(indexPath).catch(() => null);
  if (!stat?.isFile()) {
    console.error(`[package-buildings] Index introuvable : ${indexPath}`);
    console.error(`[package-buildings] Lance d'abord : pnpm preprocess:buildings:index`);
    process.exit(1);
  }

  // Read just enough of the header to grab generatedAt / counts (avoids loading
  // the whole 71 MB into memory; we only need a few fields for the summary).
  let header: { generatedAt?: string; uniqueObstaclesCount?: number; indexVersion?: number } = {};
  try {
    const fh = await fsp.open(indexPath, "r");
    const buf = Buffer.alloc(8192);
    await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    // Find each scalar field's value. Crude but cheap.
    const pick = (key: string, isString: boolean) => {
      const re = isString
        ? new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`)
        : new RegExp(`"${key}"\\s*:\\s*(\\d+)`);
      const m = buf.toString("utf8").match(re);
      return m?.[1];
    };
    header.generatedAt = pick("generatedAt", true);
    const uniq = pick("uniqueObstaclesCount", false);
    header.uniqueObstaclesCount = uniq ? Number(uniq) : undefined;
    const ver = pick("indexVersion", false);
    header.indexVersion = ver ? Number(ver) : undefined;
  } catch {
    /* non-fatal: header probe failed */
  }

  console.error(`\n[package-buildings] Index : ${indexPath}`);
  console.error(
    `[package-buildings]   ${(stat.size / 1e6).toFixed(1)} MB  generatedAt=${header.generatedAt ?? "?"}  ` +
      `obstacles=${header.uniqueObstaclesCount ?? "?"}  indexVersion=${header.indexVersion ?? "?"}`,
  );

  await fsp.mkdir(args.outDir, { recursive: true });

  if (args.dryRun) {
    process.stdout.write(
      JSON.stringify({
        archiveName: "buildings-shared.tar",
        indexBytes: stat.size,
        generatedAt: header.generatedAt,
        uniqueObstaclesCount: header.uniqueObstaclesCount,
        indexVersion: header.indexVersion,
        dryRun: true,
      }),
    );
    return;
  }

  const stagingDir = path.join(args.outDir, "_staging_buildings_shared");
  await fsp.mkdir(path.join(stagingDir, "buildings"), { recursive: true });

  const releaseInfo = {
    kind: "buildings-shared",
    indexFilename: INDEX_FILENAME,
    indexBytes: stat.size,
    generatedAt: header.generatedAt,
    uniqueObstaclesCount: header.uniqueObstaclesCount,
    indexVersion: header.indexVersion,
    packagedAt: new Date().toISOString(),
  };
  await fsp.writeFile(
    path.join(stagingDir, "release-info.json"),
    JSON.stringify(releaseInfo, null, 2),
  );

  await fsp.copyFile(indexPath, path.join(stagingDir, "buildings", INDEX_FILENAME));

  // Hash the index file itself (not the tar) so download-atlas can do a robust
  // idempotency check on the installed JSON without unpacking the tar.
  const indexSha256 = await sha256File(indexPath);
  console.error(`[package-buildings]   index sha256=${indexSha256.slice(0, 16)}…`);

  const archiveName = "buildings-shared.tar";
  const tarPath = path.join(args.outDir, archiveName);
  console.error(`[package-buildings] Création de ${archiveName}...`);
  const tarResult = spawnSync("tar", ["-cf", tarPath, "-C", stagingDir, "."], { stdio: "inherit" });
  if (tarResult.status !== 0) {
    console.error(`[package-buildings] tar failed (code ${tarResult.status})`);
    process.exit(1);
  }
  await fsp.rm(stagingDir, { recursive: true });

  const sha = await sha256File(tarPath);
  const bytes = (await fsp.stat(tarPath)).size;
  await fsp.writeFile(`${tarPath}.sha256`, `${sha}  ${archiveName}\n`);
  console.error(`[package-buildings]   ${archiveName} — ${(bytes / 1e6).toFixed(1)} MB  sha256=${sha.slice(0, 12)}…`);

  const summary = {
    archiveName,
    assetName: archiveName,
    sha256: sha,
    bytes,
    indexBytes: stat.size,
    indexSha256,
    generatedAt: header.generatedAt,
    uniqueObstaclesCount: header.uniqueObstaclesCount,
    indexVersion: header.indexVersion,
  };

  console.error(`[package-buildings] ✓ buildings-shared packagé.`);
  process.stdout.write(JSON.stringify(summary));
}

main().catch((err) => {
  console.error("[package-buildings] Erreur fatale :", err);
  process.exit(1);
});
