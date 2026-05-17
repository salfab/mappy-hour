/**
 * Identifie quels obstacles de Zurich sont silencieusement skippés
 * par gpu-mesh-loader.matchPolyfaceToObstacle (score > 6).
 */
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { loadBuildingsObstacleIndex } from "../../src/lib/sun/buildings-shadow";
import { RAW_BUILDINGS_DIR } from "../../src/lib/storage/data-paths";

interface RawVertex { x?: number; y?: number; z?: number; flag?: number; i1?: number; i2?: number; i3?: number; i4?: number; }
interface Vec3 { x: number; y: number; z: number; }
interface Polyface { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; vertices: Vec3[]; faces: number[][]; }

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function isFaceRecord(flag: number | undefined): boolean {
  if (flag === undefined) return false;
  return (flag & 128) !== 0 && (flag & 64) === 0;
}
function isCoordinateVertex(flag: number | undefined): boolean { return !isFaceRecord(flag); }

function finalizePolyface(rawVertices: RawVertex[]): Polyface | null {
  const coordVertices: Vec3[] = [];
  const faces: number[][] = [];
  for (const vertex of rawVertices) {
    if (isFaceRecord(vertex.flag)) {
      const indices = [vertex.i1, vertex.i2, vertex.i3, vertex.i4]
        .filter((v): v is number => Number.isFinite(v))
        .map(v => Math.trunc(v))
        .filter(v => v !== 0)
        .map(v => Math.abs(v));
      if (indices.length >= 3) faces.push(indices);
      continue;
    }
    if (isCoordinateVertex(vertex.flag) && vertex.x !== undefined && vertex.y !== undefined && vertex.z !== undefined) {
      coordVertices.push({ x: vertex.x, y: vertex.y, z: vertex.z });
    }
  }
  if (coordVertices.length < 3 || faces.length === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const v of coordVertices) {
    if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ, vertices: coordVertices, faces };
}

function parsePolyfacesFromZip(zipPath: string): Polyface[] {
  const zip = new AdmZip(zipPath);
  const dxfEntry = zip.getEntries().find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith(".dxf"));
  if (!dxfEntry) return [];
  const lines = dxfEntry.getData().toString("latin1").split(/\r?\n/);
  const polyfaces: Polyface[] = [];
  let pendingSectionName = false, inEntities = false, inPolyline = false;
  let currentVertices: RawVertex[] = [];
  let currentVertex: RawVertex | null = null;
  const flushVertex = () => { if (currentVertex) { currentVertices.push(currentVertex); currentVertex = null; } };
  const flushPolyline = () => { flushVertex(); const pf = finalizePolyface(currentVertices); if (pf) polyfaces.push(pf); currentVertices = []; inPolyline = false; };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1].trim();
    if (code === "0") {
      flushVertex();
      if (value === "SECTION") { pendingSectionName = true; continue; }
      if (value === "ENDSEC") { pendingSectionName = false; if (inPolyline) flushPolyline(); inEntities = false; continue; }
      if (!inEntities) continue;
      if (value === "POLYLINE") { if (inPolyline) flushPolyline(); inPolyline = true; currentVertices = []; continue; }
      if (value === "VERTEX" && inPolyline) { currentVertex = {}; continue; }
      if (value === "SEQEND" && inPolyline) { flushPolyline(); continue; }
      if (inPolyline) flushPolyline();
      continue;
    }
    if (pendingSectionName && code === "2") { inEntities = value === "ENTITIES"; pendingSectionName = false; continue; }
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

function listZips(): Map<string, string> {
  const map = new Map<string, string>();
  const stack = [RAW_BUILDINGS_DIR];
  while (stack.length) {
    const c = stack.pop()!;
    let entries;
    try { entries = fs.readdirSync(c, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(c, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".zip")) map.set(e.name, full);
    }
  }
  return map;
}

