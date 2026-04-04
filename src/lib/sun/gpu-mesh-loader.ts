/**
 * Loads real 3D mesh triangles from SwissBUILDINGS3D DXF zip files for
 * GPU shadow rendering.
 *
 * For each building obstacle, looks up the source DXF zip, parses the
 * polyface mesh, matches it to the obstacle, and converts to triangles.
 * Falls back to footprint extrusion if a DXF mesh cannot be found.
 *
 * DXF parsing logic extracted from scripts/analysis/compare-great-escape-v3-vs-detailed-grid1m.ts
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import AdmZip from "adm-zip";
import earcut from "earcut";

import { PROCESSED_BUILDINGS_DIR, RAW_BUILDINGS_DIR } from "@/lib/storage/data-paths";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";

type ObstacleArray = NonNullable<
  Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>
>["obstacles"];
type BuildingObstacle = ObstacleArray[number];

// ── DXF parsing types ────────────────────────────────────────────────────

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

export interface GpuMeshLoadResult {
  /** Float32Array of xyz vertices, 3 per vertex, 9 per triangle */
  vertices: Float32Array;
  triangleCount: number;
  dxfTriangleCount: number;
  fallbackTriangleCount: number;
  dxfObstacleCount: number;
  fallbackObstacleCount: number;
  /** Time to scan zip files */
  zipScanMs: number;
  /** Time to parse DXFs and build meshes */
  parseMs: number;
  /** Total load time */
  totalMs: number;
}

// ── DXF parsing functions ────────────────────────────────────────────────

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFaceRecord(flag: number | undefined): boolean {
  if (flag === undefined) return false;
  return (flag & 128) !== 0 && (flag & 64) === 0;
}

function isCoordinateVertex(flag: number | undefined): boolean {
  return !isFaceRecord(flag);
}

function finalizePolyface(rawVertices: RawVertex[]): Polyface | null {
  const coordVertices: Vec3[] = [];
  const faces: number[][] = [];

  for (const vertex of rawVertices) {
    if (isFaceRecord(vertex.flag)) {
      const indices = [vertex.i1, vertex.i2, vertex.i3, vertex.i4]
        .filter((value): value is number => Number.isFinite(value))
        .map((value) => Math.trunc(value))
        .filter((value) => value !== 0)
        .map((value) => Math.abs(value));
      if (indices.length >= 3) {
        faces.push(indices);
      }
      continue;
    }

    if (
      isCoordinateVertex(vertex.flag) &&
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

function toTriangles(polyface: Polyface): Array<[Vec3, Vec3, Vec3]> {
  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  for (const face of polyface.faces) {
    const valid = face
      .map((index) => polyface.vertices[index - 1] ?? null)
      .filter((value): value is Vec3 => value !== null);
    if (valid.length < 3) continue;
    triangles.push([valid[0], valid[1], valid[2]]);
    if (valid.length >= 4) {
      triangles.push([valid[0], valid[2], valid[3]]);
    }
  }
  return triangles;
}

function matchPolyfaceToObstacle(obstacle: BuildingObstacle, polyfaces: Polyface[]): Polyface | null {
  let best: { score: number; polyface: Polyface } | null = null;
  for (const polyface of polyfaces) {
    const score =
      Math.abs(polyface.minX - obstacle.minX) +
      Math.abs(polyface.minY - obstacle.minY) +
      Math.abs(polyface.maxX - obstacle.maxX) +
      Math.abs(polyface.maxY - obstacle.maxY) +
      Math.abs(polyface.minZ - obstacle.minZ) * 0.15;
    if (score > 6) continue;
    if (!best || score < best.score) {
      best = { score, polyface };
    }
  }
  return best?.polyface ?? null;
}

// ── Zip file scanner ─────────────────────────────────────────────────────

async function listZipFilesByBasename(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const stack = [RAW_BUILDINGS_DIR];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true }) as import("node:fs").Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        map.set(entry.name, fullPath);
      }
    }
  }
  return map;
}

// ── Footprint extrusion fallback ─────────────────────────────────────────

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

// ── Main loader ──────────────────────────────────────────────────────────

// ── Binary cache ─────────────────────────────────────────────────────────
// After the first DXF load (~38s), we serialize the Float32Array to a binary
// file. On subsequent loads, we read the binary directly (<1s).

const GPU_MESH_CACHE_DIR = PROCESSED_BUILDINGS_DIR;

function buildCacheKey(originX: number, originY: number, obstacleCount: number): string {
  return `gpu-mesh-${Math.round(originX)}-${Math.round(originY)}-${obstacleCount}`;
}

interface GpuMeshCacheHeader {
  originX: number;
  originY: number;
  obstacleCount: number;
  triangleCount: number;
  dxfTriangleCount: number;
  fallbackTriangleCount: number;
  dxfObstacleCount: number;
  fallbackObstacleCount: number;
  vertexCount: number;
}

async function loadFromBinaryCache(
  cacheKey: string,
): Promise<GpuMeshLoadResult | null> {
  const headerPath = path.join(GPU_MESH_CACHE_DIR, `${cacheKey}.json`);
  const binPath = path.join(GPU_MESH_CACHE_DIR, `${cacheKey}.bin`);
  try {
    const [headerRaw, binBuf] = await Promise.all([
      fsPromises.readFile(headerPath, "utf-8"),
      fsPromises.readFile(binPath),
    ]);
    const header: GpuMeshCacheHeader = JSON.parse(headerRaw);
    const vertices = new Float32Array(binBuf.buffer, binBuf.byteOffset, binBuf.byteLength / 4);
    if (vertices.length !== header.vertexCount * 3) return null;
    return {
      vertices,
      triangleCount: header.triangleCount,
      dxfTriangleCount: header.dxfTriangleCount,
      fallbackTriangleCount: header.fallbackTriangleCount,
      dxfObstacleCount: header.dxfObstacleCount,
      fallbackObstacleCount: header.fallbackObstacleCount,
      zipScanMs: 0,
      parseMs: 0,
      totalMs: 0,
    };
  } catch {
    return null;
  }
}

