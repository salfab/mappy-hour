/**
 * Benchmark: CPU ray-trace vs GPU shadow-map backend.
 *
 * Runs both backends on the same tile (Great Escape area), same instants,
 * same grid points, using the prepareSunPosition + evaluate pattern.
 *
 * Usage:
 *   npx tsx scripts/benchmark/gpu-shadow-backend-benchmark.ts [--resolution=4096]
 */
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import SunCalc from "suncalc";

import { lv95ToWgs84 } from "@/lib/geo/projection";
import {
  buildRegionTiles,
  buildTilePoints,
} from "@/lib/precompute/sunlight-cache";
import { createUtcSamples } from "@/lib/precompute/sunlight-tile-service";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
import { DEFAULT_SHADOW_CALIBRATION } from "@/lib/sun/shadow-calibration";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";
import { CpuBuildingShadowBackend } from "@/lib/sun/cpu-building-shadow-backend";
import { GpuBuildingShadowBackend, type GpuBackendMeshInfo } from "@/lib/sun/gpu-building-shadow-backend";
import type { BuildingShadowBackend, BuildingShadowQuery } from "@/lib/sun/building-shadow-backend";

// ── Config ───────────────────────────────────────────────────────────────

const TILE_ID = "e2538000_n1152250_s250";
const DATE = "2026-03-08";
const TIMEZONE = "Europe/Zurich";
const SAMPLE_EVERY_MINUTES = 15;
const GRID_STEP_METERS = 5;
const START_LOCAL_TIME = "08:00";
const END_LOCAL_TIME = "12:00";
const TILE_SIZE_METERS = 250;
const BUILDING_LOAD_RADIUS_METERS = 2500;
const OUTPUT_DIR = path.join(process.cwd(), "docs", "progress", "benchmarks");

// ── Arg parsing ──────────────────────────────────────────────────────────

function parseArgs(): { resolution: number } {
  let resolution = 4096;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--resolution=")) {
      resolution = parseInt(arg.slice("--resolution=".length), 10);
    }
  }
  return { resolution };
}

// ── Sun positions ────────────────────────────────────────────────────────

interface SunInstant {
  utc: string;
  azimuthDeg: number;
  altitudeDeg: number;
}

function computeSunPositions(
  utcSamples: Date[],
  lat: number,
  lon: number,
): SunInstant[] {
  return utcSamples.map((utcDate) => {
    const pos = SunCalc.getPosition(utcDate, lat, lon);
    const altitudeDeg = (pos.altitude * 180) / Math.PI;
    const fromNorth = ((pos.azimuth * 180) / Math.PI + 180) % 360;
    return {
      utc: utcDate.toISOString(),
      altitudeDeg: Math.round(altitudeDeg * 100) / 100,
      azimuthDeg: Math.round((fromNorth >= 0 ? fromNorth : fromNorth + 360) * 100) / 100,
    };
  });
}

// ── Benchmark one backend ────────────────────────────────────────────────

interface BackendResults {
  totalMs: number;
  prepareTotalMs: number;
  evaluateTotalMs: number;
  perPrepareMs: number;
  perEvaluateMicros: number;
  shadowFlags: number[][]; // [pointIdx][instantIdx] = 0|1
}

function benchmarkBackend(
  backend: BuildingShadowBackend,
  sunInstants: SunInstant[],
  queries: BuildingShadowQuery[],
): BackendResults {
  const shadowFlags: number[][] = queries.map(() => []);
  let prepareTotalMs = 0;
  let evaluateTotalMs = 0;

  const totalT0 = performance.now();

  for (let si = 0; si < sunInstants.length; si++) {
    const sun = sunInstants[si];

    const prepT0 = performance.now();
    backend.prepareSunPosition(sun.azimuthDeg, sun.altitudeDeg);
    prepareTotalMs += performance.now() - prepT0;

    const evalT0 = performance.now();
    for (let pi = 0; pi < queries.length; pi++) {
      const q = queries[pi];
      if (sun.altitudeDeg <= 0) {
        shadowFlags[pi].push(0); // below horizon, not "blocked by building"
        continue;
      }
      const result = backend.evaluate({
        ...q,
        solarAzimuthDeg: sun.azimuthDeg,
        solarAltitudeDeg: sun.altitudeDeg,
      });
      shadowFlags[pi].push(result.blocked ? 1 : 0);
    }
    evaluateTotalMs += performance.now() - evalT0;
  }

  const totalMs = performance.now() - totalT0;
  const totalEvals = queries.length * sunInstants.filter((s) => s.altitudeDeg > 0).length;

  return {
    totalMs: Math.round(totalMs * 100) / 100,
    prepareTotalMs: Math.round(prepareTotalMs * 100) / 100,
    evaluateTotalMs: Math.round(evaluateTotalMs * 100) / 100,
    perPrepareMs: Math.round((prepareTotalMs / Math.max(sunInstants.length, 1)) * 100) / 100,
    perEvaluateMicros:
      Math.round((evaluateTotalMs * 1000) / Math.max(totalEvals, 1) * 100) / 100,
    shadowFlags,
  };
}

