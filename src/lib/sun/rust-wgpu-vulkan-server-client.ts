/**
 * Experimental TypeScript client for the native Rust wgpu/Vulkan shadow server.
 *
 * This is server-side only. It exists to validate a long-lived native process
 * before deciding whether Rust/wgpu Vulkan should become a supported backend.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

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

export class RustWgpuVulkanShadowServer {
  private child: ChildProcessWithoutNullStreams;
  private reader: readline.Interface;
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private stderr = "";
  private evaluationTimeoutMs: number;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams, evaluationTimeoutMs: number) {
    this.child = child;
    this.evaluationTimeoutMs = evaluationTimeoutMs;
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
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
  }

  /**
   * Replace the points buffer without restarting the server.
   * Keeps mesh, depth texture, render pipeline alive.
   */
  async reloadPoints(
    id: number,
    pointsBinPath: string,
  ): Promise<{ pointCount: number; elapsedMs: number }> {
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
    const line = await this.nextLine(timeoutMs);
    return JSON.parse(line) as T;
  }

  private nextLine(timeoutMs = 0): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = (waiter: (line: string) => void) => {
        if (timeout) clearTimeout(timeout);
        this.child.off("error", onError);
        this.child.off("exit", onExit);
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex !== -1) this.waiters.splice(waiterIndex, 1);
      };
      const onError = (error: Error) => {
        cleanup(onLine);
        reject(error);
      };
      const onExit = (code: number | null) => {
        cleanup(onLine);
        reject(new Error(`Rust server exited before next line (code=${code}). stderr:\n${this.stderr}`));
      };
      this.child.once("error", onError);
      this.child.once("exit", onExit);
      const onLine = (next: string) => {
        cleanup(onLine);
        resolve(next);
      };
      this.waiters.push(onLine);
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          cleanup(onLine);
          reject(new Error(`Rust server timed out after ${timeoutMs}ms waiting for a JSON line. stderr:\n${this.stderr}`));
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

  private async forceKill(): Promise<void> {
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
    this.reader.close();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
