/**
 * Bench MAPPY_TILE_PIPELINE_DEPTH for the rust-wgpu-vulkan backend.
 *
 * Pipeline depth = number of tiles whose CPU prep can be in-flight at the
 * same time inside the single Rust process. The Rust IPC client serializes
 * actual server calls via a FIFO promise-chain mutex, so depth >= 2 only
 * overlaps Node-side work with Rust GPU compute (zero risk of multi-Vulkan
 * regression — see ADR-0019).
 *
 * This bench is GPU-IPC-mode-only because the optimization makes no sense
 * for CPU shadow modes (where there's no IPC to overlap). Refuses to run
 * if MAPPY_BUILDINGS_SHADOW_MODE is not a GPU-IPC backend.
 *
 * Usage:
 *   MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan \
 *     npx tsx scripts/benchmark/precompute-tile-pipeline-depth.ts \
 *     --region=lausanne --tile-count=8 \
 *     --start-date=2027-03-01 --days=1 \
 *     --grid-step-meters=1 --start-local-time=06:00 --end-local-time=21:00 \
 *     --depths=1,2,3 --repeats=2
 */
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { LAUSANNE_CENTER } from "@/lib/config/lausanne";
import { NYON_CENTER } from "@/lib/config/nyon";
import { precomputeCacheRuns } from "@/lib/admin/cache-admin";
import { buildRegionTiles, type PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";
import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import { clearAtlasSkipCache } from "@/lib/precompute/atlas-tile-service";
import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";

const GPU_IPC_BACKENDS = new Set(["rust-wgpu-vulkan", "webgpu-compute"]);

interface ParsedArgs {
  region: PrecomputedRegionName;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tileCount: number;
  repeats: number;
  depths: number[];
}

const DEFAULTS: ParsedArgs = {
  region: "lausanne",
  startDate: "2027-03-01",
  days: 1,
  timezone: "Europe/Zurich",
  sampleEveryMinutes: 15,
  gridStepMeters: 1,
  startLocalTime: "06:00",
  endLocalTime: "21:00",
  tileCount: 8,
  repeats: 2,
  depths: [1, 2, 3],
};

function parseInts(value: string): number[] {
  const out = new Set<number>();
  for (const item of value.split(",")) {
    const n = Number(item.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 64) out.add(n);
  }
  return Array.from(out).sort((a, b) => a - b);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { ...DEFAULTS };
  for (const raw of argv) {
    if (raw.startsWith("--region=")) {
      const v = raw.slice("--region=".length);
      if (v === "lausanne" || v === "nyon" || v === "morges" || v === "geneve" || v === "vevey" || v === "vevey_city" || v === "neuchatel" || v === "la_chaux_de_fonds" || v === "bern" || v === "zurich" || v === "thun") {
        args.region = v;
      }
    } else if (raw.startsWith("--start-date=")) {
      args.startDate = raw.slice("--start-date=".length);
    } else if (raw.startsWith("--days=")) {
      args.days = Math.max(1, Number(raw.slice("--days=".length)));
    } else if (raw.startsWith("--timezone=")) {
      args.timezone = raw.slice("--timezone=".length);
    } else if (raw.startsWith("--sample-every-minutes=")) {
      args.sampleEveryMinutes = Number(raw.slice("--sample-every-minutes=".length));
    } else if (raw.startsWith("--grid-step-meters=")) {
      args.gridStepMeters = Number(raw.slice("--grid-step-meters=".length));
    } else if (raw.startsWith("--start-local-time=")) {
      args.startLocalTime = raw.slice("--start-local-time=".length);
    } else if (raw.startsWith("--end-local-time=")) {
      args.endLocalTime = raw.slice("--end-local-time=".length);
    } else if (raw.startsWith("--tile-count=")) {
      args.tileCount = Math.max(1, Number(raw.slice("--tile-count=".length)));
    } else if (raw.startsWith("--repeats=")) {
      args.repeats = Math.max(1, Number(raw.slice("--repeats=".length)));
    } else if (raw.startsWith("--depths=")) {
      const parsed = parseInts(raw.slice("--depths=".length));
      if (parsed.length > 0) args.depths = parsed;
    }
  }
  return args;
}

function centerForRegion(region: PrecomputedRegionName): { lat: number; lon: number } {
  if (region === "lausanne") return LAUSANNE_CENTER;
  if (region === "nyon") return NYON_CENTER;
  // For other regions, use any tile bbox center as a fallback ordering anchor
  return { lat: 46.5, lon: 6.6 };
}

function distanceSquaredMeters(latA: number, lonA: number, latB: number, lonB: number): number {
  const dLatM = (latB - latA) * 111_320;
  const avgLat = (latA + latB) / 2;
  const dLonM = (lonB - lonA) * (111_320 * Math.cos((avgLat * Math.PI) / 180));
  return dLatM * dLatM + dLonM * dLonM;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  // Sanity check: this bench only makes sense for GPU-IPC backends. Refuse
  // to silently run on CPU-mode where MAPPY_TILE_PIPELINE_DEPTH has no
  // effect (no IPC to overlap with prep CPU).
  const shadowMode = process.env.MAPPY_BUILDINGS_SHADOW_MODE?.trim().toLowerCase() ?? "";
  if (!GPU_IPC_BACKENDS.has(shadowMode)) {
    throw new Error(
      `[bench:tile-pipeline-depth] MAPPY_BUILDINGS_SHADOW_MODE must be one of ` +
        `${[...GPU_IPC_BACKENDS].join(", ")} (got: ${shadowMode || "unset"}). ` +
        `Tile pipeline depth only overlaps Node-side prep with GPU-IPC eval; ` +
        `there is no IPC to overlap in CPU-mode shadow backends.`,
    );
  }

  const args = parseArgs(process.argv.slice(2));
  const center = centerForRegion(args.region);

  const tiles = buildRegionTiles(args.region, 250)
    .map((tile) => ({
      tile,
      d2: distanceSquaredMeters(
        center.lat,
        center.lon,
        (tile.bbox.minLat + tile.bbox.maxLat) / 2,
        (tile.bbox.minLon + tile.bbox.maxLon) / 2,
      ),
    }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, args.tileCount)
    .map((e) => e.tile);

  if (tiles.length === 0) {
    throw new Error("No tiles selected for benchmark.");
  }

  const selectedTileIds = tiles.map((t) => t.tileId);

  // Force a fresh modelVersionHash so every config compute from scratch
  // (atlases under the prod hash already cover most sun-angle buckets).
  const benchBias = 0.001;
  const modelVersion = await getSunlightModelVersion(args.region, {
    buildingHeightBiasMeters: benchBias,
  });
  const cacheDir = path.join(CACHE_SUNLIGHT_DIR, args.region, modelVersion.modelVersionHash);

  console.log(
    `[bench:tile-pipeline-depth] backend=${shadowMode} region=${args.region} ` +
      `date=${args.startDate} days=${args.days} tileCount=${tiles.length} ` +
      `gridStep=${args.gridStepMeters}m sampleEvery=${args.sampleEveryMinutes}min ` +
      `window=${args.startLocalTime}-${args.endLocalTime} ` +
      `depths=${args.depths.join(",")} repeats=${args.repeats}`,
  );
  console.log(`[bench:tile-pipeline-depth] purge dir between configs: ${cacheDir}`);

  interface RunSample {
    repeat: number;
    depth: number;
    elapsedMs: number;
    processedTiles: number;
    tilePerMinute: number;
    failedTiles: number;
  }
  const samples: RunSample[] = [];

  // Workers axis is fixed at 1 (ADR-0019). MAPPY_TILE_PIPELINE_DEPTH varies.
  const originalDepth = process.env.MAPPY_TILE_PIPELINE_DEPTH;
  const originalWorkers = process.env.MAPPY_PRECOMPUTE_WORKERS;
  const originalStrict = process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT;

  try {
    process.env.MAPPY_PRECOMPUTE_WORKERS = "1";
    process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT = "1";
    for (let repeat = 1; repeat <= args.repeats; repeat++) {
      const order = repeat % 2 === 1 ? [...args.depths] : [...args.depths].reverse();
      console.log(`\n[bench:tile-pipeline-depth] repeat=${repeat}/${args.repeats} order=${order.join(",")}`);

      for (const depth of order) {
        await fs.rm(cacheDir, { recursive: true, force: true });
        clearAtlasSkipCache();
        process.env.MAPPY_TILE_PIPELINE_DEPTH = String(depth);

        const startedAt = performance.now();
        const result = await precomputeCacheRuns(
          {
            region: args.region,
            startDate: args.startDate,
            days: args.days,
            timezone: args.timezone,
            sampleEveryMinutes: args.sampleEveryMinutes,
            gridStepMeters: args.gridStepMeters,
            startLocalTime: args.startLocalTime,
            endLocalTime: args.endLocalTime,
            tileIds: selectedTileIds,
            skipExisting: false,
            buildingHeightBiasMeters: benchBias,
          },
          {},
        );
        const elapsedMs = performance.now() - startedAt;
        const processedTiles = result.totalTiles * result.totalDates;
        const failed = result.dates.reduce((s, d) => s + d.failedTiles, 0);
        const tpm = elapsedMs <= 0 ? 0 : processedTiles / (elapsedMs / 60_000);
        samples.push({
          repeat,
          depth,
          elapsedMs: Math.round(elapsedMs),
          processedTiles,
          tilePerMinute: Math.round(tpm * 100) / 100,
          failedTiles: failed,
        });
        console.log(
          `[bench:tile-pipeline-depth] repeat=${repeat} depth=${depth} elapsedMs=${Math.round(elapsedMs)} ` +
            `processedTiles=${processedTiles} tilesPerMin=${tpm.toFixed(2)} failed=${failed}`,
        );
      }
    }
  } finally {
    if (originalDepth === undefined) delete process.env.MAPPY_TILE_PIPELINE_DEPTH;
    else process.env.MAPPY_TILE_PIPELINE_DEPTH = originalDepth;
    if (originalWorkers === undefined) delete process.env.MAPPY_PRECOMPUTE_WORKERS;
    else process.env.MAPPY_PRECOMPUTE_WORKERS = originalWorkers;
    if (originalStrict === undefined) delete process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT;
    else process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT = originalStrict;
  }

  // Aggregate per depth
  const byDepth = new Map<number, RunSample[]>();
  for (const s of samples) {
    const list = byDepth.get(s.depth) ?? [];
    list.push(s);
    byDepth.set(s.depth, list);
  }
  const baselineDepth = args.depths[0];
  const baselineMedian = median((byDepth.get(baselineDepth) ?? []).map((s) => s.elapsedMs));

  console.log(`\n--- Summary ---`);
  console.log("depth".padEnd(8) + "median ms".padStart(14) + "tiles/min".padStart(14) + "speedup".padStart(12));
  for (const depth of args.depths) {
    const arr = (byDepth.get(depth) ?? []).map((s) => s.elapsedMs);
    const med = median(arr);
    const tpm = (samples.find((s) => s.depth === depth)?.processedTiles ?? 0) / (med / 60_000);
    const speedup = baselineMedian > 0 ? baselineMedian / med : 0;
    console.log(
      String(depth).padEnd(8) +
        med.toFixed(0).padStart(14) +
        tpm.toFixed(2).padStart(14) +
        `${speedup.toFixed(2)}×`.padStart(12),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
