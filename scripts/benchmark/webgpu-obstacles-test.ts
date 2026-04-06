import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";
import { WebGpuComputeShadowBackend } from "@/lib/sun/webgpu-compute-shadow-backend";

async function main() {
  console.log("1. Loading obstacles (JSON files)...");
  const index = await loadBuildingsObstacleIndex("lausanne");
  if (!index) throw new Error("no index");
  console.log("2. Obstacles loaded:", index.obstacles.length);

  console.log("3. Creating Dawn backend...");
  const backend = await WebGpuComputeShadowBackend.createWithDxfMeshes(index.obstacles, 4096);
  console.log("4. Backend ready:", backend.name);

  console.log("5. Test evaluateBatch...");
  backend.setFrustumFocus({ minX: 2538000, minY: 1152000, maxX: 2538250, maxY: 1152250 }, 50);
  const origin = backend.getOrigin();
  const pts = new Float32Array(4);
  pts[0] = 2538100 - origin.x; pts[1] = 450; pts[2] = 1152100 - origin.y;
  const r = await backend.evaluateBatch(pts, 1, 180, 45);
  console.log("6. evaluateBatch OK, result:", r[0]);

  console.log("7. Disposing...");
  backend.dispose();
  console.log("8. Done — no crash!");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
