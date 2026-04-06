/**
 * Test: does loading terrain data crash after Dawn is initialized?
 */
import { WebGpuComputeShadowBackend } from "@/lib/sun/webgpu-compute-shadow-backend";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";
import { sampleSwissTerrainElevationLv95 } from "../../src/lib/terrain/swiss-terrain";

async function main() {
  console.log("1. Creating WebGPU backend FIRST (Dawn → terrain order)...");
  const index = await loadBuildingsObstacleIndex("lausanne");
  if (!index) throw new Error("no index");
  const backend = await WebGpuComputeShadowBackend.createWithDxfMeshes(index.obstacles, 4096);
  console.log("2. Backend ready:", backend.name);

  console.log("3. Sampling terrain elevation AFTER Dawn...");
  const elev = await sampleSwissTerrainElevationLv95(2538100, 1152100);
  console.log("4. Elevation:", elev);

  console.log("5. Running evaluateBatch...");
  backend.setFrustumFocus({ minX: 2538000, minY: 1152000, maxX: 2538250, maxY: 1152250 }, 50);
  const origin = backend.getOrigin();
  const points = new Float32Array(100 * 4);
  for (let i = 0; i < 100; i++) {
    points[i * 4] = 2538100 + (i % 10) - origin.x;
    points[i * 4 + 1] = elev ?? 450;
    points[i * 4 + 2] = 1152100 + Math.floor(i / 10) - origin.y;
    points[i * 4 + 3] = 0;
  }
  const result = await backend.evaluateBatch(points, 100, 180, 45);
  let blocked = 0;
  for (const w of result) { let b = w; while (b) { blocked += b & 1; b >>>= 1; } }
  console.log("6. Batch result:", blocked, "/100 blocked");

  console.log("7. Disposing...");
  backend.dispose();
  console.log("8. Done!");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exitCode = 1;
});
