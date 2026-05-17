/**
 * Download Copernicus DEM 30 m tiles covering a region's horizon bbox and emit
 * the per-region manifest the preflight expects.
 *
 * Usage:
 *   npx tsx scripts/ingest/download-horizon-dem.ts --region=morges
 *   npx tsx scripts/ingest/download-horizon-dem.ts --region=geneve --dry-run
 *   npx tsx scripts/ingest/download-horizon-dem.ts --region=all
 *
 * Honors MAPPY_DATA_ROOT (writes under RAW_HORIZON_DEM_DIR).
 *
 * Thin CLI wrapper around `ensureHorizonDemManifestForRegion` — the precompute
 * preflight calls the same core to auto-fix a missing manifest, so anything
 * fixed here is also fixable at precompute time.
 */
import { pathToFileURL } from "node:url";

import {
  ensureHorizonDemManifestForRegion,
  getKnownHorizonRegions,
} from "../../src/lib/ingest/horizon-dem";
import type { PrecomputedRegionName } from "../../src/lib/regions/regions";

import { parseIngestCliArgs } from "./cli";

export interface RunForRegionArgs {
  dryRun?: boolean;
  overwrite?: boolean;
  maxItems?: number;
}

export async function runForRegion(
  region: PrecomputedRegionName,
  args: RunForRegionArgs = {},
): Promise<void> {
  await ensureHorizonDemManifestForRegion(region, {
    overwrite: args.overwrite ?? false,
    dryRun: args.dryRun ?? false,
    maxItems: args.maxItems,
    verbose: true,
  });
}

function parseRegionArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--region=")) return arg.slice("--region=".length);
    if (arg === "--region" && i + 1 < argv.length) return argv[i + 1];
  }
  throw new Error(
    `Missing --region=<name>. Known regions: ${getKnownHorizonRegions().join(", ")}, or "all".`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseIngestCliArgs(argv);
  const regionArg = parseRegionArg(argv);

  const regions =
    regionArg === "all" ? getKnownHorizonRegions() : [regionArg];

  for (const region of regions) {
    await runForRegion(region as PrecomputedRegionName, args);
  }
}

const isDirectInvocation =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(
      `[horizon-dem] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exitCode = 1;
  });
}
