/**
 * Download swissALTI3D terrain tiles for any configured region.
 * Usage: npx tsx scripts/ingest/download-terrain.ts --region=morges
 */
import fs from "node:fs/promises";
import path from "node:path";
import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import { NYON_CONFIG } from "../../src/lib/config/nyon";
import { MORGES_CONFIG } from "../../src/lib/config/morges";
import { GENEVE_CONFIG } from "../../src/lib/config/geneve";
import { parseIngestCliArgs } from "./cli";
import { ensureDirectory } from "./http";
import { downloadStacAssets, fetchStacItems } from "./stac-client";

const COLLECTION = "ch.swisstopo.swissalti3d";
const REGIONS: Record<string, { localBbox: readonly [number, number, number, number] }> = {
  lausanne: LAUSANNE_CONFIG, nyon: NYON_CONFIG, morges: MORGES_CONFIG, geneve: GENEVE_CONFIG,
};

function parseRegion(argv: string[]): string {
  for (const arg of argv) { if (arg.startsWith("--region=")) return arg.slice(9); }
  console.error("Usage: --region=lausanne|nyon|morges|geneve"); process.exit(1);
}

async function main() {
  const region = parseRegion(process.argv.slice(2));
  const config = REGIONS[region];
  if (!config) { console.error(`Unknown region: ${region}`); process.exit(1); }
  const args = parseIngestCliArgs(process.argv.slice(2));
  const bbox = config.localBbox;
  const destinationRoot = path.join(process.cwd(), "data", "raw", "swisstopo", "swissalti3d_2m");
  const manifestPath = path.join(destinationRoot, `manifest-${region}.json`);
  console.log(`[terrain:${region}] Fetching STAC items for bbox ${bbox.join(",")}...`);
  const fetched = await fetchStacItems({ collection: COLLECTION, bbox: [...bbox] as number[], maxItems: args.maxItems, limit: 200 });
  console.log(`[terrain:${region}] Found ${fetched.items.length} items across ${fetched.pagesFetched} STAC pages.`);
  const downloadSummary = await downloadStacAssets({
    items: fetched.items, destinationRoot, dryRun: args.dryRun, overwrite: args.overwrite,
    assetSelector: (assetKey, asset) => assetKey.endsWith(".tif") || asset.href.endsWith(".tif") || asset.type?.includes("tiff") === true,
  });
  const manifest = { generatedAt: new Date().toISOString(), collection: COLLECTION, region, bbox, ...args, itemsFetched: fetched.items.length, pagesFetched: fetched.pagesFetched, downloadSummary };
  await ensureDirectory(path.dirname(manifestPath));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[terrain:${region}] Downloaded ${downloadSummary.filesDownloaded} files (skipped: ${downloadSummary.filesSkipped}).`);
}
main().catch((e) => { console.error(`Failed: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
