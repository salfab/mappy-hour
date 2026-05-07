/**
 * IPC client for the WebGPU GPU worker process.
 *
 * Uses spawn() + stdin/stdout JSON lines instead of fork() + IPC
 * to fully isolate the Dawn D3D12 process from the parent.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { BatchBuildingShadowBackend, BuildingShadowQuery, BuildingShadowResult } from "./building-shadow-backend";

type Msg = Record<string, unknown>;
type FocusBounds = { minX: number; minY: number; maxX: number; maxY: number };
const DEFAULT_MAX_BATCH_POINTS = 65_536;

function getMaxBatchPoints(): number {
  const parsed = Number(process.env.MAPPY_WEBGPU_IPC_MAX_BATCH_POINTS ?? DEFAULT_MAX_BATCH_POINTS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BATCH_POINTS;
}

export class WebGpuIpcClient implements BatchBuildingShadowBackend {
  readonly name: string;
  private child: ChildProcess;
  private originX: number;
  private originY: number;
  private pendingResolve: ((msg: Msg) => void) | null = null;
  private rl: ReturnType<typeof createInterface>;

  private constructor(child: ChildProcess, rl: ReturnType<typeof createInterface>, name: string, originX: number, originY: number) {
    this.child = child;
    this.rl = rl;
    this.name = name;
    this.originX = originX;
    this.originY = originY;

    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line) as Msg;
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.pendingResolve = null;
          resolve(msg);
        }
      } catch {}
    });

    child.on("exit", (code, signal) => {
      console.error(`[webgpu-ipc] Worker exited: code=${code} signal=${signal}`);
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        resolve({ type: "error", error: `Worker exited (code=${code}, signal=${signal})` });
      }
    });
    child.stdin?.on("error", (error) => {
      console.error(`[webgpu-ipc] Worker stdin error: ${error.message}`);
    });
  }

  private sendAndWait(msg: Msg): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const stdin = this.child.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        reject(new Error("GPU worker stdin is not writable"));
        return;
      }

      let timeout: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        timeout = null;
        stdin.off("error", onStdinError);
      };
      const fail = (error: Error) => {
        if (this.pendingResolve === onResponse) {
          this.pendingResolve = null;
          cleanup();
          reject(error);
        }
      };
      const onStdinError = (error: Error) => {
        fail(new Error(`GPU worker stdin write failed: ${error.message}`));
      };
      const onResponse = (response: Msg) => {
        cleanup();
        resolve(response);
      };

      this.pendingResolve = onResponse;
      stdin.once("error", onStdinError);
      timeout = setTimeout(() => {
        fail(new Error("GPU worker timeout (60s)"));
      }, 60_000);

      try {
        // write() returning false means backpressure, not failure. The worker
        // will still receive the line; the timeout above protects us if it does not.
        stdin.write(JSON.stringify(msg) + "\n", (error: Error | null | undefined) => {
          if (error) {
            fail(new Error(`GPU worker stdin write failed: ${error.message}`));
          }
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  static async create(region = "lausanne", focusBounds?: FocusBounds): Promise<WebGpuIpcClient> {
    const workerPath = join(__dirname, "webgpu-worker-process.ts");

    // Spawn a completely separate process (not fork) with stdio pipes
    const execArgv = process.execArgv.length > 0 ? [...process.execArgv] : ["--import", "tsx/esm"];
    const child = spawn(process.execPath, [...execArgv, workerPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env },
    });

    const rl = createInterface({ input: child.stdout! });

    // Wait for "waiting" message
    const waitingMsg = await new Promise<Msg>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        timeout = null;
        rl.off("line", onLine);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onLine = (line: string) => {
        try {
          const msg = JSON.parse(line) as Msg;
          cleanup();
          resolve(msg);
        } catch {}
      };
      const onError = (error: Error) => fail(error);
      const onExit = (code: number | null) => fail(new Error(`GPU worker exited with code ${code}`));
      rl.on("line", onLine);
      child.on("error", onError);
      child.on("exit", onExit);
      timeout = setTimeout(() => fail(new Error("GPU worker startup timeout")), 30_000);
      timeout.unref?.();
    });

    if (waitingMsg.type !== "waiting") {
      child.kill();
      throw new Error(`Unexpected startup: ${JSON.stringify(waitingMsg)}`);
    }

    // Send init
    const initResult = await new Promise<Msg>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        timeout = null;
        rl.off("line", onLine);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onLine = (line: string) => {
        try {
          const msg = JSON.parse(line) as Msg;
          cleanup();
          resolve(msg);
        } catch {}
      };
      const onError = (error: Error) => fail(error);
      const onExit = (code: number | null) => fail(new Error(`GPU worker exited with code ${code}`));
      rl.on("line", onLine);
      child.on("error", onError);
      child.on("exit", onExit);
      child.stdin!.write(JSON.stringify({ type: "init", region, focusBounds }) + "\n");
      timeout = setTimeout(() => fail(new Error("GPU worker init timeout")), 120_000);
      timeout.unref?.();
    });

    if (initResult.type !== "ready") {
      child.kill();
      throw new Error(`GPU worker init failed: ${initResult.error ?? JSON.stringify(initResult)}`);
    }

    console.log(`[webgpu-ipc] Worker ready: ${initResult.name}`);

    return new WebGpuIpcClient(
      child, rl,
      `webgpu-ipc (${initResult.name})`,
      initResult.originX as number,
      initResult.originY as number,
    );
  }

  getOrigin(): { x: number; y: number } {
    return { x: this.originX, y: this.originY };
  }

  async setFrustumFocus(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    maxBuildingHeight: number,
  ): Promise<void> {
    const result = await this.sendAndWait({ type: "focus", ...bounds, maxH: maxBuildingHeight });
    if (result.type === "error") throw new Error(result.error as string);
  }

  async evaluateBatch(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
  ): Promise<Uint32Array> {
    const maxBatchPoints = getMaxBatchPoints();
    if (pointCount > maxBatchPoints) {
      const result = new Uint32Array(Math.ceil(pointCount / 32));
      for (let offset = 0; offset < pointCount; offset += maxBatchPoints) {
        const chunkPointCount = Math.min(maxBatchPoints, pointCount - offset);
        const chunk = points.subarray(offset * 4, (offset + chunkPointCount) * 4);
        const chunkMask = await this.evaluateBatchChunk(
          chunk,
          chunkPointCount,
          azimuthDeg,
          altitudeDeg,
        );
        for (let localIndex = 0; localIndex < chunkPointCount; localIndex += 1) {
          if (((chunkMask[localIndex >>> 5] >>> (localIndex & 31)) & 1) === 1) {
            result[(offset + localIndex) >>> 5] |= 1 << ((offset + localIndex) & 31);
          }
        }
      }
      return result;
    }

    return this.evaluateBatchChunk(points, pointCount, azimuthDeg, altitudeDeg);
  }

  private async evaluateBatchChunk(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
  ): Promise<Uint32Array> {
    const pointsBuf = Buffer.from(points.buffer, points.byteOffset, points.byteLength);
    const result = await this.sendAndWait({
      type: "evaluate",
      pointsBuf: pointsBuf.toString("base64"),
      pointCount,
      azimuth: azimuthDeg,
      altitude: altitudeDeg,
    });
    if (result.type === "error") throw new Error(result.error as string);
    const maskBuf = Buffer.from(result.maskBuf as string, "base64");
    return new Uint32Array(maskBuf.buffer, maskBuf.byteOffset, maskBuf.byteLength / 4);
  }

  prepareSunPosition(): void {}
  evaluate(_query: BuildingShadowQuery): BuildingShadowResult {
    return { blocked: false, blockerId: null, blockerDistanceMeters: null, blockerAltitudeAngleDeg: null };
  }

  dispose(): void {
    try { this.child.stdin!.write(JSON.stringify({ type: "dispose" }) + "\n"); } catch {}
    const killTimer = setTimeout(() => { try { this.child.kill(); } catch {} }, 5000);
    killTimer.unref?.();
  }
}
