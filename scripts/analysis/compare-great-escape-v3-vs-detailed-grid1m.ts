import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import AdmZip from "adm-zip";
import SunCalc from "suncalc";

import { lv95ToWgs84, wgs84ToLv95 } from "@/lib/geo/projection";
import { evaluateBuildingsShadow } from "@/lib/sun/buildings-shadow";
import {
  RAW_BUILDINGS_DIR,
} from "@/lib/storage/data-paths";
import {
  loadTerrainTilesForBounds,
  sampleSwissTerrainElevationLv95FromTiles,
} from "@/lib/terrain/swiss-terrain";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

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
  sourceZip: string;
  footprint?: Array<{ x: number; y: number }>;
  footprintArea?: number;
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

interface MatchedMesh {
  obstacleId: string;
  triangles: Array<[Vec3, Vec3, Vec3]>;
}

const RAD_TO_DEG = 180 / Math.PI;

const ANALYSIS = {
  name: "Terrasse Great Escape <-> Palais de Rumine",
  date: "2026-03-08",
  localTime: "17:30",
  timezone: "Europe/Zurich",
  bbox: {
    minLon: 6.6322,
    minLat: 46.52255,
    maxLon: 6.63335,
    maxLat: 46.52305,
  },
  gridStepMeters: 1,
  maxDistanceMeters: 2500,
  buildingHeightBiasMeters: 0,
} as const;

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeAzimuthDegrees(azimuthDegreesFromSunCalc: number): number {
  const fromNorth = (azimuthDegreesFromSunCalc + 180) % 360;
  return fromNorth >= 0 ? fromNorth : fromNorth + 360;
}

async function loadIndexFromPath(indexPath: string): Promise<BuildingObstacleIndex> {
  const raw = await fs.readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as BuildingObstacleIndex;
  if (!Array.isArray(parsed.obstacles)) {
    throw new Error(`Invalid index file: ${indexPath}`);
  }
  return parsed;
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

function matchPolyfaceToObstacle(obstacle: BuildingObstacle, polyfaces: Polyface[]): Polyface | null {
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
      best = {
        score,
        polyface,
      };
    }
  }
  return best?.polyface ?? null;
}

function evaluateDetailedBlocked(params: {
  candidateMeshes: MatchedMesh[];
  point: Vec3;
  azimuthDeg: number;
  altitudeDeg: number;
  maxDistanceMeters: number;
}): { blocked: boolean; blockerId: string | null } {
  if (params.altitudeDeg <= 0) {
    return { blocked: false, blockerId: null };
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
  for (const mesh of params.candidateMeshes) {
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
        bestId = mesh.obstacleId;
      }
    }
  }

  return {
    blocked: bestId !== null,
    blockerId: bestId,
  };
}

