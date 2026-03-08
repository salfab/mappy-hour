import fs from "node:fs/promises";
import path from "node:path";

import { LAUSANNE_LOCAL_BBOX } from "../../src/lib/config/lausanne";

import { parseIngestCliArgs } from "./cli";
import { ensureDirectory } from "./http";
import { downloadStacAssets, fetchStacItems } from "./stac-client";

const COLLECTION = "ch.swisstopo.swissalti3d";

async function main() {
  const args = parseIngestCliArgs(process.argv.slice(2));

  const destinationRoot = path.join(
    process.cwd(),
    "data",
    "raw",
    "swisstopo",
    "swissalti3d_2m",
  );
  const manifestPath = path.join(destinationRoot, "manifest-lausanne.json");

  console.log(
    `[terrain-ch] Fetching STAC items for bbox ${LAUSANNE_LOCAL_BBOX.join(",")}...`,
  );

  const fetched = await fetchStacItems({
    collection: COLLECTION,
    bbox: LAUSANNE_LOCAL_BBOX,
    maxItems: args.maxItems,
    limit: 200,
  });

  console.log(
    `[terrain-ch] Found ${fetched.items.length} items across ${fetched.pagesFetched} STAC pages.`,
  );

  const downloadSummary = await downloadStacAssets({
    items: fetched.items,
    destinationRoot,
    dryRun: args.dryRun,
    overwrite: args.overwrite,
    assetSelector: (_assetKey, asset) =>
      asset.href.endsWith("_2_2056_5728.tif"),
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

  console.log(`[terrain-ch] Manifest written to ${manifestPath}`);
  console.log(
    `[terrain-ch] Downloaded ${downloadSummary.filesDownloaded} files (skipped: ${downloadSummary.filesSkipped}).`,
  );
}

main().catch((error) => {
  console.error(
    `[terrain-ch] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
