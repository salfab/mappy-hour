/**
 * Direct integration test for WebGpuComputeShadowBackend.
 * Usage: MAPPY_BUILDINGS_SHADOW_MODE=webgpu-compute npx tsx scripts/benchmark/webgpu-integration-test.ts
 */
import { performance } from "node:perf_hooks";
import { WebGpuComputeShadowBackend } from "@/lib/sun/webgpu-compute-shadow-backend";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";

async function main() {
  const iterationsArg = process.argv.find((arg) => arg.startsWith("--iterations="));
  const iterations = iterationsArg ? Number(iterationsArg.slice("--iterations=".length)) : 5;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`--iterations must be a positive integer, got ${iterationsArg}`);
  }

  console.log("Loading obstacles...");
  const index = await loadBuildingsObstacleIndex("lausanne");
  if (!index) throw new Error("no index");
  console.log(`  ${index.obstacles.length} obstacles loaded`);

  console.log("Creating WebGPU backend...");
  const t0 = performance.now();
  const backend = await WebGpuComputeShadowBackend.createWithDxfMeshes(index.obstacles, 4096);
  console.log(`  Backend ready: ${backend.name} in ${(performance.now() - t0).toFixed(0)}ms`);

  backend.setFrustumFocus(
    { minX: 2538000, minY: 1152000, maxX: 2538250, maxY: 1152250 },
    50,
  );
  const origin = backend.getOrigin();
  console.log(`  Origin: (${origin.x.toFixed(0)}, ${origin.y.toFixed(0)})`);

  // 62500 points (250×250 grid at 1m)
  const N = 62500;
  const points = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const ix = i % 250;
    const iy = Math.floor(i / 250);
    points[i * 4 + 0] = 2538000 + ix - origin.x;
    points[i * 4 + 1] = 450;
    points[i * 4 + 2] = 1152000 + iy - origin.y;
    points[i * 4 + 3] = 0;
  }

  console.log(`\nRunning ${iterations} evaluateBatch iterations (${N} points each)...\n`);

  for (let iter = 0; iter < iterations; iter++) {
    const t1 = performance.now();
    const result = await backend.evaluateBatch(points, N, 180 + iter * 10, 45);
    const ms = performance.now() - t1;
    let blocked = 0;
    for (const w of result) {
      let b = w;
      while (b) {
        blocked += b & 1;
        b >>>= 1;
      }
    }
    console.log(`  iter ${iter}: ${ms.toFixed(1)}ms, ${blocked}/${N} blocked (${(100 * blocked / N).toFixed(1)}%)`);
  }

  backend.dispose();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
