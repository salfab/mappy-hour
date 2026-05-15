/**
 * MapLibre WebGL custom layer that renders Esri World Imagery satellite tiles
 * as a "patchwork" UNDER the loaded sunlight tiles.
 *
 * Goal: keep the playful aquarelle basemap visible where we don't show
 * sunlight data, and swap to a crisp satellite view exactly where sunlight
 * masks are rendered. Stamen Watercolor (Stadia) is metered, so this layer is
 * paired with a `transformRequest` aquarelle skip on the MapLibre side to cut
 * fetches in regions fully covered by satellite patches.
 *
 * Architecture:
 *  - Holds an in-memory texture cache keyed by `z/x/y` (Web Mercator).
 *  - `setLoadedTiles(tiles)` updates the list of sunlight tiles to cover.
 *  - On `render`, computes the Web Mercator tile range required to cover each
 *    sunlight tile's bounding box at zoom = ceil(map.getZoom()) (one notch
 *    above the current zoom for crispness — `// DECISION: use ceil for sharper
 *    imagery`), kicks off async fetches for missing tiles, and draws ready
 *    textures as textured quads positioned by their lat/lon bbox.
 *
 * Note: blending is straight (one alpha), so the patches fully replace the
 * aquarelle below them. A small amount of bleed at the edges may appear at
 * fractional zooms — acceptable for v1.
 */

import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from "maplibre-gl";

// ── Types ────────────────────────────────────────────────────────────────────

interface LatLon {
  lat: number;
  lon: number;
}

export interface SatelliteTileCorners {
  nw: LatLon;
  ne: LatLon;
  sw: LatLon;
  se: LatLon;
}

export interface LoadedTile {
  tileId: string;
  tileCorners?: SatelliteTileCorners;
}

interface SatelliteTileGPU {
  texture: WebGLTexture;
  ready: boolean;
}

// ── Web Mercator helpers ─────────────────────────────────────────────────────

function lon2tileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

function lat2tileY(lat: number, z: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
    2 *
    Math.pow(2, z)
  );
}

