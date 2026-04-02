/**
 * GPU shadow-map backend for building shadow evaluation.
 *
 * Uses headless-gl to create an offscreen WebGL context and renders depth-only
 * shadow maps from the sun's point of view.
 *
 * Mesh source: real 3D polyface triangles from SwissBUILDINGS3D DXF files
 * (loaded via gpu-mesh-loader), with footprint extrusion as fallback for
 * buildings without DXF meshes.
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
import { loadGpuMeshes, type GpuMeshLoadResult } from "@/lib/sun/gpu-mesh-loader";

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

// ── Footprint extrusion helper ───────────────────────────────────────────

function extrudeFootprint(
  obs: BuildingObstacle,
  originX: number,
  originY: number,
  out: number[],
): number {
  const fp = obs.footprint!;
  const n = fp.length;
  const baseZ = obs.minZ;
  const topZ = obs.maxZ;
  let triCount = 0;

  // Roof (top face) via earcut
  const flatCoords: number[] = [];
  for (const p of fp) flatCoords.push(p.x - originX, p.y - originY);
  const indices = earcut(flatCoords);
  for (const idx of indices) {
    out.push(fp[idx].x - originX, topZ, fp[idx].y - originY);
  }
  triCount += indices.length / 3;

  // Bottom face (reversed winding)
  for (let i = indices.length - 1; i >= 0; i--) {
    const idx = indices[i];
    out.push(fp[idx].x - originX, baseZ, fp[idx].y - originY);
  }
  triCount += indices.length / 3;

  // Walls
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = fp[i].x - originX, ay = fp[i].y - originY;
    const bx = fp[j].x - originX, by = fp[j].y - originY;
    out.push(ax, baseZ, ay, bx, baseZ, by, bx, topZ, by);
    out.push(ax, baseZ, ay, bx, topZ, by, ax, topZ, ay);
    triCount += 2;
  }

  return triCount;
}

// ── GPU Backend ──────────────────────────────────────────────────────────

export interface GpuBackendMeshInfo {
  meshSource: "dxf-polyface" | "footprint-extrusion";
  dxfObstacleCount: number;
  fallbackObstacleCount: number;
  dxfTriangleCount: number;
  fallbackTriangleCount: number;
  meshLoadMs: number;
}

export class GpuBuildingShadowBackend implements BuildingShadowBackend {
  readonly name: string;
  readonly resolution: number;
  readonly triangleCount: number;
  readonly meshInfo: GpuBackendMeshInfo;

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

  private static readonly SHADOW_BIAS = 0.0002;

  /**
   * Create a GPU backend from pre-built vertices.
   * Use the static factory methods for convenient construction.
   */
  constructor(
    vertices: Float32Array,
    sceneBbox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
    originX: number,
    originY: number,
    resolution: number,
    meshInfo: GpuBackendMeshInfo,
  ) {
    this.resolution = resolution;
    this.originX = originX;
    this.originY = originY;
    this.meshInfo = meshInfo;

    this.sceneBboxMin = [sceneBbox.minX - originX, sceneBbox.minZ, sceneBbox.minY - originY];
    this.sceneBboxMax = [sceneBbox.maxX - originX, sceneBbox.maxZ, sceneBbox.maxY - originY];

    this.vertexCount = vertices.length / 3;
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
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
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

  /**
   * Create a GPU backend with real DXF 3D mesh triangles.
   * Falls back to footprint extrusion for buildings without DXF data.
   */
  static async createWithDxfMeshes(
    obstacles: BuildingObstacle[],
    resolution = 4096,
  ): Promise<GpuBuildingShadowBackend> {
    // Compute origin from obstacle bounding box
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

    const meshInfo: GpuBackendMeshInfo = {
      meshSource: "dxf-polyface",
      dxfObstacleCount: meshResult.dxfObstacleCount,
      fallbackObstacleCount: meshResult.fallbackObstacleCount,
      dxfTriangleCount: meshResult.dxfTriangleCount,
      fallbackTriangleCount: meshResult.fallbackTriangleCount,
      meshLoadMs: meshResult.totalMs,
    };

    return new GpuBuildingShadowBackend(
      meshResult.vertices,
      { minX, minY, minZ, maxX, maxY, maxZ },
      originX, originY,
      resolution,
      meshInfo,
    );
  }

  /**
   * Create a GPU backend with footprint extrusion only (fast, no DXF parsing).
   */
  static createWithFootprints(
    obstacles: BuildingObstacle[],
    resolution = 4096,
  ): GpuBuildingShadowBackend {
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
    const originX = (minX + maxX) / 2;
    const originY = (minY + maxY) / 2;

    const allVertices: number[] = [];
    let triCount = 0;
    for (const obs of obstacles) {
      if (!obs.footprint || obs.footprint.length < 3 || obs.height < 0.5) continue;
      triCount += extrudeFootprint(obs, originX, originY, allVertices);
    }

    const meshInfo: GpuBackendMeshInfo = {
      meshSource: "footprint-extrusion",
      dxfObstacleCount: 0,
      fallbackObstacleCount: obstacles.filter(
        (o) => o.footprint && o.footprint.length >= 3 && o.height >= 0.5,
      ).length,
      dxfTriangleCount: 0,
      fallbackTriangleCount: triCount,
      meshLoadMs: 0,
    };

    return new GpuBuildingShadowBackend(
      new Float32Array(allVertices),
      { minX, minY, minZ, maxX, maxY, maxZ },
      originX, originY,
      resolution,
      meshInfo,
    );
  }

  /**
   * Set a focus area for frustum fitting. When set, the ortho projection
   * is tightly fitted around this area (extended by shadow reach) instead
   * of the full scene bbox, yielding much higher depth + pixel precision.
   *
   * @param bounds LV95 bounds of the area where shadows will be queried.
   *   Typically the tile bounds, optionally padded.
   * @param maxBuildingHeight tallest building in the scene (meters).
   *   Used to compute shadow reach at low sun angles.
   */
  setFrustumFocus(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    maxBuildingHeight: number,
  ): void {
    this.frustumFocus = { ...bounds };
    this.frustumMaxBuildingHeight = maxBuildingHeight;
  }

  private frustumFocus: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private frustumMaxBuildingHeight = 100;

  private lastPreparedAz = NaN;
  private lastPreparedAlt = NaN;

  prepareSunPosition(azimuthDeg: number, altitudeDeg: number): void {
    // Skip re-render if sun position hasn't changed meaningfully.
    // Round to 0.1° — within a 250m tile the sun position varies by ~0.005°
    // between points, which is negligible for shadow map rendering.
    const roundedAz = Math.round(azimuthDeg * 10);
    const roundedAlt = Math.round(altitudeDeg * 10);
    if (roundedAz === this.lastPreparedAz && roundedAlt === this.lastPreparedAlt) {
      return;
    }
    this.lastPreparedAz = roundedAz;
    this.lastPreparedAlt = roundedAlt;

    const t0 = performance.now();
    const gl = this.gl;

    const azRad = (azimuthDeg * Math.PI) / 180;
    const altRad = (altitudeDeg * Math.PI) / 180;

    // Sun direction in GL coords (x = easting, y = up, z = northing)
    const sunDirX = Math.sin(azRad) * Math.cos(altRad);
    const sunDirY = Math.sin(altRad);
    const sunDirZ = Math.cos(azRad) * Math.cos(altRad);

    // ── Compute frustum focus box ────────────────────────────────────
    // If a focus area is set, we build the frustum around the focus
    // extended by the maximum shadow reach at this sun angle.
    // Otherwise, fall back to the full scene bbox.
    let fMinX: number, fMaxX: number, fMinZ: number, fMaxZ: number;
    let fMinY: number, fMaxY: number; // elevation

    if (this.frustumFocus) {
      // Shadow extension: how far a building shadow can reach at this altitude.
      // Extend the tile box ONLY toward the sun (that's where blockers are)
      // plus a small lateral padding for buildings straddling the boundary.
      const minAltForExtension = Math.max(altitudeDeg, 2);
      const shadowReach = this.frustumMaxBuildingHeight / Math.tan(minAltForExtension * Math.PI / 180);
      const ext = Math.min(shadowReach, 2500);
      const foc = this.frustumFocus;

      // Sun direction in horizontal plane (easting, northing)
      const hSunX = Math.sin(azRad); // easting component
      const hSunZ = Math.cos(azRad); // northing component

      // Start with tile bounds (in centered coords)
      fMinX = foc.minX - this.originX;
      fMaxX = foc.maxX - this.originX;
      fMinZ = foc.minY - this.originY;
      fMaxZ = foc.maxY - this.originY;

      // Extend toward the sun direction by shadow reach
      // (buildings in the sun direction cast shadows into the tile)
      if (hSunX > 0) fMaxX += ext * hSunX; else fMinX += ext * hSunX;
      if (hSunZ > 0) fMaxZ += ext * hSunZ; else fMinZ += ext * hSunZ;

      // Also add a lateral padding (50m) for buildings near the boundary
      const lateralPad = 50;
      fMinX -= lateralPad;
      fMaxX += lateralPad;
      fMinZ -= lateralPad;
      fMaxZ += lateralPad;

      // Clamp to scene bounds
      fMinX = Math.max(fMinX, this.sceneBboxMin[0]);
      fMaxX = Math.min(fMaxX, this.sceneBboxMax[0]);
      fMinZ = Math.max(fMinZ, this.sceneBboxMin[2]);
      fMaxZ = Math.min(fMaxZ, this.sceneBboxMax[2]);
      fMinY = this.sceneBboxMin[1];
      fMaxY = this.sceneBboxMax[1];
    } else {
      fMinX = this.sceneBboxMin[0]; fMaxX = this.sceneBboxMax[0];
      fMinY = this.sceneBboxMin[1]; fMaxY = this.sceneBboxMax[1];
      fMinZ = this.sceneBboxMin[2]; fMaxZ = this.sceneBboxMax[2];
    }

    // Center of the focus area
    const cx = (fMinX + fMaxX) / 2;
    const cy = (fMinY + fMaxY) / 2;
    const cz = (fMinZ + fMaxZ) / 2;

    let upX = 0, upY = 1, upZ = 0;
    if (Math.abs(altitudeDeg) > 85) {
      upX = 0; upY = 0; upZ = -1;
    }

    // Eye distance: far enough that the whole focus box is in front
    const focusRadius = Math.hypot(fMaxX - fMinX, fMaxY - fMinY, fMaxZ - fMinZ) / 2;
    const eyeDist = focusRadius * 3;
    const eyeX = cx + sunDirX * eyeDist;
    const eyeY = cy + sunDirY * eyeDist;
    const eyeZ = cz + sunDirZ * eyeDist;

    const view = mat4LookAt(eyeX, eyeY, eyeZ, cx, cy, cz, upX, upY, upZ);

    // ── Tight AABB in light space from the focus box corners ─────────
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
          const lx = lv[0] / lv[3];
          const ly = lv[1] / lv[3];
          const lz = lv[2] / lv[3];
          if (lx < lsMinX) lsMinX = lx;
          if (lx > lsMaxX) lsMaxX = lx;
          if (ly < lsMinY) lsMinY = ly;
          if (ly > lsMaxY) lsMaxY = ly;
          if (lz < lsMinZ) lsMinZ = lz;
          if (lz > lsMaxZ) lsMaxZ = lz;
        }
      }
    }

    const near = -lsMaxZ - 1;
    const far = -lsMinZ + 1;
    const proj = mat4Ortho(lsMinX, lsMaxX, lsMinY, lsMaxY, near, far);
    this.lightMVP = mat4Multiply(proj, view);

    // ── Render ───────────────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.clearColor(1, 1, 1, 1); // depth = 1.0 = far (no occluder)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);

    // No face culling: DXF polyfaces may have inconsistent winding.
    gl.disable(gl.CULL_FACE);

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
    const threshold = pointDepth - GpuBuildingShadowBackend.SHADOW_BIAS;

    // Sample a 2×2 quad and check if ANY texel contains a closer occluder.
    // This catches shadow edges that fall between pixel centers.
    const res = this.resolution;
    const buf = this.depthBuffer;

    // Determine the 2×2 neighborhood: pick the quad containing the
    // sub-pixel position (toward the fractional part of u,v).
    const px0 = px;
    const py0 = py;
    const px1 = u - px >= 0.5 ? Math.min(px + 1, res - 1) : Math.max(px - 1, 0);
    const py1 = v - py >= 0.5 ? Math.min(py + 1, res - 1) : Math.max(py - 1, 0);

    let blocked = false;
    for (const sy of [py0, py1]) {
      for (const sx of [px0, px1]) {
        const off = (sy * res + sx) * 4;
        const sd = unpackDepth(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
        if (sd < threshold) { blocked = true; break; }
      }
      if (blocked) break;
    }

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
