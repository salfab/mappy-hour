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
 *  - Single GPU draw call for ALL tiles (instanced rendering) — see below.
 *
 * Architecture (instanced rendering, all tiles in one draw):
 *  - A single `TEXTURE_2D_ARRAY` (the "mega-texture") of shape
 *    `maxW × maxH × totalLayers` holds the frames for every tile. Each tile's
 *    frames live at a contiguous range of slices starting at `baseLayer`.
 *  - A shared vertex buffer holds the 6 vertices of a unit quad in [0,1]²
 *    (the "local position"). Per-instance attributes carry the tile's NW/SE
 *    Mercator corners, the precomputed hatching cycle offset (`tileDirFrac`),
 *    the texture-space scale (`tileW/maxW`, `tileH/maxH`) and the slice base
 *    layer.
 *  - `render()` issues one `drawArraysInstanced(TRIANGLES, 0, 6, N)` per chunk
 *    (chunking only kicks in if `totalLayers > MAX_ARRAY_TEXTURE_LAYERS`).
 *  - `setTimeline()` rebuilds the per-instance buffer and re-uploads the
 *    mega-texture; `setFrameIndex()` only flips a uniform.
 *
 * Texture format:
 *  `R8` luminance per cell, packed frame-major within each tile, frame slices
 *  written into the mega-texture via `texSubImage3D` (one call per tile to keep
 *  the code simple — variable per-tile dimensions are handled by leaving the
 *  padding zone as 0 = indoor, which the fragment shader discards. The vertex
 *  shader applies `iTexScale` so the [0,1]² sample range only covers the
 *  populated subrect of the slice).
 *
 *  Cell values:
 *    0   → indoor  (fragment shader discards)
 *    128 → outdoor + shadow
 *    255 → outdoor + sunny
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

// Match the Leaflet palette (sunlight-map-client.tsx SUNNY_RGBA/SHADOW_RGBA)
// so the two clients are visually consistent. The pastel slate-500 shadow
// reads as a soft veil over the basemap; a saturated navy (the previous
// MapLibre default) made the sun/shadow boundary look unnaturally sharp.
const DEFAULT_SUNNY: RGBA255  = { r: 250, g: 204, b: 21,  a: 102 }; // yellow-400 @ 40%
const DEFAULT_SHADOW: RGBA255 = { r: 100, g: 116, b: 139, a: 89  }; // slate-500 @ 35%

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

