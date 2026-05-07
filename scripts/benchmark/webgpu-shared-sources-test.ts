import { buildSharedPointEvaluationSources } from "@/lib/sun/evaluation-context";

async function main() {
  console.log("1. buildSharedPointEvaluationSources...");
  const sources = await buildSharedPointEvaluationSources({
    region: "lausanne",
    lv95Bounds: { minX: 2538000, minY: 1152000, maxX: 2538250, maxY: 1152250 },
  });
  console.log("2. Sources ready. RSS:", (process.memoryUsage().rss / 1024 / 1024).toFixed(0), "MB");
  console.log("   webgpu backend:", sources.webgpuComputeBackend?.name ?? "none");
  console.log("   terrain tiles:", sources.terrainTiles?.length ?? 0);
  console.log("   buildings:", sources.buildingsIndex?.obstacles.length ?? 0);

  if (sources.webgpuComputeBackend && "evaluateBatch" in sources.webgpuComputeBackend) {
    console.log("3. Testing evaluateBatch via lazy backend...");
    const origin = sources.webgpuComputeBackend.getOrigin();
    const pts = new Float32Array(4);
    pts[0] = 2538100 - origin.x; pts[1] = 450; pts[2] = 1152100 - origin.y;
    const result = await sources.webgpuComputeBackend.evaluateBatch(pts, 1, 180, 45);
    console.log("4. evaluateBatch result:", result[0]);
  }

  console.log("5. Done!");
  if (sources.webgpuComputeBackend) sources.webgpuComputeBackend.dispose();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
