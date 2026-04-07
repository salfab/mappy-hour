/**
 * Isolated test: render zenith shadow map and output indoor/outdoor mask
 * as an HTML visualization for the cathedral area.
 *
 * Usage:
 *   MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster npx tsx scripts/tools/zenith-footprint-test.ts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { loadBuildingsObstacleIndex } from "../../src/lib/sun/buildings-shadow";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";

async function main() {
  // Cathedral area in LV95
  const centerX = 2538350;
  const centerY = 1152720;
  const halfSize = 80; // 80m radius = 160m x 160m
  const step = 1; // 1m grid

  const minX = centerX - halfSize;
  const maxX = centerX + halfSize;
  const minY = centerY - halfSize;
  const maxY = centerY + halfSize;
  const width = Math.ceil((maxX - minX) / step);
  const height = Math.ceil((maxY - minY) / step);

  console.log(`[zenith-test] Grid: ${width}x${height} = ${width * height} points`);
  console.log(`[zenith-test] Area: LV95 ${minX},${minY} → ${maxX},${maxY}`);

  // Load buildings and create GPU backend
  console.log(`[zenith-test] Loading buildings index...`);
  const index = await loadBuildingsObstacleIndex();
  if (!index) throw new Error("No buildings index");

  console.log(`[zenith-test] Creating GPU backend (${index.obstacles.length} obstacles)...`);
  const { GpuBuildingShadowBackend } = await import("../../src/lib/sun/gpu-building-shadow-backend");
  const backend = await GpuBuildingShadowBackend.createWithDxfMeshes(index.obstacles, 4096);
  console.log(`[zenith-test] Backend ready: ${backend.name}`);

  // Set frustum focus on our area
  backend.setFrustumFocus({ minX, minY, maxX, maxY }, 80);

  // Render zenith shadow map
  console.log(`[zenith-test] Rendering zenith shadow map...`);
  const t0 = performance.now();
  backend.prepareSunPosition(0, 89.999);
  console.log(`[zenith-test] Shadow map rendered in ${(performance.now() - t0).toFixed(0)}ms`);

  // Sample terrain elevation (use a fixed elevation for simplicity)
  // Cathedral area is around 500m altitude
  const groundElevation = 500;

  // Evaluate each point
  console.log(`[zenith-test] Evaluating ${width * height} points...`);
  const indoor: boolean[] = new Array(width * height);
  let indoorCount = 0;

  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const easting = minX + ix * step + step / 2;
      const northing = minY + iy * step + step / 2;
      const result = backend.evaluate({
        pointX: easting,
        pointY: northing,
        pointElevation: groundElevation,
        solarAzimuthDeg: 0,
        solarAltitudeDeg: 89.999,
      });
      const idx = iy * width + ix;
      indoor[idx] = result.blocked;
      if (result.blocked) indoorCount++;
    }
  }

  console.log(`[zenith-test] Indoor: ${indoorCount}, Outdoor: ${width * height - indoorCount}`);

  // Also do convex hull check for comparison
  const { findContainingBuilding } = await import("../../src/lib/sun/buildings-shadow");
  let hullIndoorCount = 0;
  const hullIndoor: boolean[] = new Array(width * height);
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const easting = minX + ix * step + step / 2;
      const northing = minY + iy * step + step / 2;
      const result = findContainingBuilding(
        index.obstacles, easting, northing, index.spatialGrid,
      );
      const idx = iy * width + ix;
      hullIndoor[idx] = result.insideBuilding;
      if (result.insideBuilding) hullIndoorCount++;
    }
  }
  console.log(`[zenith-test] Convex hull indoor: ${hullIndoorCount}`);

  // Generate HTML visualization
  const outputDir = path.join(process.cwd(), "data", "tmp");
  await fs.mkdir(outputDir, { recursive: true });
  const htmlPath = path.join(outputDir, "zenith-footprint.html");

  const sw = lv95ToWgs84(minX, minY);
  const ne = lv95ToWgs84(maxX, maxY);

  await fs.writeFile(htmlPath, `<!DOCTYPE html>
<html><head><title>Zenith Footprint - Cathedral</title>
<style>
  body { margin: 0; background: #1a1a2e; color: #eee; font: 14px monospace; display: flex; flex-direction: column; align-items: center; }
  h2 { margin: 10px 0 5px; }
  .row { display: flex; gap: 20px; }
  canvas { border: 1px solid #444; image-rendering: pixelated; }
  .label { text-align: center; font-size: 12px; margin-top: 4px; }
</style></head><body>
<h2>Cathédrale de Lausanne — Indoor Detection Comparison</h2>
<p>Grid: ${width}×${height} (${step}m), elevation: ${groundElevation}m, LV95: ${minX}-${maxX}, ${minY}-${maxY}</p>
<div class="row">
  <div>
    <canvas id="zenith" width="${width}" height="${height}" style="width:${width*3}px;height:${height*3}px"></canvas>
    <div class="label">Zenith Shadow Map (real DXF mesh)<br>Indoor: ${indoorCount} (${(indoorCount/(width*height)*100).toFixed(1)}%)</div>
  </div>
  <div>
    <canvas id="hull" width="${width}" height="${height}" style="width:${width*3}px;height:${height*3}px"></canvas>
    <div class="label">Convex Hull Footprint (index)<br>Indoor: ${hullIndoorCount} (${(hullIndoorCount/(width*height)*100).toFixed(1)}%)</div>
  </div>
  <div>
    <canvas id="diff" width="${width}" height="${height}" style="width:${width*3}px;height:${height*3}px"></canvas>
    <div class="label">Difference (green=zenith only, red=hull only)</div>
  </div>
</div>
<script>
const w = ${width}, h = ${height};
const zenith = ${JSON.stringify(indoor)};
const hull = ${JSON.stringify(hullIndoor)};

function draw(canvasId, data, colorFn) {
  const c = document.getElementById(canvasId);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      // Flip Y: iy=0 is south in data, but top in canvas
      const dataIdx = iy * w + ix;
      const canvasIdx = ((h - 1 - iy) * w + ix) * 4;
      const [r, g, b] = colorFn(dataIdx);
      img.data[canvasIdx] = r;
      img.data[canvasIdx+1] = g;
      img.data[canvasIdx+2] = b;
      img.data[canvasIdx+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

draw('zenith', zenith, i => zenith[i] ? [60, 60, 80] : [220, 200, 120]);
draw('hull', hull, i => hull[i] ? [60, 60, 80] : [220, 200, 120]);
draw('diff', null, i => {
  const z = zenith[i], h = hull[i];
  if (z && !h) return [0, 200, 100]; // zenith=indoor, hull=outdoor (green)
  if (!z && h) return [220, 60, 60]; // zenith=outdoor, hull=indoor (red = recovered by zenith)
  if (z && h) return [60, 60, 80];   // both indoor
  return [180, 180, 160];            // both outdoor
});
</script>
</body></html>`);

  console.log(`[zenith-test] Wrote ${htmlPath}`);
  backend.dispose();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
