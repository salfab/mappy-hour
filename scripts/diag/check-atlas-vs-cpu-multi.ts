/**
 * Diagnostic multi-tuile / multi-date : compare atlas précomputé vs CPU golden
 * pour détecter si la corruption est systémique ou localisée.
 *
 * Pour chaque (tuile, point, date) :
 *   - pick le plus proche outdoor point dans l'atlas
 *   - pour chaque 15 min sur la date, compare CPU vs atlas
 *   - agrège les mismatches
 *
 * Usage: pnpm tsx scripts/diag/check-atlas-vs-cpu-multi.ts
 *
 * ATTENTION : ne PAS lancer ce script avec MAPPY_BUILDINGS_SHADOW_MODE set à un
 * mode batch (rust-wgpu-vulkan, webgpu-compute). Dans ces modes, le
 * buildingShadowEvaluator renvoyé par buildPointEvaluationContext est
 * `undefined` (parce que le backend est supposé agréger les évaluations
 * côté GPU), donc le CPU golden ne voit aucun bâtiment et dit toujours
 * SUN — tous les mismatches ressortent "C=SUN / A=SHAD" faussement. Le
 * script erreure si on lance dans ce mode.
 */

// Fail-fast si on lance avec un mode batch (qui produirait un CPU golden invalide).
// Doit être exécuté AVANT les imports TS — ESM hoist les imports au-dessus du
// code, donc on vérifie juste et on exit ; pas de mutation d'env ici.
{
  const mode = (process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "").toLowerCase();
  if (mode === "rust-wgpu-vulkan" || mode === "webgpu-compute") {
    console.error(
      `[check-atlas-vs-cpu-multi] ABORT : MAPPY_BUILDINGS_SHADOW_MODE=${mode} rend le CPU golden invalide (buildingShadowEvaluator=undefined en mode batch).\n` +
        `→ Unset la variable ou utilise MAPPY_BUILDINGS_SHADOW_MODE=detailed|two-level|prism|gpu-raster.`,
    );
    process.exit(2);
  }
}

import SunCalc from "suncalc";

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

const TIMEZONE = "Europe/Zurich";
const GRID_STEP = 1;
const RAD_TO_DEG = 180 / Math.PI;

type Target = {
  label: string;
  region: "lausanne" | "morges" | "nyon" | "geneve";
  modelHash: string;
  lat: number;
  lon: number;
};

// Override the per-target modelHash with a single hash via env var. Useful
// during refactors that bump modelVersionHash (e.g. terrain dedup 2026-05-04)
// — set MAPPY_CHECK_MODEL_HASH=<new hash> and the script reads atlases from
// the new cache dir without editing the targets list.
const MODEL_HASH_OVERRIDE = process.env.MAPPY_CHECK_MODEL_HASH?.trim() || null;
const DEFAULT_LAUSANNE_HASH = "d43fe24cbb9190af";

// Points critiques pour tester les ombres de bâtiments :
// chaque point est près d'un gros bâtiment qui devrait projeter une ombre
// marquée à certaines heures.
const TARGETS: Target[] = [
  // Lausanne — Rumine (tuile régénérée avec Niveau 3 + merge fix, sert de baseline)
  { label: "LAU Rumine ouest", region: "lausanne", modelHash: MODEL_HASH_OVERRIDE ?? DEFAULT_LAUSANNE_HASH, lat: 46.5231, lon: 6.6323 },
  // Lausanne — St-François
  { label: "LAU St-François N", region: "lausanne", modelHash: MODEL_HASH_OVERRIDE ?? DEFAULT_LAUSANNE_HASH, lat: 46.5204, lon: 6.6333 },
  // Lausanne — Cathédrale sud
  { label: "LAU Cathédrale N", region: "lausanne", modelHash: MODEL_HASH_OVERRIDE ?? DEFAULT_LAUSANNE_HASH, lat: 46.5236, lon: 6.6354 },
  // Lausanne — Pont Bessières (ombres fortes du pont + immeubles hauts)
  { label: "LAU Pont Bessières", region: "lausanne", modelHash: MODEL_HASH_OVERRIDE ?? DEFAULT_LAUSANNE_HASH, lat: 46.5222, lon: 6.6348 },
  // Lausanne — Chauderon (rue Centrale, ombres matinales)
  { label: "LAU Chauderon", region: "lausanne", modelHash: MODEL_HASH_OVERRIDE ?? DEFAULT_LAUSANNE_HASH, lat: 46.5255, lon: 6.6245 },
];

