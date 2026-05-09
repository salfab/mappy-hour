/**
 * Aggregate per-region packaging summaries into a single release-manifest.json.
 *
 * Usage:
 *   tsx scripts/release/build-release-manifest.ts \
 *     --regions=lausanne,nyon,morges,vevey,geneve \
 *     --tag=atlas-v9-2026-05-08 \
 *     [--out-dir=dist/releases]
 *
 * Each region must already be packaged (package-atlas-region.ts must have run).
 * The script reads the per-region JSON summaries produced by package-atlas-region.ts
 * via stdout capture (it re-runs the packager in --dry-run=false mode and reads
 * the cached result files, or accepts pre-computed summaries via stdin with --from-stdin).
 *
 * Outputs:
 *   dist/releases/release-manifest.json
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  SUNLIGHT_CACHE_ALGORITHM_VERSION,
  SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
} from "@/lib/precompute/model-version";

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
      : [],
    tag: args["tag"] ?? null,
    outDir: args["out-dir"] ?? path.join(process.cwd(), "dist", "releases"),
    fromStdin: args["from-stdin"] === "true",
  };
}

interface RegionPartInfo {
  name: string;
  sha256: string;
  bytes: number;
}

interface RegionSummary {
  region: string;
  modelVersionHash: string;
  tileCount: number;
  isSplit: boolean;
  parts: RegionPartInfo[];
  assetName?: string;
  sha256?: string;
  bytes?: number;
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
      tileCount: number;
      isSplit: boolean;
      parts?: RegionPartInfo[];
      assetName?: string;
      sha256?: string;
      bytes?: number;
    }
  >;
}

function packageRegion(region: string, outDir: string): RegionSummary {
  const script = path.resolve(
    process.cwd(),
    "scripts/release/package-atlas-region.ts",
  );
  console.error(`[build-manifest] Packaging région ${region}...`);
  const result = spawnSync(
    "npx",
    ["tsx", script, `--region=${region}`, `--out-dir=${outDir}`],
    {
      shell: process.platform === "win32",
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    console.error(result.stderr ?? "");
    throw new Error(`package-atlas-region échoué pour ${region} (exit ${result.status})`);
  }
  const stdout = (result.stdout ?? "").trim();
  // stdout may contain extra lines before the JSON; take the last line
  const lastLine = stdout.split("\n").filter(Boolean).at(-1) ?? "";
  return JSON.parse(lastLine) as RegionSummary;
}

async function main() {
  const args = parseArgs();

  if (!args.tag) {
    console.error(
      "Usage: tsx build-release-manifest.ts --tag=atlas-v9-2026-05-08 --regions=lausanne,nyon [--out-dir=dist/releases]",
    );
    process.exit(1);
  }

  await fsp.mkdir(args.outDir, { recursive: true });

  let summaries: RegionSummary[];

  if (args.fromStdin) {
    const raw = fs.readFileSync(0, "utf8"); // fd 0 = stdin
    summaries = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RegionSummary);
  } else {
    if (args.regions.length === 0) {
      console.error("[build-manifest] --regions= requis (ou --from-stdin).");
      process.exit(1);
    }
    summaries = [];
    for (const region of args.regions) {
      summaries.push(packageRegion(region, args.outDir));
    }
  }

  const regionsMap: ReleaseManifest["regions"] = {};
  for (const s of summaries) {
    regionsMap[s.region] = {
      modelVersionHash: s.modelVersionHash,
      tileCount: s.tileCount,
      isSplit: s.isSplit,
      ...(s.isSplit
        ? { parts: s.parts }
        : { assetName: s.assetName, sha256: s.sha256, bytes: s.bytes }),
    };
  }

  const manifest: ReleaseManifest = {
    releaseTag: args.tag,
    algorithmVersion: SUNLIGHT_CACHE_ALGORITHM_VERSION,
    artifactFormatVersion: SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    contentHash: crypto
      .createHash("sha256")
      .update(JSON.stringify(regionsMap))
      .digest("hex")
      .slice(0, 16),
    regions: regionsMap,
  };

  const outPath = path.join(args.outDir, "release-manifest.json");
  await fsp.writeFile(outPath, JSON.stringify(manifest, null, 2));

  console.error(`[build-manifest] ✓ release-manifest.json écrit → ${outPath}`);
  console.error(`[build-manifest]   ${summaries.length} région(s) : ${summaries.map((s) => s.region).join(", ")}`);
  console.error(`[build-manifest]   tag=${args.tag}`);

  process.stdout.write(JSON.stringify(manifest));
}

main().catch((err) => {
  console.error("[build-manifest] Erreur fatale :", err);
  process.exit(1);
});
