/**
 * MapLibre custom layer rendering the *daily heatmap* of sunlight exposure.
 *
 * For each tile cell we aggregate `sunnyFrames / totalFrames` across the whole
 * timeline and upload it as an R8 (LUMINANCE) texture: value = ratio * 255.
 * The fragment shader maps the value through a continuous palette (blue→red,
 * matching the Leaflet `exposureRatioToRGBA` implementation in
 * `sunlight-map-client.tsx`).
 *
 * DECISION: separate custom layer from `MapLibreSunlightCustomLayer` (Option A
 * in the chunk brief). Easier to debug, easier to validate visually, and the
 * memory overhead of a second per-tile texture is acceptable
 * (~1 byte × 250×250 × ~100 tiles ≈ 6 MB).
 *
 * The two layers are mutually exclusive on screen — the host component toggles
 * visibility based on `showHeatmap`.
 */

import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from "maplibre-gl";

import type { TimelineTile } from "./maplibre-sunlight-custom-layer";

interface LatLon {
  lat: number;
  lon: number;
}

// ── Mask decoding helpers (duplicated from the sunlight layer; kept local to
// avoid coupling the two files' internals). ─────────────────────────────────

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function readBit(mask: Uint8Array, cellIdx: number): number {
  return (mask[cellIdx >> 3] >> (cellIdx & 7)) & 1;
}

function getTileOutdoorMask(tile: TimelineTile): Uint8Array | undefined {
  if (tile.decodedMasks) return tile.decodedMasks.outdoor;
  return tile.outdoorMaskBase64 ? decodeBase64(tile.outdoorMaskBase64) : undefined;
}

function getTileFrameSunMask(tile: TimelineTile, frameIdx: number): Uint8Array | null {
  if (tile.decodedMasks) {
    return tile.decodedMasks.frames[frameIdx]?.sun ?? null;
  }
  const frame = tile.frames[frameIdx];
  if (!frame) return null;
  return decodeBase64(frame.sunMaskBase64);
}

/**
 * Build a luminance buffer encoding the per-cell sunlight ratio.
 *
 *  - indoor cells (outdoorMask bit 0) → 0  (transparent, fragment shader discards)
 *  - outdoor cells                    → 1 + Math.round(ratio * 254)
 *
 * DECISION: indoor cells share the value 0 with "outdoor + 0% sun", so we
 * reserve 0 strictly for "indoor / discard" and rescale ratios into [1, 255].
 * The shader uses a `> 0.0` test for outdoor, so outdoor cells with full
 * shadow still render in deep-blue (ratio 0 → 1/255 ≈ 0.004).
 */
function buildHeatmapLuminance(tile: TimelineTile): Uint8Array | null {
  if (!tile.grid) return null;
  const width = tile.grid.width;
  const height = tile.grid.height;
  const totalCells = width * height;
  const frameCount = tile.frames.length;
  if (frameCount === 0) return null;

  const outdoorMask = getTileOutdoorMask(tile);
  const sunnyFrames = new Uint16Array(totalCells);
  for (let fi = 0; fi < frameCount; fi++) {
    const mask = getTileFrameSunMask(tile, fi);
    if (!mask) continue;
    for (let i = 0; i < totalCells; i++) {
      if (readBit(mask, i) === 1) sunnyFrames[i] += 1;
    }
  }

  const buf = new Uint8Array(totalCells);
  for (let i = 0; i < totalCells; i++) {
    if (outdoorMask && readBit(outdoorMask, i) === 0) {
      buf[i] = 0; // indoor → discard
      continue;
    }
    const ratio = sunnyFrames[i] / frameCount;
    // Reserve 0 for indoor; map ratio∈[0,1] → [1,255].
    buf[i] = 1 + Math.round(Math.max(0, Math.min(1, ratio)) * 254);
  }
  return buf;
}

// ── Shaders ──────────────────────────────────────────────────────────────────

const VERT_SRC = /* glsl */ `#version 300 es
uniform mat4 u_matrix;
uniform highp float u_worldSize;
in vec2 a_pos;
in vec2 a_texcoord;
out vec2 v_texcoord;
void main() {
  gl_Position = u_matrix * vec4(a_pos * u_worldSize, 0.0, 1.0);
  v_texcoord = a_texcoord;
}
`;

