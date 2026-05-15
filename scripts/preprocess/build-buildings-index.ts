/**
 * Build a buildings obstacle index for a specific region or cluster.
 *
 * Usage:
 *   npx tsx scripts/preprocess/build-buildings-index.ts --region=neuchatel
 *   npx tsx scripts/preprocess/build-buildings-index.ts --region=bern
 *   npx tsx scripts/preprocess/build-buildings-index.ts --region=lausanne-cluster
 *
 * Reads SwissBuildings3D DXF zips from RAW_BUILDINGS_DIR, filters to obstacles
 * whose bbox overlaps the region's LV95 extent, and writes:
 *   - lausanne-cluster → processed/buildings/buildings-index.json
 *   - other regions    → processed/buildings/{region}-buildings-index.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import AdmZip from "adm-zip";

import { PROCESSED_BUILDINGS_DIR, RAW_BUILDINGS_DIR } from "../../src/lib/storage/data-paths";
import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";
import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import { NYON_CONFIG } from "../../src/lib/config/nyon";
import { MORGES_CONFIG } from "../../src/lib/config/morges";
import { GENEVE_CONFIG } from "../../src/lib/config/geneve";
import { VEVEY_CONFIG } from "../../src/lib/config/vevey";
import { VEVEY_CITY_CONFIG } from "../../src/lib/config/vevey_city";
import { NEUCHATEL_CONFIG } from "../../src/lib/config/neuchatel";
import { LA_CHAUX_DE_FONDS_CONFIG } from "../../src/lib/config/la_chaux_de_fonds";
import { BERN_CONFIG } from "../../src/lib/config/bern";
import { ZURICH_CONFIG } from "../../src/lib/config/zurich";
import { THUN_CONFIG } from "../../src/lib/config/thun";

interface Lv95Bbox { minE: number; minN: number; maxE: number; maxN: number; }

interface BuildingObstacle {
  id: string;
  minX: number; minY: number; maxX: number; maxY: number;
  minZ: number; maxZ: number;
  height: number;
  centerX: number; centerY: number; halfDiagonal: number;
  sourceZip: string;
}

interface BuildingSpatialGrid {
  version: number; cellSizeMeters: number;
  cells: Record<string, number[]>; cellMaxZ: Record<string, number>;
  stats: { cellCount: number; maxObstaclesPerCell: number; avgObstaclesPerCell: number };
}

interface PolylineAccumulator { vertices: { x: number; y: number; z: number }[]; }
interface VertexAccumulator { x?: number; y?: number; z?: number; flag?: number; }

const GROUND_TOLERANCE_METERS = 0.6;
const FOOTPRINT_MIN_EDGE_METERS = 0.8;
const FOOTPRINT_COLLINEAR_TOLERANCE_METERS = 0.15;

function round3(v: number) { return Math.round(v * 1000) / 1000; }
function round1(v: number) { return Math.round(v * 10) / 10; }
function cross(o: {x:number;y:number}, a: {x:number;y:number}, b: {x:number;y:number}) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convert WGS84 [minLon, minLat, maxLon, maxLat] to LV95 bbox with margin. */
function wgs84BboxToLv95(bbox: readonly [number, number, number, number], marginM = 500): Lv95Bbox {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const sw = wgs84ToLv95Precise(minLon, minLat);
  const ne = wgs84ToLv95Precise(maxLon, maxLat);
  return {
    minE: sw.easting - marginM,
    minN: sw.northing - marginM,
    maxE: ne.easting + marginM,
    maxN: ne.northing + marginM,
  };
}

/** Merge multiple LV95 bboxes into one. */
function mergeLv95Bboxes(bboxes: Lv95Bbox[]): Lv95Bbox {
  return {
    minE: Math.min(...bboxes.map(b => b.minE)),
    minN: Math.min(...bboxes.map(b => b.minN)),
    maxE: Math.max(...bboxes.map(b => b.maxE)),
    maxN: Math.max(...bboxes.map(b => b.maxN)),
  };
}

