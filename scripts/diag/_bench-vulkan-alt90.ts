/**
 * Bench Vulkan evaluateBatch at varying altitudes to isolate the zenith bug.
 *
 * Setup: 1 point placed INSIDE a known building footprint (below its roof).
 * Expected: blocked=true at all altitudes where the sun can reach the point
 *          (e.g. alt=90 zenith with roof above → blocked=true).
 * If the shader works for alt=45..85 but fails at alt>=86 (threshold in the
 * "up vector" branch), we've confirmed the bug is in the look_at matrix at
 * zenith (up = (0,0,-1) mirrors the Y axis).
 */
import { loadBuildingsObstacleIndex } from "../../src/lib/sun/buildings-shadow";
import { RustWgpuVulkanShadowBackend } from "../../src/lib/sun/rust-wgpu-vulkan-shadow-backend";

async function main() {
  const buildings = await loadBuildingsObstacleIndex();
  if (!buildings) {
    console.log("No buildings index available");
    return;
  }

  // Pick one tall building in Lausanne (Beau-Rivage, Gare, whatever) — any
  // obstacle whose centroid is inside its own footprint will do.
  // Sort by height descending, pick the first.
  const tall = [...buildings.obstacles]
    .filter((o) => o.height > 15)
    .sort((a, b) => b.height - a.height)
    .slice(0, 1)[0];
  if (!tall) {
    console.log("No tall building");
    return;
  }
  const cx = (tall.minX + tall.maxX) / 2;
  const cy = (tall.minY + tall.maxY) / 2;
  console.log(`Test building: centroid=(${cx.toFixed(1)}, ${cy.toFixed(1)}) height=${tall.height.toFixed(1)}m`);

  // Use small obstacle set for fast startup: filter by 500m radius from the test point
  const filtered = buildings.obstacles.filter(
    (o) =>
      o.maxX > cx - 500 &&
      o.minX < cx + 500 &&
      o.maxY > cy - 500 &&
      o.minY < cy + 500,
  );
  console.log(`Filtered ${filtered.length}/${buildings.obstacles.length} obstacles within 500m`);

  const backend = await RustWgpuVulkanShadowBackend.createWithDxfMeshes(filtered);
  const origin = backend.getOrigin();

  // Point positioned at the centroid with elevation 5m below the roof.
  // vec4f layout: [x_centered, elevation, z_centered, 0]
  const pointElevation = tall.minZ + 3; // 3m above footprint floor (well below roof)
  const points = new Float32Array([
    cx - origin.x,
    pointElevation,
    cy - origin.y,
    0,
  ]);

  backend.setFrustumFocus(
    { minX: cx - 250, minY: cy - 250, maxX: cx + 250, maxY: cy + 250 },
    tall.height,
  );

  console.log("\nazimuth=0°, varying altitude:");
  for (const alt of [45, 70, 80, 84, 85, 86, 89, 89.9, 90]) {
    const mask = await backend.evaluateBatch(points, 1, 0, alt);
    const blocked = (mask[0] & 1) === 1;
    console.log(`  alt=${alt.toString().padEnd(4)}° → blocked=${blocked ? "YES" : "no "}  (mask=${mask[0]})`);
  }

  await backend.shutdown();
}
main().catch((e) => { console.error(e); process.exit(1); });
