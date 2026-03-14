import fs from "node:fs/promises";
import path from "node:path";

import {
  loadPrecomputedSunlightManifest,
  loadPrecomputedSunlightTile,
  type PrecomputedRegionName,
  type PrecomputedSunlightManifest,
} from "../../src/lib/precompute/sunlight-cache";
import { getSunlightCacheStorage } from "../../src/lib/precompute/sunlight-cache-storage";
import { SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION } from "../../src/lib/precompute/model-version";
import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";

interface CliArgs {
  action: "verify" | "purge";
  region?: PrecomputedRegionName;
  modelVersionHash?: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    action: "verify",
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--action=")) {
      const value = arg.slice("--action=".length);
      if (value === "verify" || value === "purge") {
        result.action = value;
      }
      continue;
    }
    if (arg.startsWith("--region=")) {
      const value = arg.slice("--region=".length);
      if (value === "lausanne" || value === "nyon") {
        result.region = value;
      }
      continue;
    }
    if (arg.startsWith("--model-version-hash=")) {
      result.modelVersionHash = arg.slice("--model-version-hash=".length);
      continue;
    }
    if (arg.startsWith("--date=")) {
      result.date = arg.slice("--date=".length);
      continue;
    }
    if (arg.startsWith("--start-date=")) {
      result.startDate = arg.slice("--start-date=".length);
      continue;
    }
    if (arg.startsWith("--end-date=")) {
      result.endDate = arg.slice("--end-date=".length);
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
    }
  }

  if (result.date) {
    result.startDate = result.date;
    result.endDate = result.date;
  }

  return result;
}

function dateInRange(date: string, startDate?: string, endDate?: string): boolean {
  if (startDate && date < startDate) {
    return false;
  }
  if (endDate && date > endDate) {
    return false;
  }
  return true;
}

async function findManifestFiles(rootPath: string): Promise<string[]> {
  const storage = getSunlightCacheStorage();
  const files = await storage.listFiles(rootPath);
  return files.filter((filePath) => path.basename(filePath) === "manifest.json");
}

async function loadManifestFromPath(filePath: string): Promise<PrecomputedSunlightManifest | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PrecomputedSunlightManifest;
  } catch {
    return null;
  }
}

function manifestMatches(manifest: PrecomputedSunlightManifest, args: CliArgs): boolean {
  if (args.region && manifest.region !== args.region) {
    return false;
  }
  if (args.modelVersionHash && manifest.modelVersionHash !== args.modelVersionHash) {
    return false;
  }
  return dateInRange(manifest.date, args.startDate, args.endDate);
}

async function verifyManifests(args: CliArgs): Promise<void> {
  const manifestFiles = await findManifestFiles(CACHE_SUNLIGHT_DIR);
  const manifests = (
    await Promise.all(manifestFiles.map((filePath) => loadManifestFromPath(filePath)))
  ).filter((manifest): manifest is PrecomputedSunlightManifest => manifest !== null);
  const selected = manifests.filter((manifest) => manifestMatches(manifest, args));
  const problems: string[] = [];
  let verifiedTileCount = 0;

  for (const manifest of selected) {
    if (manifest.artifactFormatVersion !== SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION) {
      problems.push(
        `Manifest ${manifest.region}/${manifest.date} uses format ${manifest.artifactFormatVersion}, expected ${SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION}.`,
      );
      continue;
    }

    for (const tileId of manifest.tileIds) {
      const tile = await loadPrecomputedSunlightTile({
        region: manifest.region,
        modelVersionHash: manifest.modelVersionHash,
        date: manifest.date,
        gridStepMeters: manifest.gridStepMeters,
        sampleEveryMinutes: manifest.sampleEveryMinutes,
        startLocalTime: manifest.startLocalTime,
        endLocalTime: manifest.endLocalTime,
        tileId,
      });
      if (!tile) {
        problems.push(
          `Missing or incompatible tile ${tileId} for ${manifest.region}/${manifest.date}/${manifest.modelVersionHash}.`,
        );
        continue;
      }
      if (tile.tile.tileId !== tileId) {
        problems.push(
          `Tile id mismatch: manifest expected ${tileId}, artifact contains ${tile.tile.tileId}.`,
        );
      }
      if (tile.modelVersionHash !== manifest.modelVersionHash) {
        problems.push(
          `Tile ${tileId} has model version ${tile.modelVersionHash}, expected ${manifest.modelVersionHash}.`,
        );
      }
      if (tile.artifactFormatVersion !== manifest.artifactFormatVersion) {
        problems.push(
          `Tile ${tileId} has format ${tile.artifactFormatVersion}, expected ${manifest.artifactFormatVersion}.`,
        );
      }
      verifiedTileCount += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        action: "verify",
        root: CACHE_SUNLIGHT_DIR,
        manifestsMatched: selected.length,
        tilesVerified: verifiedTileCount,
        problems,
      },
      null,
      2,
    ),
  );

  if (problems.length > 0) {
    process.exitCode = 1;
  }
}

async function purgeRuns(args: CliArgs): Promise<void> {
  const manifestFiles = await findManifestFiles(CACHE_SUNLIGHT_DIR);
  const manifests = (
    await Promise.all(manifestFiles.map((filePath) => loadManifestFromPath(filePath)))
  ).filter((manifest): manifest is PrecomputedSunlightManifest => manifest !== null);
  const selected = manifests.filter((manifest) => manifestMatches(manifest, args));
  const runDirs = Array.from(
    new Set(
      selected.map((manifest) =>
        path.dirname(
          path.join(
            CACHE_SUNLIGHT_DIR,
            manifest.region,
            manifest.modelVersionHash,
            `g${manifest.gridStepMeters}`,
            `m${manifest.sampleEveryMinutes}`,
            manifest.date,
            `t${manifest.startLocalTime.replace(":", "")}-${manifest.endLocalTime.replace(":", "")}`,
            "manifest.json",
          ),
        ),
      ),
    ),
  );

  if (!args.dryRun) {
    const storage = getSunlightCacheStorage();
    for (const runDir of runDirs) {
      await storage.removePrefix(runDir);
    }
  }

  console.log(
    JSON.stringify(
      {
        action: "purge",
        dryRun: args.dryRun,
        root: CACHE_SUNLIGHT_DIR,
        runsMatched: runDirs.length,
        removed: args.dryRun ? [] : runDirs,
        selected,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.action === "verify") {
    await verifyManifests(args);
    return;
  }
  await purgeRuns(args);
}

void main().catch((error) => {
  console.error(
    `[cache-admin] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
