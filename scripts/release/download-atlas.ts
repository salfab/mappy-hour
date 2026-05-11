/**
 * Download and install atlas (+ optional grid-metadata, + optional shared
 * buildings index) from a GitHub Release.
 *
 * Per the 2026-05-12 packaging redesign, a release is composed of:
 *   - {region}-atlas.tar          (one per region, required for serving sunlight)
 *   - {region}-grid-metadata.tar  (one per region, optional — only needed if
 *                                  the deploy can re-precompute or wants to
 *                                  serve the indoor mask directly)
 *   - buildings-shared.tar        (single global, optional — only needed if
 *                                  the deploy will re-precompute atlases)
 *   - {region}-places.json        (optional sidecar)
 *
 * Cache-only headless deploys (Mitch) should run the default
 * (atlas + places only). Re-precompute-capable hosts pass
 * --with-grid-metadata --with-buildings.
 *
 * Usage:
 *   tsx scripts/release/download-atlas.ts \
 *     --repo=salfab/mappy-hour \
 *     [--regions=lausanne,nyon] \
 *     [--release=latest | --release=v9.2.20260512000] \
 *     [--out=data/cache/sunlight] \
 *     [--with-grid-metadata] \
 *     [--with-buildings]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CACHE_SUNLIGHT_DIR,
  CACHE_TILE_GRID_METADATA_DIR,
  PROCESSED_BUILDINGS_DIR,
  PROCESSED_PLACES_DIR,
} from "@/lib/storage/data-paths";
import {
  SUNLIGHT_CACHE_ALGORITHM_VERSION,
  SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
} from "@/lib/precompute/model-version";

const GRID_STEP = "1";
const ATLAS_RESOLUTION_DEG = "0.75";

interface PartInfo {
  name: string;
  sha256: string;
  bytes: number;
}

interface ArchiveSummary {
  archiveName: string;
  isSplit: boolean;
  parts: PartInfo[];
  assetName?: string;
  sha256?: string;
  bytes?: number;
}

interface ManifestRegion {
  modelVersionHash: string;
  gridMetadataHash: string;
  tileCount: number;
  atlas: ArchiveSummary | null;
  gridMetadata: ArchiveSummary | null;
  gridMetadataTileCount: number;
}

interface BuildingsSharedManifest {
  archiveName: "buildings-shared.tar";
  assetName: string;
  sha256: string;
  bytes: number;
  indexBytes?: number;
  indexSha256?: string;
  uniqueObstaclesCount?: number;
  generatedAt?: string;
  indexVersion?: number;
}

interface PlacesManifestEntry {
  assetName: string;
  sha256: string;
  bytes: number;
}

function tileIdFromAtlasFile(fileName: string): string | null {
  const match = fileName.match(/^(.*)\.atlas\.(?:bin\.gz|idx|shards\.json|base\.bin\.zst|shard-\d+\.bin\.zst)$/);
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

function parseArgs() {
  const kv: Record<string, string> = {};
  const flags = new Set<string>();
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const idx = a.indexOf("=");
    if (idx === -1) flags.add(a.slice(2));
    else kv[a.slice(2, idx)] = a.slice(idx + 1);
  }
  return {
    regions: kv["regions"]
      ? kv["regions"].split(",").map((r) => r.trim()).filter(Boolean)
      : null,
    release: kv["release"] ?? "latest",
    repo: kv["repo"] ?? null,
    out: kv["out"]
      ? path.isAbsolute(kv["out"])
        ? kv["out"]
        : path.resolve(process.cwd(), kv["out"])
      : CACHE_SUNLIGHT_DIR,
    withGridMetadata: flags.has("with-grid-metadata") || kv["with-grid-metadata"] === "true",
    withBuildings: flags.has("with-buildings") || kv["with-buildings"] === "true",
  };
}

function buildAssetUrl(baseReleaseUrl: string, assetName: string): string {
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

/** Download one ArchiveSummary (single or multi-part) into `regionTmp` and
 *  return the local path of the assembled tar. */
