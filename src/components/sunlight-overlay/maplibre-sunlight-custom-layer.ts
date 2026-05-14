/**
 * MapLibre WebGL custom layer for the sunlight bitmap overlay (Phase 3).
 *
 * Replaces the DOM-canvas approach (`maplibre-sunlight-layer.ts`) with a
 * `CustomLayerInterface` that renders directly into the MapLibre GL pipeline.
 *
 * Benefits over the DOM approach:
 *  - Correct draw order: inserted BEFORE `cluster-circles` so clusters always
 *    appear on top of the sunlight overlay without any z-index tricks.
 *  - No DOM overlay container; no CSS transform hacks to keep canvases in sync
 *    with the map viewport.
 *  - Single GPU draw call per frame (one quad per tile, batched into a single
 *    VBO, single drawArrays call with all tiles interleaved).
 *
 * Architecture:
 *  - `onAdd(map, gl)` → compile shaders, create VBO/texture objects.
 *  - `render(gl, matrix)` → upload any pending textures, draw all quads.
 *  - `setTimeline() / setFrameIndex()` → update per-tile GPU state, call
 *    `map.triggerRepaint()`.
 *
 * Texture format:
 *  Each tile gets a `LUMINANCE` (WebGL1) or `R8` (WebGL2) texture of size
 *  `gridWidth × gridHeight`. Values are decoded from the bit-packed masks in
 *  CPU before upload:
 *    0   → indoor  (fragment shader discards)
 *    128 → outdoor + shadow
 *    255 → outdoor + sunny
 *
 * Vertex data:
 *  Mercator XY coordinates in [0, 1] (from `MercatorCoordinate.fromLngLat`).
 *  The vertex shader multiplies by `u_matrix` (MapLibre's combined
 *  projection×view matrix in Mercator space) to get clip space.
 */

import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from "maplibre-gl";

// ── Types (mirrored from maplibre-sunlight-layer.ts) ─────────────────────────

interface LatLon {
  lat: number;
  lon: number;
}

interface TimelineFrame {
  index: number;
  localTime: string;
  sunnyCount: number;
  sunMaskBase64: string;
  sunMaskNoVegetationBase64?: string;
}

interface DecodedTileMasks {
  outdoor: Uint8Array;
  frames: Array<{ sun: Uint8Array; sunNoVeg: Uint8Array }>;
}

interface TileGrid {
  width: number;
  height: number;
  minIx: number;
  maxIx: number;
  minIy: number;
  maxIy: number;
}

export interface TimelineTile {
  tileId: string;
  grid?: TileGrid;
  outdoorMaskBase64?: string;
  decodedMasks?: DecodedTileMasks;
  frames: TimelineFrame[];
  tileCorners?: { nw: LatLon; ne: LatLon; sw: LatLon; se: LatLon };
}

// ── Palette (same defaults as maplibre-sunlight-layer.ts) ────────────────────

/** RGBA in [0, 255] integer range. */
interface RGBA255 {
  r: number;
  g: number;
  b: number;
  a: number;
}

const DEFAULT_SUNNY: RGBA255  = { r: 255, g: 220, b: 60,  a: 110 };
const DEFAULT_SHADOW: RGBA255 = { r: 40,  g: 60,  b: 140, a: 100 };

/** Normalise an RGBA255 to [0, 1] for GLSL uniforms. */
function toGLColor(c: RGBA255): [number, number, number, number] {
  return [c.r / 255, c.g / 255, c.b / 255, c.a / 255];
}

// ── Mask decoding helpers ─────────────────────────────────────────────────────

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function readBit(mask: Uint8Array, cellIdx: number): number {
  return (mask[cellIdx >> 3] >> (cellIdx & 7)) & 1;
}

function getTileSunMask(tile: TimelineTile, frameIdx: number): Uint8Array | null {
  if (tile.decodedMasks) return tile.decodedMasks.frames[frameIdx]?.sun ?? null;
  const frame = tile.frames[Math.max(0, Math.min(frameIdx, tile.frames.length - 1))];
  if (!frame) return null;
  return decodeBase64(frame.sunMaskBase64);
}