if (MODEL_HASH_OVERRIDE) {
  console.error(
    `[check-atlas-vs-cpu-multi] modelHash override active: ${MODEL_HASH_OVERRIDE} (default ${DEFAULT_LAUSANNE_HASH} ignored)`,
  );
}

// Dates réparties sur l'année pour couvrir différentes positions solaires.
const DATES = [
  "2026-04-29", // date actuellement précalculée (Vulkan GPU terrain regen)
];

function tileIdFor(easting: number, northing: number, size = 250): string {
  const e = Math.floor(easting / size) * size;
  const n = Math.floor(northing / size) * size;
  return `e${e}_n${n}_s${size}`;
}

function findClosestOutdoorPoint(atlas: BinaryTileAtlas, targetLat: number, targetLon: number) {
  let best: { idx: number; dist2: number } | null = null;
  const target = wgs84ToLv95Precise(targetLon, targetLat);
  for (let i = 0; i < atlas.pointCount; i++) {
    const flags = atlas.pointFlags[i];
    const outdoorIdx = atlas.pointOutdoorIndex[i];
    if ((flags & 1) !== 0 || outdoorIdx < 0) continue;
    const dx = atlas.pointIx[i] - target.easting;
    const dy = atlas.pointIy[i] - target.northing;
    const d2 = dx * dx + dy * dy;
    if (!best || d2 < best.dist2) best = { idx: i, dist2: d2 };
  }
  if (!best) return null;
  return {
    idx: best.idx,
    lat: atlas.pointLat[best.idx],
    lon: atlas.pointLon[best.idx],
    ix: atlas.pointIx[best.idx],
    iy: atlas.pointIy[best.idx],
    outdoorIndex: atlas.pointOutdoorIndex[best.idx],
    distMeters: Math.sqrt(best.dist2),
  };
}

// Compute CEST/CET offset for a given date: Europe/Zurich is +01 Nov-Mar, +02 Mar-Oct
function isoWithTz(date: string, time: string): string {
  // DST in 2026: starts Sun 29 Mar 02:00 CET → 03:00 CEST; ends Sun 25 Oct 03:00 CEST → 02:00 CET
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const isSummer =
    (m > 3 && m < 10) ||
    (m === 3 && d >= 29) ||
    (m === 10 && d < 25);
  const tz = isSummer ? "+02:00" : "+01:00";
  return `${date}T${time}:00${tz}`;
}

async function evaluate(target: Target, date: string): Promise<{
  tileId: string;
  total: number; matches: number; mismatches: number; missing: number;
  mismatchDirs: { cpuSunAtlasShad: number; cpuShadAtlasSun: number };
  distMeters: number;
}> {
  const lv95 = wgs84ToLv95Precise(target.lon, target.lat);
  const tileId = tileIdFor(lv95.easting, lv95.northing);

  const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
    region: target.region,
    modelVersionHash: target.modelHash,
    gridStepMeters: GRID_STEP,
    tileId,
  });
  if (atlases.length === 0) {
    return { tileId, total: 0, matches: 0, mismatches: 0, missing: 0, mismatchDirs: { cpuSunAtlasShad: 0, cpuShadAtlasSun: 0 }, distMeters: Infinity };
  }
  const picked = findClosestOutdoorPoint(atlases[0], target.lat, target.lon);
  if (!picked) {
    return { tileId, total: 0, matches: 0, mismatches: 0, missing: 0, mismatchDirs: { cpuSunAtlasShad: 0, cpuShadAtlasSun: 0 }, distMeters: Infinity };
  }

  let sharedSources;
  try {
    sharedSources = await buildSharedPointEvaluationSources({
      lv95Bounds: { minX: picked.ix - 500, minY: picked.iy - 500, maxX: picked.ix + 500, maxY: picked.iy + 500 },
    });
  } catch (e) {
    console.log(`  ${target.label.padEnd(29)}  ${tileId.padEnd(26)}  ${date}   skipped — ${(e as Error).message.slice(0, 60)}`);
    return { tileId, total: 0, matches: 0, mismatches: 0, missing: 0, mismatchDirs: { cpuSunAtlasShad: 0, cpuShadAtlasSun: 0 }, distMeters: picked.distMeters };
  }
  const context = await buildPointEvaluationContext(picked.lat, picked.lon, { sharedSources });
  if (context.insideBuilding) {
    return { tileId, total: 0, matches: 0, mismatches: 0, missing: 0, mismatchDirs: { cpuSunAtlasShad: 0, cpuShadAtlasSun: 0 }, distMeters: picked.distMeters };
  }

  const byteIdx = picked.outdoorIndex >> 3;
  const bitMask = 1 << (picked.outdoorIndex & 7);

  let total = 0, matches = 0, mismatches = 0, missing = 0;
  let cpuSunAtlasShad = 0, cpuShadAtlasSun = 0;

  for (let hour = 6; hour <= 20; hour += 1) {
    for (const min of [0, 15, 30, 45]) {
      const t = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      const utc = new Date(isoWithTz(date, t));
      const pos = SunCalc.getPosition(utc, picked.lat, picked.lon);
      const alt = pos.altitude * RAD_TO_DEG;
      if (alt <= 0) continue;
      let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
      if (az < 0) az += 360;
      total += 1;

      const cpuSample = evaluateInstantSunlight({
        lat: picked.lat, lon: picked.lon, utcDate: utc, timeZone: TIMEZONE,
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
        vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      });
      const cpuSunny = cpuSample.isSunny;

      const bucket = lookupAtlasByAngle(atlases, az, alt);
      if (!bucket) { missing += 1; continue; }
      const atlasSunny = (bucket.sunMask[byteIdx] & bitMask) !== 0;
      if (atlasSunny === cpuSunny) matches += 1;
      else {
        mismatches += 1;
        if (cpuSunny && !atlasSunny) cpuSunAtlasShad += 1;
        else cpuShadAtlasSun += 1;
      }
    }
  }
  return { tileId, total, matches, mismatches, missing, mismatchDirs: { cpuSunAtlasShad, cpuShadAtlasSun }, distMeters: picked.distMeters };
}

