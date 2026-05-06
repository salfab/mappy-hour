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

type SessionSlot = {
  id: string;
  pointsHash: string | null;
  pointCount: number | null;
  focusKey: string | null;
  horizonHash: string | null;
  horizonMasksBinPath: string | null;
  horizonIndicesBinPath: string | null;
  pointsBinPath: string | null;
  opened: boolean;
};

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

function hashHorizonPayload(
  masks: Float32Array,
  pointMaskIndices: Uint32Array,
): string {
  const hash = crypto.createHash("sha1");
  hash.update(Buffer.from(masks.buffer, masks.byteOffset, masks.byteLength));
  hash.update(Buffer.from(pointMaskIndices.buffer, pointMaskIndices.byteOffset, pointMaskIndices.byteLength));
  return `${masks.length / 360}m:${pointMaskIndices.length}p:${hash.digest("hex")}`;
}

function hashVegetationPayload(
  meta: Float32Array,
  data: Float32Array,
  nodata: number,
  stepMeters: number,
  maxDistanceMeters: number,
  minClearance: number,
  originX: number,
  originY: number,
  isRaw: boolean,
): string {
  const hash = crypto.createHash("sha1");
  hash.update(Buffer.from(meta.buffer, meta.byteOffset, meta.byteLength));
  hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  const params = new Float32Array([
    nodata,
    stepMeters,
    maxDistanceMeters,
    minClearance,
    originX,
    originY,
    isRaw ? 1 : 0,
  ]);
  hash.update(Buffer.from(params.buffer, params.byteOffset, params.byteLength));
  return `${meta.length / 8}t:${data.length}f:${hash.digest("hex")}`;
}

