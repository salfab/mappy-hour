/**
 * Diagnostic: compare l'atlas précomputé vs le ray tracing CPU (golden)
 * sur un point du Palais de Rumine, toutes les 15 min sur 2026-04-22.
 *
 * Si divergences → tuile corrompue → regénérer avec precompute:all-regions:vulkan
 * Usage: pnpm tsx scripts/diag/check-rumine-atlas-vs-cpu.ts
 */
import SunCalc from "suncalc";

import { wgs84ToLv95 } from "../../src/lib/geo/projection";
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

const REGION = "lausanne";
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const TIMEZONE = "Europe/Zurich";
const DATE = "2026-04-22";

// Plusieurs points autour du Palais de Rumine pour détecter une corruption
// géographiquement localisée. Le côté nord devrait être quasi toujours à
// l'ombre en avril, le côté sud (Riponne) au soleil presque toute la journée.
const CANDIDATES: Array<{ label: string; lat: number; lon: number }> = [
  { label: "Rumine sud (place Riponne)", lat: 46.5229, lon: 6.6328 },
  { label: "Rumine nord (côté université)", lat: 46.52325, lon: 6.6330 },
  { label: "Rumine est", lat: 46.5231, lon: 6.6334 },
  { label: "Rumine ouest", lat: 46.5231, lon: 6.6323 },
  { label: "Riponne centre", lat: 46.52305, lon: 6.6327 },
];

const RAD_TO_DEG = 180 / Math.PI;

function tileIdFor(easting: number, northing: number, size = 250): string {
  const e = Math.floor(easting / size) * size;
  const n = Math.floor(northing / size) * size;
  return `e${e}_n${n}_s${size}`;
}

