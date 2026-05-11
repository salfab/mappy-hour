/**
 * Aggregate per-region atlas + grid-metadata summaries (plus the shared
 * buildings-index summary) into a single release-manifest.json.
 *
 * Each region produces TWO archives (`<region>-atlas.tar` +
 * `<region>-grid-metadata.tar`); the buildings-shared packager produces ONE
 * additional shared archive containing the global obstacle index. This script
 * aggregates everything into a manifest that download-atlas.ts can consume
 * selectively (atlas always, grid-metadata optionally, buildings optionally).
 *
 * Usage (called from publish-atlas-release.ps1):
 *   echo '<jsonl on stdin>' | tsx build-release-manifest.ts \
 *     --tag=v9.2.20260512000 \
 *     --from-stdin=true \
 *     [--out-dir=dist/releases] \
 *     [--places-dir=dist/releases]
 *
 * stdin is a JSON-lines stream where each line is one of:
 *   - a region summary (from package-atlas-region.ts):
 *       { region, modelVersionHash, gridMetadataHash, tileCount,
 *         atlas: ArchiveSummary | null,
 *         gridMetadata: ArchiveSummary | null, gridMetadataTileCount }
 *   - the buildings-shared summary (from package-buildings-shared.ts):
 *       { archiveName: "buildings-shared.tar", assetName, sha256, bytes,
 *         uniqueObstaclesCount, generatedAt, indexVersion }
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  SUNLIGHT_CACHE_ALGORITHM_VERSION,
  SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
} from "@/lib/precompute/model-version";

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

interface RegionSummary {
  region: string;
  modelVersionHash: string;
  gridMetadataHash: string;
  tileCount: number;
  atlas: ArchiveSummary | null;
  gridMetadata: ArchiveSummary | null;
  gridMetadataTileCount: number;
}

interface BuildingsSharedSummary {
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

interface PlacesFileInfo {
  assetName: string;
  sha256: string;
  bytes: number;
}

interface ReleaseManifest {
  releaseTag: string;
  algorithmVersion: string;
  artifactFormatVersion: number;
  generatedAt: string;
  contentHash: string;
  regions: Record<
    string,
    {
      modelVersionHash: string;
      gridMetadataHash: string;
      tileCount: number;
      atlas: ArchiveSummary | null;
      gridMetadata: ArchiveSummary | null;
      gridMetadataTileCount: number;
    }
  >;
  buildingsShared?: BuildingsSharedSummary;
  places?: Record<string, PlacesFileInfo>;
}

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
    tag: args["tag"] ?? null,
    outDir: args["out-dir"] ?? path.join(process.cwd(), "dist", "releases"),
    fromStdin: args["from-stdin"] === "true",
    placesDir: args["places-dir"] ?? null,
  };
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

function isBuildingsSharedSummary(o: unknown): o is BuildingsSharedSummary {
  return typeof o === "object" && o !== null &&
    (o as { archiveName?: unknown }).archiveName === "buildings-shared.tar";
}

function isRegionSummary(o: unknown): o is RegionSummary {
  return typeof o === "object" && o !== null &&
    typeof (o as { region?: unknown }).region === "string" &&
    "atlas" in (o as object);
}

async function main() {
  const args = parseArgs();

  if (!args.tag) {
    console.error(
      "Usage: tsx build-release-manifest.ts --tag=v9.2.20260512000 --from-stdin=true [--places-dir=...]",
    );
    process.exit(1);
  }
  if (!args.fromStdin) {
    console.error(
      "[build-manifest] --from-stdin=true required (the publish orchestrator pipes JSONL summaries via stdin).",
    );
    process.exit(1);
  }

  await fsp.mkdir(args.outDir, { recursive: true });

  const raw = fs.readFileSync(0, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const regionSummaries: RegionSummary[] = [];
  let buildingsShared: BuildingsSharedSummary | undefined = undefined;
  for (const line of lines) {
    const parsed = JSON.parse(line) as unknown;
    if (isBuildingsSharedSummary(parsed)) {
      buildingsShared = parsed;
    } else if (isRegionSummary(parsed)) {
      regionSummaries.push(parsed);
    } else {
      console.error(`[build-manifest] Warning: unrecognised summary on stdin, skipping: ${line.slice(0, 120)}`);
    }
  }

  const regionsMap: ReleaseManifest["regions"] = {};
  for (const s of regionSummaries) {
    regionsMap[s.region] = {
      modelVersionHash: s.modelVersionHash,
      gridMetadataHash: s.gridMetadataHash,
      tileCount: s.tileCount,
      atlas: s.atlas,
      gridMetadata: s.gridMetadata,
      gridMetadataTileCount: s.gridMetadataTileCount,
    };
  }

  // Optional places sidecar files
  const placesMap: Record<string, PlacesFileInfo> = {};
  if (args.placesDir) {
    let placesFiles: string[] = [];
    try {
      placesFiles = await fsp.readdir(args.placesDir);
    } catch {
      console.error(`[build-manifest] Warning: --places-dir=${args.placesDir} unreadable`);
    }
    for (const fileName of placesFiles) {
      const match = fileName.match(/^(.+)-places\.json$/);
      if (!match) continue;
      const region = match[1];
      const filePath = path.join(args.placesDir, fileName);
      const stat = await fsp.stat(filePath);
      const sha256 = await sha256File(filePath);
      placesMap[region] = { assetName: fileName, sha256, bytes: stat.size };
    }
  }

  const manifest: ReleaseManifest = {
    releaseTag: args.tag,
    algorithmVersion: SUNLIGHT_CACHE_ALGORITHM_VERSION,
    artifactFormatVersion: SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    contentHash: crypto
      .createHash("sha256")
      .update(JSON.stringify({ regionsMap, buildingsShared }))
      .digest("hex")
      .slice(0, 16),
    regions: regionsMap,
    ...(buildingsShared ? { buildingsShared } : {}),
    ...(Object.keys(placesMap).length > 0 ? { places: placesMap } : {}),
  };

  const outPath = path.join(args.outDir, "release-manifest.json");
  await fsp.writeFile(outPath, JSON.stringify(manifest, null, 2));

  console.error(`[build-manifest] ✓ release-manifest.json → ${outPath}`);
  console.error(
    `[build-manifest]   ${regionSummaries.length} région(s), buildings-shared=${buildingsShared ? "yes" : "no"}, places=${Object.keys(placesMap).length}`,
  );
  console.error(`[build-manifest]   tag=${args.tag}`);

  process.stdout.write(JSON.stringify(manifest));
}

main().catch((err) => {
  console.error("[build-manifest] Erreur fatale :", err);
  process.exit(1);
});
