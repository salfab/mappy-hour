/**
 * GPU shadow-map backend for building shadow evaluation.
 *
 * Uses headless-gl to create an offscreen WebGL context, triangulates building
 * footprints via earcut, extrudes them to 3D meshes, and renders depth-only
 * shadow maps from the sun's point of view.
 *
 * `prepareSunPosition()` renders one shadow map.
 * `evaluate()` projects each query point into light-clip space and compares
 * its depth to the stored depth buffer — O(1) per point.
 *
 * Coordinates are centered around the bounding-box midpoint to avoid float32
 * precision issues with large LV95 values (2 538 xxx).
 */
import createContext from "gl";
import earcut from "earcut";

import type {
  BuildingShadowBackend,
  BuildingShadowQuery,
  BuildingShadowResult,
} from "@/lib/sun/building-shadow-backend";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";

type ObstacleArray = NonNullable<
  Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>
>["obstacles"];
type BuildingObstacle = ObstacleArray[number];

// ── Minimal mat4 helpers (avoid pulling in gl-matrix) ────────────────────

type Mat4 = Float32Array;

function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Ortho(
  left: number, right: number,
  bottom: number, top: number,
  near: number, far: number,
): Mat4 {
  const m = new Float32Array(16);
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  m[0] = -2 * lr;
  m[5] = -2 * bt;
  m[10] = 2 * nf;
  m[12] = (left + right) * lr;
  m[13] = (top + bottom) * bt;
  m[14] = (far + near) * nf;
  m[15] = 1;
  return m;
}

