/**
 * Test terrain local shadow at morning (sun east bas, az=80 alt=10)
 * for Montriond W tile — sampling multiple points.
 */
import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import { buildPointEvaluationContext, buildSharedPointEvaluationSources } from "../../src/lib/sun/evaluation-context";

const RAD_TO_DEG = 180 / Math.PI;

async function main() {
  const shared = await buildSharedPointEvaluationSources({
    lv95Bounds: { minX: 2536700, minY: 1151900, maxX: 2537100, maxY: 1152200 },
  });

  const utc = new Date("2026-04-29T07:30:00+02:00");
  const pos = SunCalc.getPosition(utc, 46.517, 6.617);
  const alt = pos.altitude * RAD_TO_DEG;
  let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
  if (az < 0) az += 360;
  console.log(`Sun 07:30: az=${az.toFixed(1)}° alt=${alt.toFixed(1)}°`);

  // Sample 5 points across Montriond W tile: sw, nw, center, ne, se
  const samples = [
    { label: "SW corner", e: 2536760, n: 1152010 },
    { label: "NW corner", e: 2536760, n: 1152240 },
    { label: "Centre", e: 2536875, n: 1152125 },
    { label: "NE corner", e: 2536990, n: 1152240 },
    { label: "SE corner", e: 2536990, n: 1152010 },
  ];

  let blockedCount = 0;
  for (const s of samples) {
    const { lat, lon } = lv95ToWgs84Precise(s.e, s.n);
    const ctx = await buildPointEvaluationContext(lat, lon, { sharedSources: shared });
    const tEval = ctx.terrainShadowEvaluator;
    const bEval = ctx.buildingShadowEvaluator;
    const tRes = tEval ? tEval({ azimuthDeg: az, altitudeDeg: alt }) : { blocked: false };
    const bRes = bEval ? bEval({ azimuthDeg: az, altitudeDeg: alt }) : { blocked: false };
    if (tRes.blocked) blockedCount++;
    console.log(
      `  ${s.label.padEnd(10)} elev=${ctx.pointElevationMeters?.toFixed(0)}m  ` +
      `terrain=${tRes.blocked ? "BLK" : " ok"} bldg=${bRes.blocked ? "BLK" : " ok"}`,
    );
  }
  console.log(`\n${blockedCount}/${samples.length} blocked by terrain (expected: 0 if Montriond W sommet)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
