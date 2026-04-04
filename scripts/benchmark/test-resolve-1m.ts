import { performance } from "node:perf_hooks";
import { resolveSunlightTilesForBbox } from "@/lib/precompute/sunlight-tile-service";
import { DEFAULT_SHADOW_CALIBRATION } from "@/lib/sun/shadow-calibration";

async function main() {
  const t0 = performance.now();
  console.log("Starting resolveSunlightTilesForBbox...");
  const result = await resolveSunlightTilesForBbox({
    bbox: { minLon: 6.632, minLat: 46.5195, maxLon: 6.634, maxLat: 46.5205 },
    date: "2026-04-10",
    timezone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    gridStepMeters: 1,
    startLocalTime: "10:00",
    endLocalTime: "11:00",
    shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
    persistMissingTiles: false,
    onTileComputeProgress: (ev) => {
      if (ev.stageCompleted === ev.stageTotal || ev.stageCompleted % 20000 === 0) {
        console.log(`  ${ev.tileId} ${ev.stage} ${ev.stageCompleted}/${ev.stageTotal} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
      }
    },
  });
  const elapsed = (performance.now() - t0) / 1000;
  console.log(`Done: ${elapsed.toFixed(1)}s, tiles: ${result?.artifacts.length ?? 0}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
