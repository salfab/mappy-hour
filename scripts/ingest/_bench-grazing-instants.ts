/**
 * Compare 4 methods on 2 grazing-sun instants for the GE tile.
 *
 * Instants (2026-04-18, from top-XOR analysis):
 *   08:15 — az=90.09°, alt=14.89°  (sunrise grazing)
 *   18:45 — az=268.85°, alt=16.11° (sunset grazing)
 *
 * Methods:
 *   1. CPU detailed ray-trace  at exact angle        (ground truth)
 *   2. Atlas Vulkan 1°         at bucket center
 *   3. Atlas Vulkan 0.75°      at bucket center
 *   4. Atlas Vulkan 0.5°       at bucket center
 *
 * Output:
 *   - Markdown table on stdout (sunny counts, XOR vs CPU, XOR %)
 *   - JSON per-point for map viz: data/tmp/grazing-instants-disagreement.json
 *     shape: { instants: [{ name, az, alt, points: [{lat,lon,sunny_cpu,sunny_a1,sunny_a075,sunny_a05}] }] }
 *
 * Must be run with:
 *   MAPPY_BUILDINGS_SHADOW_MODE=detailed pnpm tsx scripts/ingest/_bench-grazing-instants.ts
 */

if (process.env.MAPPY_BUILDINGS_SHADOW_MODE !== "detailed") {
  console.error(
    `ERROR: expected MAPPY_BUILDINGS_SHADOW_MODE=detailed, got "${process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(unset)"}"`,
  );
  console.error(
    `Run with:  MAPPY_BUILDINGS_SHADOW_MODE=detailed pnpm tsx scripts/ingest/_bench-grazing-instants.ts`,
  );
  process.exit(1);
}

import fs from "node:fs/promises";
import path from "node:path";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import {
  computeSunlightTileArtifact,
  disposeSunlightTileEvaluationBackends,
} from "../../src/lib/precompute/sunlight-tile-service";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasBucket,
  type PrecomputedTileAtlas,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import { DEFAULT_SHADOW_CALIBRATION } from "../../src/lib/sun/shadow-calibration";
import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import type { RegionTileSpec } from "../../src/lib/precompute/sunlight-cache";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const TILE_ID = "e2538000_n1152500_s250";
const GRID_STEP = 1;

const INSTANTS = [
  { name: "08:15-sunrise-grazing", azDeg: 90.09, altDeg: 14.89 },
  { name: "18:45-sunset-grazing", azDeg: 268.85, altDeg: 16.11 },
];

const RESOLUTIONS = [1, 0.75, 0.5] as const;

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}
function popcount(buf: Uint8Array, bits: number): number {
  const fb = Math.floor(bits / 8); const tb = bits - fb * 8;
  let n = 0;
  for (let i = 0; i < fb; i++) n += popcount8(buf[i]);
  if (tb > 0) n += popcount8(buf[fb] & ((1 << tb) - 1));
  return n;
}
function popcountXor(a: Uint8Array, b: Uint8Array, bits: number): number {
  const fb = Math.floor(bits / 8); const tb = bits - fb * 8;
  let n = 0;
  for (let i = 0; i < fb; i++) n += popcount8(a[i] ^ b[i]);
  if (tb > 0) n += popcount8((a[fb] ^ b[fb]) & ((1 << tb) - 1));
  return n;
}
function isBitSet(mask: Uint8Array, index: number): boolean {
  return ((mask[index >> 3] >> (index & 7)) & 1) === 1;
}

function parseTileId(id: string): { minE: number; minN: number; size: number } {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id)!;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