async function downloadArchive(
  archive: ArchiveSummary,
  baseUrl: string,
  regionTmp: string,
  fallbackName: string,
): Promise<string> {
  if (archive.isSplit) {
    const downloadedParts: string[] = [];
    for (const part of archive.parts) {
      const partUrl = buildAssetUrl(baseUrl, part.name);
      const partDest = path.join(regionTmp, part.name);
      console.error(`[download-atlas]   Téléchargement ${part.name} (${(part.bytes / 1e6).toFixed(1)} MB)`);
      await downloadWithProgress(partUrl, partDest);

      const actualSha = await sha256File(partDest);
      if (actualSha !== part.sha256) {
        throw new Error(`SHA256 mismatch pour ${part.name}\n  attendu : ${part.sha256}\n  obtenu  : ${actualSha}`);
      }
      console.error(`[download-atlas]   ✓ SHA256 OK`);
      downloadedParts.push(partDest);
    }

    const tarPath = path.join(regionTmp, fallbackName);
    console.error(`[download-atlas]   Concaténation des ${downloadedParts.length} parts…`);
    await concatenateParts(downloadedParts, tarPath);
    for (const p of downloadedParts) await fsp.unlink(p);
    return tarPath;
  }
  if (!archive.assetName || !archive.sha256) {
    throw new Error(`Manifest incomplet pour ${archive.archiveName} (assetName ou sha256 manquant)`);
  }
  const assetUrl = buildAssetUrl(baseUrl, archive.assetName);
  const tarPath = path.join(regionTmp, archive.assetName);
  console.error(
    `[download-atlas]   Téléchargement ${archive.assetName} (${archive.bytes ? (archive.bytes / 1e6).toFixed(1) + " MB" : "taille inconnue"})`,
  );
  await downloadWithProgress(assetUrl, tarPath);

  const actualSha = await sha256File(tarPath);
  if (actualSha !== archive.sha256) {
    throw new Error(`SHA256 mismatch pour ${archive.assetName}\n  attendu : ${archive.sha256}\n  obtenu  : ${actualSha}`);
  }
  console.error(`[download-atlas]   ✓ SHA256 OK`);
  return tarPath;
}

async function processRegionAtlas(
  region: string,
  regionMeta: ManifestRegion,
  baseUrl: string,
  outDir: string,
  tmpDir: string,
): Promise<void> {
  if (!regionMeta.atlas) {
    console.error(`[download-atlas] ↩ ${region} : pas d'atlas dans la release — skip.`);
    return;
  }

  const destAtlasDir = path.join(
    outDir,
    region,
    regionMeta.modelVersionHash,
    `g${GRID_STEP}`,
    "atlas",
    `r${ATLAS_RESOLUTION_DEG}`,
  );

  let existingCount = 0;
  try {
    const existing = await fsp.readdir(destAtlasDir);
    existingCount = countAtlasTiles(existing);
  } catch { /* dir doesn't exist yet */ }

  if (existingCount >= regionMeta.tileCount) {
    console.error(
      `[download-atlas] ↩ ${region} atlas déjà installé (${existingCount}/${regionMeta.tileCount} tuiles, hash=${regionMeta.modelVersionHash.slice(0, 8)}…) — skip`,
    );
    return;
  }

  console.error(
    `\n[download-atlas] ▶ ${region} atlas (${regionMeta.tileCount} tuiles, hash=${regionMeta.modelVersionHash.slice(0, 8)}…)`,
  );

  const regionTmp = path.join(tmpDir, `${region}-atlas`);
  await fsp.mkdir(regionTmp, { recursive: true });

  const tarPath = await downloadArchive(regionMeta.atlas, baseUrl, regionTmp, `${region}-atlas.tar`);

  const stagingDir = path.join(regionTmp, "extracted");
  await extractTar(tarPath, stagingDir);
  await fsp.unlink(tarPath);

  const srcAtlasDir = path.join(stagingDir, "atlas", `r${ATLAS_RESOLUTION_DEG}`);
  await fsp.mkdir(destAtlasDir, { recursive: true });

  const extracted = await fsp.readdir(srcAtlasDir);
  for (const f of extracted) {
    await fsp.rm(path.join(destAtlasDir, f), { force: true });
    await fsp.rename(path.join(srcAtlasDir, f), path.join(destAtlasDir, f));
  }

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
  } catch { /* non-critical */ }

  await fsp.rm(regionTmp, { recursive: true, force: true });

  const installed = countAtlasTiles(await fsp.readdir(destAtlasDir));
  console.error(`[download-atlas]   ✓ ${region} atlas installé — ${installed}/${regionMeta.tileCount} tuiles`);
}

