/**
 * CPU vs GPU shadow map comparison.
 *
 * Reads the CPU baseline and GPU results, computes precision metrics
 * and speedup, and writes a final comparison report.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BENCHMARKS_DIR = path.join(process.cwd(), "docs", "progress", "benchmarks");

interface PointResult {
  x: number;
  y: number;
  shadow: number[];
}

interface CpuReport {
  generatedAt: string;
  tile: string;
  date: string;
  instants: number;
  gridPoints: number;
  outdoorPoints: number;
  evaluations: number;
  sharedLoadMs: number;
  contextBuildMs: number;
  evaluationMs: number;
  perEvaluationMicros: number;
  sunPositions: Array<{ utc: string; azimuthDeg: number; altitudeDeg: number }>;
  pointResults: PointResult[];
}

interface GpuReport {
  generatedAt: string;
  tile: string;
  date: string;
  instants: number;
  gridPoints: number;
  shadowMapResolution: number;
  buildingsLoaded: number;
  buildingsLoadMs: number;
  gpuRenderer: string;
  meshCount: number;
  meshLoadMs: number;
  renderTotalMs: number;
  renderOnlyTotalMs: number;
  perRenderMs: number[];
  lookupTotalMs: number;
  perLookupMs: number[];
  totalMs: number;
  pointResults: PointResult[];
}

async function loadJson<T>(filename: string): Promise<T> {
  const raw = await fs.readFile(path.join(BENCHMARKS_DIR, filename), "utf-8");
  return JSON.parse(raw);
}

function getMachineInfo(): string {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "unknown";
  const ram = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  return `${os.hostname()} (${cpuModel.trim()}, ${ram}GB RAM)`;
}

async function main() {
  const gpuResolution = parseInt(process.argv[2] || "4096", 10);

  console.log("[compare] loading CPU baseline...");
  const cpu = await loadJson<CpuReport>("cpu-vs-gpu-cpu-baseline.json");

  console.log(`[compare] loading GPU result (res=${gpuResolution})...`);
  const gpu = await loadJson<GpuReport>(
    `cpu-vs-gpu-gpu-shadowmap-${gpuResolution}.json`,
  );

  // ── Match points and compare ──────────────────────────────────────────
  const cpuMap = new Map<string, number[]>();
  for (const pr of cpu.pointResults) {
    cpuMap.set(`${pr.x},${pr.y}`, pr.shadow);
  }

  let totalComparisons = 0;
  let matches = 0;
  let cpuShadowGpuSun = 0; // CPU says shadow but GPU says sun
  let cpuSunGpuShadow = 0; // CPU says sun but GPU says shadow

  for (const gpr of gpu.pointResults) {
    const key = `${gpr.x},${gpr.y}`;
    const cpuShadow = cpuMap.get(key);
    if (!cpuShadow) continue; // point was indoor in CPU, skip

    for (let i = 0; i < Math.min(cpuShadow.length, gpr.shadow.length); i++) {
      totalComparisons++;
      if (cpuShadow[i] === gpr.shadow[i]) {
        matches++;
      } else if (cpuShadow[i] === 1 && gpr.shadow[i] === 0) {
        cpuShadowGpuSun++;
      } else {
        cpuSunGpuShadow++;
      }
    }
  }

  const mismatches = totalComparisons - matches;
  const mismatchRate = totalComparisons > 0
    ? Math.round((mismatches / totalComparisons) * 10000) / 100
    : 0;

  // ── Compute speedup ───────────────────────────────────────────────────
  // CPU: evaluationMs is the pure shadow eval time
  // GPU: totalMs includes mesh load, render, and lookup
  const cpuTotalMs = cpu.evaluationMs;
  const gpuTotalMs = gpu.totalMs;
  const speedup = Math.round((cpuTotalMs / Math.max(gpuTotalMs, 0.01)) * 100) / 100;

  // GPU per-evaluation: total time / number of comparisons
  const gpuEvaluations = gpu.gridPoints * gpu.instants;
  const gpuPerEvalMicros =
    Math.round((gpuTotalMs * 1000) / Math.max(gpuEvaluations, 1) * 100) / 100;

  console.log(`[compare] CPU: ${cpuTotalMs}ms for ${cpu.evaluations} evals (${cpu.perEvaluationMicros} µs/eval)`);
  console.log(`[compare] GPU: ${gpuTotalMs}ms for ${gpuEvaluations} evals (${gpuPerEvalMicros} µs/eval)`);
  console.log(`[compare] Speedup: ${speedup}x`);
  console.log(`[compare] Precision: ${matches}/${totalComparisons} match (${(100 - mismatchRate).toFixed(2)}%)`);

  const report = {
    generatedAt: new Date().toISOString(),
    machine: getMachineInfo(),
    tile: cpu.tile,
    date: cpu.date,
    instants: cpu.instants,
    points: cpu.outdoorPoints,
    evaluations: cpu.evaluations,
    cpu: {
      totalMs: cpu.evaluationMs,
      perEvaluationMicros: cpu.perEvaluationMicros,
      mode: "detailed",
      sharedLoadMs: cpu.sharedLoadMs,
      contextBuildMs: cpu.contextBuildMs,
    },
    gpu: {
      renderer: gpu.gpuRenderer,
      meshCount: gpu.meshCount,
      meshLoadMs: gpu.meshLoadMs,
      shadowMapResolution: gpu.shadowMapResolution,
      renderTotalMs: gpu.renderOnlyTotalMs,
      perRenderMs:
        Math.round(
          (gpu.renderOnlyTotalMs / Math.max(gpu.instants, 1)) * 100,
        ) / 100,
      lookupTotalMs: gpu.lookupTotalMs,
      perLookupMicros:
        Math.round(
          (gpu.lookupTotalMs * 1000) / Math.max(gpuEvaluations, 1) * 100,
        ) / 100,
      totalMs: gpu.totalMs,
    },
    speedup,
    precision: {
      totalPoints: totalComparisons,
      matches,
      mismatches,
      mismatchRate,
      cpuShadowGpuSun,
      cpuSunGpuShadow,
    },
  };

  const outPath = path.join(
    BENCHMARKS_DIR,
    "cpu-vs-gpu-shadowmap-thinkpad-x1.json",
  );
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`[compare] report saved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
