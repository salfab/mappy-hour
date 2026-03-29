import fs from "node:fs/promises";
import path from "node:path";

import AdmZip from "adm-zip";
import SunCalc from "suncalc";

import { wgs84ToLv95 } from "@/lib/geo/projection";
import { evaluateBuildingsShadow } from "@/lib/sun/buildings-shadow";
import {
  loadTerrainTilesForBounds,
  sampleSwissTerrainElevationLv95FromTiles,
} from "@/lib/terrain/swiss-terrain";
import { RAW_BUILDINGS_DIR } from "@/lib/storage/data-paths";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

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

interface BuildingObstacle {
  id: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  height: number;
  centerX: number;
  centerY: number;
  halfDiagonal: number;
  footprint?: Array<{ x: number; y: number }>;
  footprintArea?: number;
  sourceZip: string;
}

interface BuildingSpatialGrid {
  version: number;
  cellSizeMeters: number;
  cells: Record<string, number[]>;
}

interface BuildingObstacleIndex {
  indexVersion?: number;
  method: string;
  obstacles: BuildingObstacle[];
  spatialGrid?: BuildingSpatialGrid;
}

interface GridPoint {
  id: string;
  row: number;
  col: number;
  lat: number;
  lon: number;
  easting: number;
  northing: number;
}

interface MeshObstacle {
  id: string;
  sourceZip: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface MatchedMesh {
  obstacle: MeshObstacle;
  triangles: Array<[Vec3, Vec3, Vec3]>;
}

const RAD_TO_DEG = 180 / Math.PI;

const ANALYSIS = {
  name: "McCarthy's terrace / Pépinet nord",
  date: "2026-03-08",
  localTime: "17:00",
  timezone: "Europe/Zurich",
  // Petite zone: nord de la place Pépinet + largeur de la rue a l'ouest du pub.
  bbox: {
    minLon: 6.63195,
    minLat: 46.5213,
    maxLon: 6.63255,
    maxLat: 46.5217,
  },
  grid: {
    rows: 10,
    cols: 20,
  },
  maxDistanceMeters: 2500,
  buildingHeightBiasMeters: 0,
} as const;

function normalizeAzimuthDegrees(azimuthDegreesFromSunCalc: number): number {
  const fromNorth = (azimuthDegreesFromSunCalc + 180) % 360;
  return fromNorth >= 0 ? fromNorth : fromNorth + 360;
}

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFaceRecord(flag: number | undefined): boolean {
  if (flag === undefined) {
    return false;
  }
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
      coordVertices.push({
        x: vertex.x,
        y: vertex.y,
        z: vertex.z,
      });
    }
  }

  if (coordVertices.length < 3 || faces.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const vertex of coordVertices) {
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    minZ = Math.min(minZ, vertex.z);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
    maxZ = Math.max(maxZ, vertex.z);
  }

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    vertices: coordVertices,
    faces,
  };
}

