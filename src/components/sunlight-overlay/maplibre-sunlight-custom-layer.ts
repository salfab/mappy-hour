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
 *  Each tile gets a `R8` `TEXTURE_2D_ARRAY` of size `gridWidth × gridHeight ×
 *  frameCount`. All frames for a tile are packed into a single texture so
 *  `setFrameIndex` only needs to flip a `u_frameIndex` uniform — no CPU work
 *  and no GPU upload per slider tick. Values are decoded from the bit-packed
 *  masks in CPU before upload:
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

export interface SunlightStyle {
  alphaSoft: number;
  sunSoft: number;
  outlineWidthPx: number;
  outlineDarkness: number;
  outlineColor: [number, number, number];
  outlineMask: [number, number];
  outlineOpaque: number;
  hatchSpacingPx: number;
  hatchWidthPx: number;
  hatchJitter: number;
  hatchSpaceJitter: number;
  hatchAngle: number;
  hatchColor: [number, number, number];
  hatchAlpha: number;
}

export const DEFAULT_SUNLIGHT_STYLE: SunlightStyle = {
  alphaSoft: 0.125,
  sunSoft: 0.125,
  outlineWidthPx: 2.0,
  outlineDarkness: 1,
  outlineColor: [0, 0, 0],
  outlineMask: [1, 0],         // sun/shadow boundary only
  outlineOpaque: 1,            // keep contour visible on watercolor
  hatchSpacingPx: 35,
  hatchWidthPx: 2.5,
  hatchJitter: 0.12,
  hatchSpaceJitter: 0.30,
  hatchAngle: Math.PI / 4,
  hatchColor: [0.07, 0.13, 0.4],
  hatchAlpha: 0,               // disabled by default; toggle via Style panel
};

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

/**
 * Build a packed luminance buffer for ALL frames of a tile, laid out
 * frame-major: `data[frame * W * H + iy * W + ix]`. This matches the OpenGL
 * convention for `texImage3D(TEXTURE_2D_ARRAY, ...)` where the depth coordinate
 * is the slowest-varying index — slice `n` occupies bytes `[n*W*H, (n+1)*W*H)`.
 */
function buildLuminanceArray(
  gridWidth: number,
  gridHeight: number,
  frames: Array<{ sun: Uint8Array }>,
  outdoorMask: Uint8Array | undefined,
): Uint8Array {
  const cellsPerFrame = gridWidth * gridHeight;
  const buf = new Uint8Array(cellsPerFrame * frames.length);
  for (let f = 0; f < frames.length; f++) {
    const sunMask = frames[f].sun;
    const base = f * cellsPerFrame;
    for (let iy = 0; iy < gridHeight; iy++) {
      for (let ix = 0; ix < gridWidth; ix++) {
        const cellIdx = iy * gridWidth + ix;
        if (outdoorMask && readBit(outdoorMask, cellIdx) === 0) {
          buf[base + cellIdx] = 0;
        } else {
          buf[base + cellIdx] = readBit(sunMask, cellIdx) === 1 ? 255 : 128;
        }
      }
    }
  }
  return buf;
}

// ── Shader sources ────────────────────────────────────────────────────────────

