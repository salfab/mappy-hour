/// <reference types="@webgpu/types" />
/**
 * WebGPU compute-shader backend for building shadow evaluation.
 *
 * Uses Dawn (via `webgpu` npm) to run the full shadow pipeline on the real GPU:
 *   1. Render depth-only shadow map (render pass, same math as headless-gl backend)
 *   2. Evaluate all query points in parallel (compute shader)
 *   3. Read back only a bitmask (~8KB instead of 64MB depth map)
 *
 * Designed for the precompute script only — the API server should use the
 * existing headless-gl or CPU backends that don't require a GPU.
 */
import { performance } from "node:perf_hooks";

import type { BuildingShadowBackend, BuildingShadowQuery, BuildingShadowResult } from "./building-shadow-backend";
import { loadBuildingsObstacleIndex } from "./buildings-shadow";
import { loadGpuMeshes } from "./gpu-mesh-loader";

type ObstacleArray = NonNullable<Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>>["obstacles"];

// ── Minimal mat4 helpers (same as gpu-building-shadow-backend) ─────────

type Mat4 = Float32Array;

function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = 2 / (n - f);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
  m[15] = 1;
  return m;
}

function mat4LookAt(
  eyeX: number, eyeY: number, eyeZ: number,
  cx: number, cy: number, cz: number,
  upX: number, upY: number, upZ: number,
): Mat4 {
  let fx = cx - eyeX, fy = cy - eyeY, fz = cz - eyeZ;
  const fLen = Math.hypot(fx, fy, fz); fx /= fLen; fy /= fLen; fz /= fLen;
  let sx = fy * upZ - fz * upY, sy = fz * upX - fx * upZ, sz = fx * upY - fy * upX;
  const sLen = Math.hypot(sx, sy, sz); sx /= sLen; sy /= sLen; sz /= sLen;
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
  const m = new Float32Array(16);
  m[0] = sx; m[1] = ux; m[2] = -fx;
  m[4] = sy; m[5] = uy; m[6] = -fy;
  m[8] = sz; m[9] = uz; m[10] = -fz;
  m[12] = -(sx * eyeX + sy * eyeY + sz * eyeZ);
  m[13] = -(ux * eyeX + uy * eyeY + uz * eyeZ);
  m[14] = fx * eyeX + fy * eyeY + fz * eyeZ;
  m[15] = 1;
  return m;
}

function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
  return out;
}

