import { WebGpuComputeShadowBackend } from "@/lib/sun/webgpu-compute-shadow-backend";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";

async function main() {
  const index = await loadBuildingsObstacleIndex("lausanne");
  const backend = await WebGpuComputeShadowBackend.createWithDxfMeshes(index!.obstacles, 4096);
  console.log("Backend ready, sleeping 10s...");
  await new Promise(r => setTimeout(r, 10000));
  console.log("Still alive after 10s! Testing evaluateBatch...");
  backend.setFrustumFocus({ minX: 2538000, minY: 1152000, maxX: 2538250, maxY: 1152250 }, 50);
  const origin = backend.getOrigin();
  const pts = new Float32Array(4);
  pts[0] = 2538100 - origin.x; pts[1] = 450; pts[2] = 1152100 - origin.y;
  await backend.evaluateBatch(pts, 1, 180, 45);
  console.log("evaluateBatch OK!");
  backend.dispose();
  console.log("Done");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
