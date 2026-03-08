import fs from "node:fs/promises";
import path from "node:path";

import { NYON_LOCAL_BBOX } from "../../src/lib/config/nyon";

import { parseIngestCliArgs } from "./cli";
import { ensureDirectory } from "./http";
import { downloadStacAssets, fetchStacItems } from "./stac-client";

const COLLECTION = "ch.swisstopo.swisssurface3d-raster";

async function main() {
  const args = parseIngestCliArgs(process.argv.slice(2));

  const destinationRoot = path.join(
    process.cwd(),
    "data",
    "raw",
    "swisstopo",
    "swisssurface3d_raster",
  );
  const manifestPath = path.join(destinationRoot, "manifest-nyon.json");

  console.log(
    `[vegetation-surface-nyon] Fetching STAC items for bbox ${NYON_LOCAL_BBOX.join(",")}...`,
  );

  const fetched = await fetchStacItems({
    collection: COLLECTION,
    bbox: NYON_LOCAL_BBOX,
    maxItems: args.maxItems,
    limit: 200,
  });

  console.log(
    `[vegetation-surface-nyon] Found ${fetched.items.length} items across ${fetched.pagesFetched} STAC pages.`,
  );

  const downloadSummary = await downloadStacAssets({
    items: fetched.items,
    destinationRoot,
    dryRun: args.dryRun,
    overwrite: args.overwrite,
    assetSelector: (_assetKey, asset) => asset.href.endsWith("_0.5_2056_5728.tif"),
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    collection: COLLECTION,
    bbox: NYON_LOCAL_BBOX,
    dryRun: args.dryRun,
    overwrite: args.overwrite,
    maxItems: args.maxItems ?? null,
    itemsFetched: fetched.items.length,
    pagesFetched: fetched.pagesFetched,
    downloadSummary,
  };

  await ensureDirectory(path.dirname(manifestPath));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(`[vegetation-surface-nyon] Manifest written to ${manifestPath}`);
  console.log(
    `[vegetation-surface-nyon] Downloaded ${downloadSummary.filesDownloaded} files (skipped: ${downloadSummary.filesSkipped}).`,
  );
}

main().catch((error) => {
  console.error(
    `[vegetation-surface-nyon] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