// DECISION (2026-05-15): default values are chosen to match Leaflet's bitmap
// renderer pixel-for-pixel (paintTileCanvas in sunlight-map-client.tsx, which
// writes pure SUNNY_RGBA / SHADOW_RGBA per cell on a canvas displayed via
// `image-rendering: pixelated`, with no outline). Leaflet has no smoothed
// transition between outdoor/indoor or sun/shadow, so:
//   - alphaSoft / sunSoft tiny (≈ε) so smoothstep degenerates to a sharp step
//     without hitting the GLSL edge0==edge1 undefined behavior;
//   - outlineWidthPx = -1 so `step(0, u_outlineWidthPx)` zeroes the outline
//     contribution (Leaflet bitmap mode draws no outline);
//   - hatchAlpha = 0 (already the case);
// All these settings remain user-overridable via the Style panel — they're
// just the defaults that produce Leaflet parity out of the box.
export const DEFAULT_SUNLIGHT_STYLE: SunlightStyle = {
  alphaSoft: 0.001,
  sunSoft: 0.001,
  outlineWidthPx: -1,
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

function getTileOutdoorMask(tile: TimelineTile): Uint8Array | undefined {
  if (tile.decodedMasks) return tile.decodedMasks.outdoor;
  return tile.outdoorMaskBase64 ? decodeBase64(tile.outdoorMaskBase64) : undefined;
}

/**
 * Build a packed luminance buffer for ALL frames of a tile, laid out
 * frame-major: `data[frame * W * H + iy * W + ix]`. Each frame's slab is what
 * we copy into one slice of the mega-texture via `texSubImage3D`.
 */
function buildLuminanceArray(
  gridWidth: number,
  gridHeight: number,
  frames: Array<{ sun: Uint8Array; sunNoVeg?: Uint8Array }>,
  outdoorMask: Uint8Array | undefined,
  useNoVeg: boolean,
): Uint8Array {
  const cellsPerFrame = gridWidth * gridHeight;
  const buf = new Uint8Array(cellsPerFrame * frames.length);
  for (let f = 0; f < frames.length; f++) {
    // Fall back to the regular sun mask if the no-vegetation variant is
    // unavailable for this tile (older atlases lack `sunNoVeg`).
    const sunMask = useNoVeg && frames[f].sunNoVeg ? frames[f].sunNoVeg! : frames[f].sun;
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
uniform highp vec2  u_megaTexSize;  // (maxW, maxH) — size of the mega-texture in texels

// Shared vertex attribute: unit quad in [0,1]².
in vec2 a_localPos;

// Per-instance attributes (divisor = 1).
// All 4 corners are carried independently. The tiles come from an LV95 (Swiss)
// grid and are TRAPEZOIDAL in WGS84/Mercator (lat differs along the top edge
// of a tile from west to east). Storing only NW + SE and reconstructing the
// other two corners would shift NE and SW by ~2.7 m, opening a visible
// unpainted band between neighbouring tiles.
in vec2  a_tileNwMerc;   // NW corner in Mercator [0,1]
in vec2  a_tileNeMerc;   // NE corner in Mercator [0,1]
in vec2  a_tileSwMerc;   // SW corner in Mercator [0,1]
in vec2  a_tileSeMerc;   // SE corner in Mercator [0,1]
in vec2  a_texScale;     // (tileW/maxW, tileH/maxH) — populated subrect of slice
in float a_tileDirFrac;  // precomputed hatch cycle offset at the NW corner
in float a_baseLayer;    // starting slice in the mega-texture for this tile

out vec2  v_texcoord;
out vec2  v_texMin;
out vec2  v_texMax;
out highp vec2  v_localPx;
out highp float v_tileDirFrac;
flat out int    v_baseLayer;

void main() {
  // localPos: (0,0) = NW, (1,1) = SE. UV convention matches the legacy
  // buildQuadVertices(): nw=>uv(0,1), sw=>uv(0,0). So v = 1 - localPos.y.
  //
  // The 4 corners are stored independently because the tile is trapezoidal
  // (LV95 grid -> WGS84). Each vertex picks the matching raw corner —
  // no arithmetic, so adjacent tiles agree exactly on every shared edge.
  bool east  = a_localPos.x > 0.5;
  bool south = a_localPos.y > 0.5;
  vec2 merc = south
    ? (east ? a_tileSeMerc : a_tileSwMerc)
    : (east ? a_tileNeMerc : a_tileNwMerc);
  gl_Position = u_matrix * vec4(merc * u_worldSize, 0.0, 1.0);

  // Texture coordinate at the CENTER of the populated texels — emulates
  // CLAMP_TO_EDGE behavior of the legacy per-tile textures so LINEAR filtering
  // never mixes with the zero padding past the populated subrect.
  vec2 tileSize  = a_texScale * u_megaTexSize;            // (gridW, gridH) in texels
  vec2 halfTexel = 0.5 / u_megaTexSize;
  vec2 localXY   = vec2(a_localPos.x, 1.0 - a_localPos.y);
  v_texcoord = halfTexel + localXY * (tileSize - 1.0) / u_megaTexSize;
  // Clamp bounds for neighbor samples in the fragment shader.
  v_texMin = halfTexel;
  v_texMax = halfTexel + (tileSize - 1.0) / u_megaTexSize;

  v_localPx = (merc - a_tileNwMerc) * u_worldSize;
  v_tileDirFrac = a_tileDirFrac;
  v_baseLayer = int(a_baseLayer + 0.5);
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_texture;
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
uniform float u_hatchSpacingPx;
uniform float u_hatchWidthPx;
uniform float u_hatchJitter;
uniform float u_hatchSpaceJitter;
uniform float u_hatchAngle;
uniform vec3  u_hatchColor;
uniform float u_hatchAlpha;
uniform highp float u_worldSize;

in vec2  v_texcoord;
in vec2  v_texMin;
in vec2  v_texMax;
in highp vec2  v_localPx;
in highp float v_tileDirFrac;
flat in int    v_baseLayer;

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
  float layer = float(v_baseLayer + u_frameIndex);
  float v = texture(u_texture, vec3(v_texcoord, layer)).r;
  float outdoor = smoothstep(0.325 - u_alphaSoft, 0.325 + u_alphaSoft, v);
  float sun = smoothstep(0.751 - u_sunSoft, 0.751 + u_sunSoft, v);
  vec4 color = mix(u_shadow, u_sunny, sun);

  float halfW = max(u_outlineWidthPx, 0.0001) * fwidth(v);
  float outlineSun = (1.0 - smoothstep(0.0, halfW, abs(v - 0.751))) * u_outlineMask.x;
  float outlineIn  = (1.0 - smoothstep(0.0, halfW, abs(v - 0.325))) * u_outlineMask.y;
  float outline = clamp(outlineSun + outlineIn, 0.0, 1.0) * step(0.0, u_outlineWidthPx) * u_outlineDarkness;

  float localDir = (v_localPx.x * cos(u_hatchAngle) + v_localPx.y * sin(u_hatchAngle)) / u_hatchSpacingPx;
  float dirBase = v_tileDirFrac + localDir;
  vec2 noiseUv = v_localPx / max(u_hatchSpacingPx * 2.5, 1.0);
  float wobble = vnoise(noiseUv) * u_hatchJitter;
  float lineIdx = floor(dirBase);
  float perLine = (hash(vec2(lineIdx, 0.5)) - 0.5) * u_hatchSpaceJitter;
  float dir = dirBase + wobble + perLine;
  float lineDist = abs(fract(dir) - 0.5);
  float halfWidthCycle = (u_hatchWidthPx * 0.5) / u_hatchSpacingPx;
  float feather = fwidth(dir) * 0.7;
  float hatchLine = 1.0 - smoothstep(halfWidthCycle, halfWidthCycle + feather, lineDist);
  vec2 texel = 1.0 / vec2(textureSize(u_texture, 0).xy);
  // Clamp neighbor samples to the populated subrect so we don't dip into the
  // zero padding past the tile's gridW/gridH boundary.
  vec2 cE = clamp(v_texcoord + vec2( texel.x, 0.0), v_texMin, v_texMax);
  vec2 cW = clamp(v_texcoord - vec2( texel.x, 0.0), v_texMin, v_texMax);
  vec2 cS = clamp(v_texcoord + vec2( 0.0, texel.y), v_texMin, v_texMax);
  vec2 cN = clamp(v_texcoord - vec2( 0.0, texel.y), v_texMin, v_texMax);
  float vAvg = (
    texture(u_texture, vec3(v_texcoord, layer)).r * 2.0 +
    texture(u_texture, vec3(cE, layer)).r +
    texture(u_texture, vec3(cW, layer)).r +
    texture(u_texture, vec3(cS, layer)).r +
    texture(u_texture, vec3(cN, layer)).r
  ) / 6.0;
  float outdoorAvg = smoothstep(0.325 - u_alphaSoft, 0.325 + u_alphaSoft, vAvg);
  float sunAvg = smoothstep(0.751 - u_sunSoft, 0.751 + u_sunSoft, vAvg);
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

// ── Per-tile CPU state ────────────────────────────────────────────────────────

/**
 * State carried across renders for each tile. The actual GPU texture is the
 * shared mega-texture — `baseLayer` says where this tile's frames live inside
 * it. CPU data (luminance, mercator corners, dims) is preserved across
 * `disposeGPU()` so onAdd can re-upload after a basemap swap.
 */
interface TileCPUState {
  /** All frames packed frame-major: byte offset = frame*W*H + iy*W + ix. */
  luminanceArray: Uint8Array;
  gridWidth: number;
  gridHeight: number;
  frameCount: number;
  /** Mercator NW corner (x, y). */
  nwMerc: { x: number; y: number };
  /** Mercator NE corner (x, y). The LV95-aligned tile grid produces
   *  trapezoidal quads in lat/lon, so all 4 corners must be carried
   *  independently — reconstructing NE/SW from NW/SE alone would shift
   *  them ~2.5 m and leave visible bands between neighbouring tiles. */
  neMerc: { x: number; y: number };
  /** Mercator SW corner (x, y). */
  swMerc: { x: number; y: number };
  /** Mercator SE corner (x, y). */
  seMerc: { x: number; y: number };
  /** Starting slice inside the mega-texture. Assigned at re-pack time. */
  baseLayer: number;
  /** True when the slice contents need to be (re-)written. */
  textureDirty: boolean;
  /** The `tile.decodedMasks` ref this `luminanceArray` was built from. */
  decodedMasksRef: TimelineTile["decodedMasks"] | null;
  /** The `ignoreVegetationShadow` flag this `luminanceArray` was built with. */
  useNoVegRef: boolean;
}

// Per-instance attribute layout (interleaved array-of-structs):
//   [0..1]   iTileNwMerc.xy
//   [2..3]   iTileNeMerc.xy
//   [4..5]   iTileSwMerc.xy
//   [6..7]   iTileSeMerc.xy
//   [8..9]   iTexScale.xy
//   [10]     iTileDirFrac
//   [11]     iBaseLayer
const INSTANCE_FLOATS = 12;
const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

// ── Public class ──────────────────────────────────────────────────────────────

export class MapLibreSunlightCustomLayer implements CustomLayerInterface {
  readonly id = "sunlight-custom";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  // Set after onAdd.
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;

  /** Shared vertex buffer (6 vertices of a unit quad, vec2 each). */
  private quadVbo: WebGLBuffer | null = null;
  /** Per-instance buffer (one struct per tile, see INSTANCE_FLOATS). */
  private instanceVbo: WebGLBuffer | null = null;

  /** The single mega-texture holding all tile slices. */
  private megaTexture: WebGLTexture | null = null;
  private megaW = 0;
  private megaH = 0;
  private megaLayers = 0;
  /** Cached `gl.MAX_ARRAY_TEXTURE_LAYERS` for chunking decisions. */
  private maxArrayLayers = 0;

  // Attribute locations (cached after linking).
  private aLocalPos = -1;
  private aTileNwMerc = -1;
  private aTileNeMerc = -1;
  private aTileSwMerc = -1;
  private aTileSeMerc = -1;
  private aTexScale = -1;
  private aTileDirFrac = -1;
  private aBaseLayer = -1;

  // Per-tile state indexed by tileId.
  private readonly tileStates: Map<string, TileCPUState> = new Map();

  /** Tiles to render, in instance order. Built by `repack()`. */
  private renderList: TileCPUState[] = [];
  /** True when the mega-texture / instance buffer need to be rebuilt. */
  private needsRepack = false;

  /** Current frame index, sent to the shader as `u_frameIndex` uniform. */
  private frameIndex = 0;

  private visible = true;

  private sunnyColor: [number, number, number, number] = toGLColor(DEFAULT_SUNNY);
  private shadowColor: [number, number, number, number] = toGLColor(DEFAULT_SHADOW);

  private style: SunlightStyle = { ...DEFAULT_SUNLIGHT_STYLE };
  private textureFilter: "smooth" | "pixel" = "smooth";
  /** When true, the luminance arrays are built from `sunNoVeg` masks so the
   *  rendered shadow ignores vegetation. Mirrors the Leaflet
   *  `ignoreVegetationShadow` flag. */
  private ignoreVegetationShadow = false;

  constructor(private readonly map: MapLibreMap) {}

  /** Update visual style uniforms (outline, soft edges, etc.). */
  setStyle(next: Partial<SunlightStyle>): void {
    this.style = { ...this.style, ...next };
    this.map.triggerRepaint();
  }

  /** Switch the texture sampling mode between LINEAR (smooth) and NEAREST
   *  (pixel-perfect). Re-applies the filter to the mega-texture. */
  setTextureFilter(mode: "smooth" | "pixel"): void {
    this.textureFilter = mode;
    const gl = this.gl;
    if (!gl || !this.megaTexture) {
      this.map.triggerRepaint();
      return;
    }
    const f = mode === "pixel" ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.megaTexture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, f);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.map.triggerRepaint();
  }

  // ── CustomLayerInterface ────────────────────────────────────────────────────

  onAdd(_map: MapLibreMap, glAny: WebGL2RenderingContext | WebGLRenderingContext): void {
    const gl = glAny as WebGL2RenderingContext;
    this.gl = gl;
    this.maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;

    this.program = this.createProgram(gl, VERT_SRC, FRAG_SRC);
    if (!this.program) {
      console.error("[sunlight-custom] Shader compilation failed — layer will be silent.");
      return;
    }

    // Cache attribute locations.
    const p = this.program;
    this.aLocalPos    = gl.getAttribLocation(p, "a_localPos");
    this.aTileNwMerc  = gl.getAttribLocation(p, "a_tileNwMerc");
    this.aTileNeMerc  = gl.getAttribLocation(p, "a_tileNeMerc");
    this.aTileSwMerc  = gl.getAttribLocation(p, "a_tileSwMerc");
    this.aTileSeMerc  = gl.getAttribLocation(p, "a_tileSeMerc");
    this.aTexScale    = gl.getAttribLocation(p, "a_texScale");
    this.aTileDirFrac = gl.getAttribLocation(p, "a_tileDirFrac");
    this.aBaseLayer   = gl.getAttribLocation(p, "a_baseLayer");

    // Shared unit-quad VBO. Triangle list: (0,0),(1,0),(0,1) | (1,0),(1,1),(0,1).
    // localPos: x = west→east (0→1), y = north→south (0→1).
    // Winding chosen to match the legacy buildQuadVertices() order so that
    // (after the Mercator→clip Y-flip) the same culling behavior holds (we
    // disable CULL_FACE anyway, but keep consistency).
    const quadData = new Float32Array([
      0, 0,  1, 0,  0, 1,
      1, 0,  1, 1,  0, 1,
    ]);
    const quadBuf = gl.createBuffer();
    if (!quadBuf) {
      console.error("[sunlight-custom] Failed to create quad VBO.");
      return;
    }
    this.quadVbo = quadBuf;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const instBuf = gl.createBuffer();
    if (!instBuf) {
      console.error("[sunlight-custom] Failed to create instance VBO.");
      return;
    }
    this.instanceVbo = instBuf;

    // After a setStyle basemap swap, tileStates may still hold CPU data.
    // Force a repack so the mega-texture is recreated and re-uploaded.
    if (this.tileStates.size > 0) {
      for (const s of this.tileStates.values()) s.textureDirty = true;
      this.needsRepack = true;
      this.map.triggerRepaint();
    }
  }

  render(glAny: WebGL2RenderingContext | WebGLRenderingContext, options: CustomRenderMethodInput): void {
    if (!this.visible || !this.program || !this.quadVbo || !this.instanceVbo) return;
    const gl = glAny as WebGL2RenderingContext;
    const matrix = options.modelViewProjectionMatrix;

    if (this.needsRepack) {
      this.repack(gl);
      this.needsRepack = false;
    }

    if (this.renderList.length === 0 || !this.megaTexture) return;

    gl.useProgram(this.program);

    // MapLibre uses VAOs internally — unbind before touching attrs.
    gl.bindVertexArray?.(null);

    const cullFaceWasEnabled = gl.isEnabled(gl.CULL_FACE);
    gl.disable(gl.CULL_FACE);

    // Shared vertex attribute (divisor = 0).
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(this.aLocalPos);
    gl.vertexAttribPointer(this.aLocalPos, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(this.aLocalPos, 0);

    // Per-instance attributes (divisor = 1). Stride/offsets match INSTANCE_FLOATS.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.enableVertexAttribArray(this.aTileNwMerc);
    gl.vertexAttribPointer(this.aTileNwMerc, 2, gl.FLOAT, false, INSTANCE_STRIDE, 0);
    gl.vertexAttribDivisor(this.aTileNwMerc, 1);

    gl.enableVertexAttribArray(this.aTileNeMerc);
    gl.vertexAttribPointer(this.aTileNeMerc, 2, gl.FLOAT, false, INSTANCE_STRIDE, 2 * 4);
    gl.vertexAttribDivisor(this.aTileNeMerc, 1);

    gl.enableVertexAttribArray(this.aTileSwMerc);
    gl.vertexAttribPointer(this.aTileSwMerc, 2, gl.FLOAT, false, INSTANCE_STRIDE, 4 * 4);
    gl.vertexAttribDivisor(this.aTileSwMerc, 1);

    gl.enableVertexAttribArray(this.aTileSeMerc);
    gl.vertexAttribPointer(this.aTileSeMerc, 2, gl.FLOAT, false, INSTANCE_STRIDE, 6 * 4);
    gl.vertexAttribDivisor(this.aTileSeMerc, 1);

    gl.enableVertexAttribArray(this.aTexScale);
    gl.vertexAttribPointer(this.aTexScale, 2, gl.FLOAT, false, INSTANCE_STRIDE, 8 * 4);
    gl.vertexAttribDivisor(this.aTexScale, 1);

    gl.enableVertexAttribArray(this.aTileDirFrac);
    gl.vertexAttribPointer(this.aTileDirFrac, 1, gl.FLOAT, false, INSTANCE_STRIDE, 10 * 4);
    gl.vertexAttribDivisor(this.aTileDirFrac, 1);

    gl.enableVertexAttribArray(this.aBaseLayer);
    gl.vertexAttribPointer(this.aBaseLayer, 1, gl.FLOAT, false, INSTANCE_STRIDE, 11 * 4);
    gl.vertexAttribDivisor(this.aBaseLayer, 1);

    // Uniforms.
    const p = this.program;
    gl.uniformMatrix4fv(gl.getUniformLocation(p, "u_matrix"), false, matrix);

    const worldSize = 512 * Math.pow(2, this.map.getZoom());
    gl.uniform1f(gl.getUniformLocation(p, "u_worldSize"), worldSize);
    gl.uniform2f(gl.getUniformLocation(p, "u_megaTexSize"), this.megaW, this.megaH);

    gl.uniform4fv(gl.getUniformLocation(p, "u_sunny"),  this.sunnyColor);
    gl.uniform4fv(gl.getUniformLocation(p, "u_shadow"), this.shadowColor);

    const s = this.style;
    gl.uniform1f(gl.getUniformLocation(p, "u_alphaSoft"),       s.alphaSoft);
    gl.uniform1f(gl.getUniformLocation(p, "u_sunSoft"),         s.sunSoft);
    gl.uniform1f(gl.getUniformLocation(p, "u_outlineWidthPx"),  s.outlineWidthPx);
    gl.uniform1f(gl.getUniformLocation(p, "u_outlineDarkness"), s.outlineDarkness);
    gl.uniform3fv(gl.getUniformLocation(p, "u_outlineColor"),   s.outlineColor);
    gl.uniform2fv(gl.getUniformLocation(p, "u_outlineMask"),    s.outlineMask);
    gl.uniform1f(gl.getUniformLocation(p, "u_outlineOpaque"),   s.outlineOpaque);
    gl.uniform1f(gl.getUniformLocation(p, "u_hatchSpacingPx"),  s.hatchSpacingPx);
    gl.uniform1f(gl.getUniformLocation(p, "u_hatchWidthPx"),    s.hatchWidthPx);
    gl.uniform1f(gl.getUniformLocation(p, "u_hatchJitter"),     s.hatchJitter);
    gl.uniform1f(gl.getUniformLocation(p, "u_hatchSpaceJitter"),s.hatchSpaceJitter);
    gl.uniform1f(gl.getUniformLocation(p, "u_hatchAngle"),      s.hatchAngle);
    gl.uniform3fv(gl.getUniformLocation(p, "u_hatchColor"),     s.hatchColor);
    gl.uniform1f(gl.getUniformLocation(p, "u_hatchAlpha"),      s.hatchAlpha);
    gl.uniform1i(gl.getUniformLocation(p, "u_frameIndex"),      this.frameIndex);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform1i(gl.getUniformLocation(p, "u_texture"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.megaTexture);

    // Single instanced draw call: 6 vertices × N tiles.
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.renderList.length);

    // Cleanup.
    gl.disable(gl.BLEND);
    if (cullFaceWasEnabled) gl.enable(gl.CULL_FACE);

    gl.disableVertexAttribArray(this.aLocalPos);
    gl.disableVertexAttribArray(this.aTileNwMerc);
    gl.disableVertexAttribArray(this.aTileNeMerc);
    gl.disableVertexAttribArray(this.aTileSwMerc);
    gl.disableVertexAttribArray(this.aTileSeMerc);
    gl.disableVertexAttribArray(this.aTexScale);
    gl.disableVertexAttribArray(this.aTileDirFrac);
    gl.disableVertexAttribArray(this.aBaseLayer);
    // Reset divisors to 0 for MapLibre's subsequent draws.
    gl.vertexAttribDivisor(this.aTileNwMerc, 0);
    gl.vertexAttribDivisor(this.aTileNeMerc, 0);
    gl.vertexAttribDivisor(this.aTileSwMerc, 0);
    gl.vertexAttribDivisor(this.aTileSeMerc, 0);
    gl.vertexAttribDivisor(this.aTexScale, 0);
    gl.vertexAttribDivisor(this.aTileDirFrac, 0);
    gl.vertexAttribDivisor(this.aBaseLayer, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  onRemove(_map: MapLibreMap, _gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.disposeGPU();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Replace the full tile set and render at `frameIndex`.
   * Creates CPU state for new tiles, removes state for tiles no longer present.
   */
  setTimeline(
    tiles: TimelineTile[],
    frameIndex: number,
    showSunny: boolean,
    showShadow: boolean,
  ): void {
    this.frameIndex = frameIndex;
    this.updateColorUniforms(showSunny, showShadow);

    const newIds = new Set(tiles.map((t) => t.tileId));
    let mutated = false;
    for (const id of Array.from(this.tileStates.keys())) {
      if (!newIds.has(id)) {
        this.tileStates.delete(id);
        mutated = true;
      }
    }

    for (const tile of tiles) {
      if (this.syncTileState(tile)) mutated = true;
    }

    if (mutated) this.needsRepack = true;
    this.map.triggerRepaint();
  }

  /** Fast-path: advance to a different frame. All frames live in the mega
   *  texture — we only need to flip a uniform. */
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

  /** Toggle the "ignore vegetation shadow" rendering: when true, luminance
   *  arrays are rebuilt from `sunNoVeg` masks. Cheap when the value does not
   *  change; expensive (full repack) otherwise. */
  setIgnoreVegetationShadow(value: boolean): void {
    if (this.ignoreVegetationShadow === value) return;
    this.ignoreVegetationShadow = value;
    // Invalidate every tile so the next render rebuilds the luminance array
    // from the requested mask source.
    for (const s of this.tileStates.values()) {
      s.useNoVegRef = !value; // force mismatch so syncTileState rebuilds
    }
    // Trigger a repack via setTimeline-style invalidation: we walk the
    // existing tile states and rebuild their luminance arrays in place.
    for (const state of this.tileStates.values()) {
      // We can't call syncTileState here because we don't have the TimelineTile
      // refs. Rebuild directly from the decoded masks ref we kept.
      const decoded = state.decodedMasksRef;
      if (!decoded) continue;
      state.luminanceArray = buildLuminanceArray(
        state.gridWidth,
        state.gridHeight,
        decoded.frames,
        decoded.outdoor,
        value,
      );
      state.useNoVegRef = value;
      state.textureDirty = true;
    }
    this.needsRepack = true;
    this.map.triggerRepaint();
  }

  /**
   * Destroy GL resources only — tile CPU data is preserved so `onAdd` can
   * re-upload textures after a `setStyle` basemap swap. Called by `onRemove`.
   */
  private disposeGPU(): void {
    const gl = this.gl;
    if (gl) {
      if (this.megaTexture) gl.deleteTexture(this.megaTexture);
      if (this.quadVbo) gl.deleteBuffer(this.quadVbo);
      if (this.instanceVbo) gl.deleteBuffer(this.instanceVbo);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.megaTexture = null;
    this.megaW = 0;
    this.megaH = 0;
    this.megaLayers = 0;
    this.quadVbo = null;
    this.instanceVbo = null;
    this.program = null;
    this.gl = null;
    for (const s of this.tileStates.values()) s.textureDirty = true;
  }

  /** Full teardown — GPU resources + CPU tile data. Called by React cleanup. */
  dispose(): void {
    this.disposeGPU();
    this.tileStates.clear();
    this.renderList = [];
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private updateColorUniforms(showSunny: boolean, showShadow: boolean): void {
    this.sunnyColor  = showSunny  ? toGLColor(DEFAULT_SUNNY)  : [0, 0, 0, 0];
    this.shadowColor = showShadow ? toGLColor(DEFAULT_SHADOW) : [0, 0, 0, 0];
  }

  /**
   * Create or update CPU state for a single tile. Returns true when the
   * mega-texture / instance buffer need to be rebuilt (new tile, mask change,
   * or dimensions change).
   */
  private syncTileState(tile: TimelineTile): boolean {
    if (!tile.tileCorners || !tile.grid) return false;
    if (!tile.decodedMasks) return false;

    const frames = tile.decodedMasks.frames;
    if (frames.length === 0) return false;

    const existing = this.tileStates.get(tile.tileId);

    // Short-circuit: same mask reference AND same useNoVeg flag → no work.
    if (
      existing &&
      existing.decodedMasksRef === tile.decodedMasks &&
      existing.useNoVegRef === this.ignoreVegetationShadow
    ) {
      return false;
    }

    const outdoorMask = getTileOutdoorMask(tile);
    const luminanceArray = buildLuminanceArray(
      tile.grid.width,
      tile.grid.height,
      frames,
      outdoorMask,
      this.ignoreVegetationShadow,
    );

    const nwMerc = toMercator(tile.tileCorners.nw);
    const neMerc = toMercator(tile.tileCorners.ne);
    const swMerc = toMercator(tile.tileCorners.sw);
    const seMerc = toMercator(tile.tileCorners.se);

    if (!existing) {
      const state: TileCPUState = {
        luminanceArray,
        gridWidth: tile.grid.width,
        gridHeight: tile.grid.height,
        frameCount: frames.length,
        nwMerc,
        neMerc,
        swMerc,
        seMerc,
        baseLayer: 0, // assigned in repack()
        textureDirty: true,
        decodedMasksRef: tile.decodedMasks,
        useNoVegRef: this.ignoreVegetationShadow,
      };
      this.tileStates.set(tile.tileId, state);
    } else {
      existing.luminanceArray = luminanceArray;
      existing.gridWidth = tile.grid.width;
      existing.gridHeight = tile.grid.height;
      existing.frameCount = frames.length;
      existing.nwMerc = nwMerc;
      existing.neMerc = neMerc;
      existing.swMerc = swMerc;
      existing.seMerc = seMerc;
      existing.decodedMasksRef = tile.decodedMasks;
      existing.useNoVegRef = this.ignoreVegetationShadow;
      existing.textureDirty = true;
    }
    return true;
  }

  /**
   * Recompute the mega-texture layout and re-upload everything that changed.
   *
   * Layout decisions:
   *  - `maxW`, `maxH` = max dimensions across all tiles. Smaller tiles occupy a
   *    subrect of their slice; the remainder stays zero (= indoor, discarded).
   *  - Layer-major: tile i's frames occupy layers `[baseLayer[i], baseLayer[i]+F[i])`.
   *  - `totalLayers = sum(frameCount)`.
   *
   * DECISION: if `totalLayers > MAX_ARRAY_TEXTURE_LAYERS` we cap the render
   * list at the first K tiles that fit. In practice modern desktop GPUs report
   * 2048+ layers (≈66 tiles × 31 frames). For Lausanne at zoom 12 (~300 tiles)
   * a multi-mega-texture chunking would be needed if frame count is high, but
   * for the typical 31-frame timeline this maps to ~2048 / 31 ≈ 66 tiles per
   * chunk, which is below the 300-tile viewport size. We log a warning and
   * truncate rather than implementing N-chunk multi-draw — the legacy code was
   * already issuing one draw call per tile, so even a single batched draw of
   * the first 66 is a major win, and full coverage is reached on any GPU with
   * MAX_ARRAY_TEXTURE_LAYERS ≥ 9300 (most Intel/AMD/NVIDIA report ≥ 2048,
   * commonly 8192). For full coverage with > 66 tiles on a low-cap GPU we'd
   * need multi-texture chunking — left as a follow-up.
   */
  private repack(gl: WebGL2RenderingContext): void {
    const tiles = Array.from(this.tileStates.values());
    if (tiles.length === 0) {
      this.renderList = [];
      // Keep the mega-texture allocated so the filter param stays applied;
      // nothing will be drawn anyway because renderList is empty.
      return;
    }

    let maxW = 0;
    let maxH = 0;
    for (const t of tiles) {
      if (t.gridWidth > maxW) maxW = t.gridWidth;
      if (t.gridHeight > maxH) maxH = t.gridHeight;
    }

    // Compute baseLayer per tile, capped at MAX_ARRAY_TEXTURE_LAYERS.
    const cap = this.maxArrayLayers > 0 ? this.maxArrayLayers : 256;
    let layer = 0;
    const fitted: TileCPUState[] = [];
    let truncated = 0;
    for (const t of tiles) {
      if (layer + t.frameCount > cap) {
        truncated++;
        continue;
      }
      t.baseLayer = layer;
      layer += t.frameCount;
      fitted.push(t);
    }
    if (truncated > 0) {
      console.warn(
        `[sunlight-custom] mega-texture cap reached (${cap} layers): ` +
        `${truncated} tile(s) dropped from this frame. ` +
        `Consider implementing multi-texture chunking.`,
      );
    }

    const totalLayers = layer;

    // (Re)allocate the mega-texture if the shape changed or it does not exist.
    const needsRealloc =
      !this.megaTexture ||
      this.megaW !== maxW ||
      this.megaH !== maxH ||
      this.megaLayers !== totalLayers;

    if (needsRealloc) {
      if (this.megaTexture) gl.deleteTexture(this.megaTexture);
      const tex = gl.createTexture();
      if (!tex) {
        console.error("[sunlight-custom] Failed to create mega-texture.");
        return;
      }
      this.megaTexture = tex;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const filter = this.textureFilter === "pixel" ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
      // Allocate storage; contents are zero-initialised by GL spec for
      // texImage3D with a null pointer. All slices need to be re-uploaded.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.R8,
        maxW,
        maxH,
        Math.max(totalLayers, 1),
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        null,
      );
      this.megaW = maxW;
      this.megaH = maxH;
      this.megaLayers = totalLayers;
      // Force every fitted tile to re-upload into its (possibly new) slices.
      for (const t of fitted) t.textureDirty = true;
    } else {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.megaTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    }

    // Upload dirty slices, frame by frame.
    // texSubImage3D writes a (gridW × gridH × 1) sub-rect into the slice at
    // (xoff=0, yoff=0, zoff=baseLayer+f). The remaining (maxW-gridW)×(maxH-gridH)
    // padding stays at its previous value (0 after realloc); the vertex shader's
    // a_texScale keeps sampling within the populated subrect.
    const cellsPerFrame = (t: TileCPUState) => t.gridWidth * t.gridHeight;
    for (const t of fitted) {
      if (!t.textureDirty) continue;
      const stride = cellsPerFrame(t);
      for (let f = 0; f < t.frameCount; f++) {
        const slice = new Uint8Array(
          t.luminanceArray.buffer,
          t.luminanceArray.byteOffset + f * stride,
          stride,
        );
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0, 0, t.baseLayer + f,
          t.gridWidth, t.gridHeight, 1,
          gl.RED,
          gl.UNSIGNED_BYTE,
          slice,
        );
      }
      t.textureDirty = false;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    // Build the interleaved per-instance buffer.
    const inst = new Float32Array(fitted.length * INSTANCE_FLOATS);
    const cosA = Math.cos(this.style.hatchAngle);
    const sinA = Math.sin(this.style.hatchAngle);
    const invSpacing = 1 / Math.max(this.style.hatchSpacingPx, 1e-6);
    const worldSize = 512 * Math.pow(2, this.map.getZoom());
    // NOTE: hatchAngle and hatchSpacingPx are part of the style. Changing them
    // via setStyle does not currently trigger a repack — the cycle offset
    // would drift. Acceptable: defaults are stable and the toggle path is
    // hatchAlpha 0/1 which is unaffected. If style A/B testing exposes this,
    // mark needsRepack on the relevant setStyle deltas.
    for (let i = 0; i < fitted.length; i++) {
      const t = fitted[i];
      const off = i * INSTANCE_FLOATS;
      inst[off     ] = t.nwMerc.x;
      inst[off +  1] = t.nwMerc.y;
      inst[off +  2] = t.neMerc.x;
      inst[off +  3] = t.neMerc.y;
      inst[off +  4] = t.swMerc.x;
      inst[off +  5] = t.swMerc.y;
      inst[off +  6] = t.seMerc.x;
      inst[off +  7] = t.seMerc.y;
      inst[off +  8] = this.megaW > 0 ? t.gridWidth  / this.megaW : 1;
      inst[off +  9] = this.megaH > 0 ? t.gridHeight / this.megaH : 1;
      const originDir = (t.nwMerc.x * worldSize * cosA + t.nwMerc.y * worldSize * sinA) * invSpacing;
      inst[off + 10] = originDir - Math.floor(originDir);
      inst[off + 11] = t.baseLayer;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.renderList = fitted;
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

function toMercator(ll: LatLon): { x: number; y: number } {
  const m = MercatorCoordinate.fromLngLat({ lng: ll.lon, lat: ll.lat });
  return { x: m.x, y: m.y };
}