function getTileOutdoorMask(tile: TimelineTile): Uint8Array | undefined {
  if (tile.decodedMasks) return tile.decodedMasks.outdoor;
  return tile.outdoorMaskBase64 ? decodeBase64(tile.outdoorMaskBase64) : undefined;
}

/**
 * Decode the bit-packed sun + outdoor masks into a flat luminance buffer
 * suitable for GL texture upload.
 *
 *  - indoor cell  (outdoor=0)         → 0
 *  - outdoor + shadow (sunny=0)       → 128
 *  - outdoor + sunny  (sunny=1)       → 255
 *
 * The atlas has iy=0 at the SOUTH edge, but GL textures have v=0 at the BOTTOM
 * by default — which matches the atlas convention. We do NOT flip Y here because
 * the UV coordinates we pass in the VBO already account for the GL convention
 * (nw corner → uv(0,1), sw corner → uv(0,0)).
 */
function buildLuminanceBuffer(
  gridWidth: number,
  gridHeight: number,
  sunMask: Uint8Array,
  outdoorMask: Uint8Array | undefined,
): Uint8Array {
  const buf = new Uint8Array(gridWidth * gridHeight);
  for (let iy = 0; iy < gridHeight; iy++) {
    for (let ix = 0; ix < gridWidth; ix++) {
      const cellIdx = iy * gridWidth + ix;
      if (outdoorMask && readBit(outdoorMask, cellIdx) === 0) {
        buf[cellIdx] = 0; // indoor
      } else {
        buf[cellIdx] = readBit(sunMask, cellIdx) === 1 ? 255 : 128;
      }
    }
  }
  return buf;
}

// ── Shader sources ────────────────────────────────────────────────────────────

const VERT_SRC = /* glsl */ `#version 300 es
uniform mat4 u_matrix;
uniform float u_worldSize;
in vec2 a_pos;
in vec2 a_texcoord;
out vec2 v_texcoord;
void main() {
  // a_pos is in Mercator [0,1] coords; u_matrix expects world-pixel coords.
  gl_Position = u_matrix * vec4(a_pos * u_worldSize, 0.0, 1.0);
  v_texcoord = a_texcoord;
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_texture;
uniform vec4 u_sunny;
uniform vec4 u_shadow;
in vec2 v_texcoord;
out vec4 fragColor;
// Texture values (after the LINEAR filter): ~0=indoor, ~0.5=outdoor+shadow,
// ~1.0=outdoor+sunny. Two soft transitions:
//   - 0 → 0.5  : indoor → shadow (modulates the overall alpha)
//   - 0.5 → 1.0: shadow → sunny  (mixes the two color uniforms)
void main() {
  float v = texture(u_texture, v_texcoord).r;
  float outdoor = smoothstep(0.20, 0.45, v);
  if (outdoor < 0.01) discard;
  float sun = smoothstep(0.55, 0.80, v);
  vec4 color = mix(u_shadow, u_sunny, sun);
  fragColor = vec4(color.rgb, color.a * outdoor);
}
`;

// ── Per-tile GPU state ────────────────────────────────────────────────────────

interface TileGPUState {
  texture: WebGLTexture;
  /** Interleaved Float32Array: [x, y, u, v] × 6 vertices per quad. */
  vertices: Float32Array;
  /** True when the texture upload is pending (first frame or mask change). */
  textureDirty: boolean;
  /** Cached luminance buffer for the current frame. */
  luminance: Uint8Array;
  gridWidth: number;
  gridHeight: number;
}

// ── Public class ──────────────────────────────────────────────────────────────

export class MapLibreSunlightCustomLayer implements CustomLayerInterface {
  readonly id = "sunlight-custom";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  // Set after onAdd.
  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vbo: WebGLBuffer | null = null;