const VERT_SRC = /* glsl */ `#version 300 es
uniform mat4 u_matrix;
uniform highp float u_worldSize;
uniform highp vec2  u_tileOriginMerc; // NW corner of this tile in Mercator
in vec2 a_pos;
in vec2 a_texcoord;
out vec2 v_texcoord;
// Local world-pixel offset from the tile origin. Bounded by tile size
// (~few thousand px at typical zooms) so fract() in fragment is precise.
out highp vec2 v_localPx;
void main() {
  gl_Position = u_matrix * vec4(a_pos * u_worldSize, 0.0, 1.0);
  v_texcoord = a_texcoord;
  v_localPx = (a_pos - u_tileOriginMerc) * u_worldSize;
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
uniform mediump sampler2DArray u_texture;
uniform int u_frameIndex;
uniform vec4 u_sunny;
uniform vec4 u_shadow;
uniform float u_alphaSoft;
uniform float u_sunSoft;
uniform float u_outlineWidthPx;
uniform float u_outlineDarkness;
uniform vec3  u_outlineColor;
uniform vec2  u_outlineMask;
uniform float u_outlineOpaque;
// Hatching (hand-drawn look) — set u_hatchAlpha = 0 to disable.
uniform float u_hatchSpacingPx;     // mean screen pixels between hatch lines
uniform float u_hatchWidthPx;       // line thickness in screen pixels
uniform float u_hatchJitter;        // along-line wobble amplitude (cycle units)
uniform float u_hatchSpaceJitter;   // per-line spacing variation (cycle units)
uniform float u_hatchAngle;     // radians
uniform vec3  u_hatchColor;
uniform float u_hatchAlpha;     // 0=off, 1=full opaque
uniform highp float u_worldSize;     // shared with vertex stage
uniform highp float u_tileDirFrac;   // per-tile cycle offset along hatch direction
in vec2 v_texcoord;
in highp vec2 v_localPx;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) - 0.5;
}

void main() {
  float fi = float(u_frameIndex);
  float v = texture(u_texture, vec3(v_texcoord, fi)).r;
  float outdoor = smoothstep(0.325 - u_alphaSoft, 0.325 + u_alphaSoft, v);
  float sun = smoothstep(0.675 - u_sunSoft, 0.675 + u_sunSoft, v);
  vec4 color = mix(u_shadow, u_sunny, sun);

  float halfW = max(u_outlineWidthPx, 0.0001) * fwidth(v);
  float outlineSun = (1.0 - smoothstep(0.0, halfW, abs(v - 0.675))) * u_outlineMask.x;
  float outlineIn  = (1.0 - smoothstep(0.0, halfW, abs(v - 0.325))) * u_outlineMask.y;
  float outline = clamp(outlineSun + outlineIn, 0.0, 1.0) * step(0.0, u_outlineWidthPx) * u_outlineDarkness;

  // Hand-drawn hatching, gated by shadow density. Lines have a constant
  // on-screen spacing/thickness regardless of zoom: v_merc * u_worldSize is
  // the world-pixel position which matches the screen at native resolution.
  // dir = (worldPx . direction) / spacing
  // Decomposed as: per-tile cycle offset (computed precisely in JS) + the
  // small per-fragment local offset within the tile. fract() is precise
  // because both parts are well-bounded.
  float localDir = (v_localPx.x * cos(u_hatchAngle) + v_localPx.y * sin(u_hatchAngle)) / u_hatchSpacingPx;
  float dirBase = u_tileDirFrac + localDir;
  // Subtle along-line wobble (continuous noise → each line breathes slightly).
  vec2 noiseUv = v_localPx / max(u_hatchSpacingPx * 2.5, 1.0);
  float wobble = vnoise(noiseUv) * u_hatchJitter;
  // Per-line spacing variation: hash on the line index gives each stripe its
  // own constant offset, so the apparent distance between consecutive lines
  // changes slightly without breaking line straightness.
  float lineIdx = floor(dirBase);
  float perLine = (hash(vec2(lineIdx, 0.5)) - 0.5) * u_hatchSpaceJitter;
  float dir = dirBase + wobble + perLine;
  // Straight diagonal lines (no jitter yet — keep math obvious until visual works).
  float lineDist = abs(fract(dir) - 0.5);
  float halfWidthCycle = (u_hatchWidthPx * 0.5) / u_hatchSpacingPx;
  float feather = fwidth(dir) * 0.7;
  float hatchLine = 1.0 - smoothstep(halfWidthCycle, halfWidthCycle + feather, lineDist);
  // For the hatch mask, average v across a small neighbourhood of texels so
  // diagonal lines aren't chopped up by single-cell oscillations of the
  // LINEAR-filtered texture at low-DPR cells.
  vec2 texel = 1.0 / vec2(textureSize(u_texture, 0).xy);
  float vAvg = (
    texture(u_texture, vec3(v_texcoord, fi)).r * 2.0 +
    texture(u_texture, vec3(v_texcoord + vec2( texel.x, 0.0), fi)).r +
    texture(u_texture, vec3(v_texcoord - vec2( texel.x, 0.0), fi)).r +
    texture(u_texture, vec3(v_texcoord + vec2( 0.0, texel.y), fi)).r +
    texture(u_texture, vec3(v_texcoord - vec2( 0.0, texel.y), fi)).r
  ) / 6.0;
  float outdoorAvg = smoothstep(0.325 - u_alphaSoft, 0.325 + u_alphaSoft, vAvg);
  float sunAvg = smoothstep(0.675 - u_sunSoft, 0.675 + u_sunSoft, vAvg);
  float shadowMask = (1.0 - sunAvg) * outdoorAvg;
  float hatch = hatchLine * shadowMask * u_hatchAlpha;

  if (outdoor < 0.01 && outline < 0.01 && hatch < 0.01) discard;

  vec3 baseRgb = mix(color.rgb, u_hatchColor, hatch);
  baseRgb = mix(baseRgb, u_outlineColor, outline);
  float baseAlpha = color.a * outdoor;
  float alpha = mix(baseAlpha, max(max(baseAlpha, outline), hatch), u_outlineOpaque);
  fragColor = vec4(baseRgb, alpha);
}
`;

// ── Per-tile GPU state ────────────────────────────────────────────────────────