async function saveToBinaryCache(
  cacheKey: string,
  result: GpuMeshLoadResult,
  originX: number,
  originY: number,
  obstacleCount: number,
): Promise<void> {
  const headerPath = path.join(GPU_MESH_CACHE_DIR, `${cacheKey}.json`);
  const binPath = path.join(GPU_MESH_CACHE_DIR, `${cacheKey}.bin`);
  const header: GpuMeshCacheHeader = {
    originX,
    originY,
    obstacleCount,
    triangleCount: result.triangleCount,
    dxfTriangleCount: result.dxfTriangleCount,
    fallbackTriangleCount: result.fallbackTriangleCount,
    dxfObstacleCount: result.dxfObstacleCount,
    fallbackObstacleCount: result.fallbackObstacleCount,
    vertexCount: result.vertices.length / 3,
  };
  await fsPromises.mkdir(GPU_MESH_CACHE_DIR, { recursive: true });
  await Promise.all([
    fsPromises.writeFile(headerPath, JSON.stringify(header, null, 2)),
    fsPromises.writeFile(binPath, Buffer.from(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength)),
  ]);
}

// ── Main loader ──────────────────────────────────────────────────────────

export async function loadGpuMeshes(
  obstacles: BuildingObstacle[],
  originX: number,
  originY: number,
): Promise<GpuMeshLoadResult> {
  const t0 = performance.now();

  // ── Try binary cache first ─────────────────────────────────────────
  const cacheKey = buildCacheKey(originX, originY, obstacles.length);
  const cached = await loadFromBinaryCache(cacheKey);
  if (cached) {
    cached.totalMs = Math.round((performance.now() - t0) * 100) / 100;
    console.log(
      `[gpu-mesh-loader] Binary cache hit (${cacheKey}): ${cached.triangleCount} triangles in ${cached.totalMs}ms`,
    );
    return cached;
  }

  // ── Scan zip files ─────────────────────────────────────────────────
  const scanT0 = performance.now();
  const zipMap = await listZipFilesByBasename();
  const zipScanMs = performance.now() - scanT0;

  // ── Group obstacles by sourceZip to avoid parsing the same zip repeatedly ─
  const obstaclesByZip = new Map<string, BuildingObstacle[]>();
  for (const obs of obstacles) {
    if (!obs.sourceZip) continue;
    const list = obstaclesByZip.get(obs.sourceZip) ?? [];
    list.push(obs);
    obstaclesByZip.set(obs.sourceZip, list);
  }

  // ── Parse DXFs and match polyfaces ─────────────────────────────────
  const parseT0 = performance.now();
  const allVertices: number[] = [];
  let dxfTriangleCount = 0;
  let fallbackTriangleCount = 0;
  let dxfObstacleCount = 0;
  let fallbackObstacleCount = 0;
  const matchedObstacleIds = new Set<string>();

  for (const [zipName, obsGroup] of obstaclesByZip) {
    const zipPath = zipMap.get(zipName);
    if (!zipPath) continue;

    let polyfaces: Polyface[];
    try {
      polyfaces = parsePolyfacesFromZip(zipPath);
    } catch {
      continue;
    }

    for (const obs of obsGroup) {
      const matched = matchPolyfaceToObstacle(obs, polyfaces);
      if (!matched) continue;

      const triangles = toTriangles(matched);
      if (triangles.length === 0) continue;

      // Convert to GL coords: x = easting - originX, y = elevation, z = northing - originY
      for (const [a, b, c] of triangles) {
        out3(allVertices, a, originX, originY);
        out3(allVertices, b, originX, originY);
        out3(allVertices, c, originX, originY);
      }
      dxfTriangleCount += triangles.length;
      dxfObstacleCount++;
      matchedObstacleIds.add(obs.id);
    }
  }

  // ── Fallback: extrude footprints for unmatched obstacles ───────────
  for (const obs of obstacles) {
    if (matchedObstacleIds.has(obs.id)) continue;
    if (!obs.footprint || obs.footprint.length < 3 || obs.height < 0.5) continue;
    const triCount = extrudeFootprint(obs, originX, originY, allVertices);
    fallbackTriangleCount += triCount;
    fallbackObstacleCount++;
  }

  const parseMs = performance.now() - parseT0;

  const result: GpuMeshLoadResult = {
    vertices: new Float32Array(allVertices),
    triangleCount: dxfTriangleCount + fallbackTriangleCount,
    dxfTriangleCount,
    fallbackTriangleCount,
    dxfObstacleCount,
    fallbackObstacleCount,
    zipScanMs: Math.round(zipScanMs * 100) / 100,
    parseMs: Math.round(parseMs * 100) / 100,
    totalMs: Math.round((performance.now() - t0) * 100) / 100,
  };

  // ── Save binary cache for next time ────────────────────────────────
  saveToBinaryCache(cacheKey, result, originX, originY, obstacles.length).then(
    () => console.log(`[gpu-mesh-loader] Binary cache saved (${cacheKey}): ${result.triangleCount} triangles`),
    (err) => console.warn(`[gpu-mesh-loader] Failed to save cache: ${err}`),
  );

  return result;
}

/** Emit a DXF vertex as GL coordinates: x = easting - ox, y = elevation (z), z = northing - oy */
function out3(arr: number[], v: Vec3, ox: number, oy: number): void {
  // DXF coordinates: x = easting, y = northing, z = elevation
  arr.push(v.x - ox, v.z, v.y - oy);
}
