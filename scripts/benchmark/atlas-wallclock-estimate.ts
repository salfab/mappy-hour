/**
 * Estimates the wall-clock cost of an atlas precompute for the SAME coverage
 * as an existing date-keyed precompute.
 *
 * Reads the completed precompute cache: counts total lit frames, computes the
 * number of unique (az, alt) buckets at each candidate resolution at tile
 * center, and projects the atlas compute time from the observed date-keyed
 * compute time (wall seconds / frame).
 *
 * Usage:
 *   pnpm tsx scripts/benchmark/atlas-wallclock-estimate.ts \
 *     --region=lausanne \
 *     --grid-step-meters=1 \
 *     --sample-every-minutes=15 \
 *     --datekeyed-wall-seconds=<reported_time_from_precompute_run> \
 *     --resolutions=0.25,0.5,1,2
 *
 * --datekeyed-wall-seconds is the wallclock reported by the precompute
 * script. If omitted, only the frame-ratio is printed (no time projection).
 */

import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";

import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

type Args = {
  region: PrecomputedRegionName;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  dateKeyedWallSeconds: number | null;
  resolutions: number[];
};

function parseArgs(): Args {
  const args: Args = {
    region: "lausanne",
    gridStepMeters: 1,
    sampleEveryMinutes: 15,
    dateKeyedWallSeconds: null,
    resolutions: [0.25, 0.5, 1, 2],
  };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.split("=");
    if (k === "--region") args.region = v as PrecomputedRegionName;
    else if (k === "--grid-step-meters") args.gridStepMeters = Number(v);
    else if (k === "--sample-every-minutes") args.sampleEveryMinutes = Number(v);
    else if (k === "--datekeyed-wall-seconds") args.dateKeyedWallSeconds = Number(v);
    else if (k === "--resolutions") args.resolutions = v.split(",").map(Number);
  }
  return args;
}