function mat4TransformVec4(m: Mat4, x: number, y: number, z: number, w: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

// ── WGSL shaders ───────────────────────────────────────────────────────

const RENDER_WGSL = `
  struct U { lightMVP: mat4x4f };
  @group(0) @binding(0) var<uniform> u: U;
  @vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
    return u.lightMVP * vec4f(pos, 1.0);
  }
  @fragment fn fs() {}
`;

const COMPUTE_WGSL = `
  struct Params {
    lightMVP: mat4x4f,
    resolution: f32,
    bias: f32,
    pointCount: u32,
    _pad: u32,
  };

  @group(0) @binding(0) var<uniform> params: Params;
  @group(0) @binding(1) var shadowMap: texture_depth_2d;
  @group(0) @binding(2) var<storage, read> points: array<vec4f>;
  @group(0) @binding(3) var<storage, read_write> results: array<atomic<u32>>;

  @compute @workgroup_size(256)
  fn main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;
    if (idx >= params.pointCount) { return; }

    let pos = points[idx].xyz;
    let clip = params.lightMVP * vec4f(pos, 1.0);
    let w = clip.w;
    if (abs(w) < 1e-10) { return; }

    let ndc = clip.xyz / w;
    let u_coord = (ndc.x * 0.5 + 0.5) * params.resolution;
    let v_coord = (ndc.y * 0.5 + 0.5) * params.resolution;
    let px = i32(floor(u_coord));
    let py = i32(floor(v_coord));
    let res = i32(params.resolution);

    if (px < 0 || px >= res || py < 0 || py >= res) { return; }

    let pointDepth = ndc.z * 0.5 + 0.5;
    let threshold = pointDepth - params.bias;

    // 2x2 sampling (same as CPU backend)
    let px1 = select(max(px - 1, 0), min(px + 1, res - 1), (u_coord - f32(px)) >= 0.5);
    let py1 = select(max(py - 1, 0), min(py + 1, res - 1), (v_coord - f32(py)) >= 0.5);

    var blocked = false;
    let d00 = textureLoad(shadowMap, vec2i(px, py), 0);
    let d10 = textureLoad(shadowMap, vec2i(px1, py), 0);
    let d01 = textureLoad(shadowMap, vec2i(px, py1), 0);
    let d11 = textureLoad(shadowMap, vec2i(px1, py1), 0);
    if (d00 < threshold || d10 < threshold || d01 < threshold || d11 < threshold) {
      blocked = true;
    }

    if (blocked) {
      let word = idx / 32u;
      let bit = idx % 32u;
      atomicOr(&results[word], 1u << bit);
    }
  }
`;

// ── Backend class ──────────────────────────────────────────────────────

export class WebGpuComputeShadowBackend implements BuildingShadowBackend {
  readonly name: string;
  readonly resolution: number;
  readonly triangleCount: number;

  lastPrepareMs = 0;
  lastComputeMs = 0;

  private device: GPUDevice;
  private meshVbo: GPUBuffer;
  private vertexCount: number;
  private depthTexture: GPUTexture;
  private renderPipeline: GPURenderPipeline;
  private renderUniformBuf: GPUBuffer;
  private renderBindGroup: GPUBindGroup;
  private computePipeline: GPUComputePipeline;
  private computeParamsBuf: GPUBuffer;
  private computeBGL: GPUBindGroupLayout;

  private originX: number;
  private originY: number;
  private sceneBboxMin: [number, number, number];
  private sceneBboxMax: [number, number, number];

  private frustumFocus: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private frustumMaxBuildingHeight = 100;
  private lightMVP: Mat4 = mat4Identity();
  private lastPreparedAz = NaN;
  private lastPreparedAlt = NaN;

  private static readonly SHADOW_BIAS = 0.0002;

  private constructor(
    device: GPUDevice,
    meshVbo: GPUBuffer,
    vertexCount: number,
    depthTexture: GPUTexture,
    renderPipeline: GPURenderPipeline,
    renderUniformBuf: GPUBuffer,
    renderBindGroup: GPUBindGroup,
    computePipeline: GPUComputePipeline,
    computeParamsBuf: GPUBuffer,
    computeBGL: GPUBindGroupLayout,
    sceneBbox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
    originX: number,
    originY: number,
    resolution: number,
    triangleCount: number,
    adapterDesc: string,
  ) {
    this.device = device;
    this.meshVbo = meshVbo;
    this.vertexCount = vertexCount;
    this.depthTexture = depthTexture;
    this.renderPipeline = renderPipeline;
    this.renderUniformBuf = renderUniformBuf;
    this.renderBindGroup = renderBindGroup;
    this.computePipeline = computePipeline;
    this.computeParamsBuf = computeParamsBuf;
    this.computeBGL = computeBGL;
    this.originX = originX;
    this.originY = originY;
    this.resolution = resolution;
    this.triangleCount = triangleCount;
    this.sceneBboxMin = [sceneBbox.minX - originX, sceneBbox.minZ, sceneBbox.minY - originY];
    this.sceneBboxMax = [sceneBbox.maxX - originX, sceneBbox.maxZ, sceneBbox.maxY - originY];
    this.name = `webgpu-compute-${resolution} (${adapterDesc})`;
  }

  static async createWithDxfMeshes(
    obstacles: ObstacleArray,
    resolution = 4096,
  ): Promise<WebGpuComputeShadowBackend> {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const obs of obstacles) {
      if (obs.minX < minX) minX = obs.minX;
      if (obs.minY < minY) minY = obs.minY;
      if (obs.minZ < minZ) minZ = obs.minZ;
      if (obs.maxX > maxX) maxX = obs.maxX;
      if (obs.maxY > maxY) maxY = obs.maxY;
      if (obs.maxZ > maxZ) maxZ = obs.maxZ;
    }
    const originX = (minX + maxX) / 2;
    const originY = (minY + maxY) / 2;

    const meshResult = await loadGpuMeshes(obstacles, originX, originY);

    return WebGpuComputeShadowBackend.create(
      meshResult.vertices,
      { minX, minY, minZ, maxX, maxY, maxZ },
      originX, originY,
      resolution,
      meshResult.dxfTriangleCount + meshResult.fallbackTriangleCount,
    );
  }

  private static async create(
    vertices: Float32Array,
    sceneBbox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
    originX: number,
    originY: number,
    resolution: number,
    triangleCount: number,
  ): Promise<WebGpuComputeShadowBackend> {
    const { createRequire } = await import("node:module");
    const { join } = await import("node:path");
    const nodeRequire = createRequire(join(process.cwd(), "package.json"));
    const webgpu = nodeRequire("webgpu");
    const globals = webgpu.globals as Record<string, unknown>;
    for (const [key, value] of Object.entries(globals)) {
      (globalThis as Record<string, unknown>)[key] = value;
    }

    const gpu = webgpu.create([]);
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter found");

    const proto = Object.getPrototypeOf(adapter.info);
    const desc = Object.getOwnPropertyDescriptor(proto, "description")?.get?.call(adapter.info) ?? "unknown";
    const vendor = Object.getOwnPropertyDescriptor(proto, "vendor")?.get?.call(adapter.info) ?? "unknown";
    const device = Object.getOwnPropertyDescriptor(proto, "device")?.get?.call(adapter.info) ?? "unknown";

    const gpuDevice: GPUDevice = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: 256 * 1024 * 1024,
        maxBufferSize: Math.max(vertices.byteLength + 256, 256 * 1024 * 1024),
      },
    });

    console.log(`[webgpu-compute] adapter: ${vendor} ${device} (${desc})`);

    // Dawn/D3D12 segfaults on process exit if the device is not explicitly destroyed.
    let destroyed = false;
    const safeDestroy = () => {
      if (destroyed) return;
      destroyed = true;
      try { gpuDevice.destroy(); } catch {}
    };
    process.on("exit", safeDestroy);
    process.on("SIGINT", () => { safeDestroy(); process.exit(130); });
    process.on("SIGTERM", () => { safeDestroy(); process.exit(143); });
    (gpuDevice as unknown as { __safeDestroy: () => void }).__safeDestroy = safeDestroy;

    const meshVbo = gpuDevice.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    gpuDevice.queue.writeBuffer(meshVbo, 0, vertices as unknown as ArrayBuffer);

    const depthTexture = gpuDevice.createTexture({
      size: [resolution, resolution],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const renderUniformBuf = gpuDevice.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const renderShader = gpuDevice.createShaderModule({ code: RENDER_WGSL });
    const renderBGL = gpuDevice.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const renderBG = gpuDevice.createBindGroup({
      layout: renderBGL,
      entries: [{ binding: 0, resource: { buffer: renderUniformBuf } }],
    });
    const renderPipeline = gpuDevice.createRenderPipeline({
      layout: gpuDevice.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
      vertex: {
        module: renderShader,
        entryPoint: "vs",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }],
        }],
      },
      fragment: { module: renderShader, entryPoint: "fs", targets: [] },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
      primitive: { topology: "triangle-list" },
    });

    const computeShader = gpuDevice.createShaderModule({ code: COMPUTE_WGSL });
    const computeParamsBuf = gpuDevice.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const computeBGL = gpuDevice.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const computePipeline = gpuDevice.createComputePipeline({
      layout: gpuDevice.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
      compute: { module: computeShader, entryPoint: "main" },
    });

    return new WebGpuComputeShadowBackend(
      gpuDevice, meshVbo, vertices.length / 3,
      depthTexture, renderPipeline, renderUniformBuf, renderBG,
      computePipeline, computeParamsBuf, computeBGL,
      sceneBbox, originX, originY, resolution, triangleCount,
      `${vendor} ${device}`,
    );
  }

  setFrustumFocus(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    maxBuildingHeight: number,
  ): void {
    this.frustumFocus = { ...bounds };
    this.frustumMaxBuildingHeight = maxBuildingHeight;
  }

  private computeLightMVP(azimuthDeg: number, altitudeDeg: number): Mat4 {
    const azRad = (azimuthDeg * Math.PI) / 180;
    const altRad = (altitudeDeg * Math.PI) / 180;
    const sunDirX = Math.sin(azRad) * Math.cos(altRad);
    const sunDirY = Math.sin(altRad);
    const sunDirZ = Math.cos(azRad) * Math.cos(altRad);

    let fMinX: number, fMaxX: number, fMinZ: number, fMaxZ: number;
    let fMinY: number, fMaxY: number;

    if (this.frustumFocus) {
      const minAltForExtension = Math.max(altitudeDeg, 2);
      const shadowReach = this.frustumMaxBuildingHeight / Math.tan(minAltForExtension * Math.PI / 180);
      const ext = Math.min(shadowReach, 2500);
      const foc = this.frustumFocus;
      const hSunX = Math.sin(azRad);
      const hSunZ = Math.cos(azRad);

      fMinX = foc.minX - this.originX;
      fMaxX = foc.maxX - this.originX;
      fMinZ = foc.minY - this.originY;
      fMaxZ = foc.maxY - this.originY;

      if (hSunX > 0) fMaxX += ext * hSunX; else fMinX += ext * hSunX;
      if (hSunZ > 0) fMaxZ += ext * hSunZ; else fMinZ += ext * hSunZ;

      const lateralPad = 50;
      fMinX -= lateralPad; fMaxX += lateralPad;
      fMinZ -= lateralPad; fMaxZ += lateralPad;

      fMinX = Math.max(fMinX, this.sceneBboxMin[0]);
      fMaxX = Math.min(fMaxX, this.sceneBboxMax[0]);
      fMinZ = Math.max(fMinZ, this.sceneBboxMin[2]);
      fMaxZ = Math.min(fMaxZ, this.sceneBboxMax[2]);
      fMinY = this.sceneBboxMin[1]; fMaxY = this.sceneBboxMax[1];
    } else {
      fMinX = this.sceneBboxMin[0]; fMaxX = this.sceneBboxMax[0];
      fMinY = this.sceneBboxMin[1]; fMaxY = this.sceneBboxMax[1];
      fMinZ = this.sceneBboxMin[2]; fMaxZ = this.sceneBboxMax[2];
    }

    const cx = (fMinX + fMaxX) / 2;
    const cy = (fMinY + fMaxY) / 2;
    const cz = (fMinZ + fMaxZ) / 2;

    let upX = 0, upY = 1, upZ = 0;
    if (Math.abs(altitudeDeg) > 85) { upX = 0; upY = 0; upZ = -1; }

    const focusRadius = Math.hypot(fMaxX - fMinX, fMaxY - fMinY, fMaxZ - fMinZ) / 2;
    const eyeDist = focusRadius * 3;
    const eyeX = cx + sunDirX * eyeDist;
    const eyeY = cy + sunDirY * eyeDist;
    const eyeZ = cz + sunDirZ * eyeDist;

    const view = mat4LookAt(eyeX, eyeY, eyeZ, cx, cy, cz, upX, upY, upZ);

    let lsMinX = Infinity, lsMaxX = -Infinity;
    let lsMinY = Infinity, lsMaxY = -Infinity;
    let lsMinZ = Infinity, lsMaxZ = -Infinity;
    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let iz = 0; iz < 2; iz++) {
          const wx = ix === 0 ? fMinX : fMaxX;
          const wy = iy === 0 ? fMinY : fMaxY;
          const wz = iz === 0 ? fMinZ : fMaxZ;
          const lv = mat4TransformVec4(view, wx, wy, wz, 1);
          const lx = lv[0] / lv[3], ly = lv[1] / lv[3], lz = lv[2] / lv[3];
          if (lx < lsMinX) lsMinX = lx; if (lx > lsMaxX) lsMaxX = lx;
          if (ly < lsMinY) lsMinY = ly; if (ly > lsMaxY) lsMaxY = ly;
          if (lz < lsMinZ) lsMinZ = lz; if (lz > lsMaxZ) lsMaxZ = lz;
        }
      }
    }

    const near = -lsMaxZ - 1;
    const far = -lsMinZ + 1;
    const proj = mat4Ortho(lsMinX, lsMaxX, lsMinY, lsMaxY, near, far);
    return mat4Multiply(proj, view);
  }

  prepareSunPosition(azimuthDeg: number, altitudeDeg: number): void {
    const roundedAz = Math.round(azimuthDeg);
    const roundedAlt = Math.round(altitudeDeg);
    if (roundedAz === this.lastPreparedAz && roundedAlt === this.lastPreparedAlt) return;
    this.lastPreparedAz = roundedAz;
    this.lastPreparedAlt = roundedAlt;
    this.lightMVP = this.computeLightMVP(azimuthDeg, altitudeDeg);
  }

  evaluate(_query: BuildingShadowQuery): BuildingShadowResult {
    return { blocked: false, blockerId: null, blockerDistanceMeters: null, blockerAltitudeAngleDeg: null };
  }

  async evaluateBatch(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
  ): Promise<Uint32Array> {
    const t0 = performance.now();
    const lightMVP = this.computeLightMVP(azimuthDeg, altitudeDeg);

    const device = this.device;
    const resolution = this.resolution;
    const resultWords = Math.ceil(pointCount / 32);
    const resultBufSize = Math.max(resultWords * 4, 4);

    device.queue.writeBuffer(this.renderUniformBuf, 0, lightMVP as unknown as ArrayBuffer);

    const paramsData = new ArrayBuffer(80);
    new Float32Array(paramsData, 0, 16).set(lightMVP);
    const pv = new DataView(paramsData);
    pv.setFloat32(64, resolution, true);
    pv.setFloat32(68, WebGpuComputeShadowBackend.SHADOW_BIAS, true);
    pv.setUint32(72, pointCount, true);
    pv.setUint32(76, 0, true);
    device.queue.writeBuffer(this.computeParamsBuf, 0, new Uint8Array(paramsData));

    const pointsBuf = device.createBuffer({
      size: points.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(pointsBuf, 0, points as unknown as ArrayBuffer);

    const resultBuf = device.createBuffer({
      size: resultBufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readbackBuf = device.createBuffer({
      size: resultBufSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const computeBG = device.createBindGroup({
      layout: this.computeBGL,
      entries: [
        { binding: 0, resource: { buffer: this.computeParamsBuf } },
        { binding: 1, resource: this.depthTexture.createView() },
        { binding: 2, resource: { buffer: pointsBuf } },
        { binding: 3, resource: { buffer: resultBuf } },
      ],
    });

    const enc = device.createCommandEncoder();

    const rp = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    rp.setPipeline(this.renderPipeline);
    rp.setBindGroup(0, this.renderBindGroup);
    rp.setVertexBuffer(0, this.meshVbo);
    rp.draw(this.vertexCount);
    rp.end();

    const cp = enc.beginComputePass();
    cp.setPipeline(this.computePipeline);
    cp.setBindGroup(0, computeBG);
    cp.dispatchWorkgroups(Math.ceil(pointCount / 256));
    cp.end();

    enc.copyBufferToBuffer(resultBuf, 0, readbackBuf, 0, resultBufSize);

    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();

    const tGpu = performance.now();
    this.lastPrepareMs = tGpu - t0;

    await readbackBuf.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(readbackBuf.getMappedRange().slice(0));
    readbackBuf.unmap();

    this.lastComputeMs = performance.now() - t0;

    pointsBuf.destroy();
    resultBuf.destroy();
    readbackBuf.destroy();

    return result;
  }

  getOrigin(): { x: number; y: number } {
    return { x: this.originX, y: this.originY };
  }

  dispose(): void {
    const safeDestroy = (this.device as unknown as { __safeDestroy?: () => void }).__safeDestroy;
    if (safeDestroy) {
      process.removeListener("exit", safeDestroy);
      process.removeListener("SIGINT", safeDestroy);
      process.removeListener("SIGTERM", safeDestroy);
    }
    this.meshVbo.destroy();
    this.depthTexture.destroy();
    this.renderUniformBuf.destroy();
    this.computeParamsBuf.destroy();
    this.device.destroy();
  }
}
