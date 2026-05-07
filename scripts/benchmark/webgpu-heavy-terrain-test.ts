import { WebGpuComputeShadowBackend } from "@/lib/sun/webgpu-compute-shadow-backend";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";
import { sampleSwissTerrainElevationLv95 } from "@/lib/terrain/swiss-terrain";

async function main() {
  // Load MANY terrain points to fill the terrain tile cache
  console.log("1. Loading 1000 terrain points...");
  for (let i = 0; i < 1000; i++) {
    await sampleSwissTerrainElevationLv95(2537800 + (i % 50) * 10, 1152000 + Math.floor(i / 50) * 10);
  }
  console.log("2. Terrain cached. RSS:", (process.memoryUsage().rss / 1024 / 1024).toFixed(0), "MB");

  console.log("3. Creating Dawn backend...");
  const index = await loadBuildingsObstacleIndex("lausanne");
  if (!index) throw new Error("no index");
  const backend = await WebGpuComputeShadowBackend.createWithDxfMeshes(index.obstacles, 4096);
  console.log("4. Backend ready:", backend.name);

  console.log("5. evaluateBatch...");
  backend.setFrustumFocus({ minX: 2538000, minY: 1152000, maxX: 2538250, maxY: 1152250 }, 50);
  const origin = backend.getOrigin();
  const pts = new Float32Array(4);
  pts[0] = 2538100 - origin.x; pts[1] = 450; pts[2] = 1152100 - origin.y;
  await backend.evaluateBatch(pts, 1, 180, 45);
  console.log("6. OK!");

  backend.dispose();
  console.log("7. Done!");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
