import fs from "node:fs/promises";
import path from "node:path";

import { LAUSANNE_LOCAL_BBOX } from "../../src/lib/config/lausanne";

import { parseIngestCliArgs } from "./cli";
import { ensureDirectory } from "./http";
import { downloadStacAssets, fetchStacItems } from "./stac-client";

const COLLECTION = "ch.swisstopo.swissbuildings3d_2";

async function main() {
  const args = parseIngestCliArgs(process.argv.slice(2));

  const destinationRoot = path.join(
    process.cwd(),
    "data",
    "raw",
    "swisstopo",
    "swissbuildings3d_2",
  );
  const manifestPath = path.join(destinationRoot, "manifest-lausanne.json");

  console.log(
    `[buildings] Fetching STAC items for bbox ${LAUSANNE_LOCAL_BBOX.join(",")}...`,
  );

  const fetched = await fetchStacItems({
    collection: COLLECTION,
    bbox: LAUSANNE_LOCAL_BBOX,
    maxItems: args.maxItems,
    limit: 100,
  });

  console.log(
    `[buildings] Found ${fetched.items.length} items across ${fetched.pagesFetched} STAC pages.`,
  );

  const downloadSummary = await downloadStacAssets({
    items: fetched.items,
    destinationRoot,
    dryRun: args.dryRun,
    overwrite: args.overwrite,
    assetSelector: (assetKey, asset) =>
      assetKey.endsWith(".dxf.zip") ||
      asset.href.endsWith(".dxf.zip") ||
      asset.type?.includes("x.dxf") === true,
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    collection: COLLECTION,
    bbox: LAUSANNE_LOCAL_BBOX,
    dryRun: args.dryRun,
    overwrite: args.overwrite,
    maxItems: args.maxItems ?? null,
    itemsFetched: fetched.items.length,
    pagesFetched: fetched.pagesFetched,
    downloadSummary,
  };

  await ensureDirectory(path.dirname(manifestPath));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(`[buildings] Manifest written to ${manifestPath}`);
  console.log(
    `[buildings] Downloaded ${downloadSummary.filesDownloaded} files (skipped: ${downloadSummary.filesSkipped}).`,
  );
}

main().catch((error) => {
  console.error(
    `[buildings] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
