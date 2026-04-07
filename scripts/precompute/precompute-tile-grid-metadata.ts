/**
 * Precompute tile grid metadata — indoor/outdoor classification and terrain
 * elevation for each grid point. This data is static (depends only on the
 * building model and terrain, not on the date) and can be reused across all
 * precompute days.
 *
 * Usage:
 *   npx tsx scripts/precompute/precompute-tile-grid-metadata.ts \
 *     --region=lausanne --grid-step-meters=1 \
 *     --bbox=6.618,46.505,6.645,46.526
 */
import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";

import { buildRegionTiles, getIntersectingTileIds, buildTilePoints } from "../../src/lib/precompute/sunlight-cache";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";
import { getSunlightModelVersion } from "../../src/lib/precompute/model-version";
import { buildSharedPointEvaluationSources, buildPointEvaluationContext } from "../../src/lib/sun/evaluation-context";
import { getTileGridMetadataPath, loadTileGridMetadata } from "../../src/lib/precompute/tile-grid-metadata";
export type { TileGridMetadata } from "../../src/lib/precompute/tile-grid-metadata";
export { loadTileGridMetadata, getTileGridMetadataPath };

const gzip = promisify(zlib.gzip);

import type { TileGridMetadata } from "../../src/lib/precompute/tile-grid-metadata";

interface Args {
  region: PrecomputedRegionName;
  gridStepMeters: number;
  bbox: [number, number, number, number] | null;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { region: "lausanne", gridStepMeters: 1, bbox: null };
  for (const arg of argv) {
    if (arg.startsWith("--region=")) result.region = arg.slice(9) as PrecomputedRegionName;
    else if (arg.startsWith("--grid-step-meters=")) result.gridStepMeters = Number(arg.slice(19));
    else if (arg.startsWith("--bbox=")) {
      const parts = arg.slice(7).split(",").map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        result.bbox = parts as [number, number, number, number];
      }
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const allTiles = buildRegionTiles(args.region, 250);
  let tiles = allTiles;
  if (args.bbox) {
    const [minLon, minLat, maxLon, maxLat] = args.bbox;
    const tileIds = getIntersectingTileIds({
      region: args.region,
      tileSizeMeters: 250,
      bbox: { minLon, minLat, maxLon, maxLat },
    });
    tiles = allTiles.filter(t => tileIds.includes(t.tileId));
    console.log(`[grid-metadata] bbox → ${tiles.length} tiles`);
  }

  const modelVersion = await getSunlightModelVersion(args.region, { buildingHeightBiasMeters: 0 });
  console.log(`[grid-metadata] region=${args.region} model=${modelVersion.modelVersionHash} tiles=${tiles.length} grid=${args.gridStepMeters}m`);

  const globalStart = performance.now();
  let totalOutdoor = 0;
  let totalIndoor = 0;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const tileStart = performance.now();

    // Check if already exists
    const existing = await loadTileGridMetadata(args.region, modelVersion.modelVersionHash, args.gridStepMeters, tile.tileId);
    if (existing) {
      totalOutdoor += existing.outdoorCount;
      totalIndoor += existing.indoorCount;
      console.log(`[grid-metadata] tile ${i + 1}/${tiles.length} ${tile.tileId} — cached (${existing.outdoorCount} outdoor, ${existing.indoorCount} indoor)`);
      continue;
    }

    const rawPoints = buildTilePoints(tile, args.gridStepMeters);

    // Load shared sources (terrain, buildings) for this tile
    const sharedSources = await buildSharedPointEvaluationSources({
      lv95Bounds: {
        minX: tile.minEasting,
        minY: tile.minNorthing,
        maxX: tile.maxEasting,
        maxY: tile.maxNorthing,
      },
      region: args.region,
    });

    const elevations: (number | null)[] = new Array(rawPoints.length);
    const indoor: boolean[] = new Array(rawPoints.length);
    let outdoorCount = 0;
    let indoorCount = 0;

    // Indoor detection via zenith shadow map: render sun straight down,
    // any point blocked = under a roof = indoor. Uses real DXF mesh
    // geometry instead of convex hull footprints.
    const gpuBackend = sharedSources.gpuShadowBackend;
    if (gpuBackend) {
      // Force re-render by using a unique azimuth per tile (the GPU backend
      // caches by azimuth/altitude and skips re-render if unchanged, but the
      // frustum focus changes per tile so we must force a new render).
      gpuBackend.prepareSunPosition(i * 0.001, 89.999);
    }

    for (let j = 0; j < rawPoints.length; j++) {
      const pt = rawPoints[j];
      const context = await buildPointEvaluationContext(pt.lat, pt.lon, {
        skipTerrainSamplingWhenIndoor: false, // always sample elevation
        sharedSources,
        skipIndoorCheck: true, // we'll use zenith shadow map instead
      });

      // Use zenith shadow map for indoor check (if GPU available)
      let isIndoor = false;
      if (gpuBackend && context.pointElevationMeters !== null) {
        const result = gpuBackend.evaluate({
          pointX: pt.lv95Easting,
          pointY: pt.lv95Northing,
          pointElevation: context.pointElevationMeters,
          solarAzimuthDeg: 0,
          solarAltitudeDeg: 90,
        });
        isIndoor = result.blocked;
      }

      if (isIndoor) {
        indoor[j] = true;
        elevations[j] = null;
        indoorCount++;
      } else {
        indoor[j] = false;
        elevations[j] = context.pointElevationMeters;
        outdoorCount++;
      }
    }

    const metadata: TileGridMetadata = {
      tileId: tile.tileId,
      modelVersionHash: modelVersion.modelVersionHash,
      gridStepMeters: args.gridStepMeters,
      totalPoints: rawPoints.length,
      outdoorCount,
      indoorCount,
      elevations,
      indoor,
    };

    // Write compressed
    const filePath = getTileGridMetadataPath(args.region, modelVersion.modelVersionHash, args.gridStepMeters, tile.tileId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const compressed = await gzip(JSON.stringify(metadata));
    await fs.writeFile(filePath, compressed);

    totalOutdoor += outdoorCount;
    totalIndoor += indoorCount;

    const tileMs = performance.now() - tileStart;
    console.log(
      `[grid-metadata] tile ${i + 1}/${tiles.length} ${tile.tileId} — ${outdoorCount} outdoor, ${indoorCount} indoor in ${(tileMs / 1000).toFixed(1)}s`,
    );
  }

  const totalMs = performance.now() - globalStart;
  console.log(
    `[grid-metadata] done: ${tiles.length} tiles, ${totalOutdoor} outdoor, ${totalIndoor} indoor in ${(totalMs / 1000).toFixed(1)}s`,
  );
}

main().catch(e => { console.error(e); process.exitCode = 1; });
