/**
 * Export 3D scene data for the Chateau Blanc area in Gingins.
 *
 * Extracts:
 *   1. Terrain (SwissALTI3D 2m) — 500m x 500m bbox, stitched from 4 tiles
 *   2. Vegetation surface (SwissSURFACE3D 0.5m) — same bbox, stitched from 4 tiles
 *   3. Buildings (SwissBUILDINGS3D DXF) — all polyfaces whose bbox overlaps
 *
 * Output: JSON files in C:/sources/seesharpch/assets/data/
 *
 * Usage:
 *   npx tsx scripts/export-gingins-scene.ts
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { fromFile } from "geotiff";
import AdmZip from "adm-zip";

// ── Constants ────────────────────────────────────────────────────────────

/** Center point in LV95 */
const CENTER_E = 2502875;
const CENTER_N = 1141000;
const HALF_SIZE = 250; // 500m / 2

/** Bounding box in LV95 */
const BBOX = {
  minX: CENTER_E - HALF_SIZE, // 2502625
  maxX: CENTER_E + HALF_SIZE, // 2503125
  minY: CENTER_N - HALF_SIZE, // 1140750
  maxY: CENTER_N + HALF_SIZE, // 1141250
};

const PROJECT_ROOT = process.cwd();
const RAW_SWISSTOPO = path.join(PROJECT_ROOT, "data", "raw", "swisstopo");

/**
 * The bbox spans 4 tiles for both terrain and surface.
 * Each SwissALTI3D / SwissSURFACE3D tile covers 1km x 1km.
 *
 * Tile 2502-1141: E[2502000-2503000] N[1141000-1142000]  (NW quadrant)
 * Tile 2503-1141: E[2503000-2504000] N[1141000-1142000]  (NE quadrant)
 * Tile 2502-1140: E[2502000-2503000] N[1140000-1141000]  (SW quadrant)
 * Tile 2503-1140: E[2503000-2504000] N[1140000-1141000]  (SE quadrant)
 */

const TERRAIN_TIFS = [
  path.join(RAW_SWISSTOPO, "swissalti3d_2m", "swissalti3d_2019_2502-1141", "swissalti3d_2019_2502-1141_2_2056_5728.tif"),
  path.join(RAW_SWISSTOPO, "swissalti3d_2m", "swissalti3d_2019_2503-1141", "swissalti3d_2019_2503-1141_2_2056_5728.tif"),
  path.join(RAW_SWISSTOPO, "swissalti3d_2m", "swissalti3d_2019_2502-1140", "swissalti3d_2019_2502-1140_2_2056_5728.tif"),
  path.join(RAW_SWISSTOPO, "swissalti3d_2m", "swissalti3d_2019_2503-1140", "swissalti3d_2019_2503-1140_2_2056_5728.tif"),
];

const SURFACE_TIFS = [
  path.join(RAW_SWISSTOPO, "swisssurface3d_raster", "swisssurface3d-raster_2018_2502-1141", "swisssurface3d-raster_2018_2502-1141_0.5_2056_5728.tif"),
  path.join(RAW_SWISSTOPO, "swisssurface3d_raster", "swisssurface3d-raster_2019_2503-1141", "swisssurface3d-raster_2019_2503-1141_0.5_2056_5728.tif"),
  path.join(RAW_SWISSTOPO, "swisssurface3d_raster", "swisssurface3d-raster_2018_2502-1140", "swisssurface3d-raster_2018_2502-1140_0.5_2056_5728.tif"),
  path.join(RAW_SWISSTOPO, "swisssurface3d_raster", "swisssurface3d-raster_2019_2503-1140", "swisssurface3d-raster_2019_2503-1140_0.5_2056_5728.tif"),
];

const BUILDINGS_DIR = path.join(RAW_SWISSTOPO, "swissbuildings3d_2");

const OUTPUT_DIR = "C:/sources/seesharpch/assets/data";

// ── Multi-tile GeoTIFF stitcher ──────────────────────────────────────────