  // Uniform / attribute locations (cached after linking).
  private uMatrix = -1;
  private uTexture = -1;
  private uSunny = -1;
  private uShadow = -1;
  private aPos = -1;
  private aTexcoord = -1;

  // Per-tile state indexed by tileId.
  private readonly tileStates: Map<string, TileGPUState> = new Map();

  // Current tile list (used in render to iterate deterministically).
  private tiles: TimelineTile[] = [];

  private visible = true;

  // Sunny/shadow color uniforms (pre-normalised to [0,1]).
  // These track the *display* state (alpha=0 when toggled off).
  private sunnyColor: [number, number, number, number] = toGLColor(DEFAULT_SUNNY);
  private shadowColor: [number, number, number, number] = toGLColor(DEFAULT_SHADOW);

  constructor(private readonly map: MapLibreMap) {}

  // ── CustomLayerInterface ────────────────────────────────────────────────────

  onAdd(_map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.gl = gl;
    this.program = this.createProgram(gl, VERT_SRC, FRAG_SRC);
    if (!this.program) {
      console.error("[sunlight-custom] Shader compilation failed — layer will be silent.");
      return;
    }

    // Cache locations.
    const p = this.program;
    this.uMatrix   = gl.getUniformLocation(p, "u_matrix") as unknown as number;
    this.uTexture  = gl.getUniformLocation(p, "u_texture") as unknown as number;
    this.uSunny    = gl.getUniformLocation(p, "u_sunny") as unknown as number;
    this.uShadow   = gl.getUniformLocation(p, "u_shadow") as unknown as number;
    this.aPos      = gl.getAttribLocation(p, "a_pos");
    this.aTexcoord = gl.getAttribLocation(p, "a_texcoord");

    // Single shared VBO — resized dynamically in render() as needed.
    const buf = gl.createBuffer();
    if (!buf) {
      console.error("[sunlight-custom] Failed to create VBO.");
      return;
    }
    this.vbo = buf;

    // After a setStyle basemap swap, tileStates may already hold CPU data.
    // Recreate WebGL textures for each tile so render() can upload them.
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
    // `modelViewProjectionMatrix` is the combined projection×view matrix in
    // Mercator space — exactly what the vertex shader needs for `u_matrix`.
    const matrix = options.modelViewProjectionMatrix;

    const activeTiles = this.tiles.filter((t) => {
      const s = this.tileStates.get(t.tileId);
      return s !== undefined && t.tileCorners && t.grid;
    });
    if (activeTiles.length === 0) return;

    // --- Build interleaved vertex buffer [x, y, u, v] × 6 verts × N tiles ---
    const FLOATS_PER_VERT = 4; // x, y, u, v
    const VERTS_PER_TILE = 6;
    const totalVerts = activeTiles.length * VERTS_PER_TILE;
    const buf = new Float32Array(totalVerts * FLOATS_PER_VERT);
    let off = 0;

    for (const tile of activeTiles) {
      const state = this.tileStates.get(tile.tileId)!;
      const v = state.vertices;
      for (let i = 0; i < v.length; i++) {
        buf[off++] = v[i];
      }
    }

    gl.useProgram(this.program);

    // MapLibre GL JS uses VAOs internally. If one is still bound when render()
    // is called, our vertexAttribPointer calls would modify MapLibre's VAO
    // state instead of setting up our own draw. Unbind before touching attrs.
    (gl as WebGL2RenderingContext).bindVertexArray?.(null);

    // MapLibre may have CULL_FACE enabled. The Mercator→clip-space Y-flip
    // reverses our triangle winding (CW after projection), which would cull
    // them as back-faces. Disable face culling for our draw call.
    const cullFaceWasEnabled = gl.isEnabled(gl.CULL_FACE);
    gl.disable(gl.CULL_FACE);

    // Upload combined vertex data.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);

    // Attribute pointers.
    const stride = FLOATS_PER_VERT * 4; // bytes
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aTexcoord);
    gl.vertexAttribPointer(this.aTexcoord, 2, gl.FLOAT, false, stride, 2 * 4);

