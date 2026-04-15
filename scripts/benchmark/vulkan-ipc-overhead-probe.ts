/**
 * Probe IPC overhead between Node and the Rust/wgpu Vulkan server.
 *
 * Spawns one server on a real tile (mesh+points), runs N evaluate requests,
 * and reports for each: Rust-side elapsedMs (GPU + readback) vs Node-side
 * round-trip wall time (write request → parse JSON response).
 *
 * Delta = IPC overhead per call (JSON serialization, pipe IO, JSON parsing).
 */
import { performance } from "node:perf_hooks";
import path from "node:path";
import fs from "node:fs/promises";

import {
  RustWgpuVulkanShadowServer,
  makeRustWgpuVulkanEnv,
} from "@/lib/sun/rust-wgpu-vulkan-server-client";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";
import { loadGpuMeshes } from "@/lib/sun/gpu-mesh-loader";

const ITERATIONS = 60;
const RESOLUTION = 4096;

async function main() {
  const region = "lausanne";
  console.log(`[ipc-probe] loading buildings index for ${region}...`);
  const index = await loadBuildingsObstacleIndex(region);
  if (!index) throw new Error("No buildings index loaded");
  // Filter to a 2km bbox around central Lausanne to stay under 256MB GPU buffer
  // (e2538000 e2538000 = test area used in plan smoke)
  const FOCUS_LV95_X = 2538000;
  const FOCUS_LV95_Y = 1152500;
  const RADIUS = 1000; // meters
  const obstacles = index.obstacles.filter(
    (o) =>
      o.maxX >= FOCUS_LV95_X - RADIUS && o.minX <= FOCUS_LV95_X + RADIUS &&
      o.maxY >= FOCUS_LV95_Y - RADIUS && o.minY <= FOCUS_LV95_Y + RADIUS,
  );
  console.log(`[ipc-probe] filtered ${obstacles.length}/${index.obstacles.length} obstacles within ${RADIUS}m of (${FOCUS_LV95_X},${FOCUS_LV95_Y})`);

  // Compute scene bounds + origin
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const o of obstacles) {
    minX = Math.min(minX, o.minX); minY = Math.min(minY, o.minY); minZ = Math.min(minZ, o.minZ);
    maxX = Math.max(maxX, o.maxX); maxY = Math.max(maxY, o.maxY); maxZ = Math.max(maxZ, o.maxZ);
  }
  const originX = (minX + maxX) / 2;
  const originY = (minY + maxY) / 2;
  const maxBuildingHeight = obstacles.reduce((m, o) => Math.max(m, o.height), 0);

  console.log(`[ipc-probe] building mesh from ${obstacles.length} obstacles...`);
  const mesh = await loadGpuMeshes(obstacles, originX, originY);
  console.log(`[ipc-probe] mesh: ${mesh.triangleCount} triangles, ${mesh.vertices.length / 3} vertices`);

  // Synthetic 32k point grid in central Lausanne
  const POINT_COUNT = 32186;
  const points = new Float32Array(POINT_COUNT * 4);
  const cx = (minX + maxX) / 2 - originX;
  const cy = (minY + maxY) / 2 - originY;
  const halfSize = 125; // 250m tile / 2
  for (let i = 0; i < POINT_COUNT; i++) {
    const u = (i % 178) / 178;
    const v = Math.floor(i / 178) / 181;
    points[i * 4 + 0] = cx + (u - 0.5) * 2 * halfSize;
    points[i * 4 + 1] = cy + (v - 0.5) * 2 * halfSize;
    points[i * 4 + 2] = 400; // elevation
    points[i * 4 + 3] = 0;
  }

  // Write mesh + points to disk (server reads from files)
  const outDir = path.join(process.cwd(), "data", "processed", "wgpu-vulkan-probe", "runtime");
  await fs.mkdir(outDir, { recursive: true });
  const meshPath = path.join(outDir, `ipc-probe-${process.pid}.mesh.bin`);
  const pointsPath = path.join(outDir, `ipc-probe-${process.pid}.points.bin`);
  await fs.writeFile(meshPath, Buffer.from(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength));
  await fs.writeFile(pointsPath, Buffer.from(points.buffer, points.byteOffset, points.byteLength));

  const focusBounds = {
    minX: cx - halfSize,
    minZ: cy - halfSize,
    maxX: cx + halfSize,
    maxZ: cy + halfSize,
  };

  console.log(`[ipc-probe] starting Vulkan server (${process.env.MAPPY_RUST_WGPU_PROBE_PROFILE || "release"})...`);
  const startupT0 = performance.now();
  const { server, ready } = await RustWgpuVulkanShadowServer.start({
    meshBinPath: meshPath,
    pointsBinPath: pointsPath,
    focusBounds,
    maxBuildingHeight,
    resolution: RESOLUTION,
    env: makeRustWgpuVulkanEnv(),
    startupTimeoutMs: 30_000,
    evaluationTimeoutMs: 60_000,
    build: false,
  });
  const startupMs = performance.now() - startupT0;
  console.log(`[ipc-probe] server ready in ${startupMs.toFixed(0)}ms (pointCount=${ready.pointCount})`);

  // Run evaluate iterations with varying sun positions
  const samples: Array<{ idx: number; nodeMs: number; rustMs: number; ipcMs: number; bytesEstimate: number }> = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const azimuth = (i / ITERATIONS) * 360;
    const altitude = 30 + (i % 10) * 3;
    const t0 = performance.now();
    const result = await server.evaluate(i + 1, azimuth, altitude, { includeMask: true });
    const nodeMs = performance.now() - t0;
    const rustMs = result.elapsedMs;
    const ipcMs = nodeMs - rustMs;
    const wordsCount = result.blockedWords?.length ?? 0;
    // Approximate JSON size: each u32 as ~10 chars + comma
    const bytesEstimate = wordsCount * 11;
    samples.push({ idx: i, nodeMs, rustMs, ipcMs, bytesEstimate });
  }

  await server.shutdownWithTimeout();
  await fs.unlink(meshPath).catch(() => {});
  await fs.unlink(pointsPath).catch(() => {});

  // Stats
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const nodeMsArr = samples.map((s) => s.nodeMs);
  const rustMsArr = samples.map((s) => s.rustMs);
  const ipcMsArr = samples.map((s) => s.ipcMs);
  const bytes = samples[0]?.bytesEstimate ?? 0;

  console.log("");
  console.log("=== IPC overhead probe results ===");
  console.log(`Iterations: ${ITERATIONS}, points: ${POINT_COUNT}, resolution: ${RESOLUTION}`);
  console.log(`Server startup: ${startupMs.toFixed(0)}ms`);
  console.log(`Approx JSON response size: ${bytes} bytes (~${(bytes / 1024).toFixed(1)}KB) per evaluate`);
  console.log("");
  console.log(`Per-call timing:`);
  console.log(`  Node round-trip: median=${median(nodeMsArr).toFixed(2)}ms total=${sum(nodeMsArr).toFixed(0)}ms`);
  console.log(`  Rust GPU+readback: median=${median(rustMsArr).toFixed(2)}ms total=${sum(rustMsArr).toFixed(0)}ms`);
  console.log(`  IPC overhead:    median=${median(ipcMsArr).toFixed(2)}ms total=${sum(ipcMsArr).toFixed(0)}ms`);
  console.log(`  IPC fraction:    ${(sum(ipcMsArr) / sum(nodeMsArr) * 100).toFixed(1)}% of node wall time`);
  console.log("");
  console.log("First 5 calls (cold):");
  for (let i = 0; i < 5 && i < samples.length; i++) {
    const s = samples[i];
    console.log(`  [${i}] node=${s.nodeMs.toFixed(2)}ms rust=${s.rustMs.toFixed(2)}ms ipc=${s.ipcMs.toFixed(2)}ms`);
  }
  console.log("Last 5 calls (warm):");
  for (let i = Math.max(0, samples.length - 5); i < samples.length; i++) {
    const s = samples[i];
    console.log(`  [${i}] node=${s.nodeMs.toFixed(2)}ms rust=${s.rustMs.toFixed(2)}ms ipc=${s.ipcMs.toFixed(2)}ms`);
  }
}

main().catch((error) => {
  console.error(`[ipc-probe] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