async function processRegionGridMetadata(
  region: string,
  regionMeta: ManifestRegion,
  baseUrl: string,
  tmpDir: string,
): Promise<void> {
  if (!regionMeta.gridMetadata) {
    console.error(`[download-atlas] ↩ ${region} grid-metadata : pas dans la release — skip.`);
    return;
  }
  if (!regionMeta.gridMetadataHash) {
    console.error(`[download-atlas] ↩ ${region} grid-metadata : gridMetadataHash absent du manifest — skip.`);
    return;
  }

  const destGridDir = path.join(
    CACHE_TILE_GRID_METADATA_DIR,
    region,
    regionMeta.gridMetadataHash,
    `g${GRID_STEP}`,
  );

  let existingCount = 0;
  try {
    const existing = await fsp.readdir(destGridDir);
    existingCount = existing.filter((f) => f.endsWith(".json.gz")).length;
  } catch { /* dir doesn't exist yet */ }

  if (existingCount >= regionMeta.gridMetadataTileCount) {
    console.error(
      `[download-atlas] ↩ ${region} grid-metadata déjà installé (${existingCount}/${regionMeta.gridMetadataTileCount} tuiles, hash=${regionMeta.gridMetadataHash.slice(0, 8)}…) — skip`,
    );
    return;
  }

  console.error(
    `\n[download-atlas] ▶ ${region} grid-metadata (${regionMeta.gridMetadataTileCount} tuiles, hash=${regionMeta.gridMetadataHash.slice(0, 8)}…)`,
  );

  const regionTmp = path.join(tmpDir, `${region}-grid-meta`);
  await fsp.mkdir(regionTmp, { recursive: true });

  const tarPath = await downloadArchive(
    regionMeta.gridMetadata,
    baseUrl,
    regionTmp,
    `${region}-grid-metadata.tar`,
  );

  const stagingDir = path.join(regionTmp, "extracted");
  await extractTar(tarPath, stagingDir);
  await fsp.unlink(tarPath);

  const srcDir = path.join(stagingDir, "tile-grid-metadata", `g${GRID_STEP}`);
  await fsp.mkdir(destGridDir, { recursive: true });

  const extracted = await fsp.readdir(srcDir);
  for (const f of extracted) {
    await fsp.rm(path.join(destGridDir, f), { force: true });
    await fsp.rename(path.join(srcDir, f), path.join(destGridDir, f));
  }

  await fsp.rm(regionTmp, { recursive: true, force: true });

  console.error(`[download-atlas]   ✓ ${region} grid-metadata installé — ${extracted.length} tuiles`);
}

async function processBuildingsShared(
  meta: BuildingsSharedManifest,
  baseUrl: string,
  tmpDir: string,
): Promise<void> {
  const destPath = path.join(PROCESSED_BUILDINGS_DIR, "lausanne-buildings-index.json");

  // Idempotency: cheap byte-size pre-check, then sha256 confirm if the manifest
  // provides one. sha256 over 71 MB takes <1 s and is the only way to be sure
  // the on-disk index is bit-identical to the released one (different builds
  // can produce same-sized but different content).
  try {
    const stat = await fsp.stat(destPath);
    const sizeMatches = meta.indexBytes && stat.size === meta.indexBytes;
    if (sizeMatches && meta.indexSha256) {
      const localSha = await sha256File(destPath);
      if (localSha === meta.indexSha256) {
        console.error(
          `[download-atlas] ↩ buildings-shared déjà installé (${(stat.size / 1e6).toFixed(1)} MB, sha256 OK) — skip`,
        );
        return;
      }
      console.error(
        `[download-atlas] buildings-shared : taille match mais sha256 diffère → re-download`,
      );
    } else if (sizeMatches) {
      // Older manifest without indexSha256 — fall back to size-only (legacy).
      console.error(
        `[download-atlas] ↩ buildings-shared déjà installé (${(stat.size / 1e6).toFixed(1)} MB, no sha256 in manifest) — skip`,
      );
      return;
    }
  } catch { /* file absent */ }

  console.error(
    `\n[download-atlas] ▶ buildings-shared (${meta.uniqueObstaclesCount ?? "?"} obstacles, indexVersion=${meta.indexVersion ?? "?"})`,
  );

  const sharedTmp = path.join(tmpDir, "buildings-shared");
  await fsp.mkdir(sharedTmp, { recursive: true });

  const archive: ArchiveSummary = {
    archiveName: meta.archiveName,
    isSplit: false,
    parts: [],
    assetName: meta.assetName,
    sha256: meta.sha256,
    bytes: meta.bytes,
  };
  const tarPath = await downloadArchive(archive, baseUrl, sharedTmp, meta.archiveName);

  const stagingDir = path.join(sharedTmp, "extracted");
  await extractTar(tarPath, stagingDir);
  await fsp.unlink(tarPath);

  await fsp.mkdir(PROCESSED_BUILDINGS_DIR, { recursive: true });
  const srcIndexPath = path.join(stagingDir, "buildings", "lausanne-buildings-index.json");
  await fsp.rm(destPath, { force: true });
  await fsp.rename(srcIndexPath, destPath);

  await fsp.rm(sharedTmp, { recursive: true, force: true });

  const stat = await fsp.stat(destPath);
  console.error(`[download-atlas]   ✓ buildings-shared installé → ${destPath} (${(stat.size / 1e6).toFixed(1)} MB)`);
}

