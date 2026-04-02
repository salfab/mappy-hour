/**
 * GPU shadow map benchmark harness.
 *
 * Uses Playwright to open gpu-shadowmap.html with real building data,
 * runs the Three.js raycasting benchmark, and collects results.
 */
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";
import SunCalc from "suncalc";

import { lv95ToWgs84 } from "@/lib/geo/projection";
import {
  buildRegionTiles,
  buildTilePoints,
} from "@/lib/precompute/sunlight-cache";
import { createUtcSamples } from "@/lib/precompute/sunlight-tile-service";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";

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
const HTML_PATH = path.join(__dirname, "gpu-shadowmap.html");

async function main() {
  const shadowMapResolution = parseInt(process.argv[2] || "4096", 10);
  console.log(`[gpu-harness] shadow map resolution: ${shadowMapResolution}`);

  // ── Find the target tile ──────────────────────────────────────────────
  const allTiles = buildRegionTiles("lausanne", TILE_SIZE_METERS);
  const tile = allTiles.find((t) => t.tileId === TILE_ID);
  if (!tile) throw new Error(`Tile ${TILE_ID} not found`);

  // ── UTC samples + sun positions ───────────────────────────────────────
  const utcSamples = createUtcSamples(
    DATE, TIMEZONE, SAMPLE_EVERY_MINUTES, START_LOCAL_TIME, END_LOCAL_TIME,
  );
  const centerWgs84 = lv95ToWgs84(
    (tile.minEasting + tile.maxEasting) / 2,
    (tile.minNorthing + tile.maxNorthing) / 2,
  );
  const sunPositions = utcSamples.map((utcDate) => {
    const pos = SunCalc.getPosition(utcDate, centerWgs84.lat, centerWgs84.lon);
    const altitudeDeg = (pos.altitude * 180) / Math.PI;
    const fromNorth = ((pos.azimuth * 180) / Math.PI + 180) % 360;
    return {
      utc: utcDate.toISOString(),
      altitudeDeg: Math.round(altitudeDeg * 100) / 100,
      azimuthDeg: Math.round((fromNorth >= 0 ? fromNorth : fromNorth + 360) * 100) / 100,
    };
  });
  console.log(`[gpu-harness] ${sunPositions.length} time instants`);

  // ── Grid points (outdoor only from buildTilePoints) ───────────────────
  const rawPoints = buildTilePoints(tile, GRID_STEP_METERS);
  const gridPoints = rawPoints.map((p) => ({
    x: p.lv95Easting,
    y: p.lv95Northing,
  }));
  console.log(`[gpu-harness] ${gridPoints.length} grid points`);

  // ── Load buildings near the tile ──────────────────────────────────────
  const loadT0 = performance.now();
  const index = await loadBuildingsObstacleIndex();
  if (!index) throw new Error("Failed to load buildings index");

  const tileCenterX = (tile.minEasting + tile.maxEasting) / 2;
  const tileCenterY = (tile.minNorthing + tile.maxNorthing) / 2;
  const nearbyBuildings = index.obstacles.filter((obs) => {
    const dx = obs.centerX - tileCenterX;
    const dy = obs.centerY - tileCenterY;
    return Math.hypot(dx, dy) <= BUILDING_LOAD_RADIUS_METERS;
  });
  const buildingsLoadMs = performance.now() - loadT0;
  console.log(
    `[gpu-harness] ${nearbyBuildings.length} buildings within ${BUILDING_LOAD_RADIUS_METERS}m ` +
      `(loaded in ${buildingsLoadMs.toFixed(0)}ms)`,
  );

  // ── Serialize buildings for the HTML page ─────────────────────────────
  const buildingsForGpu = nearbyBuildings.map((obs) => ({
    id: obs.id,
    footprint: obs.footprint,
    height: obs.height,
    minZ: obs.minZ,
    centerX: obs.centerX,
    centerY: obs.centerY,
  }));

  const tileOrigin = { x: tileCenterX, y: tileCenterY };

  // ── Launch Playwright ─────────────────────────────────────────────────
  console.log(`[gpu-harness] launching browser...`);
  const browser = await chromium.launch({
    headless: false, // need GPU access
    args: [
      "--enable-webgl",
      "--use-gl=angle",
      "--enable-gpu",
      "--no-sandbox",
    ],
  });

  const page = await browser.newPage();

  // Inject config before the page loads
  await page.addInitScript({
    content: `window.__GPU_BENCH_CONFIG = ${JSON.stringify({
      buildings: buildingsForGpu,
      sunPositions,
      gridPoints,
      shadowMapResolution,
      tileOrigin,
    })};`,
  });

  const htmlUrl = `file:///${HTML_PATH.replace(/\\/g, "/")}`;
  console.log(`[gpu-harness] navigating to ${htmlUrl}`);
  await page.goto(htmlUrl);

  // Wait for the page to finish (title becomes "DONE" or "ERROR")
  console.log(`[gpu-harness] waiting for GPU benchmark to complete...`);
  await page.waitForFunction(
    () => document.title === "DONE" || document.title.startsWith("ERROR"),
    { timeout: 300_000 },
  );

  const title = await page.title();
  if (title.startsWith("ERROR")) {
    const result = await page.evaluate(() => (window as any).__GPU_BENCH_RESULT);
    console.error("[gpu-harness] GPU benchmark failed:", result?.error);
    await browser.close();
    process.exit(1);
  }

  // ── Collect results ───────────────────────────────────────────────────
  const gpuResult = await page.evaluate(() => (window as any).__GPU_BENCH_RESULT);
  await browser.close();

  console.log(`[gpu-harness] GPU: ${gpuResult.gpuRenderer}`);
  console.log(
    `[gpu-harness] ${gpuResult.meshCount} meshes, ` +
      `total ${gpuResult.totalMs.toFixed(0)}ms`,
  );

  // ── Save ──────────────────────────────────────────────────────────────
  const report = {
    generatedAt: new Date().toISOString(),
    tile: TILE_ID,
    date: DATE,
    gridStepMeters: GRID_STEP_METERS,
    instants: sunPositions.length,
    gridPoints: gridPoints.length,
    shadowMapResolution,
    buildingsLoaded: nearbyBuildings.length,
    buildingsLoadMs: Math.round(buildingsLoadMs),
    ...gpuResult,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    `cpu-vs-gpu-gpu-shadowmap-${shadowMapResolution}.json`,
  );
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`[gpu-harness] report saved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