const CLUSTER_REGIONS = [
  LAUSANNE_CONFIG, NYON_CONFIG, MORGES_CONFIG,
  GENEVE_CONFIG, VEVEY_CONFIG, VEVEY_CITY_CONFIG,
];

const REGION_CONFIGS: Record<string, { localBbox: readonly [number, number, number, number] }> = {
  "lausanne-cluster": { localBbox: [
    Math.min(...CLUSTER_REGIONS.map(r => r.localBbox[0])),
    Math.min(...CLUSTER_REGIONS.map(r => r.localBbox[1])),
    Math.max(...CLUSTER_REGIONS.map(r => r.localBbox[2])),
    Math.max(...CLUSTER_REGIONS.map(r => r.localBbox[3])),
  ]},
  neuchatel: NEUCHATEL_CONFIG,
  la_chaux_de_fonds: LA_CHAUX_DE_FONDS_CONFIG,
  bern: BERN_CONFIG,
  zurich: ZURICH_CONFIG,
  thun: THUN_CONFIG,
  lausanne: LAUSANNE_CONFIG,
  nyon: NYON_CONFIG,
  morges: MORGES_CONFIG,
  geneve: GENEVE_CONFIG,
  vevey: VEVEY_CONFIG,
  vevey_city: VEVEY_CITY_CONFIG,
};

function outputPath(region: string): string {
  if (region === "lausanne-cluster" || CLUSTER_REGIONS.some(
    r => ["lausanne", "nyon", "morges", "geneve", "vevey", "vevey_city"].includes(region)
  )) {
    // Cluster members all share the same global file for hash stability
    if (region === "lausanne-cluster" || ["lausanne", "nyon", "morges", "geneve", "vevey", "vevey_city"].includes(region)) {
      return path.join(PROCESSED_BUILDINGS_DIR, "buildings-index.json");
    }
  }
  return path.join(PROCESSED_BUILDINGS_DIR, `${region}-buildings-index.json`);
}

function isCoordinateVertexFlag(flag?: number) {
  if (flag === undefined) return true;
  const isFaceRecord = (flag & 128) !== 0 && (flag & 64) === 0;
  return !isFaceRecord;
}

function obstacleKey(o: BuildingObstacle) {
  return `${round1(o.minX)},${round1(o.minY)},${round1(o.maxX)},${round1(o.maxY)}|${round1(o.maxZ)}`;
}

function buildCellKey(cx: number, cy: number) { return `${cx}:${cy}`; }

function buildSpatialGrid(obstacles: BuildingObstacle[], cellSizeMeters: number): BuildingSpatialGrid {
  const cells = new Map<string, number[]>();
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const minCX = Math.floor(o.minX / cellSizeMeters);
    const maxCX = Math.floor(o.maxX / cellSizeMeters);
    const minCY = Math.floor(o.minY / cellSizeMeters);
    const maxCY = Math.floor(o.maxY / cellSizeMeters);
    for (let cy = minCY; cy <= maxCY; cy++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const key = buildCellKey(cx, cy);
        const bucket = cells.get(key);
        if (bucket) bucket.push(i); else cells.set(key, [i]);
      }
    }
  }
  const serializedCells: Record<string, number[]> = {};
  const cellMaxZ: Record<string, number> = {};
  let maxObs = 0, sumObs = 0;
  for (const [key, bucket] of cells.entries()) {
    serializedCells[key] = bucket;
    maxObs = Math.max(maxObs, bucket.length);
    sumObs += bucket.length;
    let mz = Number.NEGATIVE_INFINITY;
    for (const idx of bucket) { mz = Math.max(mz, obstacles[idx]!.maxZ); }
    if (Number.isFinite(mz)) cellMaxZ[key] = round3(mz);
  }
  return {
    version: 1, cellSizeMeters, cells: serializedCells, cellMaxZ,
    stats: { cellCount: cells.size, maxObstaclesPerCell: maxObs, avgObstaclesPerCell: cells.size === 0 ? 0 : round3(sumObs / cells.size) },
  };
}