async function processPlacesFile(
  region: string,
  entry: PlacesManifestEntry,
  baseUrl: string,
  placesDir: string,
): Promise<void> {
  const destPath = path.join(placesDir, entry.assetName);

  try {
    const existingSha = await sha256File(destPath);
    if (existingSha === entry.sha256) {
      console.error(`[download-atlas] ↩ ${entry.assetName} déjà présent (SHA256 OK) — skip`);
      return;
    }
  } catch { /* file absent */ }

  console.error(
    `\n[download-atlas] ▶ places ${region} : ${entry.assetName} (${(entry.bytes / 1e3).toFixed(1)} KB)`,
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

  await fsp.rename(tmpPath, destPath);
  console.error(`[download-atlas]   ✓ ${entry.assetName} installé → ${destPath}`);
}

async function main() {
  const args = parseArgs();

  if (!args.repo) {
    console.error(
      "Usage: tsx download-atlas.ts --repo=owner/repo [--regions=lausanne,nyon] [--release=latest] [--out=data/cache/sunlight] [--with-grid-metadata] [--with-buildings]",
    );
    process.exit(1);
  }

  const baseUrl =
    args.release === "latest"
      ? `https://github.com/${args.repo}/releases/latest/download`
      : `https://github.com/${args.repo}/releases/download/${args.release}`;

  const manifest = await fetchManifest(baseUrl);

  const mAlgVersion = manifest["algorithmVersion"] as string;
  const mFmtVersion = manifest["artifactFormatVersion"] as number;

  if (mAlgVersion !== SUNLIGHT_CACHE_ALGORITHM_VERSION) {
    console.error(
      `[download-atlas] ✗ algorithmVersion incompatible.\n  Manifest    : ${mAlgVersion}\n  Code local  : ${SUNLIGHT_CACHE_ALGORITHM_VERSION}`,
    );
    process.exit(1);
  }
  if (mFmtVersion !== SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION) {
    console.error(
      `[download-atlas] ✗ artifactFormatVersion incompatible.\n  Manifest    : ${mFmtVersion}\n  Code local  : ${SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION}`,
    );
    process.exit(1);
  }

  const regionsMap = manifest["regions"] as Record<string, ManifestRegion>;
  const allRegions = Object.keys(regionsMap);
  const targetRegions = args.regions ?? allRegions;
  const unknownRegions = targetRegions.filter((r) => !allRegions.includes(r));
  if (unknownRegions.length > 0) {
    console.error(
      `[download-atlas] ✗ Régions inconnues : ${unknownRegions.join(", ")}\n  Disponibles : ${allRegions.join(", ")}`,
    );
    process.exit(1);
  }

  console.error(`\n[download-atlas] Release       : ${args.release}`);
  console.error(`[download-atlas] Tag           : ${manifest["releaseTag"]}`);
  console.error(`[download-atlas] Régions       : ${targetRegions.join(", ")}`);
  console.error(`[download-atlas] Destination   : ${args.out}`);
  console.error(`[download-atlas] Grid-metadata : ${args.withGridMetadata ? "yes" : "no"}`);
  console.error(`[download-atlas] Buildings     : ${args.withBuildings ? "yes" : "no"}\n`);

  const tmpDir = path.join(args.out, ".download-tmp");
  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    for (const region of targetRegions) {
      const regionMeta = regionsMap[region];
      await processRegionAtlas(region, regionMeta, baseUrl, args.out, tmpDir);
      if (args.withGridMetadata) {
        await processRegionGridMetadata(region, regionMeta, baseUrl, tmpDir);
      }
    }
    if (args.withBuildings) {
      const buildingsMeta = manifest["buildingsShared"] as BuildingsSharedManifest | undefined;
      if (buildingsMeta) {
        await processBuildingsShared(buildingsMeta, baseUrl, tmpDir);
      } else {
        console.error("[download-atlas] ⚠ --with-buildings demandé mais buildingsShared absent du manifest.");
      }
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  // Places sidecars
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

  // Marker file
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
    gridMetadataInstalled: args.withGridMetadata,
    buildingsInstalled: args.withBuildings,
  };
  await fsp.writeFile(markerPath, JSON.stringify(updatedMarker, null, 2));

  console.error(`\n[download-atlas] ✓ Installation terminée.`);
  console.error(`[download-atlas]   Marker écrit : ${markerPath}`);
}

main().catch((err) => {
  console.error("[download-atlas] Erreur fatale :", err);
  process.exit(1);
});