function parsePolyfacesFromZip(zipPath: string): Polyface[] {
  const zip = new AdmZip(zipPath);
  const dxfEntry = zip
    .getEntries()
    .find((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".dxf"));
  if (!dxfEntry) {
    return [];
  }

  const lines = dxfEntry.getData().toString("latin1").split(/\r?\n/);
  const polyfaces: Polyface[] = [];
  let pendingSectionName = false;
  let inEntities = false;
  let inPolyline = false;
  let currentVertices: RawVertex[] = [];
  let currentVertex: RawVertex | null = null;

  const flushVertex = () => {
    if (!currentVertex) {
      return;
    }
    currentVertices.push(currentVertex);
    currentVertex = null;
  };

  const flushPolyline = () => {
    flushVertex();
    const polyface = finalizePolyface(currentVertices);
    if (polyface) {
      polyfaces.push(polyface);
    }
    currentVertices = [];
    inPolyline = false;
  };

  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = lines[index].trim();
    const value = lines[index + 1].trim();

    if (code === "0") {
      flushVertex();
      if (value === "SECTION") {
        pendingSectionName = true;
        continue;
      }
      if (value === "ENDSEC") {
        pendingSectionName = false;
        if (inPolyline) {
          flushPolyline();
        }
        inEntities = false;
        continue;
      }
      if (!inEntities) {
        continue;
      }
      if (value === "POLYLINE") {
        if (inPolyline) {
          flushPolyline();
        }
        inPolyline = true;
        currentVertices = [];
        continue;
      }
      if (value === "VERTEX" && inPolyline) {
        currentVertex = {};
        continue;
      }
      if (value === "SEQEND" && inPolyline) {
        flushPolyline();
        continue;
      }
      if (inPolyline) {
        flushPolyline();
      }
      continue;
    }

    if (pendingSectionName && code === "2") {
      inEntities = value === "ENTITIES";
      pendingSectionName = false;
      continue;
    }

    if (!inEntities || !inPolyline || !currentVertex) {
      continue;
    }

    if (code === "10") {
      currentVertex.x = parseNumber(value) ?? undefined;
      continue;
    }
    if (code === "20") {
      currentVertex.y = parseNumber(value) ?? undefined;
      continue;
    }
    if (code === "30") {
      currentVertex.z = parseNumber(value) ?? undefined;
      continue;
    }
    if (code === "70") {
      const parsed = parseNumber(value);
      currentVertex.flag = parsed === null ? undefined : Math.trunc(parsed);
      continue;
    }
    if (code === "71") {
      const parsed = parseNumber(value);
      currentVertex.i1 = parsed === null ? undefined : Math.trunc(parsed);
      continue;
    }
    if (code === "72") {
      const parsed = parseNumber(value);
      currentVertex.i2 = parsed === null ? undefined : Math.trunc(parsed);
      continue;
    }
    if (code === "73") {
      const parsed = parseNumber(value);
      currentVertex.i3 = parsed === null ? undefined : Math.trunc(parsed);
      continue;
    }
    if (code === "74") {
      const parsed = parseNumber(value);
      currentVertex.i4 = parsed === null ? undefined : Math.trunc(parsed);
    }
  }

  if (inPolyline) {
    flushPolyline();
  }

  return polyfaces;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function rayTriangleIntersectionDistance(
  origin: Vec3,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number | null {
  const epsilon = 1e-9;
  const edge1 = sub(b, a);
  const edge2 = sub(c, a);
  const h = cross(direction, edge2);
  const det = dot(edge1, h);
  if (Math.abs(det) < epsilon) {
    return null;
  }
  const invDet = 1 / det;
  const s = sub(origin, a);
  const u = invDet * dot(s, h);
  if (u < 0 || u > 1) {
    return null;
  }
  const q = cross(s, edge1);
  const v = invDet * dot(direction, q);
  if (v < 0 || u + v > 1) {
    return null;
  }
  const t = invDet * dot(edge2, q);
  if (t <= epsilon) {
    return null;
  }
  return t;
}

function toTriangles(polyface: Polyface): Array<[Vec3, Vec3, Vec3]> {
  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  for (const face of polyface.faces) {
    const valid = face
      .map((index) => polyface.vertices[index - 1] ?? null)
      .filter((value): value is Vec3 => value !== null);
    if (valid.length < 3) {
      continue;
    }
    if (valid.length === 3) {
      triangles.push([valid[0], valid[1], valid[2]]);
      continue;
    }
    triangles.push([valid[0], valid[1], valid[2]]);
    triangles.push([valid[0], valid[2], valid[3]]);
  }
  return triangles;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildGridPoints(): GridPoint[] {
  const points: GridPoint[] = [];
  for (let row = 0; row < ANALYSIS.grid.rows; row += 1) {
    for (let col = 0; col < ANALYSIS.grid.cols; col += 1) {
      const lon =
        ANALYSIS.bbox.minLon +
        ((col + 0.5) / ANALYSIS.grid.cols) * (ANALYSIS.bbox.maxLon - ANALYSIS.bbox.minLon);
      const lat =
        ANALYSIS.bbox.minLat +
        ((row + 0.5) / ANALYSIS.grid.rows) * (ANALYSIS.bbox.maxLat - ANALYSIS.bbox.minLat);
      const lv95 = wgs84ToLv95(lon, lat);
      points.push({
        id: `r${row}c${col}`,
        row,
        col,
        lat,
        lon,
        easting: lv95.easting,
        northing: lv95.northing,
      });
    }
  }
  return points;
}

function buildCellKey(cellX: number, cellY: number): string {
  return `${cellX}:${cellY}`;
}

function collectObstacleIndicesInBounds(params: {
  spatialGrid: BuildingSpatialGrid;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}): Set<number> {
  const cellSizeMeters = params.spatialGrid.cellSizeMeters;
  const minCellX = Math.floor(params.minX / cellSizeMeters);
  const maxCellX = Math.floor(params.maxX / cellSizeMeters);
  const minCellY = Math.floor(params.minY / cellSizeMeters);
  const maxCellY = Math.floor(params.maxY / cellSizeMeters);
  const candidateIndices = new Set<number>();

  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      const key = buildCellKey(cellX, cellY);
      const indices = params.spatialGrid.cells[key];
      if (!indices || indices.length === 0) {
        continue;
      }
      for (const obstacleIndex of indices) {
        candidateIndices.add(obstacleIndex);
      }
    }
  }

  return candidateIndices;
}

