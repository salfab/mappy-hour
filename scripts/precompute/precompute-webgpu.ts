/**
 * Single-process precompute script using WebGPU compute shaders.
 *
 * Runs tile computation sequentially in the main process to avoid
 * Dawn/D3D12 segfaults in forked child processes.
 *
 * Usage:
 *   MAPPY_BUILDINGS_SHADOW_MODE=webgpu-compute npx tsx scripts/precompute/precompute-webgpu.ts \
 *     --region=lausanne --start-date=2026-04-06 --days=1 \
 *     --start-local-time=06:00 --end-local-time=21:00 \
 *     --sample-every-minutes=15 --grid-step-meters=1 \
 *     --bbox=6.618,46.505,6.645,46.526 --skip-existing=true
 */
import { performance } from "node:perf_hooks";

import { buildRegionTiles, getIntersectingTileIds } from "../../src/lib/precompute/sunlight-cache";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";
import { getSunlightModelVersion } from "../../src/lib/precompute/model-version";
import { computeSunlightTileArtifact } from "../../src/lib/precompute/sunlight-tile-service";
import { writePrecomputedSunlightTile, writePrecomputedSunlightManifest } from "../../src/lib/precompute/sunlight-cache";
import { normalizeShadowCalibration } from "../../src/lib/sun/shadow-calibration";

// ── Arg parsing (same as precompute-region-sunlight.ts) ────────────────

interface Args {
  region: PrecomputedRegionName;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  buildingHeightBiasMeters: number;
  skipExisting: boolean;
  bbox: [number, number, number, number] | null;
}

