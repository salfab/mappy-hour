/**
 * Benchmark: WebGPU (Dawn/D3D12) vs headless-gl (software) shadow map rendering.
 *
 * Measures the hot path: render shadow map + evaluate N query points.
 * Uses the real building mesh from the Lausanne dataset.
 *
 * Usage:
 *   MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster npx tsx scripts/benchmark/webgpu-shadow-bench.ts
 */
import { performance } from "node:perf_hooks";

// ---------- helpers ----------

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`;
}

// ---------- WebGPU depth-only render pass ----------

async function benchWebGpuRenderPass(
  vertices: Float32Array,
  resolution: number,
  iterations: number,
): Promise<{ renderMs: number[]; totalMs: number[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const webgpu = require("webgpu");
  // Install WebGPU globals (GPUBufferUsage, GPUShaderStage, etc.)
  const globals = webgpu.globals as Record<string, unknown>;
  for (const [key, value] of Object.entries(globals)) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
  const gpu = webgpu.create([]);
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  // Vertex buffer
  const vbo = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vbo, 0, vertices);

  // Depth texture (shadow map)
  const depthTexture = device.createTexture({
    size: [resolution, resolution],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depthView = depthTexture.createView();

  // Readback buffer
  const readbackBuf = device.createBuffer({
    size: resolution * resolution * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Uniform buffer for lightMVP (4x4 float32 = 64 bytes)
  const uniformBuf = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Identity-ish matrix for benchmarking
  const mvp = new Float32Array(16);
  mvp[0] = 0.001; mvp[5] = 0.001; mvp[10] = 0.001; mvp[15] = 1;
  device.queue.writeBuffer(uniformBuf, 0, mvp);

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "uniform" },
    }],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });

  // Shader module
  const shaderModule = device.createShaderModule({
    code: `
      struct Uniforms { lightMVP: mat4x4f };
      @group(0) @binding(0) var<uniform> u: Uniforms;

      @vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
        return u.lightMVP * vec4f(pos, 1.0);
      }

      // No fragment output needed — depth-only pass
      @fragment fn fs() {}
    `,
  });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: "vs",
      buffers: [{
        arrayStride: 12,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
      }],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs",
      targets: [],
    },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
    primitive: { topology: "triangle-list" },
  });

  const renderMs: number[] = [];
  const totalMs: number[] = [];
  const vertexCount = vertices.length / 3;

  // Warmup
  for (let i = 0; i < 3; i++) {
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vbo);
    pass.draw(vertexCount);
    pass.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  }

  // Bench
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vbo);
    pass.draw(vertexCount);
    pass.end();

    // Copy depth texture to readback buffer
    enc.copyTextureToBuffer(
      { texture: depthTexture },
      { buffer: readbackBuf, bytesPerRow: resolution * 4 },
      [resolution, resolution],
    );

    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();

    const tRender = performance.now();
    renderMs.push(tRender - t0);

    // Map and read back
    await readbackBuf.mapAsync(GPUMapMode.READ);
    const _data = new Float32Array(readbackBuf.getMappedRange().slice(0));
    readbackBuf.unmap();

    totalMs.push(performance.now() - t0);
  }

  device.destroy();
  return { renderMs, totalMs };
}

// ---------- headless-gl (current) ----------

async function benchHeadlessGl(
  vertices: Float32Array,
  resolution: number,
  iterations: number,
): Promise<{ renderMs: number[]; totalMs: number[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createContext = require("gl");
  const gl = createContext(resolution, resolution, { preserveDrawingBuffer: true });

  const VERT_SRC = `
    attribute vec3 aPosition;
    uniform mat4 uLightMVP;
    void main() { gl_Position = uLightMVP * vec4(aPosition, 1.0); }
  `;
  const FRAG_SRC = `
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
  gl.shaderSource(vs, VERT_SRC);
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, FRAG_SRC);
  gl.compileShader(fs);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  const uLoc = gl.getUniformLocation(prog, "uLightMVP")!;
  const aLoc = gl.getAttribLocation(prog, "aPosition");

  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

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
  mvp[0] = 0.001; mvp[5] = 0.001; mvp[10] = 0.001; mvp[15] = 1;
  const readBuf = new Uint8Array(resolution * resolution * 4);
  const vertexCount = vertices.length / 3;

  const renderMs: number[] = [];
  const totalMs: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();

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

    const tRender = performance.now();
    renderMs.push(tRender - t0);

    gl.readPixels(0, 0, resolution, resolution, gl.RGBA, gl.UNSIGNED_BYTE, readBuf);

    totalMs.push(performance.now() - t0);
  }

  return { renderMs, totalMs };
}

// ---------- Main ----------

async function main() {
  // Load real building mesh
  const { loadBuildingsObstacleIndex } = await import("@/lib/sun/buildings-shadow");
  const { loadGpuMeshes } = await import("@/lib/sun/gpu-mesh-loader");

  console.log("Loading building obstacles for Lausanne...");
  const t0 = performance.now();
  const index = await loadBuildingsObstacleIndex("lausanne");
  if (!index) throw new Error("No buildings index");
  console.log(`  Loaded ${index.obstacles.length} obstacles in ${fmt(performance.now() - t0)}`);

  // Compute origin
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

  console.log("Loading GPU meshes (DXF + extrusion)...");
  const t1 = performance.now();
  const meshResult = await loadGpuMeshes(index.obstacles, originX, originY);
  console.log(`  ${meshResult.dxfTriangleCount} DXF + ${meshResult.fallbackTriangleCount} extrusion triangles in ${fmt(performance.now() - t1)}`);
  console.log(`  Vertex buffer: ${(meshResult.vertices.byteLength / 1024 / 1024).toFixed(1)} MB`);

  const resolution = 4096;
  const iterations = 10;

  console.log(`\nBenchmark: ${resolution}x${resolution} shadow map, ${meshResult.vertices.length / 3} vertices, ${iterations} iterations\n`);

  // headless-gl
  console.log("=== headless-gl (software) ===");
  const glResult = await benchHeadlessGl(meshResult.vertices, resolution, iterations);
  console.log(`  render: median ${fmt(median(glResult.renderMs))}, total (+ readback): median ${fmt(median(glResult.totalMs))}`);
  console.log(`  all: ${glResult.totalMs.map(ms => fmt(ms)).join(", ")}`);

  // WebGPU
  console.log("\n=== WebGPU (Dawn/D3D12 on Intel Arc) ===");
  const wgpuResult = await benchWebGpuRenderPass(meshResult.vertices, resolution, iterations);
  console.log(`  render: median ${fmt(median(wgpuResult.renderMs))}, total (+ readback): median ${fmt(median(wgpuResult.totalMs))}`);
  console.log(`  all: ${wgpuResult.totalMs.map(ms => fmt(ms)).join(", ")}`);

  // Ratio
  const ratio = median(glResult.totalMs) / median(wgpuResult.totalMs);
  console.log(`\n🏁 WebGPU is ${ratio.toFixed(1)}x ${ratio > 1 ? "faster" : "slower"} than headless-gl`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
