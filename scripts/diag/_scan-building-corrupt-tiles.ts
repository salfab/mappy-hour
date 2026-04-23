/**
 * Scanne toutes les tuiles d'atlas pour détecter celles dont le
 * buildingsMask est ~0 sur un bucket de sunrise (bâtiments jamais
 * évalués = bug Vulkan dropped backend).
 *
 * Critère : buildingsBlocked% < 2% pour un bucket avec altitude>5° ET
 *          indoor% > 5% dans la grid-metadata (donc des bâtiments
 *          sont présents → devrait avoir des shadows).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";
import SunCalc from "suncalc";

import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const gunzip = promisify(gunzipCallback);
const RAD_TO_DEG = 180 / Math.PI;

const REGION = (process.env.REGION ?? "lausanne") as "lausanne" | "nyon" | "morges" | "geneve" | "vevey";
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;

const DATE = "2026-04-27";
const LOCAL_TIME = "07:30"; // sun ~80° az, ~10° alt — sunrise, long shadows

function parseTile(name: string): { tileId: string; tileE: number; tileN: number } | null {
  const m = /^e(\d+)_n(\d+)_s\d+$/.exec(name);
  if (!m) return null;
  return { tileId: name, tileE: +m[1], tileN: +m[2] };
}

function lv95ToLatLon(e: number, n: number): { lat: number; lon: number } {
  const y = (e - 2600000) / 1e6;
  const x = (n - 1200000) / 1e6;
  const lon_s = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat_s = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return { lon: lon_s * 100 / 36, lat: lat_s * 100 / 36 };
}

async function getIndoorPct(tileId: string): Promise<number | null> {
  const p = path.join(
    process.cwd(),
    "data/cache/tile-grid-metadata",
    REGION,
    MODEL_HASH,
    `g${GRID}`,
    `${tileId}.json.gz`,
  );
  try {
    const buf = await fs.readFile(p);
    const json = JSON.parse((await gunzip(buf)).toString("utf8"));
    const total = json.totalPoints ?? json.pointCount ?? 0;
    if (total === 0) return null;
    return (json.indoorCount / total) * 100;
  } catch {
    return null;
  }
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
    .map((f) => parseTile(f.replace(".atlas.bin.gz", "")))
    .filter((t): t is NonNullable<ReturnType<typeof parseTile>> => t !== null);
  console.log(`[${REGION}] scanning ${tiles.length} atlas tiles for missing buildings shadows @ ${LOCAL_TIME}...`);

  const corrupt: Array<{ tileId: string; indoorPct: number; noVegPct: number; buildingsPct: number }> = [];
  let scanned = 0;
  for (const t of tiles) {
    scanned++;
    if (scanned % 50 === 0) process.stdout.write(`  ${scanned}/${tiles.length}\r`);

    const indoorPct = await getIndoorPct(t.tileId);
    if (indoorPct === null || indoorPct < 3) continue; // no buildings expected

    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      gridStepMeters: GRID,
      tileId: t.tileId,
    });
    if (atlases.length === 0) continue;
    const a = atlases[0];
    if (a.outdoorPointCount < 100) continue;

    const { lat, lon } = lv95ToLatLon(t.tileE + 125, t.tileN + 125);
    const utc = new Date(`${DATE}T${LOCAL_TIME}:00+02:00`);
    const pos = SunCalc.getPosition(utc, lat, lon);
    const alt = pos.altitude * RAD_TO_DEG;
    let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (az < 0) az += 360;
    if (alt < 5) continue;

    const bucket = lookupAtlasByAngle(atlases, az, alt);
    if (!bucket) continue;

    let sunnyNoVeg = 0, buildingsBlocked = 0;
    for (let i = 0; i < a.outdoorPointCount; i++) {
      if ((bucket.sunNoVegMask[i >> 3] >> (i & 7)) & 1) sunnyNoVeg++;
      if ((bucket.buildingsMask[i >> 3] >> (i & 7)) & 1) buildingsBlocked++;
    }
    const noVegPct = (sunnyNoVeg / a.outdoorPointCount) * 100;
    const buildingsPct = (buildingsBlocked / a.outdoorPointCount) * 100;

    // Criterion: buildings blocked <2% AND indoor%>3% → buildings existed but weren't evaluated
    if (buildingsPct < 2 && indoorPct > 3) {
      corrupt.push({ tileId: t.tileId, indoorPct, noVegPct, buildingsPct });
    }
  }
  process.stdout.write(`  ${scanned}/${tiles.length} ✓\n`);

  console.log(`\n⚠ ${corrupt.length} tuiles suspectes (buildings non évalués malgré indoor>3%) :\n`);
  corrupt.sort((a, b) => b.indoorPct - a.indoorPct);
  for (const c of corrupt) {
    console.log(
      `  ${c.tileId}  indoor=${c.indoorPct.toFixed(1)}%  noVeg=${c.noVegPct.toFixed(1)}%  buildingsBlocked=${c.buildingsPct.toFixed(2)}%`,
    );
  }

  // Write out a tile-selection file for regen
  if (corrupt.length > 0) {
    const outPath = path.join(process.cwd(), "data/processed/precompute", `corrupt-buildings-${REGION}.json`);
    const selection = {
      tileSizeMeters: 250,
      generatedAt: new Date().toISOString(),
      tiles: corrupt.map((c) => ({ region: REGION, tileId: c.tileId })),
    };
    await fs.writeFile(outPath, JSON.stringify(selection, null, 2), "utf8");
    console.log(`\nSelection de régénération écrite : ${outPath}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
