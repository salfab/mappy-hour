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
import { loadTileSelectionForRegion } from "../../src/lib/precompute/tile-selection-file";
import { buildSharedPointEvaluationSources, buildPointEvaluationContext } from "../../src/lib/sun/evaluation-context";
import { preflightMeshCascade } from "../../src/lib/precompute/preflight-mesh-cascade";
import { getTileGridMetadataPath, loadTileGridMetadata } from "../../src/lib/precompute/tile-grid-metadata";
export type { TileGridMetadata } from "../../src/lib/precompute/tile-grid-metadata";
export { loadTileGridMetadata, getTileGridMetadataPath };

const gzip = promisify(zlib.gzip);

import type { TileGridMetadata } from "../../src/lib/precompute/tile-grid-metadata";

interface Args {
  region: PrecomputedRegionName;
  gridStepMeters: number;
  bbox: [number, number, number, number] | null;
  tileSelectionFile: string | null;
  allowZeroIndoor: boolean;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { region: "lausanne", gridStepMeters: 1, bbox: null, tileSelectionFile: null, allowZeroIndoor: false };
  for (const arg of argv) {
    if (arg.startsWith("--region=")) result.region = arg.slice(9) as PrecomputedRegionName;
    else if (arg.startsWith("--grid-step-meters=")) result.gridStepMeters = Number(arg.slice(19));
    else if (arg.startsWith("--bbox=")) {
      const parts = arg.slice(7).split(",").map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        result.bbox = parts as [number, number, number, number];
      }
    }
    else if (arg.startsWith("--tile-selection-file=")) result.tileSelectionFile = arg.slice("--tile-selection-file=".length);
    else if (arg === "--allow-zero-indoor") result.allowZeroIndoor = true;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Audit binary mesh caches before building anything. A cache with a
  // matched-ratio < 100% means a previous build silently skipped obstacles
  // (cf. Zurich DXF 1091-41 = 714 MB > V8's 512 MB string cap). The cache
  // will be invalidated on next load by loadFromBinaryCache, but we surface
  // the issue here so the operator sees it up front.
  const WARN = "\x1b[33m";
  const ERR  = "\x1b[31m";
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  const cascade = await preflightMeshCascade();
  if (cascade.incompleteCaches.length > 0) {
    console.log(`${WARN}[gpu-mesh-audit] ⚠ ${cascade.incompleteCaches.length} incomplete cache(s) detected:${RESET}`);
    for (const c of cascade.incompleteCaches) {
      console.log(`${WARN}  ${c.cacheKey}: ${c.matchedCount}/${c.obstacleCount} matched (${c.skippedCount} skipped, ${(100 * c.ratio).toFixed(1)}% ratio)${RESET}`);
    }
    if (cascade.affectedRegions.size > 0) {
      console.log(`${WARN}[gpu-mesh-audit] cascade-quarantining ${cascade.affectedRegions.size} affected region(s): ${[...cascade.affectedRegions].join(", ")}${RESET}`);
      console.log(`${WARN}[gpu-mesh-audit] quarantine root: ${cascade.quarantineRoot}${RESET}`);
      console.log(`${WARN}[gpu-mesh-audit] ${cascade.quarantinedPaths.length} path(s) moved — downstream artifacts will be recomputed from rebuilt mesh${RESET}`);
    }
    if (cascade.unmappedCaches.length > 0) {
      console.log(`${WARN}[gpu-mesh-audit] ${cascade.unmappedCaches.length} cache(s) could not be mapped to a region (will rebuild via loadFromBinaryCache invalidation)${RESET}`);
    }
  } else {
    console.log(`[gpu-mesh-audit] ✓ all binary mesh caches are complete (100% obstacles matched)`);
  }

  const allTiles = buildRegionTiles(args.region, 250);
  let tileIds: string[] | null = null;
  if (args.tileSelectionFile) {
    const selection = await loadTileSelectionForRegion({
      filePath: args.tileSelectionFile,
      region: args.region,
    });
    tileIds = selection.tileIds;
    console.log(
      `[grid-metadata] tileSelectionFile=${selection.filePath} generatedAt=${selection.generatedAt} → ${selection.tileIds.length} tiles`,
    );
  }
  if (args.bbox) {
    const [minLon, minLat, maxLon, maxLat] = args.bbox;
    const bboxTileIds = getIntersectingTileIds({
      region: args.region,
      tileSizeMeters: 250,
      bbox: { minLon, minLat, maxLon, maxLat },
    });
    tileIds = tileIds
      ? tileIds.filter((tileId) => bboxTileIds.includes(tileId))
      : bboxTileIds;
    console.log(`[grid-metadata] bbox → ${bboxTileIds.length} tiles (${tileIds.length} after filters)`);
  }

  if (tileIds && tileIds.length === 0) {
    // Benign no-op: precompute-all-regions runs a 2-pass × N-region matrix
    // where many cells legitimately have no tiles for the (region, group)
    // combo. Returning here keeps exit code 0 instead of polluting the
    // parent log with `✗ a échoué`.
    console.log(
      `[grid-metadata] no tiles selected after applying tile-selection-file/bbox/group filters — exiting cleanly.`,
    );
    return;
  }

