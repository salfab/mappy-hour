/**
 * Diagnostic ciblé : pourquoi des tuiles urbaines de Zurich retournent
 * 0 indoor alors que l'index buildings contient des dizaines/centaines
 * d'obstacles dedans.
 *
 * Pour 2 tuiles (1 buggée + 1 contrôle qui marche) :
 *   1. Setup GPU comme le précompute (raster, focus=tile, zenith)
 *   2. Compte indoor GPU sur la grille 1m × 1m
 *   3. Compte indoor CPU "footprint bbox" (point dans XY d'un obstacle = indoor)
 *   4. Compare
 *
 * Usage : npx tsx scripts/diag/_zurich-zenith-bug.ts
 */
import { loadBuildingsObstacleIndex } from "../../src/lib/sun/buildings-shadow";
import { GpuBuildingShadowBackend } from "../../src/lib/sun/gpu-building-shadow-backend";
import { RustWgpuVulkanShadowBackend } from "../../src/lib/sun/rust-wgpu-vulkan-shadow-backend";
import { buildRegionTiles, buildTilePoints } from "../../src/lib/precompute/sunlight-cache";
import { buildSharedPointEvaluationSources, buildPointEvaluationContext } from "../../src/lib/sun/evaluation-context";

const REGION = "zurich" as const;
const TILES = [
  { tileId: "e2683000_n1247000_s250", expect: "BUGGED (centre, 131 obstacles, 0 indoor)" },
  { tileId: "e2680250_n1246000_s250", expect: "OK (Wollishofen, 75 obstacles, 11386 indoor)" },
];

async function testTile(tileId: string, label: string) {
  console.log(`\n========== ${tileId} — ${label} ==========`);
  const tiles = buildRegionTiles(REGION, 250);
  const tile = tiles.find(t => t.tileId === tileId);
  if (!tile) throw new Error(`tile ${tileId} not in region ${REGION}`);
  const bounds = { minX: tile.minEasting, minY: tile.minNorthing, maxX: tile.maxEasting, maxY: tile.maxNorthing };

  // Load full index, count obstacles in tile
  const idx = await loadBuildingsObstacleIndex(REGION);
  if (!idx) throw new Error("no buildings index");
  const inTile = idx.obstacles.filter(o =>
    o.maxX >= bounds.minX && o.minX <= bounds.maxX &&
    o.maxY >= bounds.minY && o.minY <= bounds.maxY,
  );
  console.log(`obstacles in tile bbox: ${inTile.length}`);
  if (inTile.length > 0) {
    const sample = inTile.slice(0, 3).map(o => `(X=${o.minX.toFixed(0)}..${o.maxX.toFixed(0)} Y=${o.minY.toFixed(0)}..${o.maxY.toFixed(0)} h=${o.height.toFixed(1)})`);
    console.log(`sample: ${sample.join(" ")}`);
  }

  // CPU truth: point indoor iff its (X,Y) is inside any obstacle bbox
  const points = buildTilePoints(tile, 1);
  let cpuIndoor = 0;
  for (const p of points) {
    for (const o of inTile) {
      if (p.lv95Easting >= o.minX && p.lv95Easting <= o.maxX &&
          p.lv95Northing >= o.minY && p.lv95Northing <= o.maxY) {
        cpuIndoor++;
        break;
      }
    }
  }
  console.log(`CPU bbox-footprint indoor: ${cpuIndoor}/${points.length} (${(100 * cpuIndoor / points.length).toFixed(1)}%)`);

  // GPU as the precompute does it
  const shared = await buildSharedPointEvaluationSources({
    lv95Bounds: bounds,
    region: REGION,
    skipZenithIndoorCheck: true,
  });
  const gpu = shared.gpuShadowBackend;
  if (!gpu) {
    console.log("✗ no GPU backend available");
    return;
  }
  console.log(`GPU backend ready: ${(gpu as { name?: string }).name ?? "?"}`);

  // Same calls as the precompute
  (gpu as { prepareSunPosition: (az: number, alt: number) => void }).prepareSunPosition(0, 90);
  let gpuIndoor = 0;
  let elevSkipped = 0;
  for (const p of points) {
    const ctx = await buildPointEvaluationContext(p.lat, p.lon, {
      skipTerrainSamplingWhenIndoor: false,
      sharedSources: shared,
      skipIndoorCheck: true,
    });
    if (ctx.pointElevationMeters === null) { elevSkipped++; continue; }
    const r = (gpu as { evaluate: (a: { pointX: number; pointY: number; pointElevation: number; solarAzimuthDeg: number; solarAltitudeDeg: number }) => { blocked: boolean } }).evaluate({
      pointX: p.lv95Easting,
      pointY: p.lv95Northing,
      pointElevation: ctx.pointElevationMeters,
      solarAzimuthDeg: 0,
      solarAltitudeDeg: 90,
    });
    if (r.blocked) gpuIndoor++;
  }
  console.log(`gpu-raster (ANGLE) indoor: ${gpuIndoor}/${points.length} (${(100 * gpuIndoor / points.length).toFixed(1)}%) — elev skipped: ${elevSkipped}`);

  // Vulkan backend — test if it produces different (correct?) results
  console.log(`\n  Testing rust-wgpu-vulkan backend on same obstacles…`);
  const maxH = inTile.reduce((m, o) => Math.max(m, o.height), idx.obstacles.reduce((m, o) => Math.max(m, o.height), 0));
  // Use the same spatial filter the precompute does: 5km around tile
  const focusObstacles = idx.obstacles.filter(o =>
    o.maxX > bounds.minX - 5000 && o.minX < bounds.maxX + 5000 &&
    o.maxY > bounds.minY - 5000 && o.minY < bounds.maxY + 5000,
  );
  const vulkan = await RustWgpuVulkanShadowBackend.createWithDxfMeshes(focusObstacles, 4096);
  vulkan.setFrustumFocus(bounds, maxH);
  const vkOrigin = vulkan.getOrigin();
  const vkPoints = new Float32Array(points.length * 4);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const ctx = await buildPointEvaluationContext(p.lat, p.lon, { sharedSources: shared, skipIndoorCheck: true });
    vkPoints[i * 4 + 0] = p.lv95Easting - vkOrigin.x;
    vkPoints[i * 4 + 1] = ctx.pointElevationMeters ?? 0;
    vkPoints[i * 4 + 2] = p.lv95Northing - vkOrigin.y;
    vkPoints[i * 4 + 3] = 0;
  }
  const vkMask = await vulkan.evaluateBatch(vkPoints, points.length, 0, 90);
  let vkIndoor = 0;
  for (let i = 0; i < points.length; i++) {
    if ((vkMask[i >> 5] & (1 << (i & 31))) !== 0) vkIndoor++;
  }
  console.log(`rust-wgpu-vulkan indoor:   ${vkIndoor}/${points.length} (${(100 * vkIndoor / points.length).toFixed(1)}%)`);
  await vulkan.shutdown();

  // Summary
  console.log(`\n  Summary vs CPU bbox truth (${cpuIndoor}):`);
  console.log(`    gpu-raster:        delta=${gpuIndoor - cpuIndoor} (${(100 * gpuIndoor / cpuIndoor).toFixed(1)}% recall)`);
  console.log(`    rust-wgpu-vulkan:  delta=${vkIndoor - cpuIndoor} (${(100 * vkIndoor / cpuIndoor).toFixed(1)}% recall)`);
}

async function main() {
  for (const t of TILES) {
    await testTile(t.tileId, t.expect);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