function hashTerrainPayload(
  meta: Float32Array,
  data: Float32Array,
  nodata: number,
  stepMeters: number,
  maxDistanceMeters: number,
  altitudeGateDeg: number,
  originX: number,
  originY: number,
): string {
  const hash = crypto.createHash("sha1");
  hash.update(Buffer.from(meta.buffer, meta.byteOffset, meta.byteLength));
  hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  const params = new Float32Array([
    nodata,
    stepMeters,
    maxDistanceMeters,
    altitudeGateDeg,
    originX,
    originY,
  ]);
  hash.update(Buffer.from(params.buffer, params.byteOffset, params.byteLength));
  return `${meta.length / 8}t:${data.length}f:${hash.digest("hex")}`;
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
  private evaluationId = 0;
  // Multi-session pool: N slots, each with its own per-tile state.
  private readonly sessionCount: number;
  private sessionSlots: SessionSlot[] = [];
  private slotChains: Promise<unknown>[] = [];
  // Scene-wide upload state (shared across all sessions on Rust side).
  private serverVegetationHash: string | null = null;
  private vegetationMetaBinPath: string | null = null;
  private vegetationDataBinPath: string | null = null;
  private serverTerrainHash: string | null = null;
  private terrainMetaBinPath: string | null = null;
  private terrainDataBinPath: string | null = null;

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
    const n = parseInt(process.env.MAPPY_RUST_VULKAN_SESSIONS ?? "1", 10);
    this.sessionCount = Number.isFinite(n) && n >= 1 ? Math.min(n, 4) : 1;
    for (let i = 0; i < this.sessionCount; i++) {
      this.sessionSlots.push({
        id: i === 0 ? "default" : `slot-${i}`,
        pointsHash: null, pointCount: null, focusKey: null,
        horizonHash: null, horizonMasksBinPath: null, horizonIndicesBinPath: null,
        pointsBinPath: null, opened: false,
      });
      this.slotChains.push(Promise.resolve());
    }
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
    for (const s of this.sessionSlots) { s.focusKey = null; }
    await this.deleteRuntimeFile(previousMeshPath);
  }

  async evaluateBatch(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
  ): Promise<Uint32Array> {
    const res = await this.evaluateBatchInternal(points, pointCount, azimuthDeg, altitudeDeg);
    return res.buildingsMask;
  }

  /**
   * Evaluate buildings + terrain + vegetation bitmasks in one dispatch.
   * Any payload provided in `options` is synced to the server (deduped
   * by hash) after the points are in place. Absent payloads leave their
   * kind on the server as-is; if a kind has never been uploaded, its
   * mask in the result is null.
   */
  async evaluateBatchWithShadows(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
    options?: {
      horizon?: { masks: Float32Array; pointMaskIndices: Uint32Array };
      vegetation?: {
        meta: Float32Array;
        data: Float32Array;
        nodata: number;
        stepMeters: number;
        maxDistanceMeters: number;
        minClearance: number;
        originX: number;
        originY: number;
        isRaw?: boolean;
      };
      terrain?: {
        meta: Float32Array;
        data: Float32Array;
        nodata: number;
        stepMeters: number;
        maxDistanceMeters: number;
        altitudeGateDeg: number;
        originX: number;
        originY: number;
      };
    },
  ): Promise<{
    buildingsMask: Uint32Array;
    terrainMask: Uint32Array | null;
    vegetationMask: Uint32Array | null;
  }> {
    if (pointCount === 0) {
      return { buildingsMask: new Uint32Array(0), terrainMask: null, vegetationMask: null };
    }
    const slot0 = this.sessionSlots[0];
    await this.ensureSlot(slot0, points, pointCount);
    if (!this.server) {
      throw new Error("Rust/wgpu Vulkan server failed to start.");
    }
    if (options?.horizon) {
      await this.uploadHorizonMasksForSlot(slot0, options.horizon);
    }
    if (options?.vegetation) {
      await this.uploadVegetationRasters(options.vegetation);
    }
    if (options?.terrain) {
      await this.uploadTerrainRasters(options.terrain);
    }
    return this.runEvaluate(slot0, pointCount, azimuthDeg, altitudeDeg);
  }

  /**
   * Phase D: evaluate N frames in a single GPU submission, using the
   * Rust server's evaluate_batch command. Horizon/vegetation uploads
   * happen at most once before the batch runs (hash-deduped).
   *
   * Returns one {buildingsMask, terrainMask, vegetationMask} per frame,
   * in the same order as `frames`.
   */
  async evaluateBatchFramesWithShadows(
    frames: Array<{ azimuthDeg: number; altitudeDeg: number }>,
    points: Float32Array,
    pointCount: number,
    options?: {
      horizon?: { masks: Float32Array; pointMaskIndices: Uint32Array };
      vegetation?: {
        meta: Float32Array;
        data: Float32Array;
        nodata: number;
        stepMeters: number;
        maxDistanceMeters: number;
        minClearance: number;
        originX: number;
        originY: number;
        isRaw?: boolean;
      };
      terrain?: {
        meta: Float32Array;
        data: Float32Array;
        nodata: number;
        stepMeters: number;
        maxDistanceMeters: number;
        altitudeGateDeg: number;
        originX: number;
        originY: number;
      };
    },
  ): Promise<
    Array<{
      buildingsMask: Uint32Array;
      terrainMask: Uint32Array | null;
      vegetationMask: Uint32Array | null;
      sunnyMask: Uint32Array;
      sunnyNoVegMask: Uint32Array;
      sunnyCount: number;
      sunnyNoVegCount: number;
    }>
  > {
    if (frames.length === 0) return [];
    if (pointCount === 0) {
      return frames.map(() => ({
        buildingsMask: new Uint32Array(0),
        terrainMask: null,
        vegetationMask: null,
        sunnyMask: new Uint32Array(0),
        sunnyNoVegMask: new Uint32Array(0),
        sunnyCount: 0,
        sunnyNoVegCount: 0,
      }));
    }
    // Multi-session pre-flight bench instrumentation: split the dispatch
    // wall into lockWait | upload | serverIpc | decode so we know which
    // segment dominates and whether multi-session would actually help.
    // See ADR-0011 Phase G post-mortem.
    const lockEnterT0 = performance.now();
    return this.withSessionLock(async (slot) => {
      const lockWaitMs = performance.now() - lockEnterT0;
      return this.evaluateBatchFramesWithShadowsOnSlot(slot, frames, points, pointCount, options, lockWaitMs);
    });
  }

  private async evaluateBatchFramesWithShadowsOnSlot(
    slot: SessionSlot,
    frames: Array<{ azimuthDeg: number; altitudeDeg: number }>,
    points: Float32Array,
    pointCount: number,
    options?: Parameters<RustWgpuVulkanShadowBackend["evaluateBatchFramesWithShadows"]>[3],
    lockWaitMs?: number,
  ): Promise<Awaited<ReturnType<RustWgpuVulkanShadowBackend["evaluateBatchFramesWithShadows"]>>> {
    if (frames.length === 0) return [];
    if (pointCount === 0) {
      return frames.map(() => ({
        buildingsMask: new Uint32Array(0),
        terrainMask: null,
        vegetationMask: null,
        sunnyMask: new Uint32Array(0),
        sunnyNoVegMask: new Uint32Array(0),
        sunnyCount: 0,
        sunnyNoVegCount: 0,
      }));
    }
    const ensureT0 = performance.now();
    await this.ensureSlot(slot, points, pointCount);
    if (!this.server) {
      throw new Error("Rust/wgpu Vulkan server failed to start.");
    }
    const ensureMs = performance.now() - ensureT0;
    const uploadHorizonT0 = performance.now();
    if (options?.horizon) {
      await this.uploadHorizonMasksForSlot(slot, options.horizon);
    }
    const uploadHorizonMs = performance.now() - uploadHorizonT0;
    const uploadVegT0 = performance.now();
    if (options?.vegetation) {
      await this.uploadVegetationRasters(options.vegetation);
    }
    const uploadVegMs = performance.now() - uploadVegT0;
    const uploadTerrainT0 = performance.now();
    if (options?.terrain) {
      await this.uploadTerrainRasters(options.terrain);
    }
    const uploadTerrainMs = performance.now() - uploadTerrainT0;
    const uploadMs = uploadHorizonMs + uploadVegMs + uploadTerrainMs;
    this.evaluationId += 1;
    const azimuthsDeg = frames.map((f) => f.azimuthDeg);
    const altitudesDeg = frames.map((f) => f.altitudeDeg);
    // Binary IPC: Rust streams Vec<u32> raw bytes on stdout after JSON header.
    let result;
    const ipcT0 = performance.now();
    try {
      result = await this.server.evaluateBatch(this.evaluationId, azimuthsDeg, altitudesDeg, {
        includeMask: true,
        sessionId: slot.id,
      });
    } catch (error) {
      // Server timed out or crashed — kill it so ensureSlot recreates it next time.
      console.error(`[rust-wgpu-vulkan] evaluateBatch failed, killing server: ${error instanceof Error ? error.message : error}`);
      try { await this.server.forceKill(); } catch { /* best effort */ }
      this.server = null;
      this.serverVegetationHash = null;
      this.serverTerrainHash = null;
      for (const s of this.sessionSlots) {
        s.horizonHash = null;
        s.pointsHash = null;
        s.pointCount = null;
        s.opened = false;
      }
      throw error;
    }
    const ipcMs = performance.now() - ipcT0;
    if (result.pointCount !== pointCount) {
      throw new Error(
        `Rust/wgpu Vulkan batch point count mismatch: server=${result.pointCount}, expected=${pointCount}`,
      );
    }
    // Terrain mask present when EITHER horizon masks OR terrain rasters uploaded.
    const hasTerrain =
      slot.horizonHash !== null || this.serverTerrainHash !== null;
    const hasVeg = this.serverVegetationHash !== null;
    const decodeT0 = performance.now();
    const decoded = result.frames.map((f) => ({
      buildingsMask: Uint32Array.from(f.blockedWords ?? []),
      terrainMask: hasTerrain && Array.isArray(f.terrainBlockedWords)
        ? Uint32Array.from(f.terrainBlockedWords)
        : null,
      vegetationMask: hasVeg && Array.isArray(f.vegetationBlockedWords)
        ? Uint32Array.from(f.vegetationBlockedWords)
        : null,
      sunnyMask: Array.isArray(f.sunnyWords) ? Uint32Array.from(f.sunnyWords) : new Uint32Array(0),
      sunnyNoVegMask: Array.isArray(f.sunnyNoVegWords)
        ? Uint32Array.from(f.sunnyNoVegWords)
        : new Uint32Array(0),
      sunnyCount: Number(f.sunnyPoints ?? 0),
      sunnyNoVegCount: Number(f.sunnyNoVegPoints ?? 0),
    }));
    const decodeMs = performance.now() - decodeT0;
    const totalDispatchMs =
      (lockWaitMs ?? 0) + ensureMs + uploadMs + ipcMs + decodeMs;
    console.log(
      `[dispatch-split] frames=${frames.length} points=${pointCount} ` +
        `lockWait=${(lockWaitMs ?? 0).toFixed(0)}ms ` +
        `ensure=${ensureMs.toFixed(0)}ms ` +
        `upload=${uploadMs.toFixed(0)}ms[h=${uploadHorizonMs.toFixed(0)}/v=${uploadVegMs.toFixed(0)}/t=${uploadTerrainMs.toFixed(0)}] ` +
        `serverIpc=${ipcMs.toFixed(0)}ms ` +
        `decode=${decodeMs.toFixed(0)}ms ` +
        `total=${totalDispatchMs.toFixed(0)}ms`,
    );
    return decoded;
  }

  private async evaluateBatchInternal(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
  ): Promise<{
    buildingsMask: Uint32Array;
    terrainMask: Uint32Array | null;
    vegetationMask: Uint32Array | null;
  }> {
    if (pointCount === 0) {
      return { buildingsMask: new Uint32Array(0), terrainMask: null, vegetationMask: null };
    }
    const slot0 = this.sessionSlots[0];
    await this.ensureSlot(slot0, points, pointCount);
    if (!this.server) {
      throw new Error("Rust/wgpu Vulkan server failed to start.");
    }
    return this.runEvaluate(slot0, pointCount, azimuthDeg, altitudeDeg);
  }

  private async runEvaluate(
    slot: SessionSlot,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
  ): Promise<{
    buildingsMask: Uint32Array;
    terrainMask: Uint32Array | null;
    vegetationMask: Uint32Array | null;
  }> {
    if (!this.server) {
      throw new Error("Rust/wgpu Vulkan server is not running.");
    }
    this.evaluationId += 1;
    let result;
    try {
      result = await this.server.evaluate(this.evaluationId, azimuthDeg, altitudeDeg, {
        includeMask: true,
        sessionId: slot.id,
      });
    } catch (error) {
      console.error(`[rust-wgpu-vulkan] evaluate failed, killing server: ${error instanceof Error ? error.message : error}`);
      try { await this.server.forceKill(); } catch { /* best effort */ }
      this.server = null;
      throw error;
    }
    if (result.pointCount !== pointCount) {
      throw new Error(
        `Rust/wgpu Vulkan point count mismatch: server=${result.pointCount}, expected=${pointCount}`,
      );
    }
    const buildingsMask = Uint32Array.from(result.blockedWords ?? []);
    const terrainMask =
      slot.horizonHash !== null && Array.isArray(result.terrainBlockedWords)
        ? Uint32Array.from(result.terrainBlockedWords)
        : null;
    const vegetationMask =
      this.serverVegetationHash !== null && Array.isArray(result.vegetationBlockedWords)
        ? Uint32Array.from(result.vegetationBlockedWords)
        : null;
    return { buildingsMask, terrainMask, vegetationMask };
  }

  /**
   * Upload packed horizon masks + per-point indices to the Rust server.
   * Delegates to slot 0 (for backward compat with single-frame evaluate path).
   */
  async uploadHorizonMasks(params: {
    masks: Float32Array;
    pointMaskIndices: Uint32Array;
  }): Promise<void> {
    return this.uploadHorizonMasksForSlot(this.sessionSlots[0], params);
  }

  private async uploadHorizonMasksForSlot(
    slot: SessionSlot,
    params: { masks: Float32Array; pointMaskIndices: Uint32Array },
  ): Promise<void> {
    const { masks, pointMaskIndices } = params;
    if (masks.length === 0 || pointMaskIndices.length === 0) {
      throw new Error("uploadHorizonMasks requires non-empty masks and indices.");
    }
    if (masks.length % 360 !== 0) {
      throw new Error(
        `uploadHorizonMasks: masks length ${masks.length} is not a multiple of 360.`,
      );
    }
    const hash = hashHorizonPayload(masks, pointMaskIndices);
    if (this.server && slot.horizonHash === hash) {
      return;
    }
    if (!this.server) {
      throw new Error(
        "uploadHorizonMasks called before the Rust server is running. Call evaluateBatch first to spin it up.",
      );
    }
    const outputDir = this.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    const runId = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    const masksPath = path.join(outputDir, `${runId}.horizon-masks.bin`);
    const indicesPath = path.join(outputDir, `${runId}.horizon-indices.bin`);
    await writeFloat32Bin(masksPath, masks);
    await fs.writeFile(
      indicesPath,
      Buffer.from(pointMaskIndices.buffer, pointMaskIndices.byteOffset, pointMaskIndices.byteLength),
    );
    try {
      this.evaluationId += 1;
      await this.server.uploadHorizonMasks(this.evaluationId, masksPath, indicesPath, { sessionId: slot.id });
    } catch (error) {
      await this.deleteRuntimeFile(masksPath);
      await this.deleteRuntimeFile(indicesPath);
      throw error;
    }
    const prevMasks = slot.horizonMasksBinPath;
    const prevIndices = slot.horizonIndicesBinPath;
    slot.horizonMasksBinPath = masksPath;
    slot.horizonIndicesBinPath = indicesPath;
    slot.horizonHash = hash;
    if (prevMasks) await this.deleteRuntimeFile(prevMasks);
    if (prevIndices) await this.deleteRuntimeFile(prevIndices);
  }

  /**
   * Upload packed vegetation rasters to the Rust server. Memoized by
   * hash; identical payloads on subsequent calls are no-ops.
   */
  async uploadVegetationRasters(params: {
    meta: Float32Array;
    data: Float32Array;
    nodata: number;
    stepMeters: number;
    maxDistanceMeters: number;
    minClearance: number;
    originX: number;
    originY: number;
    isRaw?: boolean;
  }): Promise<void> {
    if (params.meta.length === 0 || params.data.length === 0) {
      throw new Error("uploadVegetationRasters requires non-empty meta and data.");
    }
    if (params.meta.length % 8 !== 0) {
      throw new Error(
        `uploadVegetationRasters: meta length ${params.meta.length} is not a multiple of 8.`,
      );
    }
    const hash = hashVegetationPayload(
      params.meta,
      params.data,
      params.nodata,
      params.stepMeters,
      params.maxDistanceMeters,
      params.minClearance,
      params.originX,
      params.originY,
      params.isRaw ?? false,
    );
    if (this.server && this.serverVegetationHash === hash) {
      return;
    }
    if (!this.server) {
      throw new Error(
        "uploadVegetationRasters called before the Rust server is running. Call evaluateBatch first to spin it up.",
      );
    }
    const outputDir = this.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    const runId = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    const metaPath = path.join(outputDir, `${runId}.veg-meta.bin`);
    const dataPath = path.join(outputDir, `${runId}.veg-data.bin`);
    await fs.writeFile(
      metaPath,
      Buffer.from(params.meta.buffer, params.meta.byteOffset, params.meta.byteLength),
    );
    await writeFloat32Bin(dataPath, params.data);
    try {
      this.evaluationId += 1;
      await this.server.uploadVegetationRasters(this.evaluationId, {
        vegMetaBin: metaPath,
        vegDataBin: dataPath,
        vegNodata: params.nodata,
        vegStepMeters: params.stepMeters,
        vegMaxDistanceMeters: params.maxDistanceMeters,
        vegMinClearance: params.minClearance,
        vegetationIsRaw: params.isRaw ?? false,
        originX: params.originX,
        originY: params.originY,
      });
    } catch (error) {
      await this.deleteRuntimeFile(metaPath);
      await this.deleteRuntimeFile(dataPath);
      throw error;
    }
    const prevMeta = this.vegetationMetaBinPath;
    const prevData = this.vegetationDataBinPath;
    this.vegetationMetaBinPath = metaPath;
    this.vegetationDataBinPath = dataPath;
    this.serverVegetationHash = hash;
    if (prevMeta) await this.deleteRuntimeFile(prevMeta);
    if (prevData) await this.deleteRuntimeFile(prevData);
  }

  /**
   * Upload local DEM terrain rasters to the Rust server. Memoized by
   * hash. After this call, evaluate_batch will include the terrain
   * ray-march in terrainBlockedWords (OR'd with the horizon-mask result).
   */
  async uploadTerrainRasters(params: {
    meta: Float32Array;
    data: Float32Array;
    nodata: number;
    stepMeters: number;
    maxDistanceMeters: number;
    altitudeGateDeg: number;
    originX: number;
    originY: number;
  }): Promise<void> {
    if (params.meta.length === 0 || params.data.length === 0) {
      throw new Error("uploadTerrainRasters requires non-empty meta and data.");
    }
    if (params.meta.length % 8 !== 0) {
      throw new Error(
        `uploadTerrainRasters: meta length ${params.meta.length} is not a multiple of 8.`,
      );
    }
    const hash = hashTerrainPayload(
      params.meta,
      params.data,
      params.nodata,
      params.stepMeters,
      params.maxDistanceMeters,
      params.altitudeGateDeg,
      params.originX,
      params.originY,
    );
    if (this.server && this.serverTerrainHash === hash) {
      return;
    }
    if (!this.server) {
      throw new Error(
        "uploadTerrainRasters called before the Rust server is running. Call evaluateBatch first to spin it up.",
      );
    }
    const outputDir = this.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    const runId = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    const metaPath = path.join(outputDir, `${runId}.terrain-meta.bin`);
    const dataPath = path.join(outputDir, `${runId}.terrain-data.bin`);
    await fs.writeFile(
      metaPath,
      Buffer.from(params.meta.buffer, params.meta.byteOffset, params.meta.byteLength),
    );
    await writeFloat32Bin(dataPath, params.data);
    try {
      this.evaluationId += 1;
      await this.server.uploadTerrainRasters(this.evaluationId, {
        terrainMetaBin: metaPath,
        terrainDataBin: dataPath,
        terrainNodata: params.nodata,
        terrainStepMeters: params.stepMeters,
        terrainMaxDistanceMeters: params.maxDistanceMeters,
        terrainAltitudeGateDeg: params.altitudeGateDeg,
        originX: params.originX,
        originY: params.originY,
      });
    } catch (error) {
      await this.deleteRuntimeFile(metaPath);
      await this.deleteRuntimeFile(dataPath);
      throw error;
    }
    const prevMeta = this.terrainMetaBinPath;
    const prevData = this.terrainDataBinPath;
    this.terrainMetaBinPath = metaPath;
    this.terrainDataBinPath = dataPath;
    this.serverTerrainHash = hash;
    if (prevMeta) await this.deleteRuntimeFile(prevMeta);
    if (prevData) await this.deleteRuntimeFile(prevData);
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
    this.serverVegetationHash = null;
    this.serverTerrainHash = null;
    // Reset all slot states.
    for (const slot of this.sessionSlots) {
      await this.deleteRuntimeFile(slot.pointsBinPath);
      await this.deleteRuntimeFile(slot.horizonMasksBinPath);
      await this.deleteRuntimeFile(slot.horizonIndicesBinPath);
      slot.pointsHash = null;
      slot.pointCount = null;
      slot.focusKey = null;
      slot.horizonHash = null;
      slot.horizonMasksBinPath = null;
      slot.horizonIndicesBinPath = null;
      slot.pointsBinPath = null;
      slot.opened = false;
    }
    if (server) {
      console.log("[rust-wgpu-vulkan] Shutting down native server");
      await server.shutdownWithTimeout();
      console.log("[rust-wgpu-vulkan] Native server stopped");
    }
    await this.deleteRuntimeFile(this.vegetationMetaBinPath);
    await this.deleteRuntimeFile(this.vegetationDataBinPath);
    await this.deleteRuntimeFile(this.terrainMetaBinPath);
    await this.deleteRuntimeFile(this.terrainDataBinPath);
    this.vegetationMetaBinPath = null;
    this.vegetationDataBinPath = null;
    this.terrainMetaBinPath = null;
    this.terrainDataBinPath = null;
  }

  // ── Per-slot transaction lock ──────────────────────────────────────────
  // Each slot serializes its own "ensureSlot + uploads + evaluate" sequence.
  // With N=1 (default), behaves identically to the old single withBackendLock.
  // With N>1, tiles can run concurrently on different sessions, limited only
  // by GPU throughput and VRAM (depth texture per session).
  //
  // withSessionLock races all slot chains and claims the first free slot.
  // Losing slot chains receive an immediate release to avoid deadlock.
  private withSessionLock<T>(fn: (slot: SessionSlot) => Promise<T>): Promise<T> {
    const tickets = this.slotChains.map((tail, i) => {
      let release!: () => void;
      const newTail = new Promise<void>((r) => { release = r; });
      const whenFree = tail;
      this.slotChains[i] = tail.then(() => newTail) as Promise<unknown>;
      return { i, whenFree, release };
    });
    return Promise.race(
      tickets.map(({ i, whenFree, release }) =>
        whenFree.then(async () => {
          for (const t of tickets) {
            if (t.i !== i) t.release();
          }
          try {
            return await fn(this.sessionSlots[i]);
          } finally {
            release();
          }
        })
      )
    );
  }

  private async ensureSlot(slot: SessionSlot, points: Float32Array, pointCount: number): Promise<void> {
    const pointsHash = hashPoints(points, pointCount);
    const focusKey = this.currentFocusKey();

    if (!this.server) {
      // Cold-start: start the Rust process with slot 0 ("default") as the initial session.
      const outputDir = this.outputDir;
      await fs.mkdir(outputDir, { recursive: true });
      const slot0 = this.sessionSlots[0];
      const pointsBinPath = path.join(outputDir, `${process.pid}-${Date.now()}-${crypto.randomUUID()}.points.bin`);
      await writeFloat32Bin(pointsBinPath, points.subarray(0, pointCount * 4));
      slot0.pointsBinPath = pointsBinPath;
      const focus = this.focusBounds ?? {
        minX: this.sceneBounds.minX,
        minY: this.sceneBounds.minY,
        maxX: this.sceneBounds.maxX,
        maxY: this.sceneBounds.maxY,
      };
      const serverStartT0 = performance.now();
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
        evaluationTimeoutMs: 180_000,
      });
      const serverStartMs = performance.now() - serverStartT0;
      console.log(
        `[rust-wgpu-vulkan] Native server started in ${serverStartMs.toFixed(0)}ms (sessions=${this.sessionCount}, triangles=${this.triangleCount})`,
      );
      this.server = started.server;
      // Slot 0 is initialized by the server startup (points passed as CLI arg).
      slot0.pointCount = started.ready.pointCount;
      slot0.pointsHash = hashPoints(points, started.ready.pointCount);
      slot0.focusKey = focusKey;
      slot0.opened = true;
      // Open additional slots (slot 1..N-1) on the server via open_session IPC.
      for (let i = 1; i < this.sessionCount; i++) {
        this.evaluationId += 1;
        const s = this.sessionSlots[i];
        const sBinPath = path.join(outputDir, `${process.pid}-${Date.now()}-${crypto.randomUUID()}.points.bin`);
        await writeFloat32Bin(sBinPath, points.subarray(0, pointCount * 4));
        s.pointsBinPath = sBinPath;
        const res = await this.server.openSession(this.evaluationId, s.id, sBinPath);
        s.pointCount = res.pointCount;
        s.pointsHash = pointsHash;
        s.focusKey = focusKey;
        s.opened = true;
      }
    }

    // Server is up. Check if this slot needs reload.
    if (
      slot.pointCount === pointCount &&
      slot.pointsHash === pointsHash &&
      slot.focusKey === focusKey
    ) {
      return;
    }

    const pointsChanged =
      slot.pointCount !== pointCount || slot.pointsHash !== pointsHash;
    const focusChanged = slot.focusKey !== focusKey;
    try {
      if (focusChanged) {
        await this.reloadFocusOnServer();
        // After focus reload, all slots share the same focus — update all.
        for (const s of this.sessionSlots) { s.focusKey = focusKey; }
      }
      if (pointsChanged) {
        await this.reloadPointsOnSlot(slot, points, pointCount);
      }
      slot.pointCount = pointCount;
      slot.pointsHash = pointsHash;
      slot.focusKey = focusKey;
    } catch (error) {
      console.warn(
        `[rust-wgpu-vulkan] Reload failed on slot ${slot.id}, falling back to full server restart: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.shutdownServer();
      // Recursive call to cold-start after shutdown.
      await this.ensureSlot(slot, points, pointCount);
    }
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

  private async reloadPointsOnSlot(slot: SessionSlot, points: Float32Array, pointCount: number): Promise<void> {
    if (!this.server) throw new Error("Cannot reload_points: server is not running.");
    const outputDir = this.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    const newPath = path.join(
      outputDir,
      `${process.pid}-${Date.now()}-${crypto.randomUUID()}.points.bin`,
    );
    await writeFloat32Bin(newPath, points.subarray(0, pointCount * 4));
    this.evaluationId += 1;
    const result = await this.server.reloadPoints(this.evaluationId, newPath, { sessionId: slot.id });
    if (result.pointCount !== pointCount) {
      await this.deleteRuntimeFile(newPath);
      throw new Error(
        `Rust/wgpu Vulkan reload_points mismatch (slot ${slot.id}): server=${result.pointCount}, expected=${pointCount}`,
      );
    }
    const previous = slot.pointsBinPath;
    slot.pointsBinPath = newPath;
    if (previous) await this.deleteRuntimeFile(previous);
    // horizon_indices_buffer is PER-SESSION; reset so next evaluate re-uploads.
    slot.horizonHash = null;
    const prevMasks = slot.horizonMasksBinPath;
    const prevIndices = slot.horizonIndicesBinPath;
    slot.horizonMasksBinPath = null;
    slot.horizonIndicesBinPath = null;
    if (prevMasks) await this.deleteRuntimeFile(prevMasks);
    if (prevIndices) await this.deleteRuntimeFile(prevIndices);
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