function collectCandidateObstacleIndices(params: {
  obstacles: BuildingObstacle[];
  spatialGrid?: BuildingSpatialGrid;
  pointX: number;
  pointY: number;
  solarAzimuthDeg: number;
  maxDistanceMeters: number;
  maxHalfDiagonal: number;
}): number[] {
  if (!params.spatialGrid) {
    return params.obstacles.map((_, index) => index);
  }

  const azimuthRad = (params.solarAzimuthDeg * Math.PI) / 180;
  const dirX = Math.sin(azimuthRad);
  const dirY = Math.cos(azimuthRad);
  const corridorPadding = params.maxHalfDiagonal + params.spatialGrid.cellSizeMeters;
  const endX = params.pointX + dirX * params.maxDistanceMeters;
  const endY = params.pointY + dirY * params.maxDistanceMeters;
  const minX = Math.min(params.pointX, endX) - corridorPadding;
  const maxX = Math.max(params.pointX, endX) + corridorPadding;
  const minY = Math.min(params.pointY, endY) - corridorPadding;
  const maxY = Math.max(params.pointY, endY) + corridorPadding;

  const candidateIndices = collectObstacleIndicesInBounds({
    spatialGrid: params.spatialGrid,
    minX,
    maxX,
    minY,
    maxY,
  });
  const filtered: number[] = [];

  for (const obstacleIndex of candidateIndices) {
    const obstacle = params.obstacles[obstacleIndex];
    if (!obstacle) {
      continue;
    }
    const dx = obstacle.centerX - params.pointX;
    const dy = obstacle.centerY - params.pointY;
    const dotValue = dx * dirX + dy * dirY;
    if (dotValue < -obstacle.halfDiagonal) {
      continue;
    }
    const centerDistance = Math.hypot(dx, dy);
    if (centerDistance > params.maxDistanceMeters + obstacle.halfDiagonal) {
      continue;
    }
    filtered.push(obstacleIndex);
  }

  return filtered;
}