async function main() {
  const improvedPath = path.join(
    process.cwd(),
    "data",
    "processed",
    "buildings",
    "lausanne-buildings-index.v3.json",
  );

  const improvedIndex = await loadIndexFromPath(improvedPath);
  const maxHalfDiagonal = improvedIndex.obstacles.reduce(
    (max, obstacle) => Math.max(max, obstacle.halfDiagonal),
    0,
  );

  const corners = [
    wgs84ToLv95(ANALYSIS.bbox.minLon, ANALYSIS.bbox.minLat),
    wgs84ToLv95(ANALYSIS.bbox.minLon, ANALYSIS.bbox.maxLat),
    wgs84ToLv95(ANALYSIS.bbox.maxLon, ANALYSIS.bbox.minLat),
    wgs84ToLv95(ANALYSIS.bbox.maxLon, ANALYSIS.bbox.maxLat),
  ];
  const minX = Math.floor(Math.min(...corners.map((point) => point.easting)));
  const maxX = Math.ceil(Math.max(...corners.map((point) => point.easting)));
  const minY = Math.floor(Math.min(...corners.map((point) => point.northing)));
  const maxY = Math.ceil(Math.max(...corners.map((point) => point.northing)));

  const terrainTiles = await loadTerrainTilesForBounds({
    minX: minX - 20,
    minY: minY - 20,
    maxX: maxX + 20,
    maxY: maxY + 20,
  });
  if (!terrainTiles || terrainTiles.length === 0) {
    throw new Error("Terrain tiles unavailable for analysis bbox.");
  }

  const utcDate = zonedDateTimeToUtc(ANALYSIS.date, ANALYSIS.localTime, ANALYSIS.timezone);

  const points: Array<{
    easting: number;
    northing: number;
    lat: number;
    lon: number;
    elevation: number;
    altitudeDeg: number;
    azimuthDeg: number;
    candidateIndices: number[];
    improvedBlocked: boolean;
    improvedBlockerId: string | null;
    improvedBlockerAltitudeAngleDeg: number | null;
  }> = [];

  const candidateObstacleIndexSet = new Set<number>();

  const improvedEvalStartedAt = performance.now();
  for (let northing = minY; northing <= maxY; northing += ANALYSIS.gridStepMeters) {
    for (let easting = minX; easting <= maxX; easting += ANALYSIS.gridStepMeters) {
      const wgs = lv95ToWgs84(easting, northing);
      if (
        wgs.lon < ANALYSIS.bbox.minLon ||
        wgs.lon > ANALYSIS.bbox.maxLon ||
        wgs.lat < ANALYSIS.bbox.minLat ||
        wgs.lat > ANALYSIS.bbox.maxLat
      ) {
        continue;
      }

      const elevation = sampleSwissTerrainElevationLv95FromTiles(
        terrainTiles,
        easting,
        northing,
      );
      if (elevation === null) {
        continue;
      }

      const solar = SunCalc.getPosition(utcDate, wgs.lat, wgs.lon);
      const altitudeDeg = solar.altitude * RAD_TO_DEG;
      const azimuthDeg = normalizeAzimuthDegrees(solar.azimuth * RAD_TO_DEG);

      const candidateIndices = collectCandidateObstacleIndices({
        obstacles: improvedIndex.obstacles,
        spatialGrid: improvedIndex.spatialGrid,
        pointX: easting,
        pointY: northing,
        solarAzimuthDeg: azimuthDeg,
        maxDistanceMeters: ANALYSIS.maxDistanceMeters,
        maxHalfDiagonal,
      });
      for (const index of candidateIndices) {
        candidateObstacleIndexSet.add(index);
      }

      const improved = evaluateBuildingsShadow(
        improvedIndex.obstacles,
        {
          pointX: easting,
          pointY: northing,
          pointElevation: elevation,
          solarAzimuthDeg: azimuthDeg,
          solarAltitudeDeg: altitudeDeg,
          maxDistanceMeters: ANALYSIS.maxDistanceMeters,
          buildingHeightBiasMeters: ANALYSIS.buildingHeightBiasMeters,
        },
        improvedIndex.spatialGrid,
      );

      points.push({
        easting,
        northing,
        lat: wgs.lat,
        lon: wgs.lon,
        elevation,
        altitudeDeg,
        azimuthDeg,
        candidateIndices,
        improvedBlocked: improved.blocked,
        improvedBlockerId: improved.blockerId,
        improvedBlockerAltitudeAngleDeg: improved.blockerAltitudeAngleDeg,
      });
    }
  }
  const improvedEvaluationElapsedMs = performance.now() - improvedEvalStartedAt;

  const candidateObstacles = Array.from(candidateObstacleIndexSet)
    .map((index) => improvedIndex.obstacles[index] ?? null)
    .filter((obstacle): obstacle is BuildingObstacle => obstacle !== null);

  const zipsByBasename = await listZipFilesByBasename();
  const polyfaceCache = new Map<string, Polyface[]>();
  const meshByObstacleId = new Map<string, MatchedMesh>();
  let missingZip = 0;
  let unmatchedMesh = 0;

  for (const obstacle of candidateObstacles) {
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
    meshByObstacleId.set(obstacle.id, {
      obstacleId: obstacle.id,
      triangles: toTriangles(matched),
    });
  }

  const detailedEvalStartedAt = performance.now();
  const comparisons = points.map((point) => {
    const candidateMeshes = point.candidateIndices
      .map((index) => improvedIndex.obstacles[index]?.id ?? null)
      .filter((obstacleId): obstacleId is string => obstacleId !== null)
      .map((obstacleId) => meshByObstacleId.get(obstacleId) ?? null)
      .filter((mesh): mesh is MatchedMesh => mesh !== null);

    const detailed = evaluateDetailedBlocked({
      candidateMeshes,
      point: {
        x: point.easting,
        y: point.northing,
        z: point.elevation,
      },
      azimuthDeg: point.azimuthDeg,
      altitudeDeg: point.altitudeDeg,
      maxDistanceMeters: ANALYSIS.maxDistanceMeters,
    });

    return {
      ...point,
      detailedBlocked: detailed.blocked,
      detailedBlockerId: detailed.blockerId,
    };
  });
  const detailedEvaluationElapsedMs = performance.now() - detailedEvalStartedAt;

  const mismatches = comparisons.filter(
    (point) => point.improvedBlocked !== point.detailedBlocked,
  );
  const improvedOnlyBlocked = mismatches.filter(
    (point) => point.improvedBlocked && !point.detailedBlocked,
  );
  const detailedOnlyBlocked = mismatches.filter(
    (point) => !point.improvedBlocked && point.detailedBlocked,
  );

  const obstaclesById = new Map(improvedIndex.obstacles.map((obstacle) => [obstacle.id, obstacle]));
  const blockerAggregation = new Map<
    string,
    {
      count: number;
      obstacle: BuildingObstacle | null;
    }
  >();

  for (const point of mismatches) {
    const blockerId = point.improvedBlockerId;
    if (!blockerId) {
      continue;
    }
    const existing = blockerAggregation.get(blockerId);
    if (existing) {
      existing.count += 1;
      continue;
    }
    blockerAggregation.set(blockerId, {
      count: 1,
      obstacle: obstaclesById.get(blockerId) ?? null,
    });
  }

  const blockerSummary = Array.from(blockerAggregation.entries())
    .map(([blockerId, entry]) => {
      const obstacle = entry.obstacle;
      const width = obstacle ? obstacle.maxX - obstacle.minX : null;
      const depth = obstacle ? obstacle.maxY - obstacle.minY : null;
      const bboxArea =
        width !== null && depth !== null && width > 0 && depth > 0 ? width * depth : null;
      const fillRatio =
        obstacle && bboxArea && obstacle.footprintArea && bboxArea > 0
          ? obstacle.footprintArea / bboxArea
          : null;
      return {
        blockerId,
        mismatchCount: entry.count,
        mismatchShare: mismatches.length === 0 ? 0 : entry.count / mismatches.length,
        sourceZip: obstacle?.sourceZip ?? null,
        widthMeters: width === null ? null : round3(width),
        depthMeters: depth === null ? null : round3(depth),
        heightMeters: obstacle ? round3(obstacle.height) : null,
        footprintVertices: obstacle?.footprint?.length ?? null,
        footprintFillRatio: fillRatio === null ? null : round3(fillRatio),
      };
    })
    .sort((a, b) => b.mismatchCount - a.mismatchCount);

  const hybridThresholdsDeg = [0.25, 0.5, 1, 2, 3];
  const hybridSummaries = hybridThresholdsDeg.map((thresholdDeg) => {
    let checksTriggered = 0;
    let mismatchCount = 0;
    let improvedOnly = 0;
    let detailedOnly = 0;

    for (const point of comparisons) {
      const marginDeg =
        point.improvedBlockerAltitudeAngleDeg === null
          ? null
          : point.improvedBlockerAltitudeAngleDeg - point.altitudeDeg;
      const shouldRunDetailedCheck =
        point.improvedBlocked &&
        point.improvedBlockerId !== null &&
        marginDeg !== null &&
        marginDeg <= thresholdDeg;

      if (shouldRunDetailedCheck) {
        checksTriggered += 1;
      }

      const hybridBlocked = shouldRunDetailedCheck
        ? point.detailedBlocked
        : point.improvedBlocked;

      if (hybridBlocked !== point.detailedBlocked) {
        mismatchCount += 1;
        if (hybridBlocked && !point.detailedBlocked) {
          improvedOnly += 1;
        }
        if (!hybridBlocked && point.detailedBlocked) {
          detailedOnly += 1;
        }
      }
    }

    const checkRatio = comparisons.length === 0 ? 0 : checksTriggered / comparisons.length;
    const estimatedElapsedMs =
      improvedEvaluationElapsedMs + detailedEvaluationElapsedMs * checkRatio;
    return {
      thresholdDeg,
      checksTriggered,
      checksRatio: checkRatio,
      mismatchCount,
      mismatchRatio: comparisons.length === 0 ? 0 : mismatchCount / comparisons.length,
      improvedOnlyBlocked: improvedOnly,
      detailedOnlyBlocked: detailedOnly,
      estimatedElapsedMs: round3(estimatedElapsedMs),
      estimatedSpeedupVsFullDetailed:
        detailedEvaluationElapsedMs <= 0
          ? null
          : round3(detailedEvaluationElapsedMs / estimatedElapsedMs),
    };
  });

  const outputPayload = {
    analysis: ANALYSIS,
    index: {
      version: improvedIndex.indexVersion ?? null,
      method: improvedIndex.method,
      obstacleCount: improvedIndex.obstacles.length,
    },
    mesh: {
      candidateObstacles: candidateObstacles.length,
      matchedMeshes: meshByObstacleId.size,
      missingZip,
      unmatchedMesh,
    },
    points: {
      compared: comparisons.length,
      mismatches: mismatches.length,
      mismatchRatio: comparisons.length === 0 ? 0 : mismatches.length / comparisons.length,
      improvedOnlyBlocked: improvedOnlyBlocked.length,
      detailedOnlyBlocked: detailedOnlyBlocked.length,
      improvedEvaluationElapsedMs: round3(improvedEvaluationElapsedMs),
      detailedEvaluationElapsedMs: round3(detailedEvaluationElapsedMs),
    },
    hybridNearThresholdSummaries: hybridSummaries,
    topBlockers: blockerSummary.slice(0, 20),
    mismatchesPreview: mismatches.slice(0, 40).map((point) => ({
      lat: round6(point.lat),
      lon: round6(point.lon),
      easting: point.easting,
      northing: point.northing,
      improvedBlocked: point.improvedBlocked,
      detailedBlocked: point.detailedBlocked,
      improvedBlockerId: point.improvedBlockerId,
      detailedBlockerId: point.detailedBlockerId,
    })),
    mismatchesFull: mismatches.map((point) => ({
      lat: round6(point.lat),
      lon: round6(point.lon),
      easting: point.easting,
      northing: point.northing,
      improvedBlocked: point.improvedBlocked,
      detailedBlocked: point.detailedBlocked,
      improvedBlockerId: point.improvedBlockerId,
      detailedBlockerId: point.detailedBlockerId,
      altitudeDeg: round3(point.altitudeDeg),
      azimuthDeg: round3(point.azimuthDeg),
    })),
  };

  const reportDirectory = path.join(process.cwd(), "docs", "progress", "analysis");
  const reportPath = path.join(
    reportDirectory,
    "great-escape-v3-vs-detailed-grid1m-20260308-1730.json",
  );
  await fs.mkdir(reportDirectory, { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(outputPayload, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        analysis: outputPayload.analysis,
        index: outputPayload.index,
        mesh: outputPayload.mesh,
        points: outputPayload.points,
        hybridNearThresholdSummaries: outputPayload.hybridNearThresholdSummaries,
        topBlockers: outputPayload.topBlockers,
        mismatchesPreview: outputPayload.mismatchesPreview,
        reportPath: reportPath.replace(process.cwd() + path.sep, ""),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    `[compare-great-escape-v3-vs-detailed-grid1m] Failed: ${
      error instanceof Error ? error.message : "Unknown error"
    }`,
  );
  process.exitCode = 1;
});
