import { computeSunlightTileArtifact } from "@/lib/precompute/sunlight-tile-service";
import { buildRegionTiles, getIntersectingTileIds, writePrecomputedSunlightTile } from "@/lib/precompute/sunlight-cache";
import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";
import { disposeWebGpuBackend } from "@/lib/sun/evaluation-context";

async function main() {
  console.log("1. Resolving tile...");
  const tiles = buildRegionTiles("lausanne", 250);
  const ids = getIntersectingTileIds({
    region: "lausanne", tileSizeMeters: 250,
    bbox: { minLon: 6.633, minLat: 46.5205, maxLon: 6.634, maxLat: 46.521 },
  });
  const tile = tiles.find(t => t.tileId === ids[0])!;
  console.log("2. Tile:", tile.tileId);

  const model = await getSunlightModelVersion("lausanne", normalizeShadowCalibration({}));
  console.log("3. Model:", model.modelVersionHash);

  console.log("4. Computing tile artifact...");
  const artifact = await computeSunlightTileArtifact({
    region: "lausanne",
    modelVersionHash: model.modelVersionHash,
    algorithmVersion: model.algorithmVersion,
    date: "2026-04-08",
    timezone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    gridStepMeters: 1,
    startLocalTime: "12:00",
    endLocalTime: "12:15",
    tile,
    shadowCalibration: normalizeShadowCalibration({}),
  });
  console.log("5. Tile done!", artifact.frames.length, "frames,", artifact.stats.pointCount, "points");

  // CRITICAL: Dispose Dawn BEFORE any file I/O (D3D12 driver bug)
  disposeWebGpuBackend();
  console.log("6. Dawn disposed, waiting 2s for D3D12 cleanup...");
  await new Promise(r => setTimeout(r, 2000));

  // Now safe to write
  await writePrecomputedSunlightTile(artifact);
  console.log("7. Saved to cache, exiting cleanly");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