/**
 * Reads multiple GeoTIFF tiles covering the bbox and stitches them into a
 * single regular grid. The output resolution matches the first tile's
 * native resolution.
 */
async function readMultiTileGeoTiff(
  tifPaths: string[],
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
): Promise<{
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  resolution: number;
  values: number[];
}> {
  // Read tile metadata from the first tile to get resolution
  const firstTiff = await fromFile(tifPaths[0]);
  const firstImage = await firstTiff.getImage();
  const firstBbox = firstImage.getBoundingBox();
  const tileW = firstImage.getWidth();
  const tileH = firstImage.getHeight();
  const res = (firstBbox[2] - firstBbox[0]) / tileW;
  const closeFn = (firstTiff as { close?: () => false | Promise<void> }).close;
  if (typeof closeFn === "function") await closeFn.call(firstTiff);

  console.log(`  Native resolution: ${res}m`);

  // Output grid dimensions
  const outW = Math.round((bbox.maxX - bbox.minX) / res);
  const outH = Math.round((bbox.maxY - bbox.minY) / res);
  const values = new Float64Array(outW * outH);

  console.log(`  Output grid: ${outW}x${outH} (${outW * outH} samples)`);

  // For each tile, read and blit its contribution into the output grid
  for (const tifPath of tifPaths) {
    console.log(`  Reading: ${path.basename(tifPath)}`);
    const tiff = await fromFile(tifPath);
    const image = await tiff.getImage();
    const [tMinX, tMinY, tMaxX, tMaxY] = image.getBoundingBox();
    const tw = image.getWidth();
    const th = image.getHeight();
    const tResX = (tMaxX - tMinX) / tw;
    const tResY = (tMaxY - tMinY) / th;

    const noDataRaw = image.getGDALNoData();
    const nodata =
      noDataRaw === null || noDataRaw === undefined
        ? null
        : Number.parseFloat(String(noDataRaw));

    // Compute overlap between tile and our bbox
    const overlapMinX = Math.max(bbox.minX, tMinX);
    const overlapMaxX = Math.min(bbox.maxX, tMaxX);
    const overlapMinY = Math.max(bbox.minY, tMinY);
    const overlapMaxY = Math.min(bbox.maxY, tMaxY);

    if (overlapMinX >= overlapMaxX || overlapMinY >= overlapMaxY) {
      console.log(`    No overlap, skipping`);
      const cf = (tiff as { close?: () => false | Promise<void> }).close;
      if (typeof cf === "function") await cf.call(tiff);
      continue;
    }

    // Pixel window within this tile
    const pxLeft = Math.max(0, Math.floor((overlapMinX - tMinX) / tResX));
    const pxRight = Math.min(tw, Math.ceil((overlapMaxX - tMinX) / tResX));
    const pxTop = Math.max(0, Math.floor((tMaxY - overlapMaxY) / tResY));
    const pxBottom = Math.min(th, Math.ceil((tMaxY - overlapMinY) / tResY));

    const cropW = pxRight - pxLeft;
    const cropH = pxBottom - pxTop;

    if (cropW <= 0 || cropH <= 0) {
      const cf = (tiff as { close?: () => false | Promise<void> }).close;
      if (typeof cf === "function") await cf.call(tiff);
      continue;
    }

    console.log(`    Crop: ${cropW}x${cropH} from tile ${tw}x${th}`);

    const rasters = await image.readRasters({
      window: [pxLeft, pxTop, pxRight, pxBottom],
      interleave: true,
      pool: null,
    });
    const data = rasters as Float32Array | Int16Array | Float64Array;

    // Blit into output grid
    // For each pixel in the crop, compute its position in the output grid
    for (let row = 0; row < cropH; row++) {
      for (let col = 0; col < cropW; col++) {
        const v = Number(data[row * cropW + col]);
        if (!Number.isFinite(v) || (nodata !== null && Math.abs(v - nodata) < 1e-6)) {
          continue;
        }

        // Geographic coordinate of this pixel's center
        const geoX = tMinX + (pxLeft + col + 0.5) * tResX;
        const geoY = tMaxY - (pxTop + row + 0.5) * tResY;

        // Output grid position
        const outCol = Math.floor((geoX - bbox.minX) / res);
        const outRow = Math.floor((bbox.maxY - geoY) / res);

        if (outCol >= 0 && outCol < outW && outRow >= 0 && outRow < outH) {
          values[outRow * outW + outCol] = v;
        }
      }
    }

    const cf = (tiff as { close?: () => false | Promise<void> }).close;
    if (typeof cf === "function") await cf.call(tiff);
  }

  // Convert to rounded number[]
  const result: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    result[i] = Math.round(values[i] * 100) / 100;
  }

  return {
    width: outW,
    height: outH,
    minX: bbox.minX,
    minY: bbox.minY,
    maxX: bbox.maxX,
    maxY: bbox.maxY,
    resolution: res,
    values: result,
  };
}