interface TileGPUState {
  /** `gl.TEXTURE_2D_ARRAY`, dimensions gridWidth × gridHeight × frameCount. */
  texture: WebGLTexture;
  /** Interleaved Float32Array: [x, y, u, v] × 6 vertices per quad. */
  vertices: Float32Array;
  /** True when the texture upload is pending (first frame or mask change). */
  textureDirty: boolean;
  /** All frames packed frame-major: byte offset = frame*W*H + iy*W + ix. */
  luminanceArray: Uint8Array;
  gridWidth: number;
  gridHeight: number;
  frameCount: number;
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

  /** Current frame index, sent to the shader as `u_frameIndex` uniform. */
  private frameIndex = 0;

  private visible = true;

  // Sunny/shadow color uniforms (pre-normalised to [0,1]).
  // These track the *display* state (alpha=0 when toggled off).
  private sunnyColor: [number, number, number, number] = toGLColor(DEFAULT_SUNNY);
  private shadowColor: [number, number, number, number] = toGLColor(DEFAULT_SHADOW);

  // Parametric style — overridable for A/B testing.
  private style: SunlightStyle = { ...DEFAULT_SUNLIGHT_STYLE };
  private textureFilter: "smooth" | "pixel" = "smooth";

  /** Update visual style uniforms (outline, soft edges, etc.). */
  setStyle(next: Partial<SunlightStyle>): void {
    this.style = { ...this.style, ...next };
    this.map.triggerRepaint();
  }

