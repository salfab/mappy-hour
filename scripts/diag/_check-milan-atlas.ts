/**
 * Diag : autour de Parc de Milan (Lausanne), 2026-04-27 07:30
 * symptôme rapporté : tuiles 100% soleil alors qu'entourées de bâtiments.
 *
 * Pour chaque tuile voisine :
 *   - compte indoor / outdoor dans l'atlas (grid metadata)
 *   - compte sunny / total à 07:30 sur la date
 *   - compare à ce que prédit le CPU golden sur un point représentatif
 *
 * Si indoorCount≈0 ou sunMask≈100% pour UNE tuile mais pas ses voisines
 * → atlas écrit sans bâtiments (bug Vulkan dropped backend).
 */
import SunCalc from "suncalc";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";

import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";
import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasByAngle,
  type BinaryTileAtlas,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "../../src/lib/sun/evaluation-context";
import { evaluateInstantSunlight } from "../../src/lib/sun/solar";

const gunzip = promisify(gunzipCallback);

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;
const TIMEZONE = "Europe/Zurich";
const DATE = "2026-04-27";
const LOCAL_TIME = "07:30";

// Parc de Milan + voisines (grille 250m, secteur ~750m × 500m)
const TILES: Array<{ tileId: string; lat: number; lon: number; label: string }> = [
  { tileId: "e2536750_n1151750_s250", lat: 46.5157, lon: 6.6165, label: "Milan W" },
  { tileId: "e2537000_n1151750_s250", lat: 46.5157, lon: 6.6185, label: "Milan centre" },
  { tileId: "e2537250_n1151750_s250", lat: 46.5157, lon: 6.6210, label: "Milan E" },
  { tileId: "e2537000_n1152000_s250", lat: 46.5170, lon: 6.6185, label: "Milan N" },
  { tileId: "e2537000_n1151500_s250", lat: 46.5145, lon: 6.6185, label: "Milan S" },
];

const RAD_TO_DEG = 180 / Math.PI;

async function countIndoorInGridMetadata(tileId: string): Promise<{ pointCount: number; indoorCount: number } | null> {
  const filePath = path.join(
    process.cwd(),
    "data/cache/tile-grid-metadata",
    REGION,
    MODEL_HASH,
    `g${GRID}`,
    `${tileId}.json.gz`,
  );
  try {
    const buf = await fs.readFile(filePath);
    const decompressed = await gunzip(buf);
    const json = JSON.parse(decompressed.toString("utf8"));
    return {
      pointCount: json.totalPoints ?? json.pointCount ?? 0,
      indoorCount: json.indoorCount ?? 0,
    };
  } catch (e) {
    return null;
  }
}

async function analyzeTile(entry: typeof TILES[number]) {
  console.log(`\n══ ${entry.label}  (${entry.tileId}) ══`);

  const gridMeta = await countIndoorInGridMetadata(entry.tileId);
  if (gridMeta) {
    const outdoorCount = gridMeta.pointCount - gridMeta.indoorCount;
    console.log(
      `  grid-metadata  : pointCount=${gridMeta.pointCount}  indoor=${gridMeta.indoorCount}  outdoor=${outdoorCount}` +
        `  (indoor%=${((gridMeta.indoorCount / gridMeta.pointCount) * 100).toFixed(1)})`,
    );
  } else {
    console.log(`  grid-metadata  : MISSING`);
  }

  const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
    region: REGION,
    modelVersionHash: MODEL_HASH,
    gridStepMeters: GRID,
    tileId: entry.tileId,
  });
  if (atlases.length === 0) {
    console.log(`  atlas          : MISSING`);
    return;
  }
  const a = atlases[0];
  console.log(
    `  atlas (r${a.resolutionDegAz}°): pointCount=${a.pointCount}  outdoorPointCount=${a.outdoorPointCount}  bucketCount=${a.bucketCount}`,
  );

  // Compute sun angle at 07:30 on the reported date.
  const utc = new Date(`${DATE}T${LOCAL_TIME}:00+02:00`);
  const pos = SunCalc.getPosition(utc, entry.lat, entry.lon);
  const alt = pos.altitude * RAD_TO_DEG;
  let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
  if (az < 0) az += 360;
  console.log(`  sun @ ${LOCAL_TIME}   : az=${az.toFixed(1)}°  alt=${alt.toFixed(1)}°`);

  const bucket = lookupAtlasByAngle(atlases, az, alt);
  if (!bucket) {
    console.log(`  ✗ no bucket at (${az.toFixed(1)}, ${alt.toFixed(1)})`);
    return;
  }
  // Count set bits in sunMask and sunNoVegMask (limited to outdoorPointCount)
  let sunnyFull = 0, sunnyNoVeg = 0, buildingsBlocked = 0;
  const outdoorBits = a.outdoorPointCount;
  for (let i = 0; i < outdoorBits; i++) {
    if ((bucket.sunMask[i >> 3] >> (i & 7)) & 1) sunnyFull++;
    if ((bucket.sunNoVegMask[i >> 3] >> (i & 7)) & 1) sunnyNoVeg++;
    if ((bucket.buildingsMask[i >> 3] >> (i & 7)) & 1) buildingsBlocked++;
  }
  const pctFull = (sunnyFull / outdoorBits) * 100;
  const pctNoVeg = (sunnyNoVeg / outdoorBits) * 100;
  const pctBuildBlk = (buildingsBlocked / outdoorBits) * 100;
  console.log(
    `  sun@(az=${bucket.azBucket}, alt=${bucket.altBucket}) : full=${pctFull.toFixed(1)}%  noVeg=${pctNoVeg.toFixed(1)}%  buildingsBlocked=${pctBuildBlk.toFixed(1)}%`,
  );
  if (pctNoVeg > 98 && pctBuildBlk < 2) {
    console.log(`  ⚠ noVeg ~100% ET buildingsMask ~0% → bâtiments pas évalués pour ce bucket`);
  } else if (pctNoVeg > 98) {
    console.log(`  ⚠ noVeg ~100% — à vérifier`);
  }

  // CPU golden on the center point
  const lv = wgs84ToLv95Precise(entry.lon, entry.lat);
  const shared = await buildSharedPointEvaluationSources({
    lv95Bounds: { minX: lv.easting - 50, minY: lv.northing - 50, maxX: lv.easting + 50, maxY: lv.northing + 50 },
  });
  const ctx = await buildPointEvaluationContext(entry.lat, entry.lon, { sharedSources: shared });
  if (ctx.insideBuilding) {
    console.log(`  CPU point (centre): INDOOR — skip`);
    return;
  }
  const cpu = evaluateInstantSunlight({
    lat: entry.lat,
    lon: entry.lon,
    utcDate: utc,
    timeZone: TIMEZONE,
    horizonMask: ctx.horizonMask,
    buildingShadowEvaluator: ctx.buildingShadowEvaluator,
    vegetationShadowEvaluator: ctx.vegetationShadowEvaluator,
  });
  console.log(`  CPU centre     : ${cpu.isSunny ? "SUN" : "SHADOW"}  (building=${cpu.buildingBlocked ? "BLK" : "OK"}, terrain=${cpu.terrainBlocked ? "BLK" : "OK"}, veget=${cpu.vegetationBlocked ? "BLK" : "OK"})`);
}

async function main() {
  console.log(`Diag Parc de Milan — ${DATE} ${LOCAL_TIME} (Europe/Zurich)`);
  for (const t of TILES) {
    await analyzeTile(t);
  }
  console.log(`\nFini.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
