import { buildPointEvaluationContext } from "../../src/lib/sun/evaluation-context";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";

async function check(label: string, e: number, n: number) {
  const { lat, lon } = lv95ToWgs84(e, n);
  console.log(`\n═══ ${label}  (LV95 ${e},${n} → lat=${lat.toFixed(6)} lon=${lon.toFixed(6)}) ═══`);
  const ctx = await buildPointEvaluationContext(lat, lon, {});
  const mask = ctx.horizonMask;
  if (!mask) {
    console.log("No horizon mask!");
    return;
  }
  console.log(`Point elevation: ${ctx.pointElevationMeters?.toFixed(1)}m`);
  console.log("azimuth  horizonAngle");
  for (let az = 0; az < 360; az += 15) {
    console.log(`  ${az.toString().padStart(3)}°    ${mask.binsDeg[az].toFixed(2)}°`);
  }
  const max = Math.max(...mask.binsDeg);
  const maxIdx = mask.binsDeg.indexOf(max);
  console.log(`Max horizon: ${max.toFixed(2)}° at az=${maxIdx}°`);
}

async function main() {
  await check("Montriond sommet", 2536875, 1152125);
  await check("Flon (north of Montriond)", 2537000, 1152400);
  await check("Gare CFF Lausanne", 2537500, 1151600);
  await check("Ouchy", 2537500, 1150500);
}
main().catch((e) => { console.error(e); process.exit(1); });