  /** Switch the texture sampling mode between LINEAR (smooth) and NEAREST
   *  (pixel-perfect). Re-applies the filter to every existing tile texture. */
  setTextureFilter(mode: "smooth" | "pixel"): void {
    this.textureFilter = mode;
    const gl = this.gl as WebGL2RenderingContext | null;
    if (!gl) return;
    const f = mode === "pixel" ? gl.NEAREST : gl.LINEAR;
    for (const state of this.tileStates.values()) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, state.texture);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, f);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.map.triggerRepaint();
  }

  constructor(private readonly map: MapLibreMap) {}

  // ── CustomLayerInterface ────────────────────────────────────────────────────

  onAdd(_map: MapLibreMap, glAny: WebGL2RenderingContext | WebGLRenderingContext): void {
    // WebGL2 is required: we use sampler2DArray + texImage3D.
    const gl = glAny as WebGL2RenderingContext;
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
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const filter = this.textureFilter === "pixel" ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      state.texture = tex;
      state.textureDirty = true;
    }
    if (this.tileStates.size > 0) this.map.triggerRepaint();
  }

  render(glAny: WebGL2RenderingContext | WebGLRenderingContext, options: CustomRenderMethodInput): void {
    if (!this.visible || !this.program || !this.vbo) return;
    const gl = glAny as WebGL2RenderingContext;
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

    // Style uniforms (outline, smooth edges).
    const s = this.style;
    gl.uniform1f(gl.getUniformLocation(this.program, "u_alphaSoft"),       s.alphaSoft);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_sunSoft"),         s.sunSoft);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_outlineWidthPx"),  s.outlineWidthPx);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_outlineDarkness"), s.outlineDarkness);
    gl.uniform3fv(gl.getUniformLocation(this.program, "u_outlineColor"),   s.outlineColor);
    gl.uniform2fv(gl.getUniformLocation(this.program, "u_outlineMask"),    s.outlineMask);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_outlineOpaque"),    s.outlineOpaque);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_hatchSpacingPx"),   s.hatchSpacingPx);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_hatchWidthPx"),     s.hatchWidthPx);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_hatchJitter"),      s.hatchJitter);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_hatchSpaceJitter"), s.hatchSpaceJitter);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_hatchAngle"),       s.hatchAngle);
    gl.uniform3fv(gl.getUniformLocation(this.program, "u_hatchColor"),      s.hatchColor);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_hatchAlpha"),       s.hatchAlpha);

    // Blending.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Draw each tile with its own texture.
    gl.uniform1i(gl.getUniformLocation(this.program, "u_texture"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_frameIndex"), this.frameIndex);
    gl.activeTexture(gl.TEXTURE0);

    // Cache per-tile uniform locations + hatch constants used inside the loop.
    const uTileOriginMerc = gl.getUniformLocation(this.program, "u_tileOriginMerc");
    const uTileDirFrac    = gl.getUniformLocation(this.program, "u_tileDirFrac");
    const cosA = Math.cos(s.hatchAngle);
    const sinA = Math.sin(s.hatchAngle);
    const invSpacing = 1 / Math.max(s.hatchSpacingPx, 1e-6);

    for (let i = 0; i < activeTiles.length; i++) {
      const tile = activeTiles[i];
      const state = this.tileStates.get(tile.tileId)!;

      gl.bindTexture(gl.TEXTURE_2D_ARRAY, state.texture);

      // Upload texture if dirty.
      if (state.textureDirty) {
        this.uploadTexture(gl, state);
        state.textureDirty = false;
      }

      // Per-tile hatching anchor: NW corner Mercator (vertex 0) → cycle frac
      // along the hatch direction. JS doubles preserve precision here even at
      // high zooms, so the fragment shader can add a small local offset and
      // fract() without losing decimals.
      const nwX = state.vertices[0];
      const nwY = state.vertices[1];
      gl.uniform2f(uTileOriginMerc, nwX, nwY);
      const originDir = (nwX * worldSize * cosA + nwY * worldSize * sinA) * invSpacing;
      gl.uniform1f(uTileDirFrac, originDir - Math.floor(originDir));

      const vertStart = i * VERTS_PER_TILE;
      gl.drawArrays(gl.TRIANGLES, vertStart, VERTS_PER_TILE);
    }

    gl.disable(gl.BLEND);
    if (cullFaceWasEnabled) gl.enable(gl.CULL_FACE);
    gl.disableVertexAttribArray(this.aPos);
    gl.disableVertexAttribArray(this.aTexcoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
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
    this.frameIndex = frameIndex;
    this.updateColorUniforms(showSunny, showShadow);

    // Cull GPU state for tiles that are no longer in the current fetch's
    // result set. Their CPU masks survive in the LRU cache, so a future
    // fetch whose bbox brings them back will pre-seed `collected` from the
    // cache and we'll just re-upload the texture (no gzip decode, no
    // network roundtrip).
    const newIds = new Set(tiles.map((t) => t.tileId));
    for (const [id, state] of this.tileStates) {
      if (!newIds.has(id)) {
        this.destroyTileState(state);
        this.tileStates.delete(id);
      }
    }

    for (const tile of tiles) {
      this.syncTileState(tile);
    }

    this.map.triggerRepaint();
  }

  /** Fast-path: advance to a different frame. All frames are already on the GPU
   *  in the TEXTURE_2D_ARRAY of each tile — we only need to flip a uniform. */
  setFrameIndex(frameIndex: number, showSunny: boolean, showShadow: boolean): void {
    this.frameIndex = frameIndex;
    this.updateColorUniforms(showSunny, showShadow);
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
   * Create or update the GPU state for a single tile. All frames are packed
   * into a single TEXTURE_2D_ARRAY, so we don't need a frameIndex parameter —
   * `setFrameIndex` later only flips a uniform.
   * Geometry is rebuilt only when the tile state is new (corners don't change).
   * The texture is marked dirty whenever the masks change.
   */
  private syncTileState(tile: TimelineTile): void {
    if (!tile.tileCorners || !tile.grid) return;
    if (!tile.decodedMasks) return;

    const frames = tile.decodedMasks.frames;
    if (frames.length === 0) return;

    const outdoorMask = getTileOutdoorMask(tile);
    const luminanceArray = buildLuminanceArray(
      tile.grid.width,
      tile.grid.height,
      frames,
      outdoorMask,
    );

    const existing = this.tileStates.get(tile.tileId);

    if (!existing) {
      // First time seeing this tile — create full GPU state.
      const gl = this.gl as WebGL2RenderingContext | null;
      if (!gl) return;

      const texture = gl.createTexture();
      if (!texture) return;

      // Set texture parameters before first upload.
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const filter = this.textureFilter === "pixel" ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

      const state: TileGPUState = {
        texture,
        vertices: buildQuadVertices(tile.tileCorners),
        textureDirty: true,
        luminanceArray,
        gridWidth: tile.grid.width,
        gridHeight: tile.grid.height,
        frameCount: frames.length,
      };
      this.tileStates.set(tile.tileId, state);
    } else {
      // Refresh ALL geometry/dimension fields: a refetch may return slightly
      // different tileCorners (precision rounding), a different grid size for
      // tiles at the viewport edge, or a different frame count if the timeline
      // window changed. Leaving stale dimensions in place causes texImage3D to
      // read past the new luminance buffer or sample the wrong slice.
      existing.vertices = buildQuadVertices(tile.tileCorners);
      existing.gridWidth = tile.grid.width;
      existing.gridHeight = tile.grid.height;
      existing.frameCount = frames.length;
      existing.luminanceArray = luminanceArray;
      existing.textureDirty = true;
    }
  }

  private uploadTexture(
    gl: WebGL2RenderingContext,
    state: TileGPUState,
  ): void {
    // Disable row-alignment padding: UNPACK_ALIGNMENT defaults to 4, which
    // adds padding bytes to rows whose width is not a multiple of 4 (e.g. 250).
    // Our buffer is tightly packed (1 byte/cell), so we need alignment = 1.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      gl.R8,
      state.gridWidth,
      state.gridHeight,
      state.frameCount,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      state.luminanceArray,
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
