/**
 * Download SwissBuildings3D DXF files for any configured region.
 *
 * Usage (standalone):
 *   npx tsx scripts/ingest/download-buildings.ts --region=morges
 *   npx tsx scripts/ingest/download-buildings.ts --region=geneve
 *   npx tsx scripts/ingest/download-buildings.ts --region=lausanne
 *
 * Programmatic usage (from `run.ts` orchestrator):
 *   import { runForRegion } from "./download-buildings";
 *   await runForRegion("lausanne", { dryRun: false, overwrite: false });
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import { NYON_CONFIG } from "../../src/lib/config/nyon";
import { MORGES_CONFIG } from "../../src/lib/config/morges";
import { GENEVE_CONFIG } from "../../src/lib/config/geneve";
import { VEVEY_CONFIG } from "../../src/lib/config/vevey";
import { VEVEY_CITY_CONFIG } from "../../src/lib/config/vevey_city";
import { NEUCHATEL_CONFIG } from "../../src/lib/config/neuchatel";
import { LA_CHAUX_DE_FONDS_CONFIG } from "../../src/lib/config/la_chaux_de_fonds";
import { BERN_CONFIG } from "../../src/lib/config/bern";
import { ZURICH_CONFIG } from "../../src/lib/config/zurich";
import { THUN_CONFIG } from "../../src/lib/config/thun";
import type { PrecomputedRegionName } from "../../src/lib/regions/regions";

import { parseIngestCliArgs } from "./cli";
import { ensureDirectory } from "./http";
import { downloadStacAssets, fetchStacItems } from "./stac-client";

const COLLECTION = "ch.swisstopo.swissbuildings3d_2";

const REGIONS: Record<PrecomputedRegionName, { localBbox: readonly [number, number, number, number] }> = {
  lausanne: LAUSANNE_CONFIG,
  nyon: NYON_CONFIG,
  morges: MORGES_CONFIG,
  geneve: GENEVE_CONFIG,
  vevey: VEVEY_CONFIG,
  vevey_city: VEVEY_CITY_CONFIG,
  neuchatel: NEUCHATEL_CONFIG,
  la_chaux_de_fonds: LA_CHAUX_DE_FONDS_CONFIG,
  bern: BERN_CONFIG,
  zurich: ZURICH_CONFIG,
  thun: THUN_CONFIG,
};

export interface RunForRegionArgs {
  dryRun?: boolean;
  overwrite?: boolean;
  maxItems?: number;
}

export interface RunForRegionResult {
  region: PrecomputedRegionName;
  itemsFetched: number;
  filesDownloaded: number;
  filesSkipped: number;
  manifestPath: string;
}

export async function runForRegion(
  region: PrecomputedRegionName,
  args: RunForRegionArgs = {},
): Promise<RunForRegionResult> {
  const config = REGIONS[region];
  if (!config) {
    throw new Error(`Unknown region: ${region}. Available: ${Object.keys(REGIONS).join(", ")}`);
  }

  const { dryRun = false, overwrite = false, maxItems } = args;
  const bbox = config.localBbox;

  const destinationRoot = path.join(
    process.cwd(),
    "data",
    "raw",
    "swisstopo",
    "swissbuildings3d_2",
  );
  const manifestPath = path.join(destinationRoot, `manifest-${region}.json`);

  console.log(`[buildings:${region}] Fetching STAC items for bbox ${bbox.join(",")}...`);

  const fetched = await fetchStacItems({
    collection: COLLECTION,
    bbox: [...bbox] as number[],
    maxItems,
    limit: 100,
  });

  console.log(`[buildings:${region}] Found ${fetched.items.length} items across ${fetched.pagesFetched} STAC pages.`);

  const downloadSummary = await downloadStacAssets({
    items: fetched.items,
    destinationRoot,
    dryRun,
    overwrite,
    assetSelector: (assetKey, asset) =>
      assetKey.endsWith(".dxf.zip") ||
      asset.href.endsWith(".dxf.zip") ||
      asset.type?.includes("x.dxf") === true,
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    collection: COLLECTION,
    region,
    bbox,
    dryRun,
    overwrite,
    maxItems: maxItems ?? null,
    itemsFetched: fetched.items.length,
    pagesFetched: fetched.pagesFetched,
    downloadSummary,
  };

  if (!dryRun) {
    await ensureDirectory(path.dirname(manifestPath));
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    console.log(`[buildings:${region}] Manifest written to ${manifestPath}`);
  }

  console.log(`[buildings:${region}] Downloaded ${downloadSummary.filesDownloaded} files (skipped: ${downloadSummary.filesSkipped}).`);

  return {
    region,
    itemsFetched: fetched.items.length,
    filesDownloaded: downloadSummary.filesDownloaded,
    filesSkipped: downloadSummary.filesSkipped,
    manifestPath,
  };
}

function parseRegion(argv: string[]): PrecomputedRegionName {
  for (const arg of argv) {
    if (arg.startsWith("--region=")) return arg.slice(9) as PrecomputedRegionName;
  }
  console.error(`Usage: --region=${Object.keys(REGIONS).join("|")}`);
  process.exit(1);
}

async function main() {
  const region = parseRegion(process.argv.slice(2));
  if (!REGIONS[region]) {
    console.error(`Unknown region: ${region}. Available: ${Object.keys(REGIONS).join(", ")}`);
    process.exit(1);
  }
  const args = parseIngestCliArgs(process.argv.slice(2));
  await runForRegion(region, args);
}

// ESM equivalent of `if (require.main === module)`: run main() only if this
// file was executed directly (not imported by another script).
const isDirectInvocation =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(`[buildings] Failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  });
}
