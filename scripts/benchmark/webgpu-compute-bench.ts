/**
 * Benchmark: WebGPU compute shader shadow evaluation.
 *
 * Full pipeline on GPU:
 *   1. Render depth-only shadow map (render pass)
 *   2. Evaluate all query points in parallel (compute shader)
 *   3. Read back only the result bitmask (~8KB instead of 64MB)
 *
 * Compared against headless-gl render + CPU evaluate (current approach).
 *
 * Usage:
 *   MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster npx tsx scripts/benchmark/webgpu-compute-bench.ts
 */
import { performance } from "node:perf_hooks";

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

// ── WebGPU compute shader pipeline ─────────────────────────────────────

const SHADOW_EVAL_WGSL = `
  struct Params {
    lightMVP: mat4x4f,
    resolution: f32,
    bias: f32,
    pointCount: u32,
    _pad: u32,
  };

  @group(0) @binding(0) var<uniform> params: Params;
  @group(0) @binding(1) var depthTex: texture_depth_2d;
  @group(0) @binding(2) var<storage, read> points: array<vec4f>;  // xyz + padding
  @group(0) @binding(3) var<storage, read_write> results: array<atomic<u32>>;  // bitmask

  @compute @workgroup_size(256)
  fn main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;
    if (idx >= params.pointCount) { return; }

    let pos = points[idx].xyz;
    let clip = params.lightMVP * vec4f(pos, 1.0);
    let w = clip.w;
    if (abs(w) < 1e-10) { return; }

    let ndc = clip.xyz / w;
    let u = (ndc.x * 0.5 + 0.5) * params.resolution;
    let v = (ndc.y * 0.5 + 0.5) * params.resolution;
    let px = i32(floor(u));
    let py = i32(floor(v));
    let res = i32(params.resolution);

    if (px < 0 || px >= res || py < 0 || py >= res) { return; }

    let pointDepth = ndc.z * 0.5 + 0.5;
    let threshold = pointDepth - params.bias;

    // Sample depth texture (float32)
    let storedDepth = textureLoad(depthTex, vec2i(px, py), 0);
    if (storedDepth < threshold) {
      // Point is in shadow — set bit in bitmask
      let word = idx / 32u;
      let bit = idx % 32u;
      atomicOr(&results[word], 1u << bit);
    }
  }
`;

