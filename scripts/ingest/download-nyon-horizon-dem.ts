import fs from "node:fs/promises";
import path from "node:path";

import { NYON_HORIZON_BBOX } from "../../src/lib/config/nyon";

import { parseIngestCliArgs } from "./cli";
import { downloadFile, ensureDirectory } from "./http";

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

function listTilesForBbox(bbox: [number, number, number, number]): CopernicusTile[] {
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

async function main() {
  const args = parseIngestCliArgs(process.argv.slice(2));
  const destinationRoot = path.join(process.cwd(), "data", "raw", "copernicus-dem30");
  const manifestPath = path.join(destinationRoot, "manifest-nyon-horizon.json");

  const allTiles = listTilesForBbox(NYON_HORIZON_BBOX);
  const tiles = args.maxItems ? allTiles.slice(0, args.maxItems) : allTiles;

  let downloaded = 0;
  let skipped = 0;
  let notFound = 0;
  let bytesDownloaded = 0;

  const tileResults: Array<{ name: string; status: string; destination?: string }> = [];

  await ensureDirectory(destinationRoot);

  console.log(
    `[horizon-dem-nyon] Target tiles: ${tiles.length} (bbox: ${NYON_HORIZON_BBOX.join(",")}).`,
  );

  for (const tile of tiles) {
    const destinationPath = path.join(destinationRoot, `${tile.name}.tif`);

    if (args.dryRun) {
      skipped += 1;
      tileResults.push({ name: tile.name, status: "dry-run" });
      continue;
    }

    try {
      const result = await downloadFile(tile.url, destinationPath, {
        overwrite: args.overwrite,
      });

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

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: "Copernicus DEM 30m COG",
    bbox: NYON_HORIZON_BBOX,
    dryRun: args.dryRun,
    overwrite: args.overwrite,
    maxItems: args.maxItems ?? null,
    counts: {
      tilesRequested: tiles.length,
      downloaded,
      skipped,
      notFound,
      bytesDownloaded,
    },
    tiles: tileResults,
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(`[horizon-dem-nyon] Manifest written to ${manifestPath}`);
  console.log(
    `[horizon-dem-nyon] Downloaded ${downloaded}, skipped ${skipped}, not-found ${notFound}.`,
  );
}

main().catch((error) => {
  console.error(
    `[horizon-dem-nyon] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