async function main() {
  console.log(`Multi-tile / multi-date atlas-vs-CPU audit\n`);
  console.log(
    `  target                         tile                        date        match%  mism  miss  dir(C=SUN/A=SHAD | C=SHAD/A=SUN)`,
  );
  console.log(
    `  ─────────────────────────────  ──────────────────────────  ──────────  ──────  ────  ────  ────────────────────────────────`,
  );

  const perTarget = new Map<string, { total: number; mismatches: number; missing: number; cpuShadAtlasSun: number; cpuSunAtlasShad: number }>();

  for (const target of TARGETS) {
    for (const date of DATES) {
      const r = await evaluate(target, date);
      const pct = r.total > 0 ? ((r.matches / r.total) * 100).toFixed(1) : "n/a  ";
      console.log(
        `  ${target.label.padEnd(29)}  ${r.tileId.padEnd(26)}  ${date}  ${pct.padStart(5)}%  ${String(r.mismatches).padStart(4)}  ${String(r.missing).padStart(4)}  ${String(r.mismatchDirs.cpuSunAtlasShad).padStart(4)}         | ${String(r.mismatchDirs.cpuShadAtlasSun).padStart(4)}`,
      );
      const acc = perTarget.get(target.label) ?? { total: 0, mismatches: 0, missing: 0, cpuShadAtlasSun: 0, cpuSunAtlasShad: 0 };
      acc.total += r.total;
      acc.mismatches += r.mismatches;
      acc.missing += r.missing;
      acc.cpuShadAtlasSun += r.mismatchDirs.cpuShadAtlasSun;
      acc.cpuSunAtlasShad += r.mismatchDirs.cpuSunAtlasShad;
      perTarget.set(target.label, acc);
    }
  }

  console.log(`\n══════════════════ AGGREGATE PER TARGET ══════════════════`);
  console.log(
    `  target                         total  mism  miss  mism%   dir(C=SUN/A=SHAD | C=SHAD/A=SUN)`,
  );
  for (const [label, acc] of perTarget) {
    const pct = acc.total > 0 ? ((acc.mismatches / acc.total) * 100).toFixed(1) : "n/a";
    console.log(
      `  ${label.padEnd(29)}  ${String(acc.total).padStart(5)}  ${String(acc.mismatches).padStart(4)}  ${String(acc.missing).padStart(4)}  ${pct.padStart(5)}%  ${String(acc.cpuSunAtlasShad).padStart(4)}         | ${String(acc.cpuShadAtlasSun).padStart(4)}`,
    );
  }

  console.log(`\nInterprétation :`);
  console.log(`  - mism% > 10% sur plusieurs dates → corruption systémique pour ce point`);
  console.log(`  - "C=SHAD / A=SUN" nombreux → atlas rate les ombres de bâtiment (cas Rumine avant regen)`);
  console.log(`  - "C=SUN / A=SHAD" nombreux → atlas sur-ombre (calibration ou géométrie trop conservatrice)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
