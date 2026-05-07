/**
 * Scan autour de Lausanne centre : pour chaque tuile 250m cachée,
 * calcule sunny% à 07:30 le 27/04, 28/04, 29/04. On cherche des outliers
 * "~100% soleil" par rapport aux voisins — signature d'un atlas écrit
 * sans bâtiments (bug Vulkan dropped backend).
 */
import SunCalc from "suncalc";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";

import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const gunzip = promisify(gunzipCallback);
const RAD_TO_DEG = 180 / Math.PI;
const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;

const DATES = ["2026-04-27", "2026-04-28", "2026-04-29", "2026-04-30"];
const LOCAL_TIME = "07:30";

type TileInfo = { tileId: string; tileE: number; tileN: number };

function parseTileId(tileId: string): TileInfo | null {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
  if (!m) return null;
  return { tileId, tileE: +m[1], tileN: +m[2] };
}

function lv95ToLatLon(easting: number, northing: number): { lat: number; lon: number } {
  // Crude approximation (good enough for sun position calculation)
  // True impl in src/lib/geo/projection, but we only need ~1km precision
  const y = (easting - 2600000) / 1e6;
  const x = (northing - 1200000) / 1e6;
  const lon_s = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat_s = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return { lon: lon_s * 100 / 36, lat: lat_s * 100 / 36 };
}

async function main() {
  const atlasDir = path.join(
    process.cwd(),
    "data/cache/sunlight",
    REGION,
    MODEL_HASH,
    `g${GRID}`,
    "atlas",
    "r0.75",
  );
  const files = await fs.readdir(atlasDir);
  const tiles = files
    .filter((f) => f.endsWith(".atlas.bin.gz"))
    .map((f) => parseTileId(f.replace(".atlas.bin.gz", "")))
    .filter((t): t is TileInfo => t !== null);
  console.log(`Scanning ${tiles.length} atlas tiles...`);

  // Restrict to central Lausanne (within ~3km of train station)
  const CENTER_E = 2537500;
  const CENTER_N = 1152300;
  const RADIUS = 3000;
  const inScope = tiles.filter(
    (t) => Math.abs(t.tileE + 125 - CENTER_E) < RADIUS && Math.abs(t.tileN + 125 - CENTER_N) < RADIUS,
  );
  console.log(`  ${inScope.length} tiles within ${RADIUS}m of (${CENTER_E}, ${CENTER_N})`);

  type Row = { tileId: string; date: string; sunnyPct: number; outdoor: number };
  const suspects: Row[] = [];
  const all: Row[] = [];

  let scanned = 0;
  for (const t of inScope) {
    scanned++;
    if (scanned % 20 === 0) process.stdout.write(`  ${scanned}/${inScope.length}\r`);

    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      gridStepMeters: GRID,
      tileId: t.tileId,
    });
    if (atlases.length === 0) continue;
    const a = atlases[0];
    if (a.outdoorPointCount < 100) continue; // skip tiles with almost no outdoor

    const { lat, lon } = lv95ToLatLon(t.tileE + 125, t.tileN + 125);

    for (const date of DATES) {
      const utc = new Date(`${date}T${LOCAL_TIME}:00+02:00`);
      const pos = SunCalc.getPosition(utc, lat, lon);
      const alt = pos.altitude * RAD_TO_DEG;
      let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
      if (az < 0) az += 360;
      if (alt <= 0) continue;

      const bucket = lookupAtlasByAngle(atlases, az, alt);
      if (!bucket) continue;

      let sunny = 0;
      for (let i = 0; i < a.outdoorPointCount; i++) {
        if ((bucket.sunMask[i >> 3] >> (i & 7)) & 1) sunny++;
      }
      const pct = (sunny / a.outdoorPointCount) * 100;
      const row = { tileId: t.tileId, date, sunnyPct: pct, outdoor: a.outdoorPointCount };
      all.push(row);
      if (pct > 90) suspects.push(row);
    }
  }
  process.stdout.write(`  ${scanned}/${inScope.length} ✓\n`);

  console.log(`\nDistribution sunny% @ 07:30 sur ${DATES.length} dates × ${inScope.length} tiles :`);
  const buckets = [0, 10, 25, 50, 75, 90, 95, 98, 100];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i + 1];
    const n = all.filter((r) => r.sunnyPct >= lo && r.sunnyPct < hi).length;
    console.log(`  ${String(lo).padStart(3)}% – ${String(hi).padStart(3)}% : ${String(n).padStart(5)}  ${"█".repeat(Math.round(n / 5))}`);
  }
  const at100 = all.filter((r) => r.sunnyPct >= 100).length;
  console.log(`  == 100% : ${String(at100).padStart(5)}  ${"█".repeat(Math.round(at100 / 5))}`);

  console.log(`\nTuiles suspectes (sunnyPct > 90%) : ${suspects.length}`);
  suspects.sort((a, b) => b.sunnyPct - a.sunnyPct);
  for (const s of suspects.slice(0, 20)) {
    console.log(`  ${s.date}  ${s.tileId}  outdoor=${s.outdoor}  sunny=${s.sunnyPct.toFixed(1)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