  const tiles = tileIds ? allTiles.filter((tile) => tileIds.includes(tile.tileId)) : allTiles;

  const modelVersion = await getSunlightModelVersion(args.region, { buildingHeightBiasMeters: 0 });
  console.log(`[grid-metadata] region=${args.region} gridHash=${modelVersion.gridMetadataHash} (atlasHash=${modelVersion.modelVersionHash}) tiles=${tiles.length} grid=${args.gridStepMeters}m`);

  const globalStart = performance.now();
  let totalOutdoor = 0;
  let totalIndoor = 0;
  let warnedNoGpuBackend = false;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const tileStart = performance.now();

    // Check if already exists
    const existing = await loadTileGridMetadata(args.region, modelVersion.gridMetadataHash, args.gridStepMeters, tile.tileId);
    if (existing) {
      totalOutdoor += existing.outdoorCount;
      totalIndoor += existing.indoorCount;
      const zeroIndoorWarn = existing.indoorCount === 0
        ? ` ${WARN}⚠ 0 indoor — buildings manquants ?${RESET}`
        : "";
      console.log(`[grid-metadata] tile ${i + 1}/${tiles.length} ${tile.tileId} — cached (${existing.outdoorCount} outdoor, ${existing.indoorCount} indoor)${zeroIndoorWarn}`);
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
      // We ARE the preflight generating the grid metadata — the fail-fast
      // in shared-sources would otherwise create a chicken-and-egg loop.
      skipZenithIndoorCheck: true,
    });

    const elevations: (number | null)[] = new Array(rawPoints.length);
    const indoor: boolean[] = new Array(rawPoints.length);
    let outdoorCount = 0;
    let indoorCount = 0;

    // Indoor detection via zenith shadow map: render sun straight down,
    // any point blocked = under a roof = indoor. Uses real DXF mesh
    // geometry instead of convex hull footprints.
    const gpuBackend = sharedSources.gpuShadowBackend;
    if (!gpuBackend && !warnedNoGpuBackend) {
      warnedNoGpuBackend = true;
      console.error(
        `${ERR}${BOLD}[grid-metadata] ✗ PAS DE BACKEND GPU — buildings index manquant pour region=${args.region}.${RESET}\n` +
        `${ERR} Tous les points seront classés outdoor (indoor=0 non représentatif).${RESET}\n` +
        `${ERR} → Exécutez d'abord : npx tsx scripts/ingest/download-buildings.ts --region=${args.region}${RESET}`
      );
    }
    if (gpuBackend) {
      // Force re-render by using a unique azimuth per tile (the GPU backend
      // caches by azimuth/altitude and skips re-render if unchanged, but the
      // frustum focus changes per tile so we must force a new render).
      // Each tile gets a unique integer azimuth to bust the 1° rounding cache
      gpuBackend.prepareSunPosition(i % 360, 90);
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
      modelVersionHash: modelVersion.gridMetadataHash,
      gridStepMeters: args.gridStepMeters,
      totalPoints: rawPoints.length,
      outdoorCount,
      indoorCount,
      elevations,
      indoor,
    };

    // Write compressed under the narrower grid metadata hash dir.
    const filePath = getTileGridMetadataPath(args.region, modelVersion.gridMetadataHash, args.gridStepMeters, tile.tileId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const compressed = await gzip(JSON.stringify(metadata));
    await fs.writeFile(filePath, compressed);

    totalOutdoor += outdoorCount;
    totalIndoor += indoorCount;

    const tileMs = performance.now() - tileStart;
    const zeroIndoorWarn = indoorCount === 0
      ? ` ${WARN}⚠ 0 indoor — buildings manquants ?${RESET}`
      : "";
    console.log(
      `[grid-metadata] tile ${i + 1}/${tiles.length} ${tile.tileId} — ${outdoorCount} outdoor, ${indoorCount} indoor in ${(tileMs / 1000).toFixed(1)}s${zeroIndoorWarn}`,
    );
  }

  const totalMs = performance.now() - globalStart;
  const summaryLine = `[grid-metadata] done: ${tiles.length} tiles, ${totalOutdoor} outdoor, ${totalIndoor} indoor in ${(totalMs / 1000).toFixed(1)}s`;
  if (totalIndoor === 0 && tiles.length > 0) {
    console.error(`${ERR}${BOLD}${summaryLine}${RESET}`);
    if (args.allowZeroIndoor) {
      console.error(
        `${WARN}${BOLD}[grid-metadata] ⚠ totalIndoor=0 pour region=${args.region} — ignoré via --allow-zero-indoor.${RESET}`,
      );
    } else {
      console.error(
        `${ERR}${BOLD}[grid-metadata] ✗ ERREUR : totalIndoor=0 pour toutes les ${tiles.length} tuiles (region=${args.region}).${RESET}`,
      );
      console.error(`${ERR} Les buildings SwissBuildings3D ne sont pas ingérés pour cette région.${RESET}`);
      console.error(`${ERR} Relancez après : npx tsx scripts/ingest/download-buildings.ts --region=${args.region}${RESET}`);
      console.error(`${ERR} Pour bypasser (non recommandé) : ajoutez --allow-zero-indoor${RESET}`);
      process.exitCode = 1;
    }
  } else {
    console.log(summaryLine);
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