function parseArgs(argv: string[]): Args {
  const result: Args = {
    region: "lausanne",
    startDate: "2026-04-06",
    days: 1,
    timezone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    gridStepMeters: 1,
    startLocalTime: "06:00",
    endLocalTime: "21:00",
    buildingHeightBiasMeters: 0,
    skipExisting: true,
    bbox: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--region=")) result.region = arg.slice(9) as PrecomputedRegionName;
    else if (arg.startsWith("--start-date=")) result.startDate = arg.slice(13);
    else if (arg.startsWith("--days=")) result.days = Number(arg.slice(7));
    else if (arg.startsWith("--timezone=")) result.timezone = arg.slice(11);
    else if (arg.startsWith("--sample-every-minutes=")) result.sampleEveryMinutes = Number(arg.slice(23));
    else if (arg.startsWith("--grid-step-meters=")) result.gridStepMeters = Number(arg.slice(19));
    else if (arg.startsWith("--start-local-time=")) result.startLocalTime = arg.slice(19);
    else if (arg.startsWith("--end-local-time=")) result.endLocalTime = arg.slice(17);
    else if (arg.startsWith("--building-height-bias-meters=")) result.buildingHeightBiasMeters = Number(arg.slice(30));
    else if (arg.startsWith("--skip-existing=")) result.skipExisting = arg.slice(16).toLowerCase() === "true";
    else if (arg.startsWith("--bbox=")) {
      const parts = arg.slice(7).split(",").map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        result.bbox = parts as [number, number, number, number];
      }
    }
  }
  return result;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // WebGPU compute uses an IPC subprocess — no pre-init needed in main process.

  // Resolve tiles
  const allTiles = buildRegionTiles(args.region, 250);
  let tileIds: string[] | undefined;
  if (args.bbox) {
    const [minLon, minLat, maxLon, maxLat] = args.bbox;
    tileIds = getIntersectingTileIds({
      region: args.region,
      tileSizeMeters: 250,
      bbox: { minLon, minLat, maxLon, maxLat },
    });
    console.log(`[webgpu-precompute] bbox=[${args.bbox.join(",")}] → ${tileIds.length} tiles`);
  }

  const tiles = tileIds
    ? allTiles.filter((t) => tileIds!.includes(t.tileId))
    : allTiles;

  // Model version
  const modelVersion = await getSunlightModelVersion(args.region, {
    buildingHeightBiasMeters: args.buildingHeightBiasMeters,
  });
  const shadowCalibration = normalizeShadowCalibration({
    buildingHeightBiasMeters: args.buildingHeightBiasMeters,
  });

  console.log(
    `[webgpu-precompute] mode=${process.env.MAPPY_BUILDINGS_SHADOW_MODE} region=${args.region} model=${modelVersion.modelVersionHash} tiles=${tiles.length} days=${args.days} window=${args.startLocalTime}-${args.endLocalTime} grid=${args.gridStepMeters}m sample=${args.sampleEveryMinutes}min`,
  );

  const globalStart = performance.now();
  let totalTilesComputed = 0;
  let totalTilesSkipped = 0;

  for (let dayOffset = 0; dayOffset < args.days; dayOffset++) {
    const date = addDays(args.startDate, dayOffset);
    const dayStart = performance.now();
    let dayComputed = 0;
    let daySkipped = 0;

    for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
      const tile = tiles[tileIdx];

      // Skip existing check
      if (args.skipExisting) {
        const { loadPrecomputedSunlightTile } = await import("../../src/lib/precompute/sunlight-cache");
        try {
          const existing = await loadPrecomputedSunlightTile({
            region: args.region,
            modelVersionHash: modelVersion.modelVersionHash,
            date,
            gridStepMeters: args.gridStepMeters,
            sampleEveryMinutes: args.sampleEveryMinutes,
            startLocalTime: args.startLocalTime,
            endLocalTime: args.endLocalTime,
            tileId: tile.tileId,
          });
          if (existing) {
            daySkipped++;
            totalTilesSkipped++;
            continue;
          }
        } catch {
          // Not cached, compute it
        }
      }

      console.log(
        `[webgpu-precompute] date=${date} tile=${tileIdx + 1}/${tiles.length} id=${tile.tileId} computing...`,
      );

      const tileStart = performance.now();
      const artifact = await computeSunlightTileArtifact({
        region: args.region,
        modelVersionHash: modelVersion.modelVersionHash,
        algorithmVersion: modelVersion.algorithmVersion,
        date,
        timezone: args.timezone,
        sampleEveryMinutes: args.sampleEveryMinutes,
        gridStepMeters: args.gridStepMeters,
        startLocalTime: args.startLocalTime,
        endLocalTime: args.endLocalTime,
        tile,
        shadowCalibration,
        cooperativeYieldEveryPoints: 5000,
      });

      await writePrecomputedSunlightTile(artifact);

      const tileMs = performance.now() - tileStart;
      dayComputed++;
      totalTilesComputed++;

      console.log(
        `[webgpu-precompute] date=${date} tile=${tileIdx + 1}/${tiles.length} id=${tile.tileId} done in ${(tileMs / 1000).toFixed(1)}s (${artifact.stats.pointCount} outdoor pts, ${artifact.frames.length} frames)`,
      );
    }

    const dayMs = performance.now() - dayStart;
    console.log(
      `[webgpu-precompute] date=${date} done: ${dayComputed} computed, ${daySkipped} skipped in ${(dayMs / 1000).toFixed(1)}s`,
    );
  }

  const totalMs = performance.now() - globalStart;
  console.log(
    `[webgpu-precompute] completed: ${totalTilesComputed} computed, ${totalTilesSkipped} skipped, ${(totalMs / 1000 / 60).toFixed(1)} min total`,
  );

  // CRITICAL: Dispose Dawn device before exit to prevent D3D12 segfault on shutdown.
  try {
    const { disposeWebGpuBackend } = await import("../../src/lib/sun/evaluation-context");
    disposeWebGpuBackend();
  } catch {}
}

main().catch((err) => {
  console.error(`[webgpu-precompute] fatal: ${err instanceof Error ? err.message : err}`);
  try {
    const { disposeWebGpuBackend } = require("../../src/lib/sun/evaluation-context");
    disposeWebGpuBackend();
  } catch {}
  process.exitCode = 1;
});