// Continuous blue→red palette mirroring Leaflet's exposureRatioToRGBA:
//   cold = rgb(37, 99, 235)   (#2563EB) at ratio 0
//   hot  = rgb(239, 68, 68)   (#EF4444) at ratio 1
// alpha 180/255 (~0.706) to match the Leaflet overlay.
const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_alpha;
in vec2 v_texcoord;
out vec4 fragColor;

void main() {
  float v = texture(u_texture, v_texcoord).r;
  if (v <= 0.0) discard; // indoor sentinel
  // Decode ratio: 1..255 → 0..1
  float ratio = clamp((v * 255.0 - 1.0) / 254.0, 0.0, 1.0);
  vec3 cold = vec3(37.0, 99.0, 235.0) / 255.0;
  vec3 hot  = vec3(239.0, 68.0, 68.0) / 255.0;
  vec3 rgb = mix(cold, hot, ratio);
  fragColor = vec4(rgb, u_alpha);
}
`;

interface TileGPUState {
  texture: WebGLTexture;
  vertices: Float32Array;
  luminance: Uint8Array;
  gridWidth: number;
  gridHeight: number;
  textureDirty: boolean;
}

export class MapLibreHeatmapCustomLayer implements CustomLayerInterface {
  readonly id = "sunlight-heatmap-custom";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vbo: WebGLBuffer | null = null;

  private aPos = -1;
  private aTexcoord = -1;

  private readonly tileStates: Map<string, TileGPUState> = new Map();
  private tiles: TimelineTile[] = [];
  private visible = false;
  // DECISION: match Leaflet alpha (180/255 ≈ 0.706).
  private alpha = 180 / 255;

  constructor(private readonly map: MapLibreMap) {}

  onAdd(_map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.gl = gl;
    this.program = this.createProgram(gl, VERT_SRC, FRAG_SRC);
    if (!this.program) {
      console.error("[heatmap-custom] Shader compilation failed.");
      return;
    }
    this.aPos = gl.getAttribLocation(this.program, "a_pos");
    this.aTexcoord = gl.getAttribLocation(this.program, "a_texcoord");
    const buf = gl.createBuffer();
    if (!buf) {
      console.error("[heatmap-custom] Failed to create VBO.");
      return;
    }
    this.vbo = buf;

    // Recreate textures for any tile state retained across setStyle swaps.
    for (const state of this.tileStates.values()) {
      const tex = gl.createTexture();
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
      state.texture = tex;
      state.textureDirty = true;
    }
    if (this.tileStates.size > 0) this.map.triggerRepaint();
  }

  render(gl: WebGL2RenderingContext | WebGLRenderingContext, options: CustomRenderMethodInput): void {
    if (!this.visible || !this.program || !this.vbo) return;
    const matrix = options.modelViewProjectionMatrix;

    const activeTiles = this.tiles.filter(
      (t) => this.tileStates.has(t.tileId) && t.tileCorners && t.grid,
    );
    if (activeTiles.length === 0) return;

    const FLOATS_PER_VERT = 4;
    const VERTS_PER_TILE = 6;
    const totalVerts = activeTiles.length * VERTS_PER_TILE;
    const buf = new Float32Array(totalVerts * FLOATS_PER_VERT);
    let off = 0;
    for (const tile of activeTiles) {
      const state = this.tileStates.get(tile.tileId)!;
      const v = state.vertices;
      for (let i = 0; i < v.length; i++) buf[off++] = v[i];
    }

    gl.useProgram(this.program);
    (gl as WebGL2RenderingContext).bindVertexArray?.(null);

    const cullFaceWasEnabled = gl.isEnabled(gl.CULL_FACE);
    gl.disable(gl.CULL_FACE);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aTexcoord);
    gl.vertexAttribPointer(this.aTexcoord, 2, gl.FLOAT, false, stride, 2 * 4);

    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, "u_matrix"),
      false,
      matrix,
    );
    const worldSize = 512 * Math.pow(2, this.map.getZoom());
    gl.uniform1f(gl.getUniformLocation(this.program, "u_worldSize"), worldSize);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_alpha"), this.alpha);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform1i(gl.getUniformLocation(this.program, "u_texture"), 0);
    gl.activeTexture(gl.TEXTURE0);

    for (let i = 0; i < activeTiles.length; i++) {
      const tile = activeTiles[i];
      const state = this.tileStates.get(tile.tileId)!;
      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      if (state.textureDirty) {
        this.uploadTexture(gl, state);
        state.textureDirty = false;
      }
      gl.drawArrays(gl.TRIANGLES, i * VERTS_PER_TILE, VERTS_PER_TILE);
    }

    gl.disable(gl.BLEND);
    if (cullFaceWasEnabled) gl.enable(gl.CULL_FACE);
    gl.disableVertexAttribArray(this.aPos);
    gl.disableVertexAttribArray(this.aTexcoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  onRemove(_map: MapLibreMap, _gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.disposeGPU();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Replace the tile set and rebuild the daily aggregate per tile. The
   * aggregate is cached on the GPU state so subsequent frame-index changes
   * (handled by the sibling sunlight layer) don't trigger any heatmap work.
   */
  setTiles(tiles: TimelineTile[]): void {
    this.tiles = tiles;
    const newIds = new Set(tiles.map((t) => t.tileId));
    for (const [id, state] of this.tileStates) {
      if (!newIds.has(id)) {
        this.destroyTileState(state);
        this.tileStates.delete(id);
      }
    }
    for (const tile of tiles) this.syncTileState(tile);
    this.map.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map.triggerRepaint();
  }

  dispose(): void {
    this.disposeGPU();
    this.tileStates.clear();
    this.tiles = [];
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private syncTileState(tile: TimelineTile): void {
    if (!tile.tileCorners || !tile.grid) return;
    const luminance = buildHeatmapLuminance(tile);
    if (!luminance) return;

    const existing = this.tileStates.get(tile.tileId);
    if (!existing) {
      const gl = this.gl;
      if (!gl) {
        // Layer not yet onAdd'd — stash a partial state so onAdd can pick it up.
        // DECISION: skip. Custom layers receive onAdd synchronously on
        // map.addLayer, so by the time setTiles runs in normal flow the GL
        // context is available. This branch is purely defensive.
        return;
      }
      const texture = gl.createTexture();
      if (!texture) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      this.tileStates.set(tile.tileId, {
        texture,
        vertices: buildQuadVertices(tile.tileCorners),
        luminance,
        gridWidth: tile.grid.width,
        gridHeight: tile.grid.height,
        textureDirty: true,
      });
    } else {
      existing.vertices = buildQuadVertices(tile.tileCorners);
      existing.gridWidth = tile.grid.width;
      existing.gridHeight = tile.grid.height;
      existing.luminance = luminance;
      existing.textureDirty = true;
    }
  }

  private uploadTexture(
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    state: TileGPUState,
  ): void {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      state.gridWidth,
      state.gridHeight,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      state.luminance,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  private destroyTileState(state: TileGPUState): void {
    if (this.gl) this.gl.deleteTexture(state.texture);
  }

  private disposeGPU(): void {
    const gl = this.gl;
    if (gl) {
      for (const state of this.tileStates.values()) {
        gl.deleteTexture(state.texture);
        state.textureDirty = true;
      }
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.program = null;
    this.vbo = null;
    this.gl = null;
  }

  private createProgram(
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    vertSrc: string,
    fragSrc: string,
  ): WebGLProgram | null {
    const vert = this.compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = this.compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vert || !frag) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("[heatmap-custom] Program link error:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  private compileShader(
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    type: number,
    src: string,
  ): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("[heatmap-custom] Shader compile error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
}

function buildQuadVertices(
  corners: { nw: LatLon; ne: LatLon; sw: LatLon; se: LatLon },
): Float32Array {
  const nw = toMercator(corners.nw);
  const ne = toMercator(corners.ne);
  const sw = toMercator(corners.sw);
  const se = toMercator(corners.se);
  return new Float32Array([
    nw.x, nw.y, 0, 1,
    ne.x, ne.y, 1, 1,
    sw.x, sw.y, 0, 0,
    ne.x, ne.y, 1, 1,
    se.x, se.y, 1, 0,
    sw.x, sw.y, 0, 0,
  ]);
}

function toMercator(ll: LatLon): { x: number; y: number } {
  const m = MercatorCoordinate.fromLngLat({ lng: ll.lon, lat: ll.lat });
  return { x: m.x, y: m.y };
}
