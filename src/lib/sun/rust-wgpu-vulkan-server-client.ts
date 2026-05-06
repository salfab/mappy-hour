/**
 * Experimental TypeScript client for the native Rust wgpu/Vulkan shadow server.
 *
 * This is server-side only. It exists to validate a long-lived native process
 * before deciding whether Rust/wgpu Vulkan should become a supported backend.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type RustWgpuVulkanReadyMessage = {
  type: "ready";
  pointCount: number;
  triangleCount: number;
};

export type RustWgpuVulkanResultMessage = {
  type: "result";
  id: number;
  elapsedMs: number;
  blockedPoints: number;
  blockedWords?: number[];
  terrainBlockedPoints?: number | null;
  terrainBlockedWords?: number[] | null;
  vegetationBlockedPoints?: number | null;
  vegetationBlockedWords?: number[] | null;
  pointCount: number;
};

export type RustWgpuVulkanBatchFrame = {
  azimuthDeg: number;
  altitudeDeg: number;
  blockedPoints: number;
  blockedWords?: number[];
  terrainBlockedPoints?: number | null;
  terrainBlockedWords?: number[] | null;
  vegetationBlockedPoints?: number | null;
  vegetationBlockedWords?: number[] | null;
  sunnyPoints?: number;
  sunnyWords?: number[] | null;
  sunnyNoVegPoints?: number;
  sunnyNoVegWords?: number[] | null;
};

export type RustWgpuVulkanBatchResultMessage = {
  type: "batch_result";
  id: number;
  sequenceStart: number;
  frameCount: number;
  elapsedMsPerFrame: number;
  frames: RustWgpuVulkanBatchFrame[];
  pointCount: number;
};

type RustWgpuVulkanMessage =
  | RustWgpuVulkanReadyMessage
  | RustWgpuVulkanResultMessage
  | { type: string; [key: string]: unknown };

export type RustWgpuVulkanFocusBounds = {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
};

export type RustWgpuVulkanShadowServerStartParams = {
  meshBinPath: string;
  pointsBinPath: string;
  focusBounds: RustWgpuVulkanFocusBounds;
  maxBuildingHeight: number;
  resolution: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exePath?: string;
  build?: boolean;
  startupTimeoutMs?: number;
  evaluationTimeoutMs?: number;
};

export function makeRustWgpuVulkanEnv(): NodeJS.ProcessEnv {
  const rustRoot = path.join(process.env.LOCALAPPDATA ?? "", "MappyHourRust");
  const rustupHome = process.env.RUSTUP_HOME ?? path.join(rustRoot, "rustup");
  const cargoHome = process.env.CARGO_HOME ?? path.join(rustRoot, "cargo");
  const toolchainBin = path.join(rustupHome, "toolchains", "stable-x86_64-pc-windows-gnullvm", "bin");
  return {
    ...process.env,
    RUSTUP_HOME: rustupHome,
    CARGO_HOME: cargoHome,
    PATH: [path.join(cargoHome, "bin"), toolchainBin, process.env.PATH ?? ""].join(path.delimiter),
  };
}

export function defaultRustWgpuVulkanProbeExePath(): string {
  const profile = process.env.MAPPY_RUST_WGPU_PROBE_PROFILE?.trim() || "release";
  return path.join(
    "tools",
    "wgpu-vulkan-probe",
    "target",
    profile,
    process.platform === "win32" ? "mappyhour-wgpu-vulkan-probe.exe" : "mappyhour-wgpu-vulkan-probe",
  );
}

export function ensureRustWgpuVulkanProbeBuilt(
  env: NodeJS.ProcessEnv = makeRustWgpuVulkanEnv(),
  cwd = process.cwd(),
): string {
  const rustupPath = path.join(
    env.CARGO_HOME ?? "",
    "bin",
    process.platform === "win32" ? "rustup.exe" : "rustup",
  );
  if (!fs.existsSync(rustupPath)) {
    throw new Error(`Missing rustup executable at ${rustupPath}`);
  }

  const profile = process.env.MAPPY_RUST_WGPU_PROBE_PROFILE?.trim() || "release";
  const buildArgs = [
    "run",
    "stable-x86_64-pc-windows-gnullvm",
    "cargo",
    "build",
    "--manifest-path",
    "tools/wgpu-vulkan-probe/Cargo.toml",
  ];
  if (profile === "release") {
    buildArgs.push("--release");
  }
  const result = spawnSync(rustupPath, buildArgs, {
    cwd,
    env: { ...env, RUSTFLAGS: "-C linker=rust-lld" },
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Rust probe build failed with exit code ${result.status}`);
  }
  return defaultRustWgpuVulkanProbeExePath();
}

type IpcMessage = { json: RustWgpuVulkanMessage; payload: Buffer | null };

export class RustWgpuVulkanShadowServer {
  private child: ChildProcessWithoutNullStreams;
  private messages: IpcMessage[] = [];
  private waiters: Array<(message: IpcMessage) => void> = [];
  private stderr = "";
  private evaluationTimeoutMs: number;
  private closed = false;
  // Stdout parser state (binary framing: JSON header line + optional payload).
  private pending: Buffer = Buffer.alloc(0);
  private payloadRemaining = 0;
  private currentHeader: RustWgpuVulkanMessage | null = null;
  private payloadChunks: Buffer[] = [];
  private parserError: Error | null = null;

  // ── IPC lock (FIFO, promise-chain) ───────────────────────────────────
  // Serializes writeJson+nextJson pairs so concurrent callers (e.g. tile N
  // and tile N+1 being pipelined at the orchestrator level) don't interleave
  // bytes on stdin or claim each other's responses on stdout. Order of
  // acquisition = order of awaits, which matches Rust server's FIFO
  // processing of stdin requests. See ADR-0019 (single Vulkan process) and
  // the pipelining work that introduced this lock.
  private ipcChainTail: Promise<unknown> = Promise.resolve();
  private async withIpcLock<T>(fn: () => Promise<T>): Promise<T> {
    const myTurn = this.ipcChainTail;
    let release!: () => void;
    this.ipcChainTail = new Promise<void>((r) => {
      release = r;
    });
    await myTurn;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private constructor(child: ChildProcessWithoutNullStreams, evaluationTimeoutMs: number) {
    this.child = child;
    this.evaluationTimeoutMs = evaluationTimeoutMs;
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderr += text;
      // Forward microbench timing lines to operator stderr so they appear in
      // the log without polluting the JSON IPC stream on stdout.
      for (const line of text.split("\n")) {
        if (line.startsWith("[gpu-timing]")) {
          process.stderr.write(line + "\n");
        }
      }
    });
  }

  // Stream parser: alternates between line-mode (JSON header terminated by \n)
  // and binary-mode (exactly N raw bytes following the header). N is taken
  // from the header's `payloadBytes` field; absent or 0 = no payload.
  private onStdoutChunk(chunk: Buffer): void {
    if (this.parserError) return;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    try {
      while (true) {
        if (this.payloadRemaining > 0) {
          if (this.pending.length === 0) return;
          const take = Math.min(this.payloadRemaining, this.pending.length);
          this.payloadChunks.push(this.pending.subarray(0, take));
          this.pending = this.pending.subarray(take);
          this.payloadRemaining -= take;
          if (this.payloadRemaining === 0) {
            const header = this.currentHeader!;
            const payload = Buffer.concat(this.payloadChunks);
            this.currentHeader = null;
            this.payloadChunks = [];
            this.deliver({ json: header, payload });
          }
          continue;
        }
        const nlIndex = this.pending.indexOf(0x0a);
        if (nlIndex === -1) return;
        const line = this.pending.subarray(0, nlIndex).toString("utf8");
        this.pending = this.pending.subarray(nlIndex + 1);
        const json = JSON.parse(line) as RustWgpuVulkanMessage & { payloadBytes?: number };
        const bytes = typeof json.payloadBytes === "number" ? json.payloadBytes : 0;
        if (bytes > 0) {
          this.currentHeader = json;
          this.payloadRemaining = bytes;
          this.payloadChunks = [];
        } else {
          this.deliver({ json, payload: null });
        }
      }
    } catch (error) {
      this.parserError = error instanceof Error ? error : new Error(String(error));
      const err = this.parserError;
      while (this.waiters.length > 0) {
        const w = this.waiters.shift()!;
        // Reject all pending waiters by handing them a synthetic error.
        // We can't reject directly here (waiters resolve), so push an error
        // message that will be detected by callers via parserError.
        void w;
      }
      // Propagate via stderr-equivalent
      this.stderr += `\n[parser-error] ${err.message}`;
    }
  }

  private deliver(message: IpcMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.messages.push(message);
  }

  static async start(params: RustWgpuVulkanShadowServerStartParams): Promise<{
    server: RustWgpuVulkanShadowServer;
    ready: RustWgpuVulkanReadyMessage;
  }> {
    const cwd = params.cwd ?? process.cwd();
    const env = params.env ?? makeRustWgpuVulkanEnv();
    const exePath = params.exePath ?? (
      params.build === false
        ? defaultRustWgpuVulkanProbeExePath()
        : ensureRustWgpuVulkanProbeBuilt(env, cwd)
    );
    const child = spawn(
      path.resolve(cwd, exePath),
      [
        "--mode=server",
        `--mesh-bin=${params.meshBinPath}`,
        `--points-bin=${params.pointsBinPath}`,
        `--focus-bounds=${params.focusBounds.minX},${params.focusBounds.minZ},${params.focusBounds.maxX},${params.focusBounds.maxZ}`,
        `--focus-max-height=${params.maxBuildingHeight}`,
        `--resolution=${params.resolution}`,
      ],
      {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const server = new RustWgpuVulkanShadowServer(child, params.evaluationTimeoutMs ?? 60_000);
    let ready: RustWgpuVulkanReadyMessage;
    try {
      ready = await server.nextJson<RustWgpuVulkanReadyMessage>(params.startupTimeoutMs ?? 30_000);
    } catch (error) {
      await server.forceKill();
      throw error;
    }
    if (ready.type !== "ready") {
      await server.forceKill();
      throw new Error(`Unexpected Rust server first message: ${JSON.stringify(ready)}`);
    }
    return { server, ready };
  }

  async evaluate(
    id: number,
    azimuthDeg: number,
    altitudeDeg: number,
    options: { includeMask?: boolean } = { includeMask: true },
  ): Promise<RustWgpuVulkanResultMessage> {
    return this.withIpcLock(async () => {
      await this.writeJson({
        id,
        command: "evaluate",
        azimuthDeg,
        altitudeDeg,
        includeMask: options.includeMask ?? true,
      });
      const message = await this.nextJson<RustWgpuVulkanResultMessage>(this.evaluationTimeoutMs);
      if (message.type !== "result") {
        throw new Error(`Unexpected Rust server message: ${JSON.stringify(message)}`);
      }
      if ((options.includeMask ?? true) && !Array.isArray(message.blockedWords)) {
        throw new Error("Rust server result is missing blockedWords.");
      }
      return message;
    });
  }

  /**
   * Evaluate N frames in a single GPU submission. Each frame is one
   * (azimuth, altitude) pair; the server renders N depth maps + runs
   * N compute dispatches in one command buffer, returns all bitmasks
   * in a single response.
   *
   * This amortizes per-frame submit/poll/readback overheads. On Intel
   * Arc + 32K points + 60 frames, this is typically 2-3x faster than
   * calling evaluate() 60 times.
   */
  async evaluateBatch(
    id: number,
    azimuthsDeg: number[],
    altitudesDeg: number[],
    options: { includeMask?: boolean } = {},
  ): Promise<RustWgpuVulkanBatchResultMessage> {
    if (azimuthsDeg.length !== altitudesDeg.length) {
      throw new Error(
        `evaluateBatch: azimuths (${azimuthsDeg.length}) and altitudes (${altitudesDeg.length}) length mismatch.`,
      );
    }
    if (azimuthsDeg.length === 0) {
      throw new Error("evaluateBatch: empty frames");
    }
    return this.withIpcLock(async () => {
      await this.writeJson({
        id,
        command: "evaluate_batch",
        azimuthsDeg,
        altitudesDeg,
        includeMask: options.includeMask ?? true,
      });
      const ipcMessage = await this.nextMessage(this.evaluationTimeoutMs);
      const message = ipcMessage.json as RustWgpuVulkanBatchResultMessage & {
        wordCount: number;
        hasTerrain: boolean;
        hasVegetation: boolean;
        payloadBytes?: number;
      };
      if (message.type !== "batch_result") {
        throw new Error(`Unexpected batch result: ${JSON.stringify(message)}`);
      }
      if (message.frames.length !== azimuthsDeg.length) {
        throw new Error(
          `evaluateBatch frame count mismatch: server=${message.frames.length}, expected=${azimuthsDeg.length}`,
        );
      }
      const payload = ipcMessage.payload;
      if (!payload) {
        throw new Error("evaluateBatch: missing binary payload");
      }
      // Layout: [buildings × N][terrain × N][veg × N][sunny × N][sunnyNoVeg × N],
      // each block = wordCount u32 LE bytes (4 bytes/u32). Buffer comes from
      // the stdout stream parser — no file I/O on the hot path.
      const wordCount = message.wordCount;
      const frameCount = message.frameCount;
      const view = new Uint32Array(
        payload.buffer,
        payload.byteOffset,
        Math.floor(payload.byteLength / 4),
      );
      const sliceFrame = (blockIndex: number, frameIndex: number): number[] => {
        const offset = (blockIndex * frameCount + frameIndex) * wordCount;
        return Array.from(view.subarray(offset, offset + wordCount));
      };
      for (let i = 0; i < frameCount; i++) {
        const f = message.frames[i];
        f.blockedWords = sliceFrame(0, i);
        f.terrainBlockedWords = message.hasTerrain ? sliceFrame(1, i) : null;
        f.vegetationBlockedWords = message.hasVegetation ? sliceFrame(2, i) : null;
        f.sunnyWords = sliceFrame(3, i);
        f.sunnyNoVegWords = sliceFrame(4, i);
      }
      return message;
    });
  }

  /**
   * Replace the points buffer without restarting the server.
   * Keeps mesh, depth texture, render pipeline alive.
   */
  async reloadPoints(
    id: number,
    pointsBinPath: string,
  ): Promise<{ pointCount: number; elapsedMs: number }> {
    return this.withIpcLock(async () => {
      await this.writeJson({
        id,
        command: "reload_points",
        pointsBin: pointsBinPath,
      });
      const message = await this.nextJson(this.evaluationTimeoutMs);
      if (message.type !== "reloaded_points") {
        throw new Error(`Unexpected reload_points response: ${JSON.stringify(message)}`);
      }
      return {
        pointCount: Number((message as { pointCount?: number }).pointCount ?? 0),
        elapsedMs: Number((message as { elapsedMs?: number }).elapsedMs ?? 0),
      };
    });
  }

  /**
   * Replace the focus bounds used for light MVP projection.
   * No GPU resource change.
   */
  async reloadFocus(
    id: number,
    focus: RustWgpuVulkanFocusBounds,
    maxBuildingHeight: number,
  ): Promise<void> {
    return this.withIpcLock(async () => {
      await this.writeJson({
        id,
        command: "reload_focus",
        minX: focus.minX,
        minZ: focus.minZ,
        maxX: focus.maxX,
        maxZ: focus.maxZ,
        maxBuildingHeight,
      });
      const message = await this.nextJson(this.evaluationTimeoutMs);
      if (message.type !== "reloaded_focus") {
        throw new Error(`Unexpected reload_focus response: ${JSON.stringify(message)}`);
      }
    });
  }

  /**
   * Upload per-tile horizon masks for the GPU terrain check.
   * After this call, evaluate() results include a terrainBlockedWords
   * bitmask in addition to the buildings bitmask.
   */
  async uploadHorizonMasks(
    id: number,
    horizonMasksBinPath: string,
    horizonIndicesBinPath: string,
  ): Promise<{ maskCount: number; pointCount: number; elapsedMs: number }> {
    return this.withIpcLock(async () => {
      await this.writeJson({
        id,
        command: "upload_horizon_masks",
        horizonMasksBin: horizonMasksBinPath,
        horizonIndicesBin: horizonIndicesBinPath,
      });
      const message = await this.nextJson(this.evaluationTimeoutMs);
      if (message.type !== "uploaded_horizon_masks") {
        throw new Error(`Unexpected upload_horizon_masks response: ${JSON.stringify(message)}`);
      }
      return {
        maskCount: Number((message as { maskCount?: number }).maskCount ?? 0),
        pointCount: Number((message as { pointCount?: number }).pointCount ?? 0),
        elapsedMs: Number((message as { elapsedMs?: number }).elapsedMs ?? 0),
      };
    });
  }

  /**
   * Upload per-region vegetation rasters (SwissSurface3D) for the GPU
   * ray-march. After this call, evaluate() results include
   * vegetationBlockedWords.
   */
  async uploadVegetationRasters(
    id: number,
    params: {
      vegMetaBin: string;
      vegDataBin: string;
      vegNodata: number;
      vegStepMeters: number;
      vegMaxDistanceMeters: number;
      vegMinClearance: number;
      vegetationIsRaw?: boolean;
      originX: number;
      originY: number;
    },
  ): Promise<{ tileCount: number; dataBytes: number; elapsedMs: number }> {
    return this.withIpcLock(async () => {
      await this.writeJson({
        id,
        command: "upload_vegetation_rasters",
        vegMetaBin: params.vegMetaBin,
        vegDataBin: params.vegDataBin,
        vegNodata: params.vegNodata,
        vegStepMeters: params.vegStepMeters,
        vegMaxDistanceMeters: params.vegMaxDistanceMeters,
        vegMinClearance: params.vegMinClearance,
        vegetationIsRaw: params.vegetationIsRaw ?? false,
        originX: params.originX,
        originY: params.originY,
      });
      const message = await this.nextJson(this.evaluationTimeoutMs);
      if (message.type !== "uploaded_vegetation_rasters") {
        throw new Error(`Unexpected upload_vegetation_rasters response: ${JSON.stringify(message)}`);
      }
      return {
        tileCount: Number((message as { tileCount?: number }).tileCount ?? 0),
        dataBytes: Number((message as { dataBytes?: number }).dataBytes ?? 0),
        elapsedMs: Number((message as { elapsedMs?: number }).elapsedMs ?? 0),
      };
    });
  }

  /**
   * Upload the SwissALTI3D terrain rasters (LV95) so the shader can
   * ray-march the local DEM — shortcut 2b.11 on GPU. Same layout as
   * uploadVegetationRasters.
   */
  async uploadTerrainRasters(
    id: number,
    params: {
      terrainMetaBin: string;
      terrainDataBin: string;
      terrainNodata: number;
      terrainStepMeters: number;
      terrainMaxDistanceMeters: number;
      terrainAltitudeGateDeg: number;
      originX: number;
      originY: number;
    },
  ): Promise<{ tileCount: number; dataBytes: number; elapsedMs: number }> {
    return this.withIpcLock(async () => {
      await this.writeJson({
        id,
        command: "upload_terrain_rasters",
        terrainMetaBin: params.terrainMetaBin,
        terrainDataBin: params.terrainDataBin,
        terrainNodata: params.terrainNodata,
        terrainStepMeters: params.terrainStepMeters,
        terrainMaxDistanceMeters: params.terrainMaxDistanceMeters,
        terrainAltitudeGateDeg: params.terrainAltitudeGateDeg,
        originX: params.originX,
        originY: params.originY,
      });
      const message = await this.nextJson(this.evaluationTimeoutMs);
      if (message.type !== "uploaded_terrain_rasters") {
        throw new Error(`Unexpected upload_terrain_rasters response: ${JSON.stringify(message)}`);
      }
      return {
        tileCount: Number((message as { tileCount?: number }).tileCount ?? 0),
        dataBytes: Number((message as { dataBytes?: number }).dataBytes ?? 0),
        elapsedMs: Number((message as { elapsedMs?: number }).elapsedMs ?? 0),
      };
    });
  }

  /**
   * Replace the mesh (buildings geometry).
   * Recreates vertex buffer + raw_bounds. Render pipeline and
   * shadow-compute resources are kept.
   */
  async reloadMesh(
    id: number,
    meshBinPath: string,
  ): Promise<{ triangleCount: number; elapsedMs: number }> {
    return this.withIpcLock(async () => {
      await this.writeJson({
        id,
        command: "reload_mesh",
        meshBin: meshBinPath,
      });
      const message = await this.nextJson(this.evaluationTimeoutMs);
      if (message.type !== "reloaded_mesh") {
        throw new Error(`Unexpected reload_mesh response: ${JSON.stringify(message)}`);
      }
      return {
        triangleCount: Number((message as { triangleCount?: number }).triangleCount ?? 0),
        elapsedMs: Number((message as { elapsedMs?: number }).elapsedMs ?? 0),
      };
    });
  }

  async shutdown(): Promise<void> {
    if (this.hasExited()) {
      this.closeStreams();
      return;
    }
    const exitPromise = this.waitForExit();
    await this.writeJson({ id: "stop", command: "shutdown" });
    this.child.stdin.end();
    const first = await Promise.race([
      this.nextJson(5000).then((message) => ({ type: "message" as const, message })),
      exitPromise.then(() => ({ type: "exit" as const })),
    ]);
    if (first.type === "message" && first.message.type !== "shutdown") {
      throw new Error(`Unexpected Rust server shutdown message: ${JSON.stringify(first.message)}`);
    }
    await exitPromise;
    this.closeStreams();
  }

  async shutdownWithTimeout(timeoutMs = 5000): Promise<void> {
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    try {
      await Promise.race([
        this.shutdown(),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Rust server shutdown timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      await this.forceKill();
      if (!timedOut) {
        throw error;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.hasExited()) {
        this.closeStreams();
      }
    }
  }

  getStderr(): string {
    return this.stderr;
  }

  private async writeJson(value: unknown): Promise<void> {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("Rust server stdin is not writable.");
    }
    const payload = `${JSON.stringify(value)}\n`;
    if (!this.child.stdin.write(payload)) {
      await new Promise<void>((resolve) => this.child.stdin.once("drain", resolve));
    }
  }

  private async nextJson<T extends RustWgpuVulkanMessage = RustWgpuVulkanMessage>(timeoutMs = 0): Promise<T> {
    const message = await this.nextMessage(timeoutMs);
    return message.json as T;
  }

  private nextMessage(timeoutMs = 0): Promise<IpcMessage> {
    if (this.parserError) return Promise.reject(this.parserError);
    const message = this.messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = (waiter: (message: IpcMessage) => void) => {
        if (timeout) clearTimeout(timeout);
        this.child.off("error", onError);
        this.child.off("exit", onExit);
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex !== -1) this.waiters.splice(waiterIndex, 1);
      };
      const onError = (error: Error) => {
        cleanup(onMessage);
        reject(error);
      };
      const onExit = (code: number | null) => {
        cleanup(onMessage);
        reject(new Error(`Rust server exited before next message (code=${code}). stderr:\n${this.stderr}`));
      };
      this.child.once("error", onError);
      this.child.once("exit", onExit);
      const onMessage = (next: IpcMessage) => {
        cleanup(onMessage);
        resolve(next);
      };
      this.waiters.push(onMessage);
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          cleanup(onMessage);
          reject(new Error(`Rust server timed out after ${timeoutMs}ms waiting for a JSON message. stderr:\n${this.stderr}`));
        }, timeoutMs);
      }
    });
  }

  private hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private waitForExit(): Promise<void> {
    if (this.hasExited()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.child.off("exit", onExit);
        this.child.off("error", onError);
      };
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.child.once("exit", onExit);
      this.child.once("error", onError);
    });
  }

  async forceKill(): Promise<void> {
    if (!this.hasExited()) {
      try {
        this.child.kill();
      } catch {}
    }
    await Promise.race([
      this.waitForExit().catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
      }),
    ]);
    this.closeStreams();
  }

  private closeStreams(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