async function listZipFilesRecursively(dir: string): Promise<string[]> {
  const result: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".zip")) result.push(full);
    }
  }
  result.sort();
  return result;
}

function selectLatestZipByTile(zipFiles: string[]): string[] {
  const latest = new Map<string, { filePath: string; version: string }>();
  const passthrough: string[] = [];
  for (const f of zipFiles) {
    const m = /^swissbuildings3d_2_(\d{4}-\d{2})_(\d{4}-\d{2}_2056_5728\.dxf\.zip)$/i.exec(path.basename(f));
    if (!m) { passthrough.push(f); continue; }
    const [, version, tileKey] = m;
    const cur = latest.get(tileKey.toLowerCase());
    if (!cur || version > cur.version) latest.set(tileKey.toLowerCase(), { filePath: f, version });
  }
  return [...passthrough, ...Array.from(latest.values()).map(e => e.filePath)].sort();
}

function parseZipObstacles(zipPath: string, startId: number, bbox: Lv95Bbox): { obstacles: BuildingObstacle[]; nextId: number } {
  const zip = new AdmZip(zipPath);
  const dxfEntry = zip.getEntries().find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith(".dxf"));
  if (!dxfEntry) return { obstacles: [], nextId: startId };

  const lines = dxfEntry.getData().toString("latin1").split(/\r?\n/);
  const obstacles: BuildingObstacle[] = [];
  let pendingSectionName = false, inEntities = false, inPolyline = false;
  let currentPolyline: PolylineAccumulator | null = null;
  let currentVertex: VertexAccumulator | null = null;
  let nextId = startId;

  const flushVertex = () => {
    if (!currentVertex || !currentPolyline) { currentVertex = null; return; }
    if (isCoordinateVertexFlag(currentVertex.flag) && currentVertex.x !== undefined && currentVertex.y !== undefined && currentVertex.z !== undefined) {
      currentPolyline.vertices.push({ x: currentVertex.x, y: currentVertex.y, z: currentVertex.z });
    }
    currentVertex = null;
  };

  const flushPolyline = () => {
    flushVertex();
    if (!currentPolyline) { inPolyline = false; return; }
    const verts = currentPolyline.vertices;
    if (verts.length >= 4) {
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const v of verts) { minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); minZ = Math.min(minZ, v.z); maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); maxZ = Math.max(maxZ, v.z); }
      const w = maxX - minX, d = maxY - minY, h = maxZ - minZ;
      if (w >= 1 && d >= 1 && h >= 1 && w * d >= 4) {
        // Bbox overlap check with region
        if (maxX >= bbox.minE && minX <= bbox.maxE && maxY >= bbox.minN && minY <= bbox.maxN) {
          obstacles.push({
            id: `obs-${nextId++}`,
            minX: round3(minX), minY: round3(minY), maxX: round3(maxX), maxY: round3(maxY),
            minZ: round3(minZ), maxZ: round3(maxZ), height: round3(h),
            centerX: round3((minX + maxX) / 2), centerY: round3((minY + maxY) / 2),
            halfDiagonal: round3(Math.hypot(w, d) / 2),
            sourceZip: path.basename(zipPath),
          });
        }
      }
    }
    currentPolyline = null; inPolyline = false;
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1].trim();
    if (code === "0") {
      flushVertex();
      if (value === "SECTION") { pendingSectionName = true; continue; }
      if (value === "ENDSEC") { pendingSectionName = false; if (inPolyline) flushPolyline(); inEntities = false; continue; }
      if (!inEntities) continue;
      if (value === "POLYLINE") { if (inPolyline) flushPolyline(); inPolyline = true; currentPolyline = { vertices: [] }; continue; }
      if (value === "VERTEX" && inPolyline) { currentVertex = {}; continue; }
      if (value === "SEQEND" && inPolyline) { flushPolyline(); continue; }
      if (inPolyline) flushPolyline();
      continue;
    }
    if (pendingSectionName && code === "2") { inEntities = value === "ENTITIES"; pendingSectionName = false; continue; }
    if (!inEntities || !inPolyline || !currentVertex) continue;
    const n = Number.parseFloat(value);
    const num = Number.isFinite(n) ? n : undefined;
    if (code === "10") currentVertex.x = num;
    else if (code === "20") currentVertex.y = num;
    else if (code === "30") currentVertex.z = num;
    else if (code === "70" && num !== undefined) currentVertex.flag = Math.trunc(num);
  }
  if (inPolyline) flushPolyline();
  return { obstacles, nextId };
}

