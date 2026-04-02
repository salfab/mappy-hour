/**
 * CPU baseline benchmark for building shadow evaluation.
 *
 * Runs the existing `evaluateBuildingsShadow` on tile e2538000_n1152250_s250
 * (Great Escape area), date 2026-03-08, 08:00–12:00 every 15 min (16 instants).
 *
 * Outputs a JSON report with timing + per-point sun/shadow results for
 * comparison with the GPU shadow-map benchmark.
 */
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import path from "node:path";

import SunCalc from "suncalc";

import { lv95ToWgs84 } from "@/lib/geo/projection";
import {
  buildRegionTiles,
  buildTilePoints,
  type RegionTileSpec,
} from "@/lib/precompute/sunlight-cache";
import { createUtcSamples } from "@/lib/precompute/sunlight-tile-service";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
import { DEFAULT_SHADOW_CALIBRATION } from "@/lib/sun/shadow-calibration";

const TILE_ID = "e2538000_n1152250_s250";
const DATE = "2026-03-08";
const TIMEZONE = "Europe/Zurich";
const SAMPLE_EVERY_MINUTES = 15;
const GRID_STEP_METERS = 5;
const START_LOCAL_TIME = "08:00";
const END_LOCAL_TIME = "12:00";
const TILE_SIZE_METERS = 250;

const OUTPUT_DIR = path.join(process.cwd(), "docs", "progress", "benchmarks");

interface PointShadowResult {
  /** LV95 easting */
  x: number;
  /** LV95 northing */
  y: number;
  /** 0 = sunny, 1 = blocked by buildings */
  shadow: number[];
}

async function main() {
  // ── Find the target tile ──────────────────────────────────────────────
  const allTiles = buildRegionTiles("lausanne", TILE_SIZE_METERS);
  const tile = allTiles.find((t) => t.tileId === TILE_ID);
  if (!tile) {
    throw new Error(`Tile ${TILE_ID} not found among ${allTiles.length} tiles`);
  }
  console.log(`[cpu-baseline] tile ${tile.tileId}`);

  // ── UTC samples ───────────────────────────────────────────────────────
  const utcSamples = createUtcSamples(
    DATE,
    TIMEZONE,
    SAMPLE_EVERY_MINUTES,
    START_LOCAL_TIME,
    END_LOCAL_TIME,
  );
  console.log(`[cpu-baseline] ${utcSamples.length} time instants`);

  // ── Shared sources ────────────────────────────────────────────────────
  const sharedT0 = performance.now();
  const sharedSources = await buildSharedPointEvaluationSources({
    lv95Bounds: {
      minX: tile.minEasting,
      minY: tile.minNorthing,
      maxX: tile.maxEasting,
      maxY: tile.maxNorthing,
    },
  });
  const sharedLoadMs = performance.now() - sharedT0;
  console.log(`[cpu-baseline] shared sources loaded in ${sharedLoadMs.toFixed(0)}ms`);

  // ── Grid points ───────────────────────────────────────────────────────
  const allPoints = buildTilePoints(tile, GRID_STEP_METERS);
  console.log(`[cpu-baseline] ${allPoints.length} grid points`);

  // ── Build point evaluation contexts (filters indoor points) ───────────
  const contextT0 = performance.now();
  const outdoorPoints: Array<{
    x: number;
    y: number;
    lat: number;
    lon: number;
    buildingShadowEvaluator: (sample: {
      azimuthDeg: number;
      altitudeDeg: number;
    }) => { blocked: boolean };
  }> = [];

  for (const pt of allPoints) {
    const ctx = await buildPointEvaluationContext(pt.lat, pt.lon, {
      skipTerrainSamplingWhenIndoor: true,
      shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
      sharedSources,
    });
    if (ctx.insideBuilding || !ctx.buildingShadowEvaluator) continue;
    outdoorPoints.push({
      x: pt.lv95Easting,
      y: pt.lv95Northing,
      lat: pt.lat,
      lon: pt.lon,
      buildingShadowEvaluator: ctx.buildingShadowEvaluator,
    });
  }
  const contextMs = performance.now() - contextT0;
  console.log(
    `[cpu-baseline] ${outdoorPoints.length} outdoor points prepared in ${contextMs.toFixed(0)}ms`,
  );

  // ── Compute sun positions for each instant ────────────────────────────
  const centerWgs84 = lv95ToWgs84(
    (tile.minEasting + tile.maxEasting) / 2,
    (tile.minNorthing + tile.maxNorthing) / 2,
  );
  const sunPositions = utcSamples.map((utcDate) => {
    const pos = SunCalc.getPosition(utcDate, centerWgs84.lat, centerWgs84.lon);
    const altitudeDeg = (pos.altitude * 180) / Math.PI;
    const fromNorth = ((pos.azimuth * 180) / Math.PI + 180) % 360;
    const azimuthDeg = fromNorth >= 0 ? fromNorth : fromNorth + 360;
    return { utcDate, altitudeDeg, azimuthDeg };
  });

  // ── Run CPU benchmark ─────────────────────────────────────────────────
  const results: PointShadowResult[] = [];
  let totalEvaluations = 0;
  const evalT0 = performance.now();

  for (const pt of outdoorPoints) {
    const shadow: number[] = [];
    for (const sun of sunPositions) {
      if (sun.altitudeDeg <= 0) {
        shadow.push(1);
        continue;
      }
      const result = pt.buildingShadowEvaluator({
        azimuthDeg: sun.azimuthDeg,
        altitudeDeg: sun.altitudeDeg,
      });
      shadow.push(result.blocked ? 1 : 0);
      totalEvaluations += 1;
    }
    results.push({ x: pt.x, y: pt.y, shadow });
  }
  const evalMs = performance.now() - evalT0;
  console.log(
    `[cpu-baseline] ${totalEvaluations} evaluations in ${evalMs.toFixed(0)}ms ` +
      `(${((evalMs * 1000) / Math.max(totalEvaluations, 1)).toFixed(1)} µs/eval)`,
  );

  // ── Save results ──────────────────────────────────────────────────────
  const report = {
    generatedAt: new Date().toISOString(),
    tile: TILE_ID,
    date: DATE,
    gridStepMeters: GRID_STEP_METERS,
    instants: utcSamples.length,
    gridPoints: allPoints.length,
    outdoorPoints: outdoorPoints.length,
    evaluations: totalEvaluations,
    sharedLoadMs: Math.round(sharedLoadMs),
    contextBuildMs: Math.round(contextMs),
    evaluationMs: Math.round(evalMs),
    perEvaluationMicros:
      Math.round((evalMs * 1000) / Math.max(totalEvaluations, 1) * 100) / 100,
    sunPositions: sunPositions.map((s) => ({
      utc: s.utcDate.toISOString(),
      azimuthDeg: Math.round(s.azimuthDeg * 100) / 100,
      altitudeDeg: Math.round(s.altitudeDeg * 100) / 100,
    })),
    pointResults: results,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, "cpu-vs-gpu-cpu-baseline.json");
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`[cpu-baseline] report saved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