async function main() {
  const idx = await loadBuildingsObstacleIndex("zurich");
  if (!idx) throw new Error("no index");
  const zipMap = listZips();
  console.log(`obstacles total: ${idx.obstacles.length}`);
  console.log(`zips disponibles: ${zipMap.size}`);

  // Group obstacles by sourceZip
  const byZip = new Map<string, typeof idx.obstacles>();
  let noZipField = 0;
  for (const o of idx.obstacles) {
    if (!o.sourceZip) { noZipField++; continue; }
    const list = byZip.get(o.sourceZip) ?? [];
    list.push(o); byZip.set(o.sourceZip, list);
  }
  console.log(`obstacles sans sourceZip: ${noZipField}`);
  console.log(`zips uniques référencés: ${byZip.size}\n`);

  // For each zip group, parse + check matching
  let totalMatched = 0, totalSkipped = 0;
  const zipResults: Array<{ zip: string; total: number; matched: number; skipped: number; missingZip: boolean; noPolyfaces: boolean }> = [];
  for (const [zipName, obsList] of byZip) {
    const zipPath = zipMap.get(zipName);
    if (!zipPath) {
      totalSkipped += obsList.length;
      zipResults.push({ zip: zipName, total: obsList.length, matched: 0, skipped: obsList.length, missingZip: true, noPolyfaces: false });
      continue;
    }
    let polyfaces: Polyface[] = [];
    try { polyfaces = parsePolyfacesFromZip(zipPath); } catch {}
    if (polyfaces.length === 0) {
      totalSkipped += obsList.length;
      console.log(`  ✗ NO POLYFACES PARSED — zip=${zipName} path=${zipPath} obstaclesAffected=${obsList.length}`);
      // Inspect zip
      try {
        const z = new AdmZip(zipPath);
        const entries = z.getEntries().map(e => `${e.entryName} (${e.header.size}B)`);
        console.log(`    zip entries: ${entries.join(", ")}`);
        const dxfEntry = z.getEntries().find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith(".dxf"));
        if (dxfEntry) {
          const head = dxfEntry.getData().toString("latin1").slice(0, 500);
          console.log(`    DXF first 500 chars: ${JSON.stringify(head)}`);
        } else {
          console.log(`    ✗ no .dxf entry in zip`);
        }
      } catch (e) {
        console.log(`    ✗ zip read error: ${e instanceof Error ? e.message : e}`);
      }
      zipResults.push({ zip: zipName, total: obsList.length, matched: 0, skipped: obsList.length, missingZip: false, noPolyfaces: true });
      continue;
    }
    let matched = 0;
    const skipExamples: Array<{ id: string; bestScore: number }> = [];
    for (const o of obsList) {
      let bestScore = Infinity;
      for (const pf of polyfaces) {
        const s = Math.abs(pf.minX - o.minX) + Math.abs(pf.minY - o.minY) + Math.abs(pf.maxX - o.maxX) + Math.abs(pf.maxY - o.maxY) + Math.abs(pf.minZ - o.minZ) * 0.15;
        if (s < bestScore) bestScore = s;
      }
      if (bestScore <= 6) matched++;
      else if (skipExamples.length < 2) skipExamples.push({ id: o.id, bestScore });
    }
    totalMatched += matched;
    totalSkipped += obsList.length - matched;
    zipResults.push({ zip: zipName, total: obsList.length, matched, skipped: obsList.length - matched, missingZip: false, noPolyfaces: false });
    if (obsList.length - matched > 50 || (obsList.length - matched > 0 && obsList.length < 200)) {
      console.log(`  ${zipName}: ${matched}/${obsList.length} matched, ${obsList.length - matched} skipped, polyfaces=${polyfaces.length}${skipExamples.length ? ` (best scores: ${skipExamples.map(e => e.bestScore.toFixed(1)).join(", ")})` : ""}`);
    }
  }
  console.log(`\nTOTAL: matched=${totalMatched}, skipped=${totalSkipped}, ratio=${(100*totalMatched/(totalMatched+totalSkipped)).toFixed(1)}%`);
  const missingZips = zipResults.filter(r => r.missingZip);
  const noPolyfaces = zipResults.filter(r => r.noPolyfaces);
  console.log(`zips manquants sur disque: ${missingZips.length} (${missingZips.reduce((s,r)=>s+r.total,0)} obstacles concernés)`);
  if (missingZips.length) console.log(`  exemples: ${missingZips.slice(0, 3).map(r => r.zip).join(", ")}`);
  console.log(`zips sans polyface parsée: ${noPolyfaces.length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
