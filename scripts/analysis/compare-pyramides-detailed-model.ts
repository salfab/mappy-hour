import fs from "node:fs/promises";
import path from "node:path";

import AdmZip from "adm-zip";
import SunCalc from "suncalc";

import { wgs84ToLv95 } from "@/lib/geo/projection";
import {
  evaluateBuildingsShadow,
  loadBuildingsObstacleIndex,
} from "@/lib/sun/buildings-shadow";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
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

interface ObstacleSummary {
  id: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  sourceZip: string;
}

interface MeshForObstacle {
  obstacle: ObstacleSummary;
  mesh: Polyface;
  score: number;
}

const RAD_TO_DEG = 180 / Math.PI;
const TARGET = {
  name: "Chemin des Pyramides (point route)",
  lat: 46.5227926,
  lon: 6.6019121,
};
const DATE = "2026-03-08";
const TIMEZONE = "Europe/Zurich";
const START_HOUR = 7;
const END_HOUR = 19;
const MAX_DISTANCE_METERS = 2500;

function normalizeAzimuthDegrees(azimuthDegreesFromSunCalc: number): number {
  const fromNorth = (azimuthDegreesFromSunCalc + 180) % 360;
  return fromNorth >= 0 ? fromNorth : fromNorth + 360;
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

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function obstacleToSummary(obstacle: {
  id: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  sourceZip: string;
}): ObstacleSummary {
  return {
    id: obstacle.id,
    minX: obstacle.minX,
    minY: obstacle.minY,
    minZ: obstacle.minZ,
    maxX: obstacle.maxX,
    maxY: obstacle.maxY,
    maxZ: obstacle.maxZ,
    sourceZip: obstacle.sourceZip,
  };
}

function matchPolyfaceToObstacle(obstacle: ObstacleSummary, polyfaces: Polyface[]): MeshForObstacle | null {
  let best: MeshForObstacle | null = null;
  for (const polyface of polyfaces) {
    const score =
      Math.abs(polyface.minX - obstacle.minX) +
      Math.abs(polyface.minY - obstacle.minY) +
      Math.abs(polyface.maxX - obstacle.maxX) +
      Math.abs(polyface.maxY - obstacle.maxY) +
      Math.abs(polyface.minZ - obstacle.minZ) +
      Math.abs(polyface.maxZ - obstacle.maxZ);

    if (score > 8) {
      continue;
    }
    if (!best || score < best.score) {
      best = {
        obstacle,
        mesh: polyface,
        score,
      };
    }
  }
  return best;
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

function rayTriangleIntersectionDistance(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
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

function evaluateDetailedMeshesBlocked(params: {
  meshes: MeshForObstacle[];
  point: Vec3;
  azimuthDeg: number;
  altitudeDeg: number;
  maxDistanceMeters: number;
}): { blocked: boolean; blockerId: string | null; distanceMeters: number | null } {
  if (params.altitudeDeg <= 0) {
    return { blocked: false, blockerId: null, distanceMeters: null };
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
    const triangles = toTriangles(mesh.mesh);
    for (const triangle of triangles) {
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
    distanceMeters: Math.round((bestT * cosAlt) * 1000) / 1000,
  };
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

function buildTimeSeries(): string[] {
  const output: string[] = [];
  for (let hour = START_HOUR; hour <= END_HOUR; hour += 1) {
    for (let minute = 0; minute < 60; minute += 1) {
      output.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  return output;
}

async function main() {
  const buildingsIndex = await loadBuildingsObstacleIndex();
  if (!buildingsIndex) {
    throw new Error("Building obstacle index not found. Run preprocess:buildings:index.");
  }

  const pointContext = await buildPointEvaluationContext(TARGET.lat, TARGET.lon, {
    skipTerrainSamplingWhenIndoor: true,
    shadowCalibration: {
      buildingHeightBiasMeters: 0,
    },
  });
  if (pointContext.pointElevationMeters === null) {
    throw new Error("Point elevation unavailable.");
  }

  const pointLv95 = wgs84ToLv95(TARGET.lon, TARGET.lat);
  const pointElevation = pointContext.pointElevationMeters;

  const times = buildTimeSeries();
  const simplifiedByTime = new Map<string, ReturnType<typeof evaluateBuildingsShadow>>();
  const blockerIds = new Set<string>();

  for (const localTime of times) {
    const utcDate = zonedDateTimeToUtc(DATE, localTime, TIMEZONE);
    const solar = SunCalc.getPosition(utcDate, TARGET.lat, TARGET.lon);
    const altitudeDeg = solar.altitude * RAD_TO_DEG;
    const azimuthDeg = normalizeAzimuthDegrees(solar.azimuth * RAD_TO_DEG);

    const simplified = evaluateBuildingsShadow(
      buildingsIndex.obstacles,
      {
        pointX: pointLv95.easting,
        pointY: pointLv95.northing,
        pointElevation,
        solarAzimuthDeg: azimuthDeg,
        solarAltitudeDeg: altitudeDeg,
        maxDistanceMeters: MAX_DISTANCE_METERS,
        buildingHeightBiasMeters: 0,
      },
      buildingsIndex.spatialGrid,
    );
    simplifiedByTime.set(localTime, simplified);
    if (simplified.blockerId) {
      blockerIds.add(simplified.blockerId);
    }
  }

  const obstaclesById = new Map(
    buildingsIndex.obstacles.map((obstacle) => [obstacle.id, obstacleToSummary(obstacle)]),
  );
  const targetObstacles = Array.from(blockerIds)
    .map((id) => obstaclesById.get(id) ?? null)
    .filter((value): value is ObstacleSummary => value !== null);

  const zipsByBasename = await listZipFilesByBasename();
  const meshes: MeshForObstacle[] = [];
  const parseWarnings: string[] = [];
  const polyfaceCache = new Map<string, Polyface[]>();

  for (const obstacle of targetObstacles) {
    const zipPath = zipsByBasename.get(obstacle.sourceZip);
    if (!zipPath) {
      parseWarnings.push(`Zip not found for ${obstacle.id}: ${obstacle.sourceZip}`);
      continue;
    }
    let polyfaces = polyfaceCache.get(zipPath);
    if (!polyfaces) {
      polyfaces = parsePolyfacesFromZip(zipPath);
      polyfaceCache.set(zipPath, polyfaces);
    }
    const match = matchPolyfaceToObstacle(obstacle, polyfaces);
    if (!match) {
      parseWarnings.push(`No polyface match for ${obstacle.id} in ${obstacle.sourceZip}`);
      continue;
    }
    meshes.push(match);
  }

  const differences: Array<{
    localTime: string;
    altitudeDeg: number;
    azimuthDeg: number;
    simplifiedBlocked: boolean;
    simplifiedBlockerId: string | null;
    detailedBlocked: boolean;
    detailedBlockerId: string | null;
  }> = [];

  for (const localTime of times) {
    const utcDate = zonedDateTimeToUtc(DATE, localTime, TIMEZONE);
    const solar = SunCalc.getPosition(utcDate, TARGET.lat, TARGET.lon);
    const altitudeDeg = solar.altitude * RAD_TO_DEG;
    const azimuthDeg = normalizeAzimuthDegrees(solar.azimuth * RAD_TO_DEG);
    const simplified = simplifiedByTime.get(localTime);
    if (!simplified) {
      continue;
    }
    const detailed = evaluateDetailedMeshesBlocked({
      meshes,
      point: {
        x: pointLv95.easting,
        y: pointLv95.northing,
        z: pointElevation,
      },
      azimuthDeg,
      altitudeDeg,
      maxDistanceMeters: MAX_DISTANCE_METERS,
    });

    if (simplified.blocked !== detailed.blocked) {
      differences.push({
        localTime,
        altitudeDeg: Math.round(altitudeDeg * 1000) / 1000,
        azimuthDeg: Math.round(azimuthDeg * 1000) / 1000,
        simplifiedBlocked: simplified.blocked,
        simplifiedBlockerId: simplified.blockerId,
        detailedBlocked: detailed.blocked,
        detailedBlockerId: detailed.blockerId,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        target: TARGET,
        date: DATE,
        timezone: TIMEZONE,
        pointLv95: {
          easting: Math.round(pointLv95.easting * 1000) / 1000,
          northing: Math.round(pointLv95.northing * 1000) / 1000,
          elevation: Math.round(pointElevation * 1000) / 1000,
        },
        blockersSeenInSimplifiedModel: targetObstacles.map((obstacle) => ({
          id: obstacle.id,
          sourceZip: obstacle.sourceZip,
        })),
        matchedMeshes: meshes.map((mesh) => ({
          id: mesh.obstacle.id,
          sourceZip: mesh.obstacle.sourceZip,
          matchScore: Math.round(mesh.score * 1000) / 1000,
          vertices: mesh.mesh.vertices.length,
          faces: mesh.mesh.faces.length,
        })),
        parseWarnings,
        differencesCount: differences.length,
        differencesPreview: differences.slice(0, 20),
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