    // Matrix uniform (MapLibre mercator projection×view).
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, "u_matrix"),
      false,
      matrix,
    );

    // WorldSize: the matrix expects coordinates in world-pixel space (Mercator × worldSize),
    // but our vertices are stored in Mercator [0,1]. MapLibre uses 512px tiles, so
    // worldSize = 512 * 2^zoom (fractional zoom OK).
    const worldSize = 512 * Math.pow(2, this.map.getZoom());
    gl.uniform1f(gl.getUniformLocation(this.program, "u_worldSize"), worldSize);

    // Color uniforms.
    gl.uniform4fv(gl.getUniformLocation(this.program, "u_sunny"),  this.sunnyColor);
    gl.uniform4fv(gl.getUniformLocation(this.program, "u_shadow"), this.shadowColor);

    // Blending.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Draw each tile with its own texture.
    gl.uniform1i(gl.getUniformLocation(this.program, "u_texture"), 0);
    gl.activeTexture(gl.TEXTURE0);

    for (let i = 0; i < activeTiles.length; i++) {
      const tile = activeTiles[i];
      const state = this.tileStates.get(tile.tileId)!;

      gl.bindTexture(gl.TEXTURE_2D, state.texture);

      // Upload texture if dirty.
      if (state.textureDirty) {
        this.uploadTexture(gl, state);
        state.textureDirty = false;
      }

      const vertStart = i * VERTS_PER_TILE;
      gl.drawArrays(gl.TRIANGLES, vertStart, VERTS_PER_TILE);
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

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Replace the full tile set and render at `frameIndex`.
   * Creates GPU state for new tiles, removes state for tiles no longer present.
   */
  setTimeline(
    tiles: TimelineTile[],
    frameIndex: number,
    showSunny: boolean,
    showShadow: boolean,
  ): void {
    this.tiles = tiles;
    this.updateColorUniforms(showSunny, showShadow);

    // Remove GPU state for tiles that disappeared.
    const newIds = new Set(tiles.map((t) => t.tileId));
    for (const [id, state] of this.tileStates) {
      if (!newIds.has(id)) {
        this.destroyTileState(state);
        this.tileStates.delete(id);
      }
    }

    // Create/update GPU state for each tile.
    for (const tile of tiles) {
      this.syncTileState(tile, frameIndex);
    }

    this.map.triggerRepaint();
  }

  /** Fast-path: advance to a different frame without changing the tile set. */
  setFrameIndex(frameIndex: number, showSunny: boolean, showShadow: boolean): void {
    this.updateColorUniforms(showSunny, showShadow);
    for (const tile of this.tiles) {
      this.syncTileState(tile, frameIndex);
    }
    this.map.triggerRepaint();
  }

  /** Show or hide the overlay. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map.triggerRepaint();
  }

  /**
   * Destroy GL resources only — tile CPU data is preserved so `onAdd` can
   * re-upload textures after a `setStyle` basemap swap. Called by `onRemove`.
   */
  private disposeGPU(): void {
    const gl = this.gl;
    if (gl) {
      for (const state of this.tileStates.values()) {
        gl.deleteTexture(state.texture);
        state.textureDirty = true; // needs re-upload on next onAdd
      }
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.program = null;
    this.vbo = null;
    this.gl = null;
    // tileStates CPU data (luminance, vertices, gridWidth/Height) is kept.
  }

  /** Full teardown — GPU resources + CPU tile data. Called by React cleanup. */
  dispose(): void {
    this.disposeGPU();
    this.tileStates.clear();
    this.tiles = [];
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private updateColorUniforms(showSunny: boolean, showShadow: boolean): void {
    this.sunnyColor  = showSunny  ? toGLColor(DEFAULT_SUNNY)  : [0, 0, 0, 0];
    this.shadowColor = showShadow ? toGLColor(DEFAULT_SHADOW) : [0, 0, 0, 0];
  }

  /**
   * Create or update the GPU state for a single tile at the given frame.
   * Geometry is rebuilt only when the tile state is new (corners don't change).
   * The texture is marked dirty whenever the frame or masks change.
   */
  private syncTileState(tile: TimelineTile, frameIndex: number): void {
    if (!tile.tileCorners || !tile.grid) return;

    const sunMask = getTileSunMask(tile, frameIndex);
    if (!sunMask) return;

    const outdoorMask = getTileOutdoorMask(tile);
    const luminance = buildLuminanceBuffer(
      tile.grid.width,
      tile.grid.height,
      sunMask,
      outdoorMask,
    );

    const existing = this.tileStates.get(tile.tileId);

    if (!existing) {
      // First time seeing this tile — create full GPU state.
      const gl = this.gl;
      if (!gl) return;

      const texture = gl.createTexture();
      if (!texture) return;

      // Set texture parameters before first upload.
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const state: TileGPUState = {
        texture,
        vertices: buildQuadVertices(tile.tileCorners),
        textureDirty: true,
        luminance,
        gridWidth: tile.grid.width,
        gridHeight: tile.grid.height,
      };
      this.tileStates.set(tile.tileId, state);
    } else {
      // Refresh ALL geometry/dimension fields, not just luminance: a refetch
      // may return slightly different tileCorners (precision rounding) or a
      // different grid size for tiles at the viewport edge. Leaving the old
      // vertices or gridWidth/gridHeight in place causes visible misalignment
      // and texImage2D reading past the new luminance buffer.
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
    // Disable row-alignment padding: UNPACK_ALIGNMENT defaults to 4, which
    // adds padding bytes to rows whose width is not a multiple of 4 (e.g. 250).
    // Our buffer is tightly packed (1 byte/cell), so we need alignment = 1.
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
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4); // restore default
  }

  private destroyTileState(state: TileGPUState): void {
    const gl = this.gl;
    if (gl) {
      gl.deleteTexture(state.texture);
    }
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
      console.error("[sunlight-custom] Program link error:", gl.getProgramInfoLog(program));
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
      console.error("[sunlight-custom] Shader compile error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

/**
 * Build a 6-vertex (2 triangles) interleaved buffer [x, y, u, v] for a tile
 * quad. Vertices are in Mercator [0, 1] coordinates.
 *
 * GL texture convention: v=0 is the BOTTOM of the texture. The atlas has
 * iy=0 at the SOUTH (bottom) edge, which matches v=0. So:
 *   nw (top-left)  → uv(0, 1)
 *   ne (top-right) → uv(1, 1)
 *   sw (bot-left)  → uv(0, 0)
 *   se (bot-right) → uv(1, 0)
 *
 * Triangle list order: nw, ne, sw | ne, se, sw
 */
function buildQuadVertices(
  corners: { nw: LatLon; ne: LatLon; sw: LatLon; se: LatLon },
): Float32Array {
  const nw = toMercator(corners.nw);
  const ne = toMercator(corners.ne);
  const sw = toMercator(corners.sw);
  const se = toMercator(corners.se);

  // [x, y, u, v] — 4 floats per vertex, 6 vertices = 24 floats
  return new Float32Array([
    // Triangle 1: nw, ne, sw
    nw.x, nw.y, 0, 1,
    ne.x, ne.y, 1, 1,
    sw.x, sw.y, 0, 0,
    // Triangle 2: ne, se, sw
    ne.x, ne.y, 1, 1,
    se.x, se.y, 1, 0,
    sw.x, sw.y, 0, 0,
  ]);
}

function toMercator(ll: LatLon): { x: number; y: number } {
  const m = MercatorCoordinate.fromLngLat({ lng: ll.lon, lat: ll.lat });
  return { x: m.x, y: m.y };
}