// ── DXF parsing (adapted from gpu-mesh-loader.ts) ────────────────────────

interface RawVertex {
  x?: number;
  y?: number;
  z?: number;
  flag?: number;
  i1?: number;
  i2?: number;
  i3?: number;
  i4?: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Polyface {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  vertices: Vec3[];
  faces: number[][];
}

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFaceRecord(flag: number | undefined): boolean {
  if (flag === undefined) return false;
  return (flag & 128) !== 0 && (flag & 64) === 0;
}

function finalizePolyface(rawVertices: RawVertex[]): Polyface | null {
  const coordVertices: Vec3[] = [];
  const faces: number[][] = [];

  for (const vertex of rawVertices) {
    if (isFaceRecord(vertex.flag)) {
      const indices = [vertex.i1, vertex.i2, vertex.i3, vertex.i4]
        .filter((v): v is number => Number.isFinite(v))
        .map((v) => Math.trunc(v))
        .filter((v) => v !== 0)
        .map((v) => Math.abs(v));
      if (indices.length >= 3) faces.push(indices);
      continue;
    }

    if (
      vertex.x !== undefined &&
      vertex.y !== undefined &&
      vertex.z !== undefined
    ) {
      coordVertices.push({ x: vertex.x, y: vertex.y, z: vertex.z });
    }
  }

  if (coordVertices.length < 3 || faces.length === 0) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const v of coordVertices) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
    if (v.z > maxZ) maxZ = v.z;
  }

  return { minX, minY, minZ, maxX, maxY, maxZ, vertices: coordVertices, faces };
}

function parsePolyfacesFromZip(zipPath: string): Polyface[] {
  const zip = new AdmZip(zipPath);
  const dxfEntry = zip
    .getEntries()
    .find((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".dxf"));
  if (!dxfEntry) return [];

  const lines = dxfEntry.getData().toString("latin1").split(/\r?\n/);
  const polyfaces: Polyface[] = [];
  let pendingSectionName = false;
  let inEntities = false;
  let inPolyline = false;
  let currentVertices: RawVertex[] = [];
  let currentVertex: RawVertex | null = null;

  const flushVertex = () => {
    if (!currentVertex) return;
    currentVertices.push(currentVertex);
    currentVertex = null;
  };

  const flushPolyline = () => {
    flushVertex();
    const polyface = finalizePolyface(currentVertices);
    if (polyface) polyfaces.push(polyface);
    currentVertices = [];
    inPolyline = false;
  };

  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = lines[index].trim();
    const value = lines[index + 1].trim();

    if (code === "0") {
      flushVertex();
      if (value === "SECTION") { pendingSectionName = true; continue; }
      if (value === "ENDSEC") {
        pendingSectionName = false;
        if (inPolyline) flushPolyline();
        inEntities = false;
        continue;
      }
      if (!inEntities) continue;
      if (value === "POLYLINE") {
        if (inPolyline) flushPolyline();
        inPolyline = true;
        currentVertices = [];
        continue;
      }
      if (value === "VERTEX" && inPolyline) { currentVertex = {}; continue; }
      if (value === "SEQEND" && inPolyline) { flushPolyline(); continue; }
      if (inPolyline) flushPolyline();
      continue;
    }

    if (pendingSectionName && code === "2") {
      inEntities = value === "ENTITIES";
      pendingSectionName = false;
      continue;
    }

    if (!inEntities || !inPolyline || !currentVertex) continue;

    if (code === "10") { currentVertex.x = parseNumber(value) ?? undefined; continue; }
    if (code === "20") { currentVertex.y = parseNumber(value) ?? undefined; continue; }
    if (code === "30") { currentVertex.z = parseNumber(value) ?? undefined; continue; }
    if (code === "70") { const p = parseNumber(value); currentVertex.flag = p === null ? undefined : Math.trunc(p); continue; }
    if (code === "71") { const p = parseNumber(value); currentVertex.i1 = p === null ? undefined : Math.trunc(p); continue; }
    if (code === "72") { const p = parseNumber(value); currentVertex.i2 = p === null ? undefined : Math.trunc(p); continue; }
    if (code === "73") { const p = parseNumber(value); currentVertex.i3 = p === null ? undefined : Math.trunc(p); continue; }
    if (code === "74") { const p = parseNumber(value); currentVertex.i4 = p === null ? undefined : Math.trunc(p); }
  }

  if (inPolyline) flushPolyline();
  return polyfaces;
}

