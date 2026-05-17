/**
 * Ensures the Copernicus DEM 30 m horizon manifest exists for a region.
 *
 * Shared core used by:
 *  - `scripts/ingest/download-horizon-dem.ts` (CLI)
 *  - `src/lib/precompute/preflight-atlas-health.ts` (auto-fix at precompute start)
 *
 * The atlas precompute refuses to run without a horizon manifest, because
 * atlases generated with `terrainHorizonMethod=none` declare cells as "sunny"
 * that should actually be blocked by distant relief. Rather than skipping a
 * region when its manifest is missing, the preflight calls
 * `ensureHorizonDemManifestForRegion` to fetch the missing tiles on the fly.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { BBox } from "@/lib/config/lausanne";
import { LAUSANNE_CONFIG } from "@/lib/config/lausanne";
import { NYON_CONFIG } from "@/lib/config/nyon";
import { MORGES_CONFIG } from "@/lib/config/morges";
import { GENEVE_CONFIG } from "@/lib/config/geneve";
import { VEVEY_CONFIG } from "@/lib/config/vevey";
import { VEVEY_CITY_CONFIG } from "@/lib/config/vevey_city";
import { NEUCHATEL_CONFIG } from "@/lib/config/neuchatel";
import { LA_CHAUX_DE_FONDS_CONFIG } from "@/lib/config/la_chaux_de_fonds";
import { BERN_CONFIG } from "@/lib/config/bern";
import { ZURICH_CONFIG } from "@/lib/config/zurich";
import { THUN_CONFIG } from "@/lib/config/thun";
import { RAW_HORIZON_DEM_DIR } from "@/lib/storage/data-paths";

const REGION_HORIZON_BBOX: Record<string, BBox> = {
  lausanne: LAUSANNE_CONFIG.horizonBbox,
  nyon: NYON_CONFIG.horizonBbox,
  morges: MORGES_CONFIG.horizonBbox,
  geneve: GENEVE_CONFIG.horizonBbox,
  vevey: VEVEY_CONFIG.horizonBbox,
  vevey_city: VEVEY_CITY_CONFIG.horizonBbox,
  neuchatel: NEUCHATEL_CONFIG.horizonBbox,
  la_chaux_de_fonds: LA_CHAUX_DE_FONDS_CONFIG.horizonBbox,
  bern: BERN_CONFIG.horizonBbox,
  zurich: ZURICH_CONFIG.horizonBbox,
  thun: THUN_CONFIG.horizonBbox,
};

export function getKnownHorizonRegions(): string[] {
  return Object.keys(REGION_HORIZON_BBOX);
}

export function getRegionHorizonBbox(region: string): BBox {
  const bbox = REGION_HORIZON_BBOX[region];
  if (!bbox) {
    throw new Error(
      `Unknown region '${region}'. Known: ${Object.keys(REGION_HORIZON_BBOX).join(", ")}.`,
    );
  }
  return bbox;
}

export function getHorizonManifestPathForRegion(region: string): string {
  return path.join(RAW_HORIZON_DEM_DIR, `manifest-${region}-horizon.json`);
}

interface CopernicusTile {
  lat: number;
  lon: number;
  name: string;
  url: string;
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

function latitudeToken(latitude: number): string {
  return `${latitude >= 0 ? "N" : "S"}${pad(Math.abs(latitude), 2)}`;
}

function longitudeToken(longitude: number): string {
  return `${longitude >= 0 ? "E" : "W"}${pad(Math.abs(longitude), 3)}`;
}

function buildTileName(latFloor: number, lonFloor: number): string {
  return `Copernicus_DSM_COG_10_${latitudeToken(latFloor)}_00_${longitudeToken(lonFloor)}_00_DEM`;
}

function listTilesForBbox(bbox: BBox): CopernicusTile[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const tiles: CopernicusTile[] = [];
  for (let lat = Math.floor(minLat); lat < Math.ceil(maxLat); lat += 1) {
    for (let lon = Math.floor(minLon); lon < Math.ceil(maxLon); lon += 1) {
      const name = buildTileName(lat, lon);
      const url = `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
      tiles.push({ lat, lon, name, url });
    }
  }
  return tiles;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadTile(
  url: string,
  destinationPath: string,
  overwrite: boolean,
): Promise<{ downloaded: boolean; bytes: number }> {
  if (!overwrite && (await fileExists(destinationPath))) {
    return { downloaded: false, bytes: 0 };
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(destinationPath, buffer);
  return { downloaded: true, bytes: buffer.byteLength };
}

export interface EnsureHorizonDemOptions {
  /** When true, redownload tiles even if they already exist locally. */
  overwrite?: boolean;
  /** When true, log progress to console with [horizon-dem:<region>] prefix. */
  verbose?: boolean;
  /** Cap the tile count (for smoke tests). */
  maxItems?: number;
  /** When true, list tiles but neither download nor write the manifest. */
  dryRun?: boolean;
}