export function tileX2lon(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

export function tileY2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Convert sunlight tile lat/lon corners → range of Web Mercator z/x/y tiles. */
function cornersToMercatorTileRange(
  corners: SatelliteTileCorners,
  z: number,
): { xMin: number; xMax: number; yMin: number; yMax: number } {
  const lons = [corners.nw.lon, corners.ne.lon, corners.sw.lon, corners.se.lon];
  const lats = [corners.nw.lat, corners.ne.lat, corners.sw.lat, corners.se.lat];
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const xMin = Math.floor(lon2tileX(minLon, z));
  const xMax = Math.floor(lon2tileX(maxLon, z));
  // Note: Mercator Y axis is flipped (y=0 at top/north). So maxLat → minY.
  const yMin = Math.floor(lat2tileY(maxLat, z));
  const yMax = Math.floor(lat2tileY(minLat, z));
  return { xMin, xMax, yMin, yMax };
}

/** Public helper: check whether a Web Mercator aquarelle tile is fully covered
 *  by the union of the given sunlight tile corner bboxes. Conservative — only
 *  returns true if every lat/lon corner of the aquarelle tile falls inside a
 *  single sunlight tile bbox. Adequate for the metered-skip heuristic. */
export function isAquarelleTileCovered(
  z: number,
  x: number,
  y: number,
  sunlightTiles: ReadonlyArray<LoadedTile>,
): boolean {
  if (sunlightTiles.length === 0) return false;
  const w = tileX2lon(x, z);
  const e = tileX2lon(x + 1, z);
  const n = tileY2lat(y, z);
  const s = tileY2lat(y + 1, z);
  // Conservative: require ALL 4 corners of the aquarelle tile to fall inside
  // some sunlight tile's bbox. Adjacent sunlight tiles don't combine — but
  // adjacent corners of the aquarelle tile may each be in a different sunlight
  // tile, which is fine (we only need each corner individually).
  const corners: Array<[number, number]> = [
    [w, n],
    [e, n],
    [w, s],
    [e, s],
  ];
  for (const [lon, lat] of corners) {
    let covered = false;
    for (const t of sunlightTiles) {
      const c = t.tileCorners;
      if (!c) continue;
      const tMinLon = Math.min(c.nw.lon, c.sw.lon);
      const tMaxLon = Math.max(c.ne.lon, c.se.lon);
      const tMinLat = Math.min(c.sw.lat, c.se.lat);
      const tMaxLat = Math.max(c.nw.lat, c.ne.lat);
      if (lon >= tMinLon && lon <= tMaxLon && lat >= tMinLat && lat <= tMaxLat) {
        covered = true;
        break;
      }
    }
    if (!covered) return false;
  }
  return true;
}

// ── Shaders ─────────────────────────────────────────────────────────────────

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

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_texture;
in vec2 v_texcoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_texture, v_texcoord);
  fragColor = vec4(c.rgb, 1.0);
}
`;

// ── Class ────────────────────────────────────────────────────────────────────

export class MapLibreSatellitePatchworkLayer implements CustomLayerInterface {
  readonly id = "satellite-patchwork";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vbo: WebGLBuffer | null = null;
  private aPos = -1;
  private aTexcoord = -1;

  private readonly tileTextures = new Map<string, SatelliteTileGPU>();
  /** In-flight or completed fetches keyed by "z/x/y". */
  private readonly inFlight = new Set<string>();

  private loadedTiles: LoadedTile[] = [];
  private visible = true;

  constructor(private readonly map: MapLibreMap) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  setLoadedTiles(tiles: LoadedTile[]): void {
    this.loadedTiles = tiles.filter((t) => !!t.tileCorners);
    this.map.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map.triggerRepaint();
  }

  dispose(): void {
    this.disposeGPU();
    this.tileTextures.clear();
    this.inFlight.clear();
    this.loadedTiles = [];
  }

  // ── CustomLayerInterface ───────────────────────────────────────────────────

  onAdd(_map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.gl = gl;
    this.program = this.createProgram(gl, VERT_SRC, FRAG_SRC);
    if (!this.program) {
      console.error("[satellite-patchwork] Shader compilation failed.");
      return;
    }
    this.aPos = gl.getAttribLocation(this.program, "a_pos");
    this.aTexcoord = gl.getAttribLocation(this.program, "a_texcoord");
    this.vbo = gl.createBuffer();
    // Drop cached textures: GL context may have changed after setStyle.
    this.tileTextures.clear();
    this.inFlight.clear();
    if (this.loadedTiles.length > 0) this.map.triggerRepaint();
  }

  onRemove(_map: MapLibreMap, _gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.disposeGPU();
  }

  render(
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    if (!this.visible || !this.program || !this.vbo) return;
    if (this.loadedTiles.length === 0) return;

    // DECISION: use ceil(zoom) for sharper imagery (one notch above the
    // current viewport zoom). Cap to Esri's max zoom of 19.
    const z = Math.min(19, Math.max(0, Math.ceil(this.map.getZoom())));

    // Collect the set of distinct mercator tiles needed to cover all loaded
    // sunlight tiles at this zoom. Deduplicated across overlapping bboxes.
    const needed = new Set<string>();
    for (const tile of this.loadedTiles) {
      if (!tile.tileCorners) continue;
      const range = cornersToMercatorTileRange(tile.tileCorners, z);
      for (let y = range.yMin; y <= range.yMax; y++) {
        for (let x = range.xMin; x <= range.xMax; x++) {
          needed.add(`${z}/${x}/${y}`);
        }
      }
    }

    // Kick off async fetches for any tile that isn't cached + isn't in flight.
    for (const key of needed) {
      if (this.tileTextures.has(key) || this.inFlight.has(key)) continue;
      const [zs, xs, ys] = key.split("/");
      this.fetchTile(Number(zs), Number(xs), Number(ys));
    }

    // Gather drawable (ready) tiles.
    type Drawable = { key: string; z: number; x: number; y: number };
    const drawables: Drawable[] = [];
    for (const key of needed) {
      const state = this.tileTextures.get(key);
      if (!state || !state.ready) continue;
      const [zs, xs, ys] = key.split("/");
      drawables.push({ key, z: Number(zs), x: Number(xs), y: Number(ys) });
    }
    if (drawables.length === 0) return;

    const matrix = options.modelViewProjectionMatrix;
    const worldSize = 512 * Math.pow(2, this.map.getZoom());

    gl.useProgram(this.program);
    (gl as WebGL2RenderingContext).bindVertexArray?.(null);
    const cullFaceWasEnabled = gl.isEnabled(gl.CULL_FACE);
    gl.disable(gl.CULL_FACE);

    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, "u_matrix"),
      false,
      matrix,
    );
    gl.uniform1f(gl.getUniformLocation(this.program, "u_worldSize"), worldSize);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_texture"), 0);
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ZERO);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 4 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aTexcoord);
    gl.vertexAttribPointer(this.aTexcoord, 2, gl.FLOAT, false, stride, 2 * 4);

    for (const d of drawables) {
      const state = this.tileTextures.get(d.key)!;
      // Tile lat/lon bbox.
      const lonW = tileX2lon(d.x, d.z);
      const lonE = tileX2lon(d.x + 1, d.z);
      const latN = tileY2lat(d.y, d.z);
      const latS = tileY2lat(d.y + 1, d.z);

      const nw = toMercator(latN, lonW);
      const ne = toMercator(latN, lonE);
      const sw = toMercator(latS, lonW);
      const se = toMercator(latS, lonE);

      // UV convention: image y=0 is the top of the image. For our vertex
      // shader (no Y flip) the texture is sampled directly: nw → (0,0).
      const verts = new Float32Array([
        nw.x, nw.y, 0, 0,
        ne.x, ne.y, 1, 0,
        sw.x, sw.y, 0, 1,
        ne.x, ne.y, 1, 0,
        se.x, se.y, 1, 1,
        sw.x, sw.y, 0, 1,
      ]);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);

      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.disable(gl.BLEND);
    if (cullFaceWasEnabled) gl.enable(gl.CULL_FACE);
    gl.disableVertexAttribArray(this.aPos);
    gl.disableVertexAttribArray(this.aTexcoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private fetchTile(z: number, x: number, y: number): void {
    const key = `${z}/${x}/${y}`;
    this.inFlight.add(key);
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    // DECISION: HTMLImageElement + crossOrigin to avoid manual CORS plumbing.
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.inFlight.delete(key);
      const gl = this.gl;
      if (!gl) return;
      const tex = gl.createTexture();
      if (!tex) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.tileTextures.set(key, { texture: tex, ready: true });
      this.map.triggerRepaint();
    };
    img.onerror = () => {
      this.inFlight.delete(key);
    };
    img.src = url;
  }

  private disposeGPU(): void {
    const gl = this.gl;
    if (gl) {
      for (const state of this.tileTextures.values()) {
        gl.deleteTexture(state.texture);
      }
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.program = null;
    this.vbo = null;
    this.gl = null;
    // Drop cached entries: textures belonged to the (now gone) GL context.
    this.tileTextures.clear();
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
      console.error("[satellite-patchwork] Program link error:", gl.getProgramInfoLog(program));
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
      console.error("[satellite-patchwork] Shader compile error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
}

function toMercator(lat: number, lon: number): { x: number; y: number } {
  const m = MercatorCoordinate.fromLngLat({ lng: lon, lat });
  return { x: m.x, y: m.y };
}