async function benchWebGpuCompute(
  meshVertices: Float32Array,
  queryPoints: Float32Array,  // Nx4 (x, y, z, 0)
  pointCount: number,
  resolution: number,
  iterations: number,
): Promise<{ renderMs: number[]; computeMs: number[]; readbackMs: number[]; totalMs: number[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const webgpu = require("webgpu");
  const globals = webgpu.globals as Record<string, unknown>;
  for (const [key, value] of Object.entries(globals)) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
  const gpu = webgpu.create([]);
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");

  const device: GPUDevice = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.max(queryPoints.byteLength, 256) + 256,
      maxBufferSize: Math.max(meshVertices.byteLength, queryPoints.byteLength) + 256,
    },
  });

  // ── Render pipeline (depth-only shadow map) ──────────────────────────

  const meshVbo = device.createBuffer({
    size: meshVertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(meshVbo, 0, meshVertices);

  const depthTexture = device.createTexture({
    size: [resolution, resolution],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  const renderUniformBuf = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const renderBGL = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
  });
  const renderBG = device.createBindGroup({
    layout: renderBGL,
    entries: [{ binding: 0, resource: { buffer: renderUniformBuf } }],
  });

  const renderShader = device.createShaderModule({
    code: `
      struct U { lightMVP: mat4x4f };
      @group(0) @binding(0) var<uniform> u: U;
      @vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
        return u.lightMVP * vec4f(pos, 1.0);
      }
      @fragment fn fs() {}
    `,
  });

  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
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

  // ── Compute pipeline (shadow evaluation) ─────────────────────────────

  const computeShader = device.createShaderModule({ code: SHADOW_EVAL_WGSL });

  const resultWords = Math.ceil(pointCount / 32);
  const resultBufSize = resultWords * 4;

  const paramsBuffer = device.createBuffer({
    size: 96, // mat4x4f(64) + 4 floats(16) = 80, round to 96
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const pointsBuf = device.createBuffer({
    size: queryPoints.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(pointsBuf, 0, queryPoints);

  const resultBuf = device.createBuffer({
    size: resultBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: resultBufSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const computeBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });

  const computeBG = device.createBindGroup({
    layout: computeBGL,
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: depthTexture.createView() },
      { binding: 2, resource: { buffer: pointsBuf } },
      { binding: 3, resource: { buffer: resultBuf } },
    ],
  });

  const computePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
    compute: { module: computeShader, entryPoint: "main" },
  });

  // ── Build a plausible light MVP matrix ───────────────────────────────
  // Simple orthographic from a 45° sun angle looking at the scene center
  const mvp = new Float32Array(16);
  mvp[0] = 0.0004; mvp[5] = 0.0004; mvp[10] = -0.0002; mvp[15] = 1;

  // Params: lightMVP(64 bytes) + resolution(4) + bias(4) + pointCount(4) + pad(4)
  const paramsData = new ArrayBuffer(80);
  new Float32Array(paramsData, 0, 16).set(mvp);
  const paramsView = new DataView(paramsData);
  paramsView.setFloat32(64, resolution, true);
  paramsView.setFloat32(68, 0.0002, true);
  paramsView.setUint32(72, pointCount, true);
  paramsView.setUint32(76, 0, true);

  device.queue.writeBuffer(renderUniformBuf, 0, mvp);
  device.queue.writeBuffer(paramsBuffer, 0, new Uint8Array(paramsData));

  const vertexCount = meshVertices.length / 3;
  const workgroups = Math.ceil(pointCount / 256);

  const renderMs: number[] = [];
  const computeMs: number[] = [];
  const readbackMs: number[] = [];
  const totalMs: number[] = [];

  // Warmup
  for (let i = 0; i < 3; i++) {
    const enc = device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    rp.setPipeline(renderPipeline);
    rp.setBindGroup(0, renderBG);
    rp.setVertexBuffer(0, meshVbo);
    rp.draw(vertexCount);
    rp.end();
    const cp = enc.beginComputePass();
    cp.setPipeline(computePipeline);
    cp.setBindGroup(0, computeBG);
    cp.dispatchWorkgroups(workgroups);
    cp.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  }

  // Bench
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();

    // 1. Render shadow map
    const enc = device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    rp.setPipeline(renderPipeline);
    rp.setBindGroup(0, renderBG);
    rp.setVertexBuffer(0, meshVbo);
    rp.draw(vertexCount);
    rp.end();

    // 2. Compute shader: evaluate all points
    const cp = enc.beginComputePass();
    cp.setPipeline(computePipeline);
    cp.setBindGroup(0, computeBG);
    cp.dispatchWorkgroups(workgroups);
    cp.end();

    // 3. Copy results to readback buffer
    enc.copyBufferToBuffer(resultBuf, 0, readbackBuf, 0, resultBufSize);

    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    const tGpu = performance.now();
    renderMs.push(tGpu - t0);

    // 4. Map and read back bitmask
    await readbackBuf.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(readbackBuf.getMappedRange().slice(0));
    readbackBuf.unmap();
    const tReadback = performance.now();

    // Count shadow bits for sanity check
    let shadowCount = 0;
    for (let w = 0; w < data.length; w++) {
      let bits = data[w];
      while (bits) { shadowCount += bits & 1; bits >>>= 1; }
    }

    readbackMs.push(tReadback - tGpu);
    computeMs.push(0); // included in renderMs since we can't separate GPU passes
    totalMs.push(tReadback - t0);

    if (i === 0) {
      console.log(`    [sanity] ${shadowCount}/${pointCount} points in shadow (${(100 * shadowCount / pointCount).toFixed(1)}%)`);
      console.log(`    [sanity] readback size: ${resultBufSize} bytes (vs 64MB for full depth map)`);
    }
  }

  device.destroy();
  return { renderMs, computeMs, readbackMs, totalMs };
}

