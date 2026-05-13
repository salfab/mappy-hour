/**
 * Download swissSURFACE3D vegetation raster tiles for any configured region.
 * Usage: npx tsx scripts/ingest/download-vegetation.ts --region=morges
 */
import fs from "node:fs/promises";
import path from "node:path";
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
import { parseIngestCliArgs } from "./cli";
import { ensureDirectory } from "./http";
import { downloadStacAssets, fetchStacItems } from "./stac-client";

const COLLECTION = "ch.swisstopo.swisssurface3d-raster";
const REGIONS: Record<string, { localBbox: readonly [number, number, number, number] }> = {
  lausanne: LAUSANNE_CONFIG, nyon: NYON_CONFIG, morges: MORGES_CONFIG, geneve: GENEVE_CONFIG, vevey: VEVEY_CONFIG, vevey_city: VEVEY_CITY_CONFIG, neuchatel: NEUCHATEL_CONFIG, la_chaux_de_fonds: LA_CHAUX_DE_FONDS_CONFIG, bern: BERN_CONFIG, zurich: ZURICH_CONFIG, thun: THUN_CONFIG,
};

function parseRegion(argv: string[]): string {
  for (const arg of argv) { if (arg.startsWith("--region=")) return arg.slice(9); }
  console.error("Usage: --region=lausanne|nyon|morges|geneve|vevey|vevey_city|neuchatel|la_chaux_de_fonds|bern|zurich|thun"); process.exit(1);
}

async function main() {
  const region = parseRegion(process.argv.slice(2));
  const config = REGIONS[region];
  if (!config) { console.error(`Unknown region: ${region}`); process.exit(1); }
  const args = parseIngestCliArgs(process.argv.slice(2));
  const bbox = config.localBbox;
  const destinationRoot = path.join(process.cwd(), "data", "raw", "swisstopo", "swisssurface3d_raster");
  const manifestPath = path.join(destinationRoot, `manifest-${region}.json`);
  console.log(`[vegetation:${region}] Fetching STAC items for bbox ${bbox.join(",")}...`);
  const fetched = await fetchStacItems({ collection: COLLECTION, bbox: [...bbox] as number[], maxItems: args.maxItems, limit: 200 });
  console.log(`[vegetation:${region}] Found ${fetched.items.length} items across ${fetched.pagesFetched} STAC pages.`);
  const downloadSummary = await downloadStacAssets({
    items: fetched.items, destinationRoot, dryRun: args.dryRun, overwrite: args.overwrite,
    assetSelector: (assetKey, asset) => assetKey.endsWith(".tif") || asset.href.endsWith(".tif") || asset.type?.includes("tiff") === true,
  });
  const manifest = { generatedAt: new Date().toISOString(), collection: COLLECTION, region, bbox, ...args, itemsFetched: fetched.items.length, pagesFetched: fetched.pagesFetched, downloadSummary };
  await ensureDirectory(path.dirname(manifestPath));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[vegetation:${region}] Downloaded ${downloadSummary.filesDownloaded} files (skipped: ${downloadSummary.filesSkipped}).`);
}
main().catch((e) => { console.error(`Failed: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