function mat4LookAt(
  eyeX: number, eyeY: number, eyeZ: number,
  centerX: number, centerY: number, centerZ: number,
  upX: number, upY: number, upZ: number,
): Mat4 {
  let fx = centerX - eyeX;
  let fy = centerY - eyeY;
  let fz = centerZ - eyeZ;
  let len = Math.hypot(fx, fy, fz);
  fx /= len; fy /= len; fz /= len;

  let sx = fy * upZ - fz * upY;
  let sy = fz * upX - fx * upZ;
  let sz = fx * upY - fy * upX;
  len = Math.hypot(sx, sy, sz);
  sx /= len; sy /= len; sz /= len;

  const ux = sy * fz - sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy - sy * fx;

  const m = new Float32Array(16);
  m[0] = sx;  m[1] = ux;  m[2] = -fx; m[3] = 0;
  m[4] = sy;  m[5] = uy;  m[6] = -fy; m[7] = 0;
  m[8] = sz;  m[9] = uz;  m[10] = -fz; m[11] = 0;
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
      out[j * 4 + i] =
        a[i] * b[j * 4] +
        a[4 + i] * b[j * 4 + 1] +
        a[8 + i] * b[j * 4 + 2] +
        a[12 + i] * b[j * 4 + 3];
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

// ── Shaders ──────────────────────────────────────────────────────────────

const VERT_SRC = `
attribute vec3 aPosition;
uniform mat4 uLightMVP;
void main() {
  gl_Position = uLightMVP * vec4(aPosition, 1.0);
}
`;

// Encode gl_FragCoord.z into RGBA for readback (no depth texture in WebGL1 headless)
const FRAG_SRC = `
precision highp float;
vec4 packDepth(float depth) {
  float d = clamp(depth, 0.0, 1.0);
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * d;
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
  return enc;
}
void main() {
  gl_FragColor = packDepth(gl_FragCoord.z);
}
`;

function unpackDepth(r: number, g: number, b: number, a: number): number {
  return r / 255 + g / 65025 + b / 16581375 + a / 4228250625;
}

// ── GPU Backend ──────────────────────────────────────────────────────────

export class GpuBuildingShadowBackend implements BuildingShadowBackend {
  readonly name: string;
  readonly resolution: number;
  readonly triangleCount: number;

  /** GL renderer string */
  readonly glRenderer: string;

  /** Timing for the last prepareSunPosition call */
  lastPrepareMs = 0;
  /** Timing for readPixels within prepareSunPosition */
  lastReadPixelsMs = 0;

  // Scene bounding box (centered coordinates)
  private sceneBboxMin: [number, number, number];
  private sceneBboxMax: [number, number, number];
  private originX: number;
  private originY: number;

  // GL resources
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private vbo: WebGLBuffer;
  private framebuffer: WebGLFramebuffer;
  private colorTex: WebGLTexture;
  private depthRb: WebGLRenderbuffer;
  private uLightMVPLoc: WebGLUniformLocation;
  private aPositionLoc: number;
  private vertexCount: number;

  // Shadow map state
  private depthBuffer: Uint8Array;
  private lightMVP: Mat4 = mat4Identity();
  private prepared = false;

  private static readonly SHADOW_BIAS = 0.003;

  constructor(obstacles: BuildingObstacle[], resolution = 4096) {
    this.resolution = resolution;

    // ── Compute scene bounding box ─────────────────────────────────────
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const obs of obstacles) {
      if (!obs.footprint || obs.footprint.length < 3 || obs.height < 0.5) continue;
      if (obs.minX < minX) minX = obs.minX;
      if (obs.minY < minY) minY = obs.minY;
      if (obs.minZ < minZ) minZ = obs.minZ;
      if (obs.maxX > maxX) maxX = obs.maxX;
      if (obs.maxY > maxY) maxY = obs.maxY;
      if (obs.maxZ > maxZ) maxZ = obs.maxZ;
    }

    this.originX = (minX + maxX) / 2;
    this.originY = (minY + maxY) / 2;

    this.sceneBboxMin = [minX - this.originX, minZ, minY - this.originY];
    this.sceneBboxMax = [maxX - this.originX, maxZ, maxY - this.originY];

    // ── Triangulate buildings ──────────────────────────────────────────
    const allVertices: number[] = [];
    for (const obs of obstacles) {
      if (!obs.footprint || obs.footprint.length < 3 || obs.height < 0.5) continue;
      this.triangulateBuilding(obs, allVertices);
    }
    this.vertexCount = allVertices.length / 3;
    this.triangleCount = this.vertexCount / 3;

    // ── Create GL context ─────────────────────────────────────────────
    const gl = createContext(resolution, resolution, {
      preserveDrawingBuffer: true,
    });
    this.gl = gl;
    this.glRenderer = String(gl.getParameter(gl.RENDERER) ?? "unknown");
    this.name = `gpu-shadowmap-${resolution} (${this.glRenderer})`;

    // ── Compile shaders ───────────────────────────────────────────────
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT_SRC);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error("Vertex shader: " + gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, FRAG_SRC);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error("Fragment shader: " + gl.getShaderInfoLog(fs));
    }

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("Program link: " + gl.getProgramInfoLog(program));
    }
    this.program = program;
    this.uLightMVPLoc = gl.getUniformLocation(program, "uLightMVP")!;
    this.aPositionLoc = gl.getAttribLocation(program, "aPosition");

    // ── Upload vertex buffer ──────────────────────────────────────────
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(allVertices), gl.STATIC_DRAW);
    this.vbo = vbo;

    // ── Framebuffer with color texture + depth renderbuffer ───────────
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);

    const colorTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      resolution, resolution, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);

    const depthRb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, resolution, resolution);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);

    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete: 0x${fbStatus.toString(16)}`);
    }

    this.framebuffer = fb;
    this.colorTex = colorTex;
    this.depthRb = depthRb;

    // Depth buffer readback array
    this.depthBuffer = new Uint8Array(resolution * resolution * 4);
  }

  private triangulateBuilding(obs: BuildingObstacle, out: number[]): void {
    const fp = obs.footprint!;
    const n = fp.length;
    const ox = this.originX;
    const oy = this.originY;
    const baseZ = obs.minZ;
    const topZ = obs.maxZ;

    // ── Roof (top face) ──────────────────────────────────────────────
    const flatCoords: number[] = [];
    for (const p of fp) {
      flatCoords.push(p.x - ox, p.y - oy);
    }
    const indices = earcut(flatCoords);
    for (const idx of indices) {
      out.push(fp[idx].x - ox, topZ, fp[idx].y - oy);
    }

    // ── Bottom face ──────────────────────────────────────────────────
    for (let i = indices.length - 1; i >= 0; i--) {
      const idx = indices[i];
      out.push(fp[idx].x - ox, baseZ, fp[idx].y - oy);
    }

    // ── Walls (two triangles per edge) ───────────────────────────────
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = fp[i].x - ox, ay = fp[i].y - oy;
      const bx = fp[j].x - ox, by = fp[j].y - oy;

      // Triangle 1
      out.push(ax, baseZ, ay);
      out.push(bx, baseZ, by);
      out.push(bx, topZ, by);

      // Triangle 2
      out.push(ax, baseZ, ay);
      out.push(bx, topZ, by);
      out.push(ax, topZ, ay);
    }
  }

  prepareSunPosition(azimuthDeg: number, altitudeDeg: number): void {
    const t0 = performance.now();
    const gl = this.gl;

    // ── Build light view+projection matrices ─────────────────────────
    const azRad = (azimuthDeg * Math.PI) / 180;
    const altRad = (altitudeDeg * Math.PI) / 180;

    // Sun direction vector (from sun toward scene)
    const sunDirX = Math.sin(azRad) * Math.cos(altRad);
    const sunDirY = Math.sin(altRad);
    const sunDirZ = Math.cos(azRad) * Math.cos(altRad);

    // Scene center and extent
    const cx = (this.sceneBboxMin[0] + this.sceneBboxMax[0]) / 2;
    const cy = (this.sceneBboxMin[1] + this.sceneBboxMax[1]) / 2;
    const cz = (this.sceneBboxMin[2] + this.sceneBboxMax[2]) / 2;

    const extentX = (this.sceneBboxMax[0] - this.sceneBboxMin[0]) / 2;
    const extentY = (this.sceneBboxMax[1] - this.sceneBboxMin[1]) / 2;
    const extentZ = (this.sceneBboxMax[2] - this.sceneBboxMin[2]) / 2;
    const sceneRadius = Math.hypot(extentX, extentY, extentZ);

    // Eye position: scene center + sun direction * distance
    const eyeDist = sceneRadius * 2;
    const eyeX = cx + sunDirX * eyeDist;
    const eyeY = cy + sunDirY * eyeDist;
    const eyeZ = cz + sunDirZ * eyeDist;

    // Up vector: use world-up (0,1,0), unless sun is nearly vertical
    let upX = 0, upY = 1, upZ = 0;
    if (Math.abs(altitudeDeg) > 85) {
      upX = 0; upY = 0; upZ = -1;
    }

    const view = mat4LookAt(eyeX, eyeY, eyeZ, cx, cy, cz, upX, upY, upZ);
    const proj = mat4Ortho(
      -sceneRadius, sceneRadius,
      -sceneRadius, sceneRadius,
      0.1, eyeDist * 2 + sceneRadius,
    );
    this.lightMVP = mat4Multiply(proj, view);

    // ── Render ───────────────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.clearColor(1, 1, 1, 1); // depth = 1.0 = far (no occluder)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uLightMVPLoc, false, this.lightMVP);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(this.aPositionLoc);
    gl.vertexAttribPointer(this.aPositionLoc, 3, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    // ── Read back depth (encoded in RGBA) ────────────────────────────
    const readT0 = performance.now();
    gl.readPixels(0, 0, this.resolution, this.resolution, gl.RGBA, gl.UNSIGNED_BYTE, this.depthBuffer);
    this.lastReadPixelsMs = performance.now() - readT0;

    this.prepared = true;
    this.lastPrepareMs = performance.now() - t0;
  }

  evaluate(query: BuildingShadowQuery): BuildingShadowResult {
    if (!this.prepared) {
      return { blocked: false, blockerId: null, blockerDistanceMeters: null, blockerAltitudeAngleDeg: null };
    }

    // Transform point to light clip space
    // In our coordinate system: x = easting - originX, y = elevation, z = northing - originY
    const localX = query.pointX - this.originX;
    const localY = query.pointElevation;
    const localZ = query.pointY - this.originY;

    const clip = mat4TransformVec4(this.lightMVP, localX, localY, localZ, 1);
    const w = clip[3];
    if (Math.abs(w) < 1e-10) {
      return { blocked: false, blockerId: null, blockerDistanceMeters: null, blockerAltitudeAngleDeg: null };
    }

    // NDC
    const ndcX = clip[0] / w;
    const ndcY = clip[1] / w;
    const ndcZ = clip[2] / w;

    // To texture coordinates [0, resolution)
    const u = (ndcX * 0.5 + 0.5) * this.resolution;
    const v = (ndcY * 0.5 + 0.5) * this.resolution;

    const px = Math.floor(u);
    const py = Math.floor(v);

    // Out of shadow map bounds → not blocked
    if (px < 0 || px >= this.resolution || py < 0 || py >= this.resolution) {
      return { blocked: false, blockerId: null, blockerDistanceMeters: null, blockerAltitudeAngleDeg: null };
    }

    // Point depth in [0,1] range
    const pointDepth = ndcZ * 0.5 + 0.5;

    // Read stored depth from the RGBA-encoded depth buffer
    const offset = (py * this.resolution + px) * 4;
    const storedDepth = unpackDepth(
      this.depthBuffer[offset],
      this.depthBuffer[offset + 1],
      this.depthBuffer[offset + 2],
      this.depthBuffer[offset + 3],
    );

    // If stored depth < point depth - bias, something is closer to the sun → point is blocked
    const blocked = storedDepth < pointDepth - GpuBuildingShadowBackend.SHADOW_BIAS;

    return {
      blocked,
      blockerId: null,
      blockerDistanceMeters: null,
      blockerAltitudeAngleDeg: null,
    };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteTexture(this.colorTex);
    gl.deleteRenderbuffer(this.depthRb);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteProgram(this.program);
    // headless-gl doesn't have a formal destroy, but we release references
  }
}