function findClosestOutdoorPoint(atlas: BinaryTileAtlas, targetLat: number, targetLon: number): {
  idx: number;
  lat: number;
  lon: number;
  ix: number;
  iy: number;
  outdoorIndex: number;
  distMeters: number;
} | null {
  let best: { idx: number; dist2: number } | null = null;
  const target = wgs84ToLv95(targetLon, targetLat);
  for (let i = 0; i < atlas.pointCount; i++) {
    const flags = atlas.pointFlags[i];
    const outdoorIdx = atlas.pointOutdoorIndex[i];
    const insideBuilding = (flags & 1) !== 0 || outdoorIdx < 0;
    if (insideBuilding) continue;
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

async function evaluateCandidate(
  candidate: { label: string; lat: number; lon: number },
  atlases: BinaryTileAtlas[],
): Promise<{ matches: number; mismatches: number; missing: number; total: number; firstMismatches: string[] }> {
  const RUMINE_LAT = candidate.lat;
  const RUMINE_LON = candidate.lon;

  console.log(`\n════════════════ ${candidate.label} ════════════════`);
  console.log(`  target WGS84=(${RUMINE_LAT}, ${RUMINE_LON})`);

  // Use the finest-resolution atlas for the point index (same meta across resolutions).
  const pointAtlas = atlases[0];
  const picked = findClosestOutdoorPoint(pointAtlas, RUMINE_LAT, RUMINE_LON);
  if (!picked) {
    console.error("  No outdoor point found in atlas.");
    return { matches: 0, mismatches: 0, missing: 0, total: 0, firstMismatches: [] };
  }
  console.log(
    `  nearest outdoor atlas idx=${picked.idx} outdoorIdx=${picked.outdoorIndex}\n` +
    `  LV95=(${picked.ix}, ${picked.iy})  WGS84=(${picked.lat.toFixed(6)}, ${picked.lon.toFixed(6)})\n` +
    `  dist from target=${picked.distMeters.toFixed(2)}m`,
  );

  // Build CPU golden evaluator for this exact point.
  const sharedSources = await buildSharedPointEvaluationSources({
    lv95Bounds: {
      minX: picked.ix - 50, minY: picked.iy - 50,
      maxX: picked.ix + 50, maxY: picked.iy + 50,
    },
  });
  const context = await buildPointEvaluationContext(picked.lat, picked.lon, { sharedSources });
  if (context.insideBuilding) {
    console.error("  WARNING: CPU context reports insideBuilding=true — skipping");
    return { matches: 0, mismatches: 0, missing: 0, total: 0, firstMismatches: [] };
  }

  const byteIdx = picked.outdoorIndex >> 3;
  const bitMask = 1 << (picked.outdoorIndex & 7);

  const verbose = process.env.VERBOSE === "1";
  if (verbose) {
    console.log(`  local  az°     alt°   | CPU  | atlas | match? | bucket(azB,altB)`);
  }

  let totalFrames = 0;
  let matchCount = 0;
  let mismatchCount = 0;
  let atlasMissingCount = 0;
  const mismatches: Array<{
    t: string; az: number; alt: number; cpu: boolean; atlas: boolean | "missing";
  }> = [];

  // 2026-04-22 in Europe/Zurich = CEST (+02:00)
  for (let hour = 6; hour <= 20; hour += 1) {
    for (const min of [0, 15, 30, 45]) {
      const t = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      const utc = new Date(`${DATE}T${t}:00+02:00`);
      const pos = SunCalc.getPosition(utc, picked.lat, picked.lon);
      const alt = pos.altitude * RAD_TO_DEG;
      let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
      if (az < 0) az += 360;
      if (alt <= 0) continue;
      totalFrames += 1;

      // CPU golden
      const cpuSample = evaluateInstantSunlight({
        lat: picked.lat,
        lon: picked.lon,
        utcDate: utc,
        timeZone: TIMEZONE,
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
        vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      });
      const cpuSunny = cpuSample.isSunny;

      // Atlas
      const bucket = lookupAtlasByAngle(atlases, az, alt);
      let atlasSunny: boolean | "missing" = "missing";
      let azB = -1, altB = -1;
      if (bucket) {
        azB = bucket.azBucket;
        altB = bucket.altBucket;
        atlasSunny = (bucket.sunMask[byteIdx] & bitMask) !== 0;
      } else {
        atlasMissingCount += 1;
      }

      const match =
        atlasSunny === "missing"
          ? "MISS"
          : atlasSunny === cpuSunny
          ? "✓"
          : "✗";
      if (atlasSunny !== "missing") {
        if (atlasSunny === cpuSunny) matchCount += 1;
        else {
          mismatchCount += 1;
          mismatches.push({ t, az, alt, cpu: cpuSunny, atlas: atlasSunny });
        }
      }

      if (verbose) {
        const cpuStr = cpuSunny ? "SUN " : "SHAD";
        const atlasStr = atlasSunny === "missing" ? "----" : atlasSunny ? "SUN " : "SHAD";
        console.log(
          `  ${t}  ${az.toFixed(2).padStart(6)}  ${alt.toFixed(2).padStart(6)} │ ${cpuStr} │ ${atlasStr}  │  ${match.padEnd(4)}  │ (${azB},${altB})`,
        );
      }
    }
  }

  console.log(`\n  Summary: match=${matchCount}/${totalFrames} (${((matchCount / totalFrames) * 100).toFixed(1)}%), mismatch=${mismatchCount}, missing=${atlasMissingCount}`);
  if (mismatches.length > 0) {
    console.log(`  First mismatches:`);
    for (const m of mismatches.slice(0, 5)) {
      console.log(
        `    ${m.t}  az=${m.az.toFixed(1)}° alt=${m.alt.toFixed(1)}°  CPU=${m.cpu ? "SUN" : "SHAD"}  atlas=${m.atlas ? "SUN" : "SHAD"}`,
      );
    }
  }

  return {
    matches: matchCount,
    mismatches: mismatchCount,
    missing: atlasMissingCount,
    total: totalFrames,
    firstMismatches: mismatches.slice(0, 5).map((m) => `${m.t} (CPU=${m.cpu ? "SUN" : "SHAD"}, atlas=${m.atlas ? "SUN" : "SHAD"})`),
  };
}

async function main() {
  const lv95 = wgs84ToLv95(CANDIDATES[0].lon, CANDIDATES[0].lat);
  const tileId = tileIdFor(lv95.easting, lv95.northing);
  console.log(`tileId=${tileId} (all candidates must share this tile)\n`);

  const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
    region: REGION as never,
    modelVersionHash: MODEL_HASH,
    gridStepMeters: GRID_STEP,
    tileId,
  });
  if (atlases.length === 0) {
    console.error(`ATLAS NOT FOUND for tile ${tileId}`);
    return;
  }
  console.log(`Loaded ${atlases.length} atlas(es): ${atlases.map((a) => `r${a.resolutionDegAz}°`).join(", ")}`);

  const results: Array<{ label: string; matches: number; mismatches: number; missing: number; total: number }> = [];
  for (const cand of CANDIDATES) {
    const r = await evaluateCandidate(cand, atlases);
    results.push({ label: cand.label, ...r });
  }

  console.log(`\n\n══════════════════ GLOBAL SUMMARY ══════════════════`);
  console.log(`  label                                 match%   mism   miss`);
  for (const r of results) {
    const pct = r.total > 0 ? ((r.matches / r.total) * 100).toFixed(1) : "--";
    console.log(
      `  ${r.label.padEnd(38)}  ${pct.padStart(5)}%   ${String(r.mismatches).padStart(4)}   ${String(r.missing).padStart(4)}`,
    );
  }

  const worst = results.reduce((acc, r) => (r.total > 0 && r.mismatches / r.total > acc.pct ? { label: r.label, pct: r.mismatches / r.total } : acc), { label: "", pct: 0 });
  if (worst.pct > 0.05) {
    console.log(`\n⚠ CORRUPTION SUSPECTED — worst point: ${worst.label} (${(worst.pct * 100).toFixed(1)}% mismatches)`);
  } else {
    console.log(`\n✓ Atlas coherent with CPU golden across all candidates (worst ${(worst.pct * 100).toFixed(1)}%)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
