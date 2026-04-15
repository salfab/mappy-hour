/**
 * Experimental batch backend backed by the native Rust wgpu/Vulkan probe.
 *
 * This is opt-in only. It mirrors the batch contract used by precompute but
 * keeps the GPU work in a long-lived native subprocess.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PROCESSED_ROOT } from "@/lib/storage/data-paths";
import type {
  BatchBuildingShadowBackend,
  BuildingShadowResult,
} from "@/lib/sun/building-shadow-backend";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";
import { loadGpuMeshes } from "@/lib/sun/gpu-mesh-loader";
import {
  RustWgpuVulkanShadowServer,
  makeRustWgpuVulkanEnv,
} from "@/lib/sun/rust-wgpu-vulkan-server-client";

type ObstacleArray = NonNullable<Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>>["obstacles"];

type Bounds2d = { minX: number; minY: number; maxX: number; maxY: number };
type Bounds3d = Bounds2d & { minZ: number; maxZ: number };

const DEFAULT_RESOLUTION = 4096;

function runtimeOutputDir(): string {
  return process.env.MAPPY_RUST_WGPU_OUTPUT_DIR?.trim() ||
    path.join(PROCESSED_ROOT, "wgpu-vulkan-probe", "runtime");
}

function computeObstacleBounds(obstacles: ObstacleArray): Bounds3d {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const obstacle of obstacles) {
    minX = Math.min(minX, obstacle.minX);
    minY = Math.min(minY, obstacle.minY);
    minZ = Math.min(minZ, obstacle.minZ);
    maxX = Math.max(maxX, obstacle.maxX);
    maxY = Math.max(maxY, obstacle.maxY);
    maxZ = Math.max(maxZ, obstacle.maxZ);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    throw new Error("Cannot create Rust/wgpu Vulkan backend without obstacles.");
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function writeFloat32Bin(filePath: string, values: Float32Array): Promise<void> {
  return fs.writeFile(filePath, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
}

function hashPoints(points: Float32Array, pointCount: number): string {
  const byteLength = pointCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  const buffer = Buffer.from(points.buffer, points.byteOffset, byteLength);
  return `${pointCount}:${crypto.createHash("sha1").update(buffer).digest("hex")}`;
}

export class RustWgpuVulkanShadowBackend implements BatchBuildingShadowBackend {
  readonly name: string;
  // Mutable: reassigned on updateMesh when the focus zone (and therefore
  // the filtered mesh) changes. Consumers that read these fields should
  // not cache them across evaluateBatch calls.
  triangleCount: number;

  private readonly resolution: number;
  private readonly outputDir: string;
  private originX: number;
  private originY: number;
  private meshBinPath: string;
  private sceneBounds: Bounds3d;
  private focusBounds: Bounds2d | null = null;
  private maxBuildingHeight: number;
  private server: RustWgpuVulkanShadowServer | null = null;
  private serverPointCount: number | null = null;
  private serverPointsHash: string | null = null;
  private serverFocusKey: string | null = null;
  private pointsBinPath: string | null = null;
  private evaluationId = 0;

  private constructor(params: {
    originX: number;
    originY: number;
    resolution: number;
    meshBinPath: string;
    outputDir: string;
    sceneBounds: Bounds3d;
    triangleCount: number;
    maxBuildingHeight: number;
  }) {
    this.originX = params.originX;
    this.originY = params.originY;
    this.resolution = params.resolution;
    this.meshBinPath = params.meshBinPath;
    this.outputDir = params.outputDir;
    this.sceneBounds = params.sceneBounds;
    this.triangleCount = params.triangleCount;
    this.maxBuildingHeight = params.maxBuildingHeight;
    this.name = `rust-wgpu-vulkan-${params.resolution}`;
  }

  static async createWithDxfMeshes(
    obstacles: ObstacleArray,
    resolution = DEFAULT_RESOLUTION,
  ): Promise<RustWgpuVulkanShadowBackend> {
    const sceneBounds = computeObstacleBounds(obstacles);
    const originX = (sceneBounds.minX + sceneBounds.maxX) / 2;
    const originY = (sceneBounds.minY + sceneBounds.maxY) / 2;
    const mesh = await loadGpuMeshes(obstacles, originX, originY);
    const outputDir = runtimeOutputDir();
    await fs.mkdir(outputDir, { recursive: true });
    const runId = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    const meshBinPath = path.join(outputDir, `${runId}.mesh.bin`);
    await writeFloat32Bin(meshBinPath, mesh.vertices);
    const maxBuildingHeight = obstacles.reduce((max, obstacle) => Math.max(max, obstacle.height), 0);

    return new RustWgpuVulkanShadowBackend({
      originX,
      originY,
      resolution,
      meshBinPath,
      outputDir,
      sceneBounds,
      triangleCount: mesh.triangleCount,
      maxBuildingHeight,
    });
  }

  getOrigin(): { x: number; y: number } {
    return { x: this.originX, y: this.originY };
  }

  setFrustumFocus(bounds: Bounds2d, maxBuildingHeight: number): void {
    this.focusBounds = { ...bounds };
    this.maxBuildingHeight = maxBuildingHeight;
  }

  /**
   * Replace the mesh with a new filtered obstacle set (usually after a
   * focus-zone change). If a server is running, the mesh is reloaded in
   * place without tearing down the Vulkan device; otherwise the new mesh
   * will be used by the next server start.
   *
   * Any previously set focus bounds are cleared — callers should call
   * setFrustumFocus() again with the new focus bounds right after.
   */
  async updateMesh(obstacles: ObstacleArray): Promise<void> {
    const sceneBounds = computeObstacleBounds(obstacles);
    const originX = (sceneBounds.minX + sceneBounds.maxX) / 2;
    const originY = (sceneBounds.minY + sceneBounds.maxY) / 2;
    const mesh = await loadGpuMeshes(obstacles, originX, originY);
    const runId = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    const newMeshBinPath = path.join(this.outputDir, `${runId}.mesh.bin`);
    await writeFloat32Bin(newMeshBinPath, mesh.vertices);
    const maxBuildingHeight = obstacles.reduce(
      (max, obstacle) => Math.max(max, obstacle.height),
      0,
    );

    if (this.server) {
      try {
        this.evaluationId += 1;
        await this.server.reloadMesh(this.evaluationId, newMeshBinPath);
      } catch (error) {
        // Clean up the new mesh bin if the reload failed (we'll keep the old one).
        await this.deleteRuntimeFile(newMeshBinPath);
        throw error;
      }
    }

    // Commit new mesh state and drop the previous mesh file.
    const previousMeshPath = this.meshBinPath;
    this.meshBinPath = newMeshBinPath;
    this.originX = originX;
    this.originY = originY;
    this.sceneBounds = sceneBounds;
    this.triangleCount = mesh.triangleCount;
    this.maxBuildingHeight = maxBuildingHeight;
    // Invalidate the cached focus key so the next evaluateBatch will sync
    // the server's focus (caller usually calls setFrustumFocus right after
    // updateMesh, so the value itself is already fresh).
    this.serverFocusKey = null;
    await this.deleteRuntimeFile(previousMeshPath);
  }

  async evaluateBatch(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
  ): Promise<Uint32Array> {
    if (pointCount === 0) {
      return new Uint32Array(0);
    }
    await this.ensureServer(points, pointCount);
    if (!this.server) {
      throw new Error("Rust/wgpu Vulkan server failed to start.");
    }
    this.evaluationId += 1;
    const result = await this.server.evaluate(this.evaluationId, azimuthDeg, altitudeDeg, {
      includeMask: true,
    });
    if (result.pointCount !== pointCount) {
      throw new Error(`Rust/wgpu Vulkan point count mismatch: server=${result.pointCount}, expected=${pointCount}`);
    }
    return Uint32Array.from(result.blockedWords ?? []);
  }

  prepareSunPosition(): void {}

  evaluate(): BuildingShadowResult {
    return {
      blocked: false,
      blockerId: null,
      blockerDistanceMeters: null,
      blockerAltitudeAngleDeg: null,
    };
  }

  dispose(): void {
    void this.shutdown().catch((error) => {
      console.warn(`[rust-wgpu-vulkan] Failed to shutdown server: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async shutdown(): Promise<void> {
    await this.shutdownServer();
    await this.deleteRuntimeFile(this.meshBinPath);
  }

  private async shutdownServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.serverPointCount = null;
    this.serverPointsHash = null;
    this.serverFocusKey = null;
    if (server) {
      console.log("[rust-wgpu-vulkan] Shutting down native server");
      await server.shutdownWithTimeout();
      console.log("[rust-wgpu-vulkan] Native server stopped");
    }
    await this.deleteRuntimeFile(this.pointsBinPath);
    this.pointsBinPath = null;
  }

  private async ensureServer(points: Float32Array, pointCount: number): Promise<void> {
    const pointsHash = hashPoints(points, pointCount);
    const focusKey = this.currentFocusKey();
    if (this.server) {
      if (
        this.serverPointCount === pointCount &&
        this.serverPointsHash === pointsHash &&
        this.serverFocusKey === focusKey
      ) {
        return;
      }
      // Long-lived path: only points and/or focus changed — reload in place.
      // (Mesh is constructor-bound and does not change over the backend's lifetime.)
      const pointsChanged =
        this.serverPointCount !== pointCount || this.serverPointsHash !== pointsHash;
      const focusChanged = this.serverFocusKey !== focusKey;
      try {
        if (focusChanged) {
          await this.reloadFocusOnServer();
        }
        if (pointsChanged) {
          await this.reloadPointsOnServer(points, pointCount);
        }
        this.serverPointCount = pointCount;
        this.serverPointsHash = pointsHash;
        this.serverFocusKey = focusKey;
        return;
      } catch (error) {
        // On reload failure, fall through to full restart to stay safe.
        console.warn(
          `[rust-wgpu-vulkan] Reload failed, falling back to full server restart: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.shutdownServer();
      }
    }

    const outputDir = this.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    const pointsBinPath = path.join(outputDir, `${process.pid}-${Date.now()}-${crypto.randomUUID()}.points.bin`);
    await writeFloat32Bin(pointsBinPath, points.subarray(0, pointCount * 4));
    this.pointsBinPath = pointsBinPath;
    const focus = this.focusBounds ?? {
      minX: this.sceneBounds.minX,
      minY: this.sceneBounds.minY,
      maxX: this.sceneBounds.maxX,
      maxY: this.sceneBounds.maxY,
    };
    const started = await RustWgpuVulkanShadowServer.start({
      meshBinPath: this.meshBinPath,
      pointsBinPath,
      focusBounds: {
        minX: focus.minX - this.originX,
        minZ: focus.minY - this.originY,
        maxX: focus.maxX - this.originX,
        maxZ: focus.maxY - this.originY,
      },
      maxBuildingHeight: this.maxBuildingHeight,
      resolution: this.resolution,
      env: makeRustWgpuVulkanEnv(),
      startupTimeoutMs: 30_000,
      evaluationTimeoutMs: 60_000,
    });
    if (started.ready.pointCount !== pointCount) {
      await started.server.shutdown();
      await this.deleteRuntimeFile(pointsBinPath);
      throw new Error(`Rust/wgpu Vulkan ready point count mismatch: server=${started.ready.pointCount}, expected=${pointCount}.`);
    }
    this.server = started.server;
    this.serverPointCount = pointCount;
    this.serverPointsHash = pointsHash;
    this.serverFocusKey = focusKey;
  }

  private async reloadFocusOnServer(): Promise<void> {
    if (!this.server) throw new Error("Cannot reload_focus: server is not running.");
    const focus = this.focusBounds ?? {
      minX: this.sceneBounds.minX,
      minY: this.sceneBounds.minY,
      maxX: this.sceneBounds.maxX,
      maxY: this.sceneBounds.maxY,
    };
    this.evaluationId += 1;
    await this.server.reloadFocus(
      this.evaluationId,
      {
        minX: focus.minX - this.originX,
        minZ: focus.minY - this.originY,
        maxX: focus.maxX - this.originX,
        maxZ: focus.maxY - this.originY,
      },
      this.maxBuildingHeight,
    );
  }

  private async reloadPointsOnServer(points: Float32Array, pointCount: number): Promise<void> {
    if (!this.server) throw new Error("Cannot reload_points: server is not running.");
    // Write new points bin, ask server to load it, drop the previous bin only
    // after the server confirms (so we can always roll back on failure).
    const outputDir = this.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    const newPath = path.join(
      outputDir,
      `${process.pid}-${Date.now()}-${crypto.randomUUID()}.points.bin`,
    );
    await writeFloat32Bin(newPath, points.subarray(0, pointCount * 4));
    this.evaluationId += 1;
    const result = await this.server.reloadPoints(this.evaluationId, newPath);
    if (result.pointCount !== pointCount) {
      await this.deleteRuntimeFile(newPath);
      throw new Error(
        `Rust/wgpu Vulkan reload_points mismatch: server=${result.pointCount}, expected=${pointCount}`,
      );
    }
    // Cleanup previous points bin now that the server uses the new one.
    const previous = this.pointsBinPath;
    this.pointsBinPath = newPath;
    if (previous) await this.deleteRuntimeFile(previous);
  }

  private currentFocusKey(): string {
    const focus = this.focusBounds ?? {
      minX: this.sceneBounds.minX,
      minY: this.sceneBounds.minY,
      maxX: this.sceneBounds.maxX,
      maxY: this.sceneBounds.maxY,
    };
    return [
      focus.minX,
      focus.minY,
      focus.maxX,
      focus.maxY,
      this.maxBuildingHeight,
    ].map((value) => Math.round(value * 1000) / 1000).join(",");
  }

  private async deleteRuntimeFile(filePath: string | null): Promise<void> {
    if (!filePath) return;
    const root = path.resolve(this.outputDir).toLowerCase();
    const target = path.resolve(filePath);
    const targetLower = target.toLowerCase();
    if (targetLower === root || !targetLower.startsWith(`${root}${path.sep}`)) {
      return;
    }
    try {
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[rust-wgpu-vulkan] Failed to delete runtime file ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
