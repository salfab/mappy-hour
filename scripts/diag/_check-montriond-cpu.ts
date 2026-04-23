/**
 * Compare atlas Montriond (after regen) vs CPU golden on multiple points
 * in the tile to detect whether the bug is data-driven or pipeline-driven.
 */
import SunCalc from "suncalc";

import { wgs84ToLv95, lv95ToWgs84 } from "../../src/lib/geo/projection";
import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "../../src/lib/sun/evaluation-context";
import { evaluateInstantSunlight } from "../../src/lib/sun/solar";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;
const TIMEZONE = "Europe/Zurich";
const RAD_TO_DEG = 180 / Math.PI;

const DATE = "2026-04-29";
const LOCAL_TIME = "07:30"; // bucket that has data: az~79.8 alt~10.1

// Sample a 5x5 grid of points inside the Montriond tile e2536750_n1152000_s250
const TILE_E_MIN = 2536750, TILE_N_MIN = 1152000, TILE_SIZE = 250;

async function main() {
  const tileId = "e2536750_n1152000_s250";

  // Load the atlas
  const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
    region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID, tileId,
  });
  const a = atlases[0];
  const utc = new Date(`${DATE}T${LOCAL_TIME}:00+02:00`);
  const tileCenter = lv95ToWgs84(TILE_E_MIN + TILE_SIZE / 2, TILE_N_MIN + TILE_SIZE / 2);
  const pos = SunCalc.getPosition(utc, tileCenter.lat, tileCenter.lon);
  const alt = pos.altitude * RAD_TO_DEG;
  let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
  if (az < 0) az += 360;
  console.log(`Sun @ Montriond ${DATE} ${LOCAL_TIME}: az=${az.toFixed(1)}° alt=${alt.toFixed(1)}°`);
  const bucket = lookupAtlasByAngle(atlases, az, alt);
  if (!bucket) { console.log("NO BUCKET in atlas"); return; }

  let atlasBbblk = 0;
  for (let i = 0; i < a.outdoorPointCount; i++) {
    if ((bucket.buildingsMask[i >> 3] >> (i & 7)) & 1) atlasBbblk++;
  }
  console.log(`Atlas : outdoor=${a.outdoorPointCount}  buildingsBlocked=${((atlasBbblk/a.outdoorPointCount)*100).toFixed(1)}%`);

  // Now sample 5x5 points, run CPU golden on each
  const shared = await buildSharedPointEvaluationSources({
    lv95Bounds: {
      minX: TILE_E_MIN - 200, minY: TILE_N_MIN - 200,
      maxX: TILE_E_MIN + TILE_SIZE + 200, maxY: TILE_N_MIN + TILE_SIZE + 200,
    },
  });

  let cpuSun = 0, cpuBuildBlk = 0, cpuVegBlk = 0, cpuIndoor = 0, cpuOutdoor = 0;
  const dumps: string[] = [];
  for (let iy = 0; iy < 5; iy++) {
    for (let ix = 0; ix < 5; ix++) {
      const ey = TILE_E_MIN + 25 + ix * 50;
      const ny = TILE_N_MIN + 25 + iy * 50;
      const ll = lv95ToWgs84(ey, ny);
      const ctx = await buildPointEvaluationContext(ll.lat, ll.lon, { sharedSources: shared });
      if (ctx.insideBuilding) { cpuIndoor++; continue; }
      cpuOutdoor++;
      // Direct test: call buildingShadowEvaluator on this sample, twice
      // Once as my script does (2 fields), once as evaluateInstantSunlight does (3 fields with utcDate)
      let directBldg: { blocked: boolean } | undefined;
      let directBldgWithUtc: { blocked: boolean } | undefined;
      if (ctx.buildingShadowEvaluator) {
        directBldg = ctx.buildingShadowEvaluator({ azimuthDeg: az, altitudeDeg: alt }) as typeof directBldg;
        directBldgWithUtc = ctx.buildingShadowEvaluator({ azimuthDeg: az, altitudeDeg: alt, utcDate: utc } as any) as typeof directBldgWithUtc;
      }
      // Force the override so evaluateInstantSunlight uses the same angles as directBldg
      const r = evaluateInstantSunlight({
        lat: ll.lat, lon: ll.lon, utcDate: utc, timeZone: TIMEZONE,
        horizonMask: ctx.horizonMask,
        buildingShadowEvaluator: ctx.buildingShadowEvaluator,
        vegetationShadowEvaluator: ctx.vegetationShadowEvaluator,
        solarPositionOverride: { azimuthDeg: az, altitudeDeg: alt },
        evaluateAllBlockers: true,
      });
      if (r.isSunny) cpuSun++;
      if (r.buildingsBlocked) cpuBuildBlk++;
      if (r.vegetationBlocked) cpuVegBlk++;
      dumps.push(`  (${ix},${iy}) LV95=(${ey},${ny}) ptElev=${ctx.pointElevationMeters?.toFixed(1)}  directBldg=${directBldg?.blocked}/withUtc=${directBldgWithUtc?.blocked}  r.buildingsBlocked=${r.buildingsBlocked}  r.terrainBlocked=${r.terrainBlocked}  ${r.isSunny ? "SUN" : "SHADOW"}  veg=${r.vegetationBlocked ? "BLK" : "-"}`);
    }
  }
  console.log(`\nCPU sample 5x5 (50m spacing):`);
  dumps.forEach((s) => console.log(s));
  console.log(`\nCPU totals : indoor=${cpuIndoor}  outdoor=${cpuOutdoor}  sunny=${cpuSun}  buildingBlocked=${cpuBuildBlk}  vegBlocked=${cpuVegBlk}`);
  if (cpuOutdoor > 0) {
    console.log(`CPU buildings%=${((cpuBuildBlk/cpuOutdoor)*100).toFixed(1)}%  (atlas=${((atlasBbblk/a.outdoorPointCount)*100).toFixed(1)}%)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
