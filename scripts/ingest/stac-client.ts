import path from "node:path";

import { downloadFile, ensureDirectory } from "./http";

export interface StacLink {
  rel: string;
  href: string;
}

export interface StacAsset {
  href: string;
  type?: string;
}

export interface StacItem {
  id: string;
  assets: Record<string, StacAsset>;
  bbox?: number[];
  properties?: Record<string, unknown>;
}

interface StacFeatureCollection {
  features: StacItem[];
  links?: StacLink[];
}

export interface FetchStacItemsOptions {
  collection: string;
  bbox: [number, number, number, number];
  limit?: number;
  maxItems?: number;
  stacBaseUrl?: string;
}

export interface FetchStacItemsResult {
  items: StacItem[];
  pagesFetched: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return (await response.json()) as T;
}

export async function fetchStacItems(
  options: FetchStacItemsOptions,
): Promise<FetchStacItemsResult> {
  const baseUrl =
    options.stacBaseUrl ?? process.env.STAC_BASE_URL ?? "https://data.geo.admin.ch/api/stac/v0.9";

  const startUrl = new URL(
    `${baseUrl.replace(/\/$/, "")}/collections/${options.collection}/items`,
  );
  startUrl.searchParams.set("bbox", options.bbox.join(","));
  startUrl.searchParams.set("limit", String(options.limit ?? 100));

  let nextUrl: string | null = startUrl.toString();
  let pagesFetched = 0;
  const items: StacItem[] = [];

  while (nextUrl) {
    const currentUrl: string = nextUrl;
    const page: StacFeatureCollection = await fetchJson(currentUrl);
    pagesFetched += 1;
    items.push(...page.features);

    if (options.maxItems && items.length >= options.maxItems) {
      items.length = options.maxItems;
      break;
    }

    const nextLink: StacLink | undefined = page.links?.find(
      (link: StacLink) => link.rel === "next",
    );
    nextUrl = nextLink ? new URL(nextLink.href, currentUrl).toString() : null;
  }

  return {
    items,
    pagesFetched,
  };
}

type AssetSelector = (assetKey: string, asset: StacAsset) => boolean;

export interface DownloadStacAssetsOptions {
  items: StacItem[];
  destinationRoot: string;
  assetSelector?: AssetSelector;
  dryRun?: boolean;
  overwrite?: boolean;
}

export interface DownloadStacAssetsResult {
  filesDownloaded: number;
  filesSkipped: number;
  bytesDownloaded: number;
}

export async function downloadStacAssets(
  options: DownloadStacAssetsOptions,
): Promise<DownloadStacAssetsResult> {
  const dryRun = options.dryRun ?? false;
  const overwrite = options.overwrite ?? false;
  const assetSelector = options.assetSelector ?? (() => true);

  await ensureDirectory(options.destinationRoot);

  let filesDownloaded = 0;
  let filesSkipped = 0;
  let bytesDownloaded = 0;

  for (const item of options.items) {
    const itemDirectory = path.join(options.destinationRoot, item.id);
    await ensureDirectory(itemDirectory);

    for (const [assetKey, asset] of Object.entries(item.assets)) {
      if (!assetSelector(assetKey, asset)) {
        continue;
      }

      const fileName = path.basename(new URL(asset.href).pathname);
      const destinationPath = path.join(itemDirectory, fileName);

      if (dryRun) {
        filesSkipped += 1;
        continue;
      }

      const result = await downloadFile(asset.href, destinationPath, {
        overwrite,
      });

      if (result.downloaded) {
        filesDownloaded += 1;
        bytesDownloaded += result.bytes;
      } else {
        filesSkipped += 1;
      }
    }
  }

  return {
    filesDownloaded,
    filesSkipped,
    bytesDownloaded,
  };
}