function parseTileId(tileId: string): { minE: number; minN: number; size: number } | null {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
  if (!m) return null;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

function parseTimeWindow(tw: string): { startMin: number; endMin: number } | null {
  const m = /^t(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(tw);
  if (!m) return null;
  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    endMin: Number(m[3]) * 60 + Number(m[4]),
  };
}

async function main() {
  const args = parseArgs();
  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, args.region);
  console.log(`Scanning ${regionRoot} — grid=${args.gridStepMeters}m sample=${args.sampleEveryMinutes}min`);

  // Walk directory structure to enumerate all (date, tw, tileId) triples.
  let hashes: string[];
  try { hashes = await fs.readdir(regionRoot); } catch {
    console.error(`No region directory: ${regionRoot}`);
    process.exit(1);
  }

  const byResBuckets = new Map<number, Set<string>>();
  for (const r of args.resolutions) byResBuckets.set(r, new Set());

  let tileFrameCountTotal = 0;
  let tilesCountUnique = 0;
  const tileIdsSeen = new Set<string>();

  for (const hash of hashes) {
    const gSampleDir = path.join(regionRoot, hash, `g${args.gridStepMeters}`, `m${args.sampleEveryMinutes}`);
    let dates: string[];
    try { dates = await fs.readdir(gSampleDir); } catch { continue; }
    for (const date of dates) {
      const dateDir = path.join(gSampleDir, date);
      let tws: string[];
      try { tws = await fs.readdir(dateDir); } catch { continue; }
      for (const tw of tws) {
        const winParsed = parseTimeWindow(tw);
        if (!winParsed) continue;
        const tilesDir = path.join(dateDir, tw, "tiles");
        let files: string[];
        try { files = await fs.readdir(tilesDir); } catch { continue; }
        const [y, mo, d] = date.split("-").map(Number);
        // Enumerate samples at utcDate for every tileId in this group.
        // We'll use the tile center to compute (az, alt) for bucketing.
        // All frames above horizon (alt > 0) count as "lit" (= actually computed).
        const frameTimesUtc: Date[] = [];
        for (let minOfDay = winParsed.startMin; minOfDay <= winParsed.endMin; minOfDay += args.sampleEveryMinutes) {
          // Assume CET UTC+1 for Swiss regions (DST makes this approximate — acceptable for bucket counting)
          const utcMs = Date.UTC(y, mo - 1, d, Math.floor(minOfDay / 60) - 1, minOfDay % 60, 0);
          frameTimesUtc.push(new Date(utcMs));
        }

        for (const f of files) {
          if (!f.endsWith(".tile.bin.gz")) continue;
          const tileId = f.slice(0, -".tile.bin.gz".length);
          if (!tileIdsSeen.has(tileId)) {
            tileIdsSeen.add(tileId);
            tilesCountUnique++;
          }
          const parsed = parseTileId(tileId);
          if (!parsed) continue;
          const centerE = parsed.minE + parsed.size / 2;
          const centerN = parsed.minN + parsed.size / 2;
          const center = lv95ToWgs84(centerE, centerN);
          for (const utc of frameTimesUtc) {
            const p = SunCalc.getPosition(utc, center.lat, center.lon);
            const alt = p.altitude * 180 / Math.PI;
            if (alt <= 0) continue;
            tileFrameCountTotal++;
            let az = (p.azimuth * 180 / Math.PI + 180) % 360;
            if (az < 0) az += 360;
            for (const r of args.resolutions) {
              const set = byResBuckets.get(r)!;
              set.add(`${tileId}|${Math.floor(az / r)}:${Math.floor(alt / r)}`);
            }
          }
        }
      }
    }
  }

  console.log(`\nDate-keyed coverage summary:`);
  console.log(`  Unique tiles: ${tilesCountUnique.toLocaleString()}`);
  console.log(`  Total lit frames (per tile summed): ${tileFrameCountTotal.toLocaleString()}`);
  console.log();
  console.log(`Atlas projected frame counts per tile resolution:`);
  console.log(`(bucket key = (tileId × (azBucket, altBucket)), i.e. per-tile bucket set)`);
  console.log();
  console.log(`Res    | Atlas frames  | Ratio vs date | Dedup |${args.dateKeyedWallSeconds ? " Projected wall" : ""}`);
  console.log(`-------+---------------+---------------+-------+${args.dateKeyedWallSeconds ? "----------------" : ""}`);
  for (const r of args.resolutions) {
    const unique = byResBuckets.get(r)!.size;
    const ratio = unique / Math.max(tileFrameCountTotal, 1);
    const dedup = tileFrameCountTotal / Math.max(unique, 1);
    const label = `${r}°`.padEnd(6);
    const cells = `${unique.toLocaleString().padStart(13)} | ${(ratio * 100).toFixed(1).padStart(11)}% | ${dedup.toFixed(2).padStart(5)}×`;
    let projection = "";
    if (args.dateKeyedWallSeconds != null) {
      const projectedS = args.dateKeyedWallSeconds * ratio;
      const h = Math.floor(projectedS / 3600);
      const m = Math.round((projectedS % 3600) / 60);
      projection = ` | ${h}h${String(m).padStart(2, "0")}m`;
    }
    console.log(`${label} | ${cells}${projection}`);
  }
  console.log();
  if (args.dateKeyedWallSeconds != null) {
    console.log(`Baseline date-keyed wall: ${args.dateKeyedWallSeconds.toLocaleString()}s = ${Math.floor(args.dateKeyedWallSeconds / 3600)}h${String(Math.round((args.dateKeyedWallSeconds % 3600) / 60)).padStart(2, "0")}m`);
  }
  console.log(`\nNOTE: projected wall assumes perfect scaling from date-keyed to atlas`);
  console.log(`      (same per-frame cost). Real atlas compute might have different`);
  console.log(`      overhead patterns (setup per bucket vs setup per date).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
