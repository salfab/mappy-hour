/**
 * Download and install atlas files from a GitHub Release.
 *
 * Usage:
 *   tsx scripts/release/download-atlas.ts \
 *     [--regions=lausanne,nyon] \
 *     [--release=latest | --release=atlas-v9-2026-05-08] \
 *     [--repo=owner/repo] \
 *     [--out=data/cache/sunlight]
 *
 * The script:
 *   1. Downloads release-manifest.json from the GitHub release
 *   2. Checks algorithmVersion + artifactFormatVersion compatibility
 *   3. For each requested region:
 *      a. Skips if atlas already installed with same modelVersionHash
 *      b. Downloads .tar (or all .tar.partN)
 *      c. Verifies SHA256
 *      d. Extracts into CACHE_SUNLIGHT_DIR/{region}/{modelVersionHash}/g1/atlas/r0.75/
 *   4. For each requested region, downloads {region}-places.json if manifest has a "places" section
 *   5. Writes atlas-version.json marker
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CACHE_SUNLIGHT_DIR, PROCESSED_PLACES_DIR } from "@/lib/storage/data-paths";
import {
  SUNLIGHT_CACHE_ALGORITHM_VERSION,
  SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
} from "@/lib/precompute/model-version";

const GRID_STEP = "1";
const ATLAS_RESOLUTION_DEG = "0.75";

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
    regions: args["regions"]
      ? args["regions"].split(",").map((r) => r.trim()).filter(Boolean)
      : null,
    release: args["release"] ?? "latest",
    repo: args["repo"] ?? null,
    out: args["out"]
      ? path.isAbsolute(args["out"])
        ? args["out"]
        : path.resolve(process.cwd(), args["out"])
      : CACHE_SUNLIGHT_DIR,
  };
}

function buildAssetUrl(
  baseReleaseUrl: string,
  assetName: string,
): string {
  return `${baseReleaseUrl}/${assetName}`;
}

async function fetchManifest(baseUrl: string): Promise<Record<string, unknown>> {
  const url = `${baseUrl}/release-manifest.json`;
  console.error(`[download-atlas] Téléchargement manifest : ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Impossible de télécharger le manifest (${response.status}): ${url}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

async function downloadWithProgress(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Téléchargement échoué (${response.status}): ${url}`);
  }
  const totalBytes = Number(response.headers.get("content-length") ?? 0);
  const writer = fs.createWriteStream(destPath);

  let downloaded = 0;
  let lastPct = -1;
  const reader = response.body!.getReader();

  await new Promise<void>((resolve, reject) => {
    writer.on("error", reject);
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
          downloaded += value.length;
          if (totalBytes > 0) {
            const pct = Math.floor((downloaded / totalBytes) * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              process.stderr.write(
                `\r[download-atlas]   ${(downloaded / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB  (${pct}%)   `,
              );
              lastPct = pct;
            }
          }
        }
        writer.end(resolve);
      } catch (e) {
        writer.destroy();
        reject(e);
      }
    };
    pump();
  });
  process.stderr.write("\n");
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

async function extractTar(tarPath: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const result = spawnSync("tar", ["-xf", tarPath, "-C", destDir], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`tar extract échoué (exit ${result.status})`);
  }
}

async function concatenateParts(partPaths: string[], outPath: string): Promise<void> {
  const writer = fs.createWriteStream(outPath);
  for (const partPath of partPaths) {
    await new Promise<void>((resolve, reject) => {
      const reader = fs.createReadStream(partPath);
      reader.on("error", reject);
      reader.on("end", resolve);
      reader.pipe(writer, { end: false });
    });
  }
  await new Promise<void>((r) => writer.end(r));
}

interface ManifestRegion {
  modelVersionHash: string;
  tileCount: number;
  isSplit: boolean;
  parts?: Array<{ name: string; sha256: string; bytes: number }>;
  assetName?: string;
  sha256?: string;
  bytes?: number;
}

interface PlacesManifestEntry {
  assetName: string;
  sha256: string;
  bytes: number;
}

async function processRegion(
  region: string,
  regionMeta: ManifestRegion,
  baseUrl: string,
  outDir: string,
  tmpDir: string,
): Promise<void> {
  const destAtlasDir = path.join(
    outDir,
    region,
    regionMeta.modelVersionHash,
    `g${GRID_STEP}`,
    "atlas",
    `r${ATLAS_RESOLUTION_DEG}`,
  );

  // Idempotency check: count existing .atlas.bin.gz files
  let existingCount = 0;
  try {
    const existing = await fsp.readdir(destAtlasDir);
    existingCount = existing.filter((f) => f.endsWith(".atlas.bin.gz")).length;
  } catch {
    // dir doesn't exist yet
  }

  if (existingCount >= regionMeta.tileCount) {
    console.error(
      `[download-atlas] ↩ ${region} déjà installé (${existingCount}/${regionMeta.tileCount} tuiles, hash=${regionMeta.modelVersionHash.slice(0, 8)}...) — skip`,
    );
    return;
  }

  console.error(
    `\n[download-atlas] ▶ ${region}  (${regionMeta.tileCount} tuiles, hash=${regionMeta.modelVersionHash.slice(0, 8)}...)`,
  );

  const regionTmp = path.join(tmpDir, region);
  await fsp.mkdir(regionTmp, { recursive: true });

  let tarPath: string;

  if (regionMeta.isSplit && regionMeta.parts) {
    // Download each part and verify SHA256
    const downloadedParts: string[] = [];
    for (const part of regionMeta.parts) {
      const partUrl = buildAssetUrl(baseUrl, part.name);
      const partDest = path.join(regionTmp, part.name);
      console.error(`[download-atlas]   Téléchargement ${part.name} (${(part.bytes / 1e6).toFixed(1)} MB)`);
      await downloadWithProgress(partUrl, partDest);

      const actualSha = await sha256File(partDest);
      if (actualSha !== part.sha256) {
        throw new Error(
          `SHA256 mismatch pour ${part.name}\n  attendu : ${part.sha256}\n  obtenu  : ${actualSha}`,
        );
      }
      console.error(`[download-atlas]   ✓ SHA256 OK`);
      downloadedParts.push(partDest);
    }

    // Concatenate parts
    tarPath = path.join(regionTmp, `${region}-atlas.tar`);
    console.error(`[download-atlas]   Concaténation des ${downloadedParts.length} parts...`);
    await concatenateParts(downloadedParts, tarPath);
    for (const p of downloadedParts) await fsp.unlink(p);
  } else {
    // Single file
    if (!regionMeta.assetName || !regionMeta.sha256) {
      throw new Error(`Manifest incomplet pour ${region} (assetName ou sha256 manquant)`);
    }
    const assetUrl = buildAssetUrl(baseUrl, regionMeta.assetName);
    tarPath = path.join(regionTmp, regionMeta.assetName);
    console.error(
      `[download-atlas]   Téléchargement ${regionMeta.assetName} (${regionMeta.bytes ? (regionMeta.bytes / 1e6).toFixed(1) + " MB" : "taille inconnue"})`,
    );
    await downloadWithProgress(assetUrl, tarPath);

    const actualSha = await sha256File(tarPath);
    if (actualSha !== regionMeta.sha256) {
      throw new Error(
        `SHA256 mismatch pour ${regionMeta.assetName}\n  attendu : ${regionMeta.sha256}\n  obtenu  : ${actualSha}`,
      );
    }
    console.error(`[download-atlas]   ✓ SHA256 OK`);
  }

  // Extract — the tar contains release-info.json + atlas/r0.75/*.atlas.bin.gz|idx
  const stagingDir = path.join(regionTmp, "extracted");
  await extractTar(tarPath, stagingDir);
  await fsp.unlink(tarPath);

  // Move atlas files to final destination
  const srcAtlasDir = path.join(stagingDir, "atlas", `r${ATLAS_RESOLUTION_DEG}`);
  await fsp.mkdir(destAtlasDir, { recursive: true });

  const extracted = await fsp.readdir(srcAtlasDir);
  for (const f of extracted) {
    await fsp.rename(path.join(srcAtlasDir, f), path.join(destAtlasDir, f));
  }

  // Also copy release-info.json one level up (next to atlas/)
  const releaseInfoSrc = path.join(stagingDir, "release-info.json");
  const releaseInfoDest = path.join(
    outDir,
    region,
    regionMeta.modelVersionHash,
    `g${GRID_STEP}`,
    "release-info.json",
  );
  try {
    await fsp.rename(releaseInfoSrc, releaseInfoDest);
  } catch {
    // non-critical
  }

  await fsp.rm(regionTmp, { recursive: true, force: true });

  const installed = (await fsp.readdir(destAtlasDir)).filter((f) =>
    f.endsWith(".atlas.bin.gz"),
  ).length;
  console.error(`[download-atlas]   ✓ ${region} installé — ${installed}/${regionMeta.tileCount} tuiles`);
}

async function processPlacesFile(
  region: string,
  entry: PlacesManifestEntry,
  baseUrl: string,
  placesDir: string,
): Promise<void> {
  const destPath = path.join(placesDir, entry.assetName);

  // Idempotency check: if file exists and SHA256 matches, skip
  try {
    const existingSha = await sha256File(destPath);
    if (existingSha === entry.sha256) {
      console.error(
        `[download-atlas] ↩ ${entry.assetName} déjà présent (SHA256 OK) — skip`,
      );
      return;
    }
  } catch {
    // file doesn't exist yet, proceed with download
  }

  console.error(
    `\n[download-atlas] ▶ Téléchargement places ${region} : ${entry.assetName} (${(entry.bytes / 1e3).toFixed(1)} KB)`,
  );

  await fsp.mkdir(placesDir, { recursive: true });

  const url = `${baseUrl}/${entry.assetName}`;
  const tmpPath = destPath + ".tmp";
  await downloadWithProgress(url, tmpPath);

  const actualSha = await sha256File(tmpPath);
  if (actualSha !== entry.sha256) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw new Error(
      `SHA256 mismatch pour ${entry.assetName}\n  attendu : ${entry.sha256}\n  obtenu  : ${actualSha}`,
    );
  }

  await fsp.writeFile(destPath, await fsp.readFile(tmpPath));
  await fsp.unlink(tmpPath);

  console.error(`[download-atlas]   ✓ ${entry.assetName} installé → ${destPath}`);
}

async function main() {
  const args = parseArgs();

  if (!args.repo) {
    console.error(
      "Usage: tsx download-atlas.ts --repo=owner/repo [--regions=lausanne,nyon] [--release=latest] [--out=data/cache/sunlight]",
    );
    process.exit(1);
  }

  const baseUrl =
    args.release === "latest"
      ? `https://github.com/${args.repo}/releases/latest/download`
      : `https://github.com/${args.repo}/releases/download/${args.release}`;

  const manifest = await fetchManifest(baseUrl);

  // Compatibility check
  const mAlgVersion = manifest["algorithmVersion"] as string;
  const mFmtVersion = manifest["artifactFormatVersion"] as number;

  if (mAlgVersion !== SUNLIGHT_CACHE_ALGORITHM_VERSION) {
    console.error(
      `[download-atlas] ✗ algorithmVersion incompatible.\n` +
        `  Manifest    : ${mAlgVersion}\n` +
        `  Code local  : ${SUNLIGHT_CACHE_ALGORITHM_VERSION}\n` +
        `  → Mettez à jour le code source ou utilisez une release compatible.`,
    );
    process.exit(1);
  }
  if (mFmtVersion !== SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION) {
    console.error(
      `[download-atlas] ✗ artifactFormatVersion incompatible.\n` +
        `  Manifest    : ${mFmtVersion}\n` +
        `  Code local  : ${SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION}\n` +
        `  → Mettez à jour le code source ou utilisez une release compatible.`,
    );
    process.exit(1);
  }

  const allRegions = Object.keys(manifest["regions"] as Record<string, unknown>);
  const targetRegions = args.regions ?? allRegions;
  const unknownRegions = targetRegions.filter((r) => !allRegions.includes(r));
  if (unknownRegions.length > 0) {
    console.error(
      `[download-atlas] ✗ Régions inconnues dans la release : ${unknownRegions.join(", ")}\n` +
        `  Régions disponibles : ${allRegions.join(", ")}`,
    );
    process.exit(1);
  }

  console.error(`\n[download-atlas] Release   : ${args.release}`);
  console.error(`[download-atlas] Tag        : ${manifest["releaseTag"]}`);
  console.error(`[download-atlas] Régions    : ${targetRegions.join(", ")}`);
  console.error(`[download-atlas] Destination: ${args.out}\n`);

  const tmpDir = path.join(args.out, ".download-tmp");
  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    for (const region of targetRegions) {
      const regionMeta = (manifest["regions"] as Record<string, ManifestRegion>)[region];
      await processRegion(region, regionMeta, baseUrl, args.out, tmpDir);
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  // Download places files if manifest has a "places" section
  const manifestPlaces = manifest["places"] as Record<string, PlacesManifestEntry> | undefined;
  const installedPlacesRegions: string[] = [];
  if (manifestPlaces) {
    for (const region of targetRegions) {
      const entry = manifestPlaces[region];
      if (entry) {
        await processPlacesFile(region, entry, baseUrl, PROCESSED_PLACES_DIR);
        installedPlacesRegions.push(region);
      }
    }
  }

  // Write marker file
  const markerPath = path.join(args.out, "atlas-version.json");
  const existingMarker = await fsp
    .readFile(markerPath, "utf8")
    .then((s) => JSON.parse(s) as Record<string, unknown>)
    .catch(() => ({}));

  const updatedMarker = {
    ...existingMarker,
    lastInstalled: new Date().toISOString(),
    releaseTag: manifest["releaseTag"],
    algorithmVersion: mAlgVersion,
    artifactFormatVersion: mFmtVersion,
    installedRegions: Array.from(
      new Set([
        ...((existingMarker["installedRegions"] as string[]) ?? []),
        ...targetRegions,
      ]),
    ).sort(),
    placesInstalledRegions: Array.from(
      new Set([
        ...((existingMarker["placesInstalledRegions"] as string[]) ?? []),
        ...installedPlacesRegions,
      ]),
    ).sort(),
  };
  await fsp.writeFile(markerPath, JSON.stringify(updatedMarker, null, 2));

  console.error(`\n[download-atlas] ✓ Installation terminée.`);
  console.error(`[download-atlas]   Marker écrit : ${markerPath}`);
}

main().catch((err) => {
  console.error("[download-atlas] Erreur fatale :", err);
  process.exit(1);
});