// ── Compare precision ────────────────────────────────────────────────────

interface PrecisionReport {
  total: number;
  matches: number;
  mismatches: number;
  mismatchRate: number;
  cpuShadowGpuSun: number;
  cpuSunGpuShadow: number;
}

function comparePrecision(
  cpuFlags: number[][],
  gpuFlags: number[][],
): PrecisionReport {
  let total = 0, matches = 0, cpuShadowGpuSun = 0, cpuSunGpuShadow = 0;

  for (let pi = 0; pi < cpuFlags.length; pi++) {
    for (let si = 0; si < cpuFlags[pi].length; si++) {
      total++;
      const c = cpuFlags[pi][si];
      const g = gpuFlags[pi][si];
      if (c === g) {
        matches++;
      } else if (c === 1 && g === 0) {
        cpuShadowGpuSun++;
      } else {
        cpuSunGpuShadow++;
      }
    }
  }

  return {
    total,
    matches,
    mismatches: total - matches,
    mismatchRate: total > 0 ? Math.round(((total - matches) / total) * 10000) / 100 : 0,
    cpuShadowGpuSun,
    cpuSunGpuShadow,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { resolution } = parseArgs();
  console.log(`[benchmark] GPU shadow backend benchmark (resolution=${resolution})`);

  // ── Find tile ──────────────────────────────────────────────────────
  const allTiles = buildRegionTiles("lausanne", TILE_SIZE_METERS);
  const tile = allTiles.find((t) => t.tileId === TILE_ID);
  if (!tile) throw new Error(`Tile ${TILE_ID} not found`);

  // ── UTC samples + sun positions ────────────────────────────────────
  const utcSamples = createUtcSamples(
    DATE, TIMEZONE, SAMPLE_EVERY_MINUTES, START_LOCAL_TIME, END_LOCAL_TIME,
  );
  const centerWgs84 = lv95ToWgs84(
    (tile.minEasting + tile.maxEasting) / 2,
    (tile.minNorthing + tile.maxNorthing) / 2,
  );
  const sunInstants = computeSunPositions(utcSamples, centerWgs84.lat, centerWgs84.lon);
  console.log(`[benchmark] ${sunInstants.length} time instants`);

  // ── Load buildings index ───────────────────────────────────────────
  const loadT0 = performance.now();
  const index = await loadBuildingsObstacleIndex();
  if (!index) throw new Error("Failed to load buildings index");
  const indexLoadMs = performance.now() - loadT0;
  console.log(`[benchmark] buildings index loaded in ${indexLoadMs.toFixed(0)}ms (${index.obstacles.length} obstacles)`);

  // Filter buildings within range for GPU (all for CPU since it uses spatial grid)
  const tileCenterX = (tile.minEasting + tile.maxEasting) / 2;
  const tileCenterY = (tile.minNorthing + tile.maxNorthing) / 2;
  const gpuObstacles = index.obstacles.filter((obs) => {
    const dx = obs.centerX - tileCenterX;
    const dy = obs.centerY - tileCenterY;
    return Math.hypot(dx, dy) <= BUILDING_LOAD_RADIUS_METERS;
  });
  console.log(`[benchmark] ${gpuObstacles.length} buildings within ${BUILDING_LOAD_RADIUS_METERS}m for GPU`);

  // ── Build outdoor point queries ────────────────────────────────────
  const sharedSources = await buildSharedPointEvaluationSources({
    lv95Bounds: {
      minX: tile.minEasting,
      minY: tile.minNorthing,
      maxX: tile.maxEasting,
      maxY: tile.maxNorthing,
    },
  });

  const rawPoints = buildTilePoints(tile, GRID_STEP_METERS);
  const queries: BuildingShadowQuery[] = [];

  for (const pt of rawPoints) {
    const ctx = await buildPointEvaluationContext(pt.lat, pt.lon, {
      skipTerrainSamplingWhenIndoor: true,
      shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
      sharedSources,
    });
    if (ctx.insideBuilding || ctx.pointElevationMeters === null) continue;
    queries.push({
      pointX: ctx.pointLv95.easting,
      pointY: ctx.pointLv95.northing,
      pointElevation: ctx.pointElevationMeters,
      solarAzimuthDeg: 0, // overridden per instant
      solarAltitudeDeg: 0,
    });
  }
  console.log(`[benchmark] ${queries.length} outdoor point queries`);

  // ── Create backends ────────────────────────────────────────────────
  console.log(`[benchmark] Creating CPU backend...`);
  const cpuBackend = new CpuBuildingShadowBackend(
    index.obstacles,
    index.spatialGrid,
  );

  console.log(`[benchmark] Creating GPU backend with DXF meshes (${resolution}px)...`);
  const gpuConstructT0 = performance.now();
  const gpuBackend = await GpuBuildingShadowBackend.createWithDxfMeshes(gpuObstacles, resolution);
  const gpuConstructMs = performance.now() - gpuConstructT0;
  console.log(
    `[benchmark] GPU backend: ${gpuBackend.glRenderer}, ` +
      `${gpuBackend.triangleCount} triangles (DXF: ${gpuBackend.meshInfo.dxfTriangleCount}, ` +
      `fallback: ${gpuBackend.meshInfo.fallbackTriangleCount}), ` +
      `${gpuBackend.meshInfo.dxfObstacleCount} DXF + ` +
      `${gpuBackend.meshInfo.fallbackObstacleCount} extruded obstacles, ` +
      `constructed in ${gpuConstructMs.toFixed(0)}ms`,
  );

  // Set frustum focus to the tile area — this tightens the ortho projection
  // so the shadow map concentrates resolution on the tile + shadow reach zone
  // instead of the full 5km scene.
  const maxBuildingHeight = gpuObstacles.reduce((m, o) => Math.max(m, o.height), 0);
  gpuBackend.setFrustumFocus(
    { minX: tile.minEasting, minY: tile.minNorthing, maxX: tile.maxEasting, maxY: tile.maxNorthing },
    maxBuildingHeight,
  );
  console.log(`[benchmark] Frustum focus set to tile ${tile.tileId}, maxH=${maxBuildingHeight.toFixed(1)}m`);

  // ── Run CPU benchmark ──────────────────────────────────────────────
  console.log(`[benchmark] Running CPU benchmark...`);
  const cpuResult = benchmarkBackend(cpuBackend, sunInstants, queries);
  console.log(
    `[benchmark] CPU: ${cpuResult.totalMs.toFixed(0)}ms total, ` +
      `${cpuResult.perEvaluateMicros.toFixed(1)} µs/eval`,
  );

  // ── Also collect CPU blocker info for mismatch diagnostics ─────────
  const cpuBlockerIds: (string | null)[][] = queries.map(() => []);
  const cpuBlockerDistances: (number | null)[][] = queries.map(() => []);
  for (let si = 0; si < sunInstants.length; si++) {
    const sun = sunInstants[si];
    cpuBackend.prepareSunPosition(sun.azimuthDeg, sun.altitudeDeg);
    for (let pi = 0; pi < queries.length; pi++) {
      if (sun.altitudeDeg <= 0) {
        cpuBlockerIds[pi].push(null);
        cpuBlockerDistances[pi].push(null);
        continue;
      }
      const result = cpuBackend.evaluate({
        ...queries[pi],
        solarAzimuthDeg: sun.azimuthDeg,
        solarAltitudeDeg: sun.altitudeDeg,
      });
      cpuBlockerIds[pi].push(result.blockerId);
      cpuBlockerDistances[pi].push(result.blockerDistanceMeters);
    }
  }

  // ── Run GPU benchmark ──────────────────────────────────────────────
  console.log(`[benchmark] Running GPU benchmark...`);
  const gpuResult = benchmarkBackend(gpuBackend, sunInstants, queries);
  console.log(
    `[benchmark] GPU: ${gpuResult.totalMs.toFixed(0)}ms total ` +
      `(prepare ${gpuResult.prepareTotalMs.toFixed(0)}ms + evaluate ${gpuResult.evaluateTotalMs.toFixed(0)}ms), ` +
      `${gpuResult.perEvaluateMicros.toFixed(1)} µs/eval`,
  );

  // ── Precision comparison ───────────────────────────────────────────
  const precision = comparePrecision(cpuResult.shadowFlags, gpuResult.shadowFlags);
  console.log(
    `[benchmark] Precision: ${precision.matches}/${precision.total} match ` +
      `(${(100 - precision.mismatchRate).toFixed(2)}%) — ` +
      `CPU→shadow/GPU→sun: ${precision.cpuShadowGpuSun}, ` +
      `CPU→sun/GPU→shadow: ${precision.cpuSunGpuShadow}`,
  );

  // ── Mismatch diagnostics (first 20) ────────────────────────────────
  const mismatchSamples: Array<{
    pointX: number;
    pointY: number;
    pointElevation: number;
    instant: number;
    azimuthDeg: number;
    altitudeDeg: number;
    cpuBlocked: boolean;
    gpuBlocked: boolean;
    cpuBlockerId: string | null;
    cpuBlockerDistanceMeters: number | null;
  }> = [];

  for (let pi = 0; pi < queries.length && mismatchSamples.length < 20; pi++) {
    for (let si = 0; si < sunInstants.length && mismatchSamples.length < 20; si++) {
      const c = cpuResult.shadowFlags[pi][si];
      const g = gpuResult.shadowFlags[pi][si];
      if (c !== g) {
        mismatchSamples.push({
          pointX: queries[pi].pointX,
          pointY: queries[pi].pointY,
          pointElevation: queries[pi].pointElevation,
          instant: si,
          azimuthDeg: sunInstants[si].azimuthDeg,
          altitudeDeg: sunInstants[si].altitudeDeg,
          cpuBlocked: c === 1,
          gpuBlocked: g === 1,
          cpuBlockerId: cpuBlockerIds[pi][si],
          cpuBlockerDistanceMeters: cpuBlockerDistances[pi][si],
        });
      }
    }
  }

  if (mismatchSamples.length > 0) {
    console.log(`\n[benchmark] First ${mismatchSamples.length} mismatches:`);
    for (const m of mismatchSamples) {
      console.log(
        `  (${m.pointX.toFixed(1)}, ${m.pointY.toFixed(1)}, z=${m.pointElevation.toFixed(1)}) ` +
          `t=${m.instant} az=${m.azimuthDeg}° alt=${m.altitudeDeg}° — ` +
          `CPU:${m.cpuBlocked ? "shadow" : "sun"} GPU:${m.gpuBlocked ? "shadow" : "sun"} ` +
          `blocker=${m.cpuBlockerId ?? "none"} dist=${m.cpuBlockerDistanceMeters?.toFixed(0) ?? "?"}m`,
      );
    }
  }

  // ── Speedup ────────────────────────────────────────────────────────
  const speedup = Math.round((cpuResult.totalMs / Math.max(gpuResult.totalMs, 0.01)) * 100) / 100;
  console.log(`\n[benchmark] Speedup: ${speedup}x`);

  // ── Report ─────────────────────────────────────────────────────────
  const activeInstants = sunInstants.filter((s) => s.altitudeDeg > 0).length;
  const totalEvals = queries.length * activeInstants;

  const report = {
    generatedAt: new Date().toISOString(),
    machine:
      os.hostname() +
      " (" +
      os.cpus()[0].model.trim() +
      ", " +
      Math.round(os.totalmem() / (1024 * 1024 * 1024)) +
      "GB RAM)",
    glRenderer: gpuBackend.glRenderer,
    tile: TILE_ID,
    date: DATE,
    instants: sunInstants.length,
    activeInstants,
    outdoorPoints: queries.length,
    evaluations: totalEvals,
    meshSource: gpuBackend.meshInfo.meshSource,
    cpu: {
      totalMs: cpuResult.totalMs,
      prepareTotalMs: cpuResult.prepareTotalMs,
      evaluateTotalMs: cpuResult.evaluateTotalMs,
      perPrepareSunMs: cpuResult.perPrepareMs,
      perEvaluateMicros: cpuResult.perEvaluateMicros,
      mode: "detailed",
    },
    gpu: {
      shadowMapResolution: resolution,
      totalMs: gpuResult.totalMs,
      meshLoadMs: Math.round(gpuConstructMs * 100) / 100,
      triangleCount: gpuBackend.triangleCount,
      dxfObstacleCount: gpuBackend.meshInfo.dxfObstacleCount,
      fallbackObstacleCount: gpuBackend.meshInfo.fallbackObstacleCount,
      dxfTriangleCount: gpuBackend.meshInfo.dxfTriangleCount,
      fallbackTriangleCount: gpuBackend.meshInfo.fallbackTriangleCount,
      prepareTotalMs: gpuResult.prepareTotalMs,
      perPrepareSunMs: gpuResult.perPrepareMs,
      evaluateTotalMs: gpuResult.evaluateTotalMs,
      perEvaluateMicros: gpuResult.perEvaluateMicros,
      depthBufferReadMs: gpuBackend.lastReadPixelsMs,
    },
    speedup,
    precision,
    mismatchSamples,
  };

  // ── Save ───────────────────────────────────────────────────────────
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, "gpu-shadow-backend-v5-wider-frustum-benchmark.json");
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`[benchmark] Report saved to ${outPath}`);

  // ── Cleanup ────────────────────────────────────────────────────────
  cpuBackend.dispose();
  gpuBackend.dispose();

  // Print report summary
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK RESULTS (v5 — tile-focused frustum + shadow extension)");
  console.log("=".repeat(60));
  console.log(`Machine: ${report.machine}`);
  console.log(`GL renderer: ${report.glRenderer}`);
  console.log(`Tile: ${report.tile}, ${report.outdoorPoints} outdoor points × ${report.activeInstants} instants = ${report.evaluations} evals`);
  console.log(`Mesh: ${report.gpu.dxfObstacleCount} DXF + ${report.gpu.fallbackObstacleCount} extruded = ${report.gpu.triangleCount} triangles`);
  console.log();
  console.log(`CPU (${report.cpu.mode}):`);
  console.log(`  Total: ${report.cpu.totalMs.toFixed(0)}ms`);
  console.log(`  Per evaluate: ${report.cpu.perEvaluateMicros.toFixed(1)} µs`);
  console.log();
  console.log(`GPU (shadow map ${report.gpu.shadowMapResolution}px):`);
  console.log(`  Mesh construction: ${report.gpu.meshLoadMs.toFixed(0)}ms`);
  console.log(`  Total: ${report.gpu.totalMs.toFixed(0)}ms`);
  console.log(`    prepareSunPosition: ${report.gpu.prepareTotalMs.toFixed(0)}ms (${report.gpu.perPrepareSunMs.toFixed(1)}ms/render)`);
  console.log(`    evaluate: ${report.gpu.evaluateTotalMs.toFixed(0)}ms (${report.gpu.perEvaluateMicros.toFixed(2)} µs/point)`);
  console.log(`    last readPixels: ${report.gpu.depthBufferReadMs.toFixed(1)}ms`);
  console.log();
  console.log(`Speedup: ${report.speedup}x`);
  console.log(`Precision: ${report.precision.matches}/${report.precision.total} (${(100 - report.precision.mismatchRate).toFixed(2)}%)`);
  console.log(`  CPU-shadow/GPU-sun: ${report.precision.cpuShadowGpuSun}`);
  console.log(`  CPU-sun/GPU-shadow: ${report.precision.cpuSunGpuShadow}`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
