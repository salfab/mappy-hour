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
  }

  private sendAndWait(msg: Msg): Promise<Msg> {
    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      const ok = this.child.stdin!.write(JSON.stringify(msg) + "\n");
      if (!ok) {
        this.pendingResolve = null;
        reject(new Error("GPU worker stdin write failed"));
        return;
      }
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          reject(new Error("GPU worker timeout (60s)"));
        }
      }, 60_000);
    });
  }

  static async create(region = "lausanne"): Promise<WebGpuIpcClient> {
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
      const onLine = (line: string) => {
        try {
          const msg = JSON.parse(line) as Msg;
          rl.off("line", onLine);
          resolve(msg);
        } catch {}
      };
      rl.on("line", onLine);
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`GPU worker exited with code ${code}`)));
      setTimeout(() => reject(new Error("GPU worker startup timeout")), 30_000);
    });

    if (waitingMsg.type !== "waiting") {
      child.kill();
      throw new Error(`Unexpected startup: ${JSON.stringify(waitingMsg)}`);
    }

    // Send init
    const initResult = await new Promise<Msg>((resolve, reject) => {
      const onLine = (line: string) => {
        try {
          const msg = JSON.parse(line) as Msg;
          rl.off("line", onLine);
          resolve(msg);
        } catch {}
      };
      rl.on("line", onLine);
      child.stdin!.write(JSON.stringify({ type: "init", region }) + "\n");
      setTimeout(() => reject(new Error("GPU worker init timeout")), 120_000);
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
    setTimeout(() => { try { this.child.kill(); } catch {} }, 5000);
  }
}
