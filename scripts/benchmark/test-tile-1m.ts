import { performance } from "node:perf_hooks";
import { buildRegionTiles } from "@/lib/precompute/sunlight-cache";
import { computeSunlightTileArtifact } from "@/lib/precompute/sunlight-tile-service";
import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import { DEFAULT_SHADOW_CALIBRATION } from "@/lib/sun/shadow-calibration";

async function main() {
  const tiles = buildRegionTiles("lausanne", 250);
  const tile = tiles.find((t) => t.tileId === "e2538000_n1152250_s250")!;
  const mv = await getSunlightModelVersion("lausanne", DEFAULT_SHADOW_CALIBRATION);

  console.log(`Computing ${tile.tileId} grid=1m 60 frames...`);
  const t0 = performance.now();
  const result = await computeSunlightTileArtifact({
    region: "lausanne",
    modelVersionHash: mv.modelVersionHash,
    algorithmVersion: mv.algorithmVersion,
    date: "2026-04-04",
    timezone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    gridStepMeters: 1,
    startLocalTime: "06:00",
    endLocalTime: "21:00",
    tile,
    shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
    cooperativeYieldEveryPoints: 5000,
    onProgress: (p) => {
      if (p.completed === p.total || p.completed % 5000 === 0) {
        console.log(`  ${p.stage} ${p.completed}/${p.total} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
      }
    },
  });
  const elapsed = performance.now() - t0;
  console.log(`Done: ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`Points: ${result.stats.pointCount}, Evals: ${result.stats.totalEvaluations}`);
  console.log(`Elapsed: ${result.stats.elapsedMs}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