async function main() {
  const args = process.argv.slice(2);
  const region = args.find(a => a.startsWith("--region="))?.slice(9) ?? "";
  if (!region || !REGION_CONFIGS[region]) {
    console.error(`Usage: --region=<${Object.keys(REGION_CONFIGS).join("|")}>`);
    process.exitCode = 1; return;
  }

  const config = REGION_CONFIGS[region];
  const bbox = wgs84BboxToLv95(config.localBbox);
  const out = outputPath(region);

  console.log(`[buildings-index] region=${region}`);
  console.log(`[buildings-index] LV95 bbox E=[${Math.round(bbox.minE)},${Math.round(bbox.maxE)}] N=[${Math.round(bbox.minN)},${Math.round(bbox.maxN)}]`);
  console.log(`[buildings-index] output → ${out}`);

  const startedAt = performance.now();
  const allZipFiles = await listZipFilesRecursively(RAW_BUILDINGS_DIR);
  const zipFiles = selectLatestZipByTile(allZipFiles);
  if (zipFiles.length === 0) {
    throw new Error(`No building zip files found in ${RAW_BUILDINGS_DIR}. Run download-buildings.ts first.`);
  }
  console.log(`[buildings-index] ${zipFiles.length} zip files (deduplicated from ${allZipFiles.length})`);

  const deduped = new Map<string, BuildingObstacle>();
  let obstacleId = 1, rawCount = 0;
  for (let i = 0; i < zipFiles.length; i++) {
    const parsed = parseZipObstacles(zipFiles[i], obstacleId, bbox);
    obstacleId = parsed.nextId;
    rawCount += parsed.obstacles.length;
    for (const o of parsed.obstacles) {
      const key = obstacleKey(o);
      const ex = deduped.get(key);
      if (!ex || o.maxZ > ex.maxZ) deduped.set(key, o);
    }
    if ((i + 1) % 10 === 0 || i + 1 === zipFiles.length) {
      console.log(`[buildings-index] ${i + 1}/${zipFiles.length} zips — ${rawCount} raw obs in region, ${deduped.size} unique`);
    }
  }

  const obstacles = Array.from(deduped.values()).sort((a, b) => a.id.localeCompare(b.id));
  const spatialGrid = buildSpatialGrid(obstacles, 64);
  const elapsed = round3((performance.now() - startedAt) / 1000);

  const payload = {
    generatedAt: new Date().toISOString(),
    method: "dxf-footprint-prism-v5-source-order-hull-cell-maxz",
    indexVersion: 5,
    region,
    sourceSelectionStrategy: "latest-zip-per-tile",
    sourceDirectory: RAW_BUILDINGS_DIR,
    lv95BboxFilter: bbox,
    zipFilesProcessed: zipFiles.length,
    zipFilesDiscovered: allZipFiles.length,
    rawObstaclesCount: rawCount,
    uniqueObstaclesCount: obstacles.length,
    elapsedSeconds: elapsed,
    obstacles,
    spatialGrid,
  };

  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[buildings-index] ✓ Wrote ${out} with ${obstacles.length} unique obstacles in ${elapsed}s`);
}

main().catch(e => { console.error(`[buildings-index] Failed:`, e); process.exitCode = 1; });