async function main(): Promise<void> {
  const parsed = parseTileId(TILE_ID);
  const centerE = parsed.minE + parsed.size / 2;
  const centerN = parsed.minN + parsed.size / 2;
  const { lat: centerLat, lon: centerLon } = lv95ToWgs84Precise(centerE, centerN);

  const tileSpec: RegionTileSpec = {
    tileId: TILE_ID, tileSizeMeters: parsed.size,
    minEasting: parsed.minE, minNorthing: parsed.minN,
    maxEasting: parsed.minE + parsed.size, maxNorthing: parsed.minN + parsed.size,
    bbox: { minLon: centerLon - 0.01, maxLon: centerLon + 0.01, minLat: centerLat - 0.01, maxLat: centerLat + 0.01 },
  };

  console.log(`Grazing-instants bench — tile ${TILE_ID}`);
  console.log(`Backend: ${process.env.MAPPY_BUILDINGS_SHADOW_MODE}`);
  console.log();

  // ── 1. Compute CPU detailed masks for both instants in a single call ─
  const sunOverride = INSTANTS.map((i) => ({ azimuthDeg: i.azDeg, altitudeDeg: i.altDeg }));
  process.stdout.write(`Running CPU detailed for ${INSTANTS.length} frames...`);
  const t0 = Date.now();
  const cpuArtifact = await computeSunlightTileArtifact({
    region: REGION, modelVersionHash: MODEL_HASH, algorithmVersion: MODEL_HASH,
    date: "2026-04-18", timezone: LAUSANNE_CONFIG.timezone, sampleEveryMinutes: 15,
    gridStepMeters: GRID_STEP, startLocalTime: "00:00", endLocalTime: "23:59",
    tile: tileSpec, shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
    sunOverride,
  });
  console.log(` done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  outdoor points: ${cpuArtifact.stats.pointCount}, frames: ${cpuArtifact.frames.length}`);
  console.log();

  const outdoorBits = cpuArtifact.stats.pointCount;

  // ── 2. Load all 3 atlases ─────────────────────────────────────────────
  const atlases = new Map<number, PrecomputedTileAtlas>();
  for (const res of RESOLUTIONS) {
    const a = await loadPrecomputedTileAtlas({
      region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID_STEP, tileId: TILE_ID, resolutionDeg: res,
    });
    if (!a) { console.error(`Atlas r${res} not found, aborting.`); process.exit(1); }
    atlases.set(res, a);
  }

  // ── 3. Per-instant comparison ─────────────────────────────────────────
  type MethodRow = { method: string; sunny: number; xorBits: number; xorPct: number };
  const tables: Array<{ instant: typeof INSTANTS[number]; rows: MethodRow[] }> = [];

  const mapExport: Array<{
    name: string; azDeg: number; altDeg: number;
    buckets: Record<string, { azB: number; altB: number }>;
    sunnyCounts: Record<string, number>;
    points: Array<{ lat: number; lon: number; cpu: 0 | 1; a1: 0 | 1; a075: 0 | 1; a05: 0 | 1 }>;
  }> = [];

  for (let i = 0; i < INSTANTS.length; i++) {
    const inst = INSTANTS[i];
    const frame = cpuArtifact.frames[i];
    const cpuMask = frame.sunMask;
    const cpuSunny = popcount(cpuMask, outdoorBits);

    const rows: MethodRow[] = [
      { method: "CPU detailed (exact angle)", sunny: cpuSunny, xorBits: 0, xorPct: 0 },
    ];

    const methodMasks: Record<string, Uint8Array> = { cpu: cpuMask };
    const buckets: Record<string, { azB: number; altB: number }> = {};
    const sunnyCounts: Record<string, number> = { cpu: cpuSunny };

    for (const res of RESOLUTIONS) {
      const atlas = atlases.get(res)!;
      const azB = Math.floor(inst.azDeg / res);
      const altB = Math.floor(inst.altDeg / res);
      const entry = lookupAtlasBucket(atlas, azB, altB);
      if (!entry) { console.warn(`No bucket for instant ${inst.name} at ${res}°`); continue; }
      const aSunny = popcount(entry.sunMask, outdoorBits);
      const xor = popcountXor(entry.sunMask, cpuMask, outdoorBits);
      const label = `Atlas Vulkan ${res}° (bucket ${azB},${altB})`;
      rows.push({ method: label, sunny: aSunny, xorBits: xor, xorPct: (100 * xor) / outdoorBits });
      const key = `a${String(res).replace(".", "")}`;
      methodMasks[key] = entry.sunMask;
      buckets[key] = { azB, altB };
      sunnyCounts[key] = aSunny;
    }
    tables.push({ instant: inst, rows });

    // Build per-point export (outdoor points only — indoor have no mask bit)
    const points: Array<{ lat: number; lon: number; cpu: 0 | 1; a1: 0 | 1; a075: 0 | 1; a05: 0 | 1 }> = [];
    for (let p = 0; p < cpuArtifact.points.length; p++) {
      const pt = cpuArtifact.points[p];
      if (pt.outdoorIndex === null || pt.outdoorIndex === undefined) continue;
      const oi = pt.outdoorIndex;
      const { lat, lon } = lv95ToWgs84Precise(pt.lv95Easting, pt.lv95Northing);
      points.push({
        lat: Math.round(lat * 1e6) / 1e6,
        lon: Math.round(lon * 1e6) / 1e6,
        cpu: (isBitSet(methodMasks.cpu, oi) ? 1 : 0),
        a1: (methodMasks.a1 ? (isBitSet(methodMasks.a1, oi) ? 1 : 0) : 0),
        a075: (methodMasks.a075 ? (isBitSet(methodMasks.a075, oi) ? 1 : 0) : 0),
        a05: (methodMasks.a05 ? (isBitSet(methodMasks.a05, oi) ? 1 : 0) : 0),
      });
    }

    mapExport.push({
      name: inst.name, azDeg: inst.azDeg, altDeg: inst.altDeg,
      buckets, sunnyCounts, points,
    });
  }

  // ── 4. Print markdown table ───────────────────────────────────────────
  console.log(`Outdoor points evaluated: ${outdoorBits}`);
  console.log();
  for (const t of tables) {
    console.log(`### Instant: ${t.instant.name}  (az=${t.instant.azDeg}°, alt=${t.instant.altDeg}°)`);
    console.log();
    console.log(`| Méthode | Sunny points | XOR vs CPU (bits) | XOR vs CPU (%) |`);
    console.log(`|---|---:|---:|---:|`);
    for (const r of t.rows) {
      console.log(`| ${r.method} | ${r.sunny} | ${r.xorBits} | ${r.xorPct.toFixed(3)}% |`);
    }
    console.log();
  }

  // ── 5. Write JSON for map viz ─────────────────────────────────────────
  const outPath = path.join(process.cwd(), "data", "tmp", "grazing-instants-disagreement.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({
    tileId: TILE_ID, region: REGION, modelHash: MODEL_HASH,
    date: "2026-04-18",
    outdoorPointCount: outdoorBits,
    instants: mapExport,
  }, null, 0));
  console.log(`Per-point map data → ${outPath}`);
  console.log(`  size: ${((await fs.stat(outPath)).size / 1024).toFixed(0)} KB`);

  // ── 6. Write grid-format JSON for blog Leaflet viz ────────────────────
  const gs = parsed.size;
  const minIx = Math.floor(parsed.minE / GRID_STEP);
  const minIy = Math.floor(parsed.minN / GRID_STEP);
  const indoorGrid = new Uint8Array(gs * gs);
  const idxToOutdoor = new Int32Array(gs * gs).fill(-1);
  for (let p = 0; p < cpuArtifact.points.length; p++) {
    const pt = cpuArtifact.points[p];
    const col = pt.ix - minIx;
    const row = pt.iy - minIy;
    if (col < 0 || col >= gs || row < 0 || row >= gs) continue;
    const idx = row * gs + col;
    if (pt.outdoorIndex == null) indoorGrid[idx] = 1;
    else idxToOutdoor[idx] = pt.outdoorIndex;
  }

  const packMask = (mask: Uint8Array): number[] => {
    const out = new Array<number>(gs * gs);
    for (let i = 0; i < gs * gs; i++) {
      const oi = idxToOutdoor[i];
      out[i] = oi >= 0 && isBitSet(mask, oi) ? 1 : 0;
    }
    return out;
  };

  const blogInstants = INSTANTS.map((inst, i) => {
    const frame = cpuArtifact.frames[i];
    const cpuMask = frame.sunMask;
    const atlasMasks: Record<string, Uint8Array> = {};
    const buckets: Record<string, { azB: number; altB: number }> = {};
    for (const res of RESOLUTIONS) {
      const atlas = atlases.get(res)!;
      const azB = Math.floor(inst.azDeg / res);
      const altB = Math.floor(inst.altDeg / res);
      const entry = lookupAtlasBucket(atlas, azB, altB);
      if (!entry) continue;
      const key = `a${String(res).replace(".", "")}`;
      atlasMasks[key] = entry.sunMask;
      buckets[key] = { azB, altB };
    }
    return {
      name: inst.name,
      azDeg: inst.azDeg,
      altDeg: inst.altDeg,
      buckets,
      masks: {
        cpu: packMask(cpuMask),
        a1: packMask(atlasMasks.a1),
        a075: packMask(atlasMasks.a075),
        a05: packMask(atlasMasks.a05),
      },
    };
  });

  const blogPayload = {
    tileId: TILE_ID,
    region: REGION,
    date: "2026-04-18",
    gridSize: gs,
    minEasting: parsed.minE,
    minNorthing: parsed.minN,
    maxEasting: parsed.minE + gs,
    maxNorthing: parsed.minN + gs,
    outdoorPointCount: outdoorBits,
    indoor: Array.from(indoorGrid),
    instants: blogInstants,
  };

  const blogPath = "C:\\sources\\seesharpch\\assets\\data\\grazing-disagreement.json";
  await fs.writeFile(blogPath, JSON.stringify(blogPayload, null, 0));
  console.log(`Blog grid viz data → ${blogPath}`);
  console.log(`  size: ${((await fs.stat(blogPath)).size / 1024).toFixed(0)} KB`);

  await disposeSunlightTileEvaluationBackends();
}

main().catch((err) => { console.error(err); process.exit(1); });