// ── headless-gl + CPU evaluate (current approach) ──────────────────────

async function benchHeadlessGlCpu(
  meshVertices: Float32Array,
  queryPoints: Float32Array,
  pointCount: number,
  resolution: number,
  iterations: number,
): Promise<{ totalMs: number[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createContext = require("gl");
  const gl = createContext(resolution, resolution, { preserveDrawingBuffer: true });

  const VERT = `
    attribute vec3 aPosition;
    uniform mat4 uLightMVP;
    void main() { gl_Position = uLightMVP * vec4(aPosition, 1.0); }
  `;
  const FRAG = `
    precision highp float;
    void main() {
      float d = gl_FragCoord.z;
      vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * d;
      enc = fract(enc);
      enc -= enc.yzww * vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
      gl_FragColor = enc;
    }
  `;

  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, VERT); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, FRAG); gl.compileShader(fs);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  const uLoc = gl.getUniformLocation(prog, "uLightMVP")!;
  const aLoc = gl.getAttribLocation(prog, "aPosition");
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, meshVertices, gl.STATIC_DRAW);

  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const colorTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, colorTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, resolution, resolution, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
  const depthRb = gl.createRenderbuffer()!;
  gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, resolution, resolution);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);

  const mvp = new Float32Array(16);
  mvp[0] = 0.0004; mvp[5] = 0.0004; mvp[10] = -0.0002; mvp[15] = 1;
  const readBuf = new Uint8Array(resolution * resolution * 4);
  const vertexCount = meshVertices.length / 3;
  const BIAS = 0.0002;

  function unpackDepth(r: number, g: number, b: number, a: number): number {
    return r / 255 + g / 65025 + b / 16581375 + a / 4228250625;
  }

  const totalMs: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();

    // Render
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, resolution, resolution);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(uLoc, false, mvp);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

    // Readback full depth map
    gl.readPixels(0, 0, resolution, resolution, gl.RGBA, gl.UNSIGNED_BYTE, readBuf);

    // CPU evaluate all points
    let shadowCount = 0;
    for (let p = 0; p < pointCount; p++) {
      const px = queryPoints[p * 4];
      const py = queryPoints[p * 4 + 1];
      const pz = queryPoints[p * 4 + 2];

      // Transform
      const cx = mvp[0] * px + mvp[4] * py + mvp[8] * pz + mvp[12];
      const cy = mvp[1] * px + mvp[5] * py + mvp[9] * pz + mvp[13];
      const cz = mvp[2] * px + mvp[6] * py + mvp[10] * pz + mvp[14];
      const cw = mvp[3] * px + mvp[7] * py + mvp[11] * pz + mvp[15];
      if (Math.abs(cw) < 1e-10) continue;

      const ndcX = cx / cw;
      const ndcY = cy / cw;
      const ndcZ = cz / cw;

      const u = (ndcX * 0.5 + 0.5) * resolution;
      const v = (ndcY * 0.5 + 0.5) * resolution;
      const ix = Math.floor(u);
      const iy = Math.floor(v);
      if (ix < 0 || ix >= resolution || iy < 0 || iy >= resolution) continue;

      const pointDepth = ndcZ * 0.5 + 0.5;
      const threshold = pointDepth - BIAS;
      const off = (iy * resolution + ix) * 4;
      const sd = unpackDepth(readBuf[off], readBuf[off + 1], readBuf[off + 2], readBuf[off + 3]);
      if (sd < threshold) shadowCount++;
    }

    totalMs.push(performance.now() - t0);
    if (i === 0) {
      console.log(`    [sanity] ${shadowCount}/${pointCount} points in shadow`);
    }
  }

  return { totalMs };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const { loadBuildingsObstacleIndex } = await import("@/lib/sun/buildings-shadow");
  const { loadGpuMeshes } = await import("@/lib/sun/gpu-mesh-loader");

  console.log("Loading buildings...");
  const index = await loadBuildingsObstacleIndex("lausanne");
  if (!index) throw new Error("No buildings index");
  console.log(`  ${index.obstacles.length} obstacles`);

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const obs of index.obstacles) {
    if (obs.minX < minX) minX = obs.minX;
    if (obs.minY < minY) minY = obs.minY;
    if (obs.maxX > maxX) maxX = obs.maxX;
    if (obs.maxY > maxY) maxY = obs.maxY;
  }
  const originX = (minX + maxX) / 2;
  const originY = (minY + maxY) / 2;

  console.log("Loading meshes...");
  const mesh = await loadGpuMeshes(index.obstacles, originX, originY);
  console.log(`  ${mesh.dxfTriangleCount + mesh.fallbackTriangleCount} triangles, ${(mesh.vertices.byteLength / 1024 / 1024).toFixed(1)} MB`);

  // Generate query points: simulate a 250×250 grid at 1m resolution
  const tileW = 250;
  const tileH = 250;
  const pointCount = tileW * tileH; // 62,500
  const queryPoints = new Float32Array(pointCount * 4);
  // Place points in the center of the scene
  const cx = 0; // already centered
  const cy = 0;
  for (let iy = 0; iy < tileH; iy++) {
    for (let ix = 0; ix < tileW; ix++) {
      const idx = iy * tileW + ix;
      queryPoints[idx * 4 + 0] = cx + ix - tileW / 2;       // x (easting)
      queryPoints[idx * 4 + 1] = 450;                        // elevation ~450m (Lausanne)
      queryPoints[idx * 4 + 2] = cy + iy - tileH / 2;       // z (northing)
      queryPoints[idx * 4 + 3] = 0;                          // padding
    }
  }

  const resolution = 4096;
  const iterations = 10;

  console.log(`\nBenchmark: ${resolution}² shadow map, ${mesh.vertices.length / 3} mesh vertices, ${pointCount} query points, ${iterations} iterations\n`);

  // Current approach
  console.log("=== headless-gl + CPU evaluate (current) ===");
  const glResult = await benchHeadlessGlCpu(mesh.vertices, queryPoints, pointCount, resolution, iterations);
  console.log(`  total: median ${fmt(median(glResult.totalMs))}`);
  console.log(`  all: ${glResult.totalMs.map(ms => fmt(ms)).join(", ")}`);

  // WebGPU compute
  console.log("\n=== WebGPU render + compute shader (Intel Arc) ===");
  const wgpuResult = await benchWebGpuCompute(mesh.vertices, queryPoints, pointCount, resolution, iterations);
  console.log(`  GPU (render+compute): median ${fmt(median(wgpuResult.renderMs))}`);
  console.log(`  readback: median ${fmt(median(wgpuResult.readbackMs))}`);
  console.log(`  total: median ${fmt(median(wgpuResult.totalMs))}`);
  console.log(`  all: ${wgpuResult.totalMs.map(ms => fmt(ms)).join(", ")}`);

  const ratio = median(glResult.totalMs) / median(wgpuResult.totalMs);
  console.log(`\n--- WebGPU compute is ${ratio.toFixed(1)}x ${ratio > 1 ? "faster" : "slower"} than headless-gl + CPU ---`);

  // Extrapolate to 66 frames (full daily timeline)
  const glPerFrame = median(glResult.totalMs);
  const wgpuPerFrame = median(wgpuResult.totalMs);
  const frames = 66;
  console.log(`\nExtrapolation for ${frames} frames (1 tile, 1 day):`);
  console.log(`  headless-gl: ${fmt(glPerFrame * frames)} (${(glPerFrame * frames / 1000).toFixed(1)}s)`);
  console.log(`  WebGPU:      ${fmt(wgpuPerFrame * frames)} (${(wgpuPerFrame * frames / 1000).toFixed(1)}s)`);
  console.log(`  99 tiles × 1 day:`);
  console.log(`    headless-gl: ${((glPerFrame * frames * 99) / 1000 / 60).toFixed(1)} min`);
  console.log(`    WebGPU:      ${((wgpuPerFrame * frames * 99) / 1000 / 60).toFixed(1)} min`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