async function listZipFilesByBasename(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const stack = [RAW_BUILDINGS_DIR];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
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

function meshKey(obstacle: MeshObstacle): string {
  return `${obstacle.sourceZip}|${round3(obstacle.minX)}|${round3(obstacle.minY)}|${round3(
    obstacle.maxX,
  )}|${round3(obstacle.maxY)}`;
}

function obstacleFromBuilding(obstacle: BuildingObstacle): MeshObstacle {
  return {
    id: obstacle.id,
    sourceZip: obstacle.sourceZip,
    minX: obstacle.minX,
    minY: obstacle.minY,
    minZ: obstacle.minZ,
    maxX: obstacle.maxX,
    maxY: obstacle.maxY,
    maxZ: obstacle.maxZ,
  };
}

function matchPolyfaceToObstacle(obstacle: MeshObstacle, polyfaces: Polyface[]): Polyface | null {
  let best: { score: number; polyface: Polyface } | null = null;
  for (const polyface of polyfaces) {
    const score =
      Math.abs(polyface.minX - obstacle.minX) +
      Math.abs(polyface.minY - obstacle.minY) +
      Math.abs(polyface.maxX - obstacle.maxX) +
      Math.abs(polyface.maxY - obstacle.maxY) +
      Math.abs(polyface.minZ - obstacle.minZ) * 0.15;

    if (score > 6) {
      continue;
    }
    if (!best || score < best.score) {
      best = { score, polyface };
    }
  }

  return best?.polyface ?? null;
}

function evaluateDetailedBlocked(params: {
  meshes: MatchedMesh[];
  point: Vec3;
  azimuthDeg: number;
  altitudeDeg: number;
  maxDistanceMeters: number;
}): { blocked: boolean; blockerId: string | null; distanceMeters: number | null } {
  if (params.altitudeDeg <= 0) {
    return {
      blocked: false,
      blockerId: null,
      distanceMeters: null,
    };
  }

  const azimuthRad = (params.azimuthDeg * Math.PI) / 180;
  const altitudeRad = (params.altitudeDeg * Math.PI) / 180;
  const cosAlt = Math.cos(altitudeRad);
  const direction: Vec3 = {
    x: Math.sin(azimuthRad) * cosAlt,
    y: Math.cos(azimuthRad) * cosAlt,
    z: Math.sin(altitudeRad),
  };
  const maxT = cosAlt <= 1e-6 ? Number.POSITIVE_INFINITY : params.maxDistanceMeters / cosAlt;

  let bestT: number | null = null;
  let bestId: string | null = null;

  for (const mesh of params.meshes) {
    for (const triangle of mesh.triangles) {
      const t = rayTriangleIntersectionDistance(
        params.point,
        direction,
        triangle[0],
        triangle[1],
        triangle[2],
      );
      if (t === null || t > maxT) {
        continue;
      }
      if (bestT === null || t < bestT) {
        bestT = t;
        bestId = mesh.obstacle.id;
      }
    }
  }

  if (bestT === null) {
    return { blocked: false, blockerId: null, distanceMeters: null };
  }

  return {
    blocked: true,
    blockerId: bestId,
    distanceMeters: Math.round(bestT * cosAlt * 1000) / 1000,
  };
}

async function loadIndexFromPath(indexPath: string): Promise<BuildingObstacleIndex> {
  const raw = await fs.readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as BuildingObstacleIndex;
  if (!Array.isArray(parsed.obstacles)) {
    throw new Error(`Invalid index file: ${indexPath}`);
  }
  return parsed;
}

async function main() {
  const coarsePath = path.join(
    process.cwd(),
    "data",
    "processed",
    "buildings",
    "lausanne-buildings-index.v2.json",
  );
  const improvedPath = path.join(
    process.cwd(),
    "data",
    "processed",
    "buildings",
    "lausanne-buildings-index.v3.json",
  );

  const [coarseIndex, improvedIndex] = await Promise.all([
    loadIndexFromPath(coarsePath),
    loadIndexFromPath(improvedPath),
  ]);

  const utcDate = zonedDateTimeToUtc(ANALYSIS.date, ANALYSIS.localTime, ANALYSIS.timezone);
  const points = buildGridPoints();
  const corners = [
    wgs84ToLv95(ANALYSIS.bbox.minLon, ANALYSIS.bbox.minLat),
    wgs84ToLv95(ANALYSIS.bbox.minLon, ANALYSIS.bbox.maxLat),
    wgs84ToLv95(ANALYSIS.bbox.maxLon, ANALYSIS.bbox.minLat),
    wgs84ToLv95(ANALYSIS.bbox.maxLon, ANALYSIS.bbox.maxLat),
  ];
  const terrainTiles = await loadTerrainTilesForBounds({
    minX: Math.min(...corners.map((point) => point.easting)) - 30,
    minY: Math.min(...corners.map((point) => point.northing)) - 30,
    maxX: Math.max(...corners.map((point) => point.easting)) + 30,
    maxY: Math.max(...corners.map((point) => point.northing)) + 30,
  });

  if (!terrainTiles || terrainTiles.length === 0) {
    throw new Error("Terrain tiles unavailable for analysis bbox.");
  }

  const coarseMaxHalfDiagonal = coarseIndex.obstacles.reduce(
    (max, obstacle) => Math.max(max, obstacle.halfDiagonal),
    0,
  );
  const improvedMaxHalfDiagonal = improvedIndex.obstacles.reduce(
    (max, obstacle) => Math.max(max, obstacle.halfDiagonal),
    0,
  );

  const candidateMeshObstacles = new Map<string, MeshObstacle>();
  const evaluablePoints: Array<
    GridPoint & { elevation: number; azimuthDeg: number; altitudeDeg: number }
  > = [];

  for (const point of points) {
    const elevation = sampleSwissTerrainElevationLv95FromTiles(
      terrainTiles,
      point.easting,
      point.northing,
    );
    if (elevation === null) {
      continue;
    }

    const solar = SunCalc.getPosition(utcDate, point.lat, point.lon);
    const altitudeDeg = solar.altitude * RAD_TO_DEG;
    const azimuthDeg = normalizeAzimuthDegrees(solar.azimuth * RAD_TO_DEG);

    evaluablePoints.push({
      ...point,
      elevation,
      altitudeDeg,
      azimuthDeg,
    });

    const coarseCandidates = collectCandidateObstacleIndices({
      obstacles: coarseIndex.obstacles,
      spatialGrid: coarseIndex.spatialGrid,
      pointX: point.easting,
      pointY: point.northing,
      solarAzimuthDeg: azimuthDeg,
      maxDistanceMeters: ANALYSIS.maxDistanceMeters,
      maxHalfDiagonal: coarseMaxHalfDiagonal,
    });
    for (const index of coarseCandidates) {
      const obstacle = coarseIndex.obstacles[index];
      if (!obstacle) {
        continue;
      }
      const meshObstacle = obstacleFromBuilding(obstacle);
      candidateMeshObstacles.set(meshKey(meshObstacle), meshObstacle);
    }

    const improvedCandidates = collectCandidateObstacleIndices({
      obstacles: improvedIndex.obstacles,
      spatialGrid: improvedIndex.spatialGrid,
      pointX: point.easting,
      pointY: point.northing,
      solarAzimuthDeg: azimuthDeg,
      maxDistanceMeters: ANALYSIS.maxDistanceMeters,
      maxHalfDiagonal: improvedMaxHalfDiagonal,
    });
    for (const index of improvedCandidates) {
      const obstacle = improvedIndex.obstacles[index];
      if (!obstacle) {
        continue;
      }
      const meshObstacle = obstacleFromBuilding(obstacle);
      candidateMeshObstacles.set(meshKey(meshObstacle), meshObstacle);
    }
  }

  const zipsByBasename = await listZipFilesByBasename();
  const polyfaceCache = new Map<string, Polyface[]>();
  const meshes: MatchedMesh[] = [];
  let missingZip = 0;
  let unmatchedMesh = 0;

  for (const obstacle of candidateMeshObstacles.values()) {
    const zipPath = zipsByBasename.get(obstacle.sourceZip);
    if (!zipPath) {
      missingZip += 1;
      continue;
    }
    let polyfaces = polyfaceCache.get(zipPath);
    if (!polyfaces) {
      polyfaces = parsePolyfacesFromZip(zipPath);
      polyfaceCache.set(zipPath, polyfaces);
    }
    const matched = matchPolyfaceToObstacle(obstacle, polyfaces);
    if (!matched) {
      unmatchedMesh += 1;
      continue;
    }

    meshes.push({
      obstacle,
      triangles: toTriangles(matched),
    });
  }

  type PointComparison = {
    id: string;
    row: number;
    col: number;
    lat: number;
    lon: number;
    altitudeDeg: number;
    coarseBlocked: boolean;
    improvedBlocked: boolean;
    detailedBlocked: boolean;
    coarseBlockerId: string | null;
    improvedBlockerId: string | null;
    detailedBlockerId: string | null;
  };

  const comparisons: PointComparison[] = [];

  for (const point of evaluablePoints) {
    const coarse = evaluateBuildingsShadow(
      coarseIndex.obstacles,
      {
        pointX: point.easting,
        pointY: point.northing,
        pointElevation: point.elevation,
        solarAzimuthDeg: point.azimuthDeg,
        solarAltitudeDeg: point.altitudeDeg,
        maxDistanceMeters: ANALYSIS.maxDistanceMeters,
        buildingHeightBiasMeters: ANALYSIS.buildingHeightBiasMeters,
      },
      coarseIndex.spatialGrid,
    );

    const improved = evaluateBuildingsShadow(
      improvedIndex.obstacles,
      {
        pointX: point.easting,
        pointY: point.northing,
        pointElevation: point.elevation,
        solarAzimuthDeg: point.azimuthDeg,
        solarAltitudeDeg: point.altitudeDeg,
        maxDistanceMeters: ANALYSIS.maxDistanceMeters,
        buildingHeightBiasMeters: ANALYSIS.buildingHeightBiasMeters,
      },
      improvedIndex.spatialGrid,
    );

    const detailed = evaluateDetailedBlocked({
      meshes,
      point: {
        x: point.easting,
        y: point.northing,
        z: point.elevation,
      },
      azimuthDeg: point.azimuthDeg,
      altitudeDeg: point.altitudeDeg,
      maxDistanceMeters: ANALYSIS.maxDistanceMeters,
    });

    comparisons.push({
      id: point.id,
      row: point.row,
      col: point.col,
      lat: round3(point.lat),
      lon: round3(point.lon),
      altitudeDeg: round3(point.altitudeDeg),
      coarseBlocked: coarse.blocked,
      improvedBlocked: improved.blocked,
      detailedBlocked: detailed.blocked,
      coarseBlockerId: coarse.blockerId,
      improvedBlockerId: improved.blockerId,
      detailedBlockerId: detailed.blockerId,
    });
  }

  const coarseMismatches = comparisons.filter(
    (entry) => entry.coarseBlocked !== entry.detailedBlocked,
  );
  const improvedMismatches = comparisons.filter(
    (entry) => entry.improvedBlocked !== entry.detailedBlocked,
  );
  const improvedWins = comparisons.filter(
    (entry) =>
      entry.improvedBlocked === entry.detailedBlocked &&
      entry.coarseBlocked !== entry.detailedBlocked,
  );
  const coarseWins = comparisons.filter(
    (entry) =>
      entry.coarseBlocked === entry.detailedBlocked &&
      entry.improvedBlocked !== entry.detailedBlocked,
  );

  const output = {
    analysis: ANALYSIS,
    indexes: {
      coarse: {
        indexVersion: coarseIndex.indexVersion ?? null,
        method: coarseIndex.method,
        obstacleCount: coarseIndex.obstacles.length,
      },
      improved: {
        indexVersion: improvedIndex.indexVersion ?? null,
        method: improvedIndex.method,
        obstacleCount: improvedIndex.obstacles.length,
      },
    },
    mesh: {
      candidateObstacles: candidateMeshObstacles.size,
      matchedMeshes: meshes.length,
      missingZip,
      unmatchedMesh,
    },
    points: {
      requested: ANALYSIS.grid.rows * ANALYSIS.grid.cols,
      evaluated: comparisons.length,
    },
    results: {
      coarseVsDetailedMismatchCount: coarseMismatches.length,
      coarseVsDetailedMismatchRatio:
        comparisons.length === 0 ? 0 : coarseMismatches.length / comparisons.length,
      improvedVsDetailedMismatchCount: improvedMismatches.length,
      improvedVsDetailedMismatchRatio:
        comparisons.length === 0 ? 0 : improvedMismatches.length / comparisons.length,
      improvedWinsCount: improvedWins.length,
      coarseWinsCount: coarseWins.length,
    },
    mismatchesPreview: {
      coarseVsDetailed: coarseMismatches.slice(0, 20),
      improvedVsDetailed: improvedMismatches.slice(0, 20),
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(
    `[compare-mccarthys-terrace-models] Failed: ${
      error instanceof Error ? error.message : "Unknown error"
    }`,
  );
  process.exitCode = 1;
});
