/**
 * For suspicious buckets, find which cached frame is closest to bucket center
 * (= the representative that the atlas builder would pick).
 */

import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";
import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import { loadPrecomputedSunlightTileBinary } from "../../src/lib/precompute/sunlight-cache-binary";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";

const REGION = "lausanne";
const MODEL_HASH = "d43fe24cbb9190af";
const TILE_ID = "e2538000_n1152500_s250";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const RES = 1;

const SUSPECT_BUCKETS: Array<[number, number]> = [
  [263, 21], [266, 18], [260, 23], [257, 26], [268, 16], [254, 28], [251, 31],
];

async function main() {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(TILE_ID)!;
  const minE = Number(m[1]); const minN = Number(m[2]); const size = Number(m[3]);
  const { lat, lon } = lv95ToWgs84Precise(minE + size / 2, minN + size / 2);

  const dateRoot = path.join(CACHE_SUNLIGHT_DIR, REGION, MODEL_HASH, `g${GRID_STEP}`, `m${SAMPLE_MINUTES}`);
  const dates = await fs.readdir(dateRoot);

  type Candidate = { date: string; tw: string; localTime: string; az: number; alt: number; sunnyCount: number; distToCenter: number };
  const perBucket = new Map<string, Candidate[]>();

  for (const d of dates) {
    const dateDir = path.join(dateRoot, d);
    let tws: string[]; try { tws = await fs.readdir(dateDir); } catch { continue; }
    for (const tw of tws) {
      const m2 = /^t(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(tw); if (!m2) continue;
      const startLocal = `${m2[1]}:${m2[2]}`;
      const endLocal = `${m2[3]}:${m2[4]}`;
      const f = path.join(dateDir, tw, "tiles", `${TILE_ID}.tile.bin.gz`);
      try { await fs.access(f); } catch { continue; }
      const tile = await loadPrecomputedSunlightTileBinary({
        region: REGION as never, modelVersionHash: MODEL_HASH, date: d, gridStepMeters: GRID_STEP,
        sampleEveryMinutes: SAMPLE_MINUTES, startLocalTime: startLocal, endLocalTime: endLocal, tileId: TILE_ID,
      });
      if (!tile) continue;
      for (let i = 0; i < tile.frameCount; i++) {
        const fm = tile.meta.framesMeta[i];
        const utc = new Date(fm.utcTime);
        const pos = SunCalc.getPosition(utc, lat, lon);
        const alt = pos.altitude * 180 / Math.PI;
        if (alt <= 0) continue;
        let az = (pos.azimuth * 180 / Math.PI + 180) % 360;
        if (az < 0) az += 360;
        if (alt > 2 && fm.sunnyCount === 0) continue;
        const azB = Math.floor(az / RES);
        const altB = Math.floor(alt / RES);
        for (const [wantAz, wantAlt] of SUSPECT_BUCKETS) {
          if (azB === wantAz && altB === wantAlt) {
            const key = `${azB},${altB}`;
            const azCenter = (wantAz + 0.5) * RES;
            const altCenter = (wantAlt + 0.5) * RES;
            const dist = Math.hypot(az - azCenter, alt - altCenter);
            const list = perBucket.get(key) ?? [];
            list.push({ date: d, tw, localTime: fm.localTime, az, alt, sunnyCount: fm.sunnyCount, distToCenter: dist });
            perBucket.set(key, list);
          }
        }
      }
    }
  }

  for (const [bucket, cands] of perBucket) {
    cands.sort((a, b) => a.distToCenter - b.distToCenter);
    console.log(`\nBucket ${bucket}  (${cands.length} candidates, winner in bold):`);
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const mark = i === 0 ? "[WIN]" : "     ";
      console.log(`  ${mark} ${c.date} ${c.tw} ${c.localTime}  az=${c.az.toFixed(3)}° alt=${c.alt.toFixed(3)}°  dist=${c.distToCenter.toFixed(3)}  sunnyCount=${c.sunnyCount}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