function polyfaceOverlapsBbox(
  pf: Polyface,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return !(
    pf.maxX < bbox.minX ||
    pf.minX > bbox.maxX ||
    pf.maxY < bbox.minY ||
    pf.minY > bbox.maxY
  );
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Export Gingins Chateau Blanc scene data ===");
  console.log(`BBOX: E[${BBOX.minX}, ${BBOX.maxX}] N[${BBOX.minY}, ${BBOX.maxY}]`);
  console.log(`Center: E ${CENTER_E}, N ${CENTER_N}`);
  console.log();

  // ── 1. Terrain ────────────────────────────────────────────────────────
  console.log("[1/3] Terrain (SwissALTI3D 2m) — 4 tiles...");
  const terrain = await readMultiTileGeoTiff(TERRAIN_TIFS, BBOX);
  const terrainJson = {
    width: terrain.width,
    height: terrain.height,
    minX: terrain.minX,
    minY: terrain.minY,
    maxX: terrain.maxX,
    maxY: terrain.maxY,
    elevations: terrain.values,
  };
  const terrainPath = path.join(OUTPUT_DIR, "gingins-terrain.json");
  await fsPromises.writeFile(terrainPath, JSON.stringify(terrainJson), "utf8");
  console.log(`  => ${terrainPath} (${terrain.width}x${terrain.height} = ${terrain.values.length} samples)`);

  // Quick stats
  {
    let minE = Infinity, maxE = -Infinity, zeroCount = 0;
    for (const v of terrain.values) {
      if (v === 0) { zeroCount++; continue; }
      if (v < minE) minE = v;
      if (v > maxE) maxE = v;
    }
    if (minE < Infinity) {
      console.log(`  Elevation range: ${minE.toFixed(1)} - ${maxE.toFixed(1)} m`);
      console.log(`  Zero-value pixels: ${zeroCount} / ${terrain.values.length}`);
    }
  }
  console.log();

  // ── 2. Vegetation surface ─────────────────────────────────────────────
  console.log("[2/3] Vegetation surface (SwissSURFACE3D 0.5m) — 4 tiles...");
  const surface = await readMultiTileGeoTiff(SURFACE_TIFS, BBOX);
  const surfaceJson = {
    width: surface.width,
    height: surface.height,
    minX: surface.minX,
    minY: surface.minY,
    maxX: surface.maxX,
    maxY: surface.maxY,
    surface: surface.values,
  };
  const surfacePath = path.join(OUTPUT_DIR, "gingins-surface.json");
  await fsPromises.writeFile(surfacePath, JSON.stringify(surfaceJson), "utf8");
  console.log(`  => ${surfacePath} (${surface.width}x${surface.height} = ${surface.values.length} samples)`);

  {
    let minS = Infinity, maxS = -Infinity, zeroCount = 0;
    for (const v of surface.values) {
      if (v === 0) { zeroCount++; continue; }
      if (v < minS) minS = v;
      if (v > maxS) maxS = v;
    }
    if (minS < Infinity) {
      console.log(`  Surface height range: ${minS.toFixed(1)} - ${maxS.toFixed(1)} m`);
      console.log(`  Zero-value pixels: ${zeroCount} / ${surface.values.length}`);
    }
  }
  console.log();

  // ── 3. Buildings ──────────────────────────────────────────────────────
  console.log("[3/3] Buildings (SwissBUILDINGS3D DXF)...");

  // Scan all zip files recursively
  const zipPaths: string[] = [];
  const stack = [BUILDINGS_DIR];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true }) as fs.Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        zipPaths.push(fullPath);
      }
    }
  }
  console.log(`  Found ${zipPaths.length} zip files total`);

  // Parse all zips and collect polyfaces in our bbox
  const allVertices: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;
  let totalTriangles = 0;
  let totalPolyfaces = 0;
  let zipsWithHits = 0;

  for (const zipPath of zipPaths) {
    let polyfaces: Polyface[];
    try {
      polyfaces = parsePolyfacesFromZip(zipPath);
    } catch {
      continue;
    }

    const matching = polyfaces.filter((pf) => polyfaceOverlapsBbox(pf, BBOX));
    if (matching.length === 0) continue;

    zipsWithHits++;
    for (const pf of matching) {
      totalPolyfaces++;

      // Add vertices (in LV95 coordinates: x=easting, y=northing, z=elevation)
      const baseIdx = vertexOffset;
      for (const v of pf.vertices) {
        allVertices.push(
          Math.round(v.x * 1000) / 1000,
          Math.round(v.y * 1000) / 1000,
          Math.round(v.z * 1000) / 1000,
        );
        vertexOffset++;
      }

      // Add face indices (triangulated: quads become 2 triangles)
      for (const face of pf.faces) {
        const valid = face
          .map((idx) => idx - 1) // DXF 1-based -> 0-based
          .filter((idx) => idx >= 0 && idx < pf.vertices.length)
          .map((idx) => idx + baseIdx); // offset into global vertex array

        if (valid.length >= 3) {
          allIndices.push(valid[0], valid[1], valid[2]);
          totalTriangles++;
        }
        if (valid.length >= 4) {
          allIndices.push(valid[0], valid[2], valid[3]);
          totalTriangles++;
        }
      }
    }
  }

  console.log(`  Matched: ${totalPolyfaces} polyfaces from ${zipsWithHits} zip files`);
  console.log(`  Triangles: ${totalTriangles}, Vertices: ${vertexOffset}`);

  const buildingsJson = {
    bbox: BBOX,
    vertexCount: vertexOffset,
    triangleCount: totalTriangles,
    // Flat array: [x0, y0, z0, x1, y1, z1, ...] where x=easting, y=northing, z=elevation
    vertices: allVertices,
    // Flat array: [i0, i1, i2, i3, i4, i5, ...] groups of 3 = triangles
    indices: allIndices,
  };
  const buildingsPath = path.join(OUTPUT_DIR, "gingins-buildings.json");
  await fsPromises.writeFile(buildingsPath, JSON.stringify(buildingsJson), "utf8");
  console.log(`  => ${buildingsPath}`);
  console.log();

  // Summary
  const terrainSize = (await fsPromises.stat(terrainPath)).size;
  const surfaceSize = (await fsPromises.stat(surfacePath)).size;
  const buildingsSize = (await fsPromises.stat(buildingsPath)).size;
  console.log("=== Done ===");
  console.log(`  Terrain:   ${(terrainSize / 1024).toFixed(0)} KB (${terrain.width}x${terrain.height}, ${terrain.resolution}m res)`);
  console.log(`  Surface:   ${(surfaceSize / 1024).toFixed(0)} KB (${surface.width}x${surface.height}, ${surface.resolution}m res)`);
  console.log(`  Buildings: ${(buildingsSize / 1024).toFixed(0)} KB (${totalPolyfaces} buildings, ${totalTriangles} triangles)`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
