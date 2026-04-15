/**
 * Dedicated GPU worker process for WebGPU shadow evaluation.
 *
 * Communicates via stdin/stdout JSON lines (not IPC).
 * After Dawn is initialized, this process does NO file I/O.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import type { loadBuildingsObstacleIndex } from "./buildings-shadow";

const DEFAULT_WEBGPU_FOCUS_MARGIN_METERS = 5000;
type BuildingsIndex = NonNullable<Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>>;
type BuildingObstacle = BuildingsIndex["obstacles"][number];

async function loadModules() {
  const dir = __dirname;
  const backendUrl = pathToFileURL(join(dir, "webgpu-compute-shadow-backend.ts")).href;
  const buildingsUrl = pathToFileURL(join(dir, "buildings-shadow.ts")).href;
  const { WebGpuComputeShadowBackend } = await import(backendUrl);
  const { loadBuildingsObstacleIndex } = await import(buildingsUrl);
  return { WebGpuComputeShadowBackend, loadBuildingsObstacleIndex };
}

let backend: import("./webgpu-compute-shadow-backend").WebGpuComputeShadowBackend | null = null;

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function parseFocusBounds(value: unknown): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const minX = Number(record.minX);
  const minY = Number(record.minY);
  const maxX = Number(record.maxX);
  const maxY = Number(record.maxY);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return { minX, minY, maxX, maxY };
}

function getFocusMarginMeters(): number {
  const raw = process.env.MAPPY_WEBGPU_FOCUS_MARGIN_METERS;
  const parsed = raw === undefined ? DEFAULT_WEBGPU_FOCUS_MARGIN_METERS : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WEBGPU_FOCUS_MARGIN_METERS;
}

async function handleMessage(msg: Record<string, unknown>) {
  try {
    if (msg.type === "init") {
      console.error(`[gpu-worker] Initializing...`);
      const mods = await loadModules();
      const index = await mods.loadBuildingsObstacleIndex();
      if (!index) { send({ type: "error", error: "No buildings index" }); return; }
      const focusBounds = parseFocusBounds(msg.focusBounds);
      let obstacles = index.obstacles;
      if (focusBounds) {
        const margin = getFocusMarginMeters();
        obstacles = index.obstacles.filter((obstacle: BuildingObstacle) =>
          obstacle.maxX > focusBounds.minX - margin &&
          obstacle.minX < focusBounds.maxX + margin &&
          obstacle.maxY > focusBounds.minY - margin &&
          obstacle.minY < focusBounds.maxY + margin
        );
        console.error(
          `[gpu-worker] Spatial filter: ${obstacles.length}/${index.obstacles.length} obstacles within ${margin}m of focus`,
        );
      }
      const activeBackend = await mods.WebGpuComputeShadowBackend.createWithDxfMeshes(obstacles, 4096);
      backend = activeBackend;
      if (focusBounds) {
        const maxH = obstacles.reduce((max: number, obstacle: BuildingObstacle) => Math.max(max, obstacle.height), 0);
        activeBackend.setFrustumFocus(focusBounds, maxH);
      }
      const origin = activeBackend.getOrigin();
      console.error(`[gpu-worker] Ready: ${activeBackend.name}`);
      send({ type: "ready", name: activeBackend.name, originX: origin.x, originY: origin.y });
    } else if (msg.type === "focus") {
      if (!backend) { send({ type: "error", error: "Not initialized" }); return; }
      backend.setFrustumFocus(
        { minX: msg.minX as number, minY: msg.minY as number, maxX: msg.maxX as number, maxY: msg.maxY as number },
        msg.maxH as number,
      );
      send({ type: "focused" });
    } else if (msg.type === "evaluate") {
      if (!backend) { send({ type: "error", error: "Not initialized" }); return; }
      const pointsBuf = Buffer.from(msg.pointsBuf as string, "base64");
      const points = new Float32Array(pointsBuf.buffer, pointsBuf.byteOffset, pointsBuf.byteLength / 4);
      const result = await backend.evaluateBatch(
        points, msg.pointCount as number, msg.azimuth as number, msg.altitude as number,
      );
      const resultBuf = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
      send({ type: "result", maskBuf: resultBuf.toString("base64") });
    } else if (msg.type === "dispose") {
      if (backend) { backend.dispose(); backend = null; }
      send({ type: "disposed" });
      process.exit(0);
    }
  } catch (err) {
    console.error(`[gpu-worker] Error:`, err);
    send({ type: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

// Read JSON lines from stdin
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line) as Record<string, unknown>;
    void handleMessage(msg);
  } catch {}
});

send({ type: "waiting" });
