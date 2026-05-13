/**
 * Diagnostic: given a list of LV95 tile IDs, print which region(s) localBbox
 * they fall into. Useful when the tile-selection drop warning fires.
 *
 * Usage:
 *   npx tsx scripts/diag/_find-region-for-tile.ts e2530750_n1151000_s250 e2544750_n1148500_s250
 */
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import { LAUSANNE_CONFIG } from "../../src/lib/config/lausanne";
import { MORGES_CONFIG } from "../../src/lib/config/morges";
import { NYON_CONFIG } from "../../src/lib/config/nyon";
import { VEVEY_CONFIG } from "../../src/lib/config/vevey";
import { GENEVE_CONFIG } from "../../src/lib/config/geneve";
import { VEVEY_CITY_CONFIG } from "../../src/lib/config/vevey_city";
import { NEUCHATEL_CONFIG } from "../../src/lib/config/neuchatel";
import { LA_CHAUX_DE_FONDS_CONFIG } from "../../src/lib/config/la_chaux_de_fonds";
import { BERN_CONFIG } from "../../src/lib/config/bern";
import { ZURICH_CONFIG } from "../../src/lib/config/zurich";
import { THUN_CONFIG } from "../../src/lib/config/thun";

const regions: Record<string, readonly [number, number, number, number]> = {
  lausanne: LAUSANNE_CONFIG.localBbox,
  morges: MORGES_CONFIG.localBbox,
  nyon: NYON_CONFIG.localBbox,
  vevey: VEVEY_CONFIG.localBbox,
  vevey_city: VEVEY_CITY_CONFIG.localBbox,
  neuchatel: NEUCHATEL_CONFIG.localBbox,
  la_chaux_de_fonds: LA_CHAUX_DE_FONDS_CONFIG.localBbox,
  bern: BERN_CONFIG.localBbox,
  zurich: ZURICH_CONFIG.localBbox,
  thun: THUN_CONFIG.localBbox,
  geneve: GENEVE_CONFIG.localBbox,
};

for (const [r, b] of Object.entries(regions)) {
  console.log(`${r.padEnd(11)} bbox = [${b.join(", ")}]`);
}
console.log("");

const tiles = process.argv.slice(2);
if (tiles.length === 0) {
  console.error("Usage: tsx _find-region-for-tile.ts <tileId> [<tileId> ...]");
  process.exit(1);
}

for (const tileId of tiles) {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
  if (!m) {
    console.error(`Invalid tileId: ${tileId}`);
    continue;
  }
  const e = Number(m[1]);
  const n = Number(m[2]);
  const s = Number(m[3]);
  const center = lv95ToWgs84Precise(e + s / 2, n + s / 2);
  // Also check the 4 tile corners (a tile is "in region" if any corner falls inside).
  const corners = [
    lv95ToWgs84Precise(e, n),
    lv95ToWgs84Precise(e + s, n),
    lv95ToWgs84Precise(e, n + s),
    lv95ToWgs84Precise(e + s, n + s),
  ];
  const lonMin = Math.min(...corners.map((c) => c.lon));
  const lonMax = Math.max(...corners.map((c) => c.lon));
  const latMin = Math.min(...corners.map((c) => c.lat));
  const latMax = Math.max(...corners.map((c) => c.lat));

  console.log(
    `${tileId}  center=(${center.lon.toFixed(5)}, ${center.lat.toFixed(5)})  envelope=[${lonMin.toFixed(5)}, ${latMin.toFixed(5)}, ${lonMax.toFixed(5)}, ${latMax.toFixed(5)}]`,
  );
  for (const [r, b] of Object.entries(regions)) {
    const intersects = !(lonMax < b[0] || lonMin > b[2] || latMax < b[1] || latMin > b[3]);
    const containsCenter = center.lon >= b[0] && center.lon <= b[2] && center.lat >= b[1] && center.lat <= b[3];
    const flag = containsCenter ? "  CENTER" : intersects ? "  edge" : "        ";
    console.log(`  ${r.padEnd(11)} intersects=${intersects ? "yes" : "no "}  containsCenter=${containsCenter ? "yes" : "no "}${flag}`);
  }
  console.log("");
}