export interface EnsureHorizonDemResult {
  region: string;
  manifestPath: string;
  bbox: BBox;
  counts: {
    tilesRequested: number;
    downloaded: number;
    skipped: number;
    notFound: number;
    bytesDownloaded: number;
  };
}

/**
 * Downloads (if needed) every Copernicus DEM 30 m tile covering the region's
 * horizon bbox and writes the per-region manifest the preflight expects.
 *
 * Idempotent: a region that already has every tile + manifest returns a
 * counts.downloaded === 0 result without touching the network.
 */
export async function ensureHorizonDemManifestForRegion(
  region: string,
  options: EnsureHorizonDemOptions = {},
): Promise<EnsureHorizonDemResult> {
  const bbox = getRegionHorizonBbox(region);
  const destinationRoot = RAW_HORIZON_DEM_DIR;
  const manifestPath = getHorizonManifestPathForRegion(region);

  await fs.mkdir(destinationRoot, { recursive: true });

  const allTiles = listTilesForBbox(bbox);
  const tiles = options.maxItems ? allTiles.slice(0, options.maxItems) : allTiles;

  const log = options.verbose
    ? (msg: string) => console.log(`[horizon-dem:${region}] ${msg}`)
    : () => {};

  log(`Target tiles: ${tiles.length} (bbox: ${bbox.join(",")}).`);

  let downloaded = 0;
  let skipped = 0;
  let notFound = 0;
  let bytesDownloaded = 0;
  const tileResults: Array<{ name: string; status: string; destination?: string }> =
    [];

  for (const tile of tiles) {
    const destinationPath = path.join(destinationRoot, `${tile.name}.tif`);

    if (options.dryRun) {
      skipped += 1;
      tileResults.push({ name: tile.name, status: "dry-run" });
      continue;
    }

    try {
      const result = await downloadTile(
        tile.url,
        destinationPath,
        options.overwrite ?? false,
      );
      if (result.downloaded) {
        downloaded += 1;
        bytesDownloaded += result.bytes;
        tileResults.push({
          name: tile.name,
          status: "downloaded",
          destination: destinationPath,
        });
      } else {
        skipped += 1;
        tileResults.push({
          name: tile.name,
          status: "skipped-existing",
          destination: destinationPath,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("404")) {
        notFound += 1;
        tileResults.push({ name: tile.name, status: "not-found" });
        continue;
      }
      throw error;
    }
  }

  const counts = {
    tilesRequested: tiles.length,
    downloaded,
    skipped,
    notFound,
    bytesDownloaded,
  };

  if (!options.dryRun) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      source: "Copernicus DEM 30m COG",
      region,
      bbox,
      overwrite: options.overwrite ?? false,
      maxItems: options.maxItems ?? null,
      counts,
      tiles: tileResults,
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    log(`Manifest written to ${manifestPath}`);
  }

  log(
    `Downloaded ${downloaded}, skipped ${skipped}, not-found ${notFound}.`,
  );

  return { region, manifestPath, bbox, counts };
}
