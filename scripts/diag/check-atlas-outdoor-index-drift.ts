/**
 * Diagnostic : compare le pointOutdoorIndex stocké dans l'atlas à celui
 * qu'un nouveau run produirait via la grid metadata actuelle.
 *
 * Hypothèse : mergeBucketsIntoAtlas réutilise l'ancien pointOutdoorIndex
 * quand il merge de nouveaux buckets. Si l'indoor classification a changé
 * entre deux runs, le mismatch provoque un décalage de bits dans la lecture
 * atlas → "CPU=SHAD / atlas=SUN" en masse.
 *
 * Usage :
 *   npx tsx scripts/diag/check-atlas-outdoor-index-drift.ts --tile=e2538000_n1152500_s250 --region=lausanne
 */

import { loadPrecomputedTileAtlas } from "../../src/lib/precompute/sunlight-cache-atlas";
import { loadTileGridMetadata } from "../../src/lib/precompute/tile-grid-metadata";
import { getSunlightModelVersion } from "../../src/lib/precompute/model-version";
import { buildTilePoints, buildRegionTiles } from "../../src/lib/precompute/sunlight-cache";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

async function main() {
  const args = process.argv.slice(2);
  let tileId = "";
  let region = "" as PrecomputedRegionName;
  for (const a of args) {
    if (a.startsWith("--tile=")) tileId = a.slice(7);
    else if (a.startsWith("--region=")) region = a.slice(9) as PrecomputedRegionName;
  }
  if (!tileId || !region) throw new Error("--tile= --region= requis");

  const match = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
  if (!match) throw new Error(`tile id invalide : ${tileId}`);
  const size = Number(match[3]);

  const modelVersion = await getSunlightModelVersion(region, { buildingHeightBiasMeters: 0 });
  console.log(`[diag] region=${region} tile=${tileId} model=${modelVersion.modelVersionHash}`);

  const atlas = await loadPrecomputedTileAtlas({
    region,
    modelVersionHash: modelVersion.modelVersionHash,
    gridStepMeters: 1,
    tileId,
  });
  if (!atlas) throw new Error(`pas d'atlas pour ${tileId}`);

  const metadata = await loadTileGridMetadata(region, modelVersion.modelVersionHash, 1, tileId);
  if (!metadata) throw new Error(`pas de grid metadata`);

  const regionTiles = buildRegionTiles(region, size);
  const tileSpec = regionTiles.find((t) => t.tileId === tileId);
  if (!tileSpec) throw new Error(`tuile pas dans buildRegionTiles`);
  const allPoints = buildTilePoints(tileSpec, 1);

  console.log(`\n[ATLAS stocké]`);
  console.log(`  pointCount:         ${atlas.pointCount}`);
  console.log(`  outdoorPointCount:  ${atlas.outdoorPointCount}`);
  console.log(`  maskBytesPerBucket: ${atlas.maskBytesPerBucket}`);

  console.log(`\n[GRID METADATA actuelle]`);
  let freshIndoor = 0;
  for (let i = 0; i < metadata.indoor.length; i++) if (metadata.indoor[i]) freshIndoor++;
  const freshOutdoor = metadata.indoor.length - freshIndoor;
  console.log(`  pointCount:         ${allPoints.length}`);
  console.log(`  indoor:             ${freshIndoor}`);
  console.log(`  outdoor:            ${freshOutdoor}`);

  // Compare bit-à-bit les flags indoor
  let flagDrift = 0;
  let outdoorIdxDrift = 0;
  let freshOutdoorCursor = 0;
  for (let i = 0; i < atlas.pointCount; i++) {
    const atlasIndoor = (atlas.pointFlags[i] & 1) !== 0;
    const freshIndoorI = metadata.indoor[i] ?? false;
    if (atlasIndoor !== freshIndoorI) flagDrift++;

    const atlasOutIdx = atlas.pointOutdoorIndex[i];
    const freshOutIdx = freshIndoorI ? -1 : freshOutdoorCursor++;
    if (atlasOutIdx !== freshOutIdx) outdoorIdxDrift++;
  }

  console.log(`\n[DÉCALAGE]`);
  console.log(`  pointFlags (indoor bit) diff : ${flagDrift}/${atlas.pointCount}`);
  console.log(`  pointOutdoorIndex diff       : ${outdoorIdxDrift}/${atlas.pointCount}`);
  console.log(`  outdoorCount atlas vs fresh  : ${atlas.outdoorPointCount} vs ${freshOutdoor}  (Δ=${freshOutdoor - atlas.outdoorPointCount})`);

  if (outdoorIdxDrift > 0 || atlas.outdoorPointCount !== freshOutdoor) {
    console.log(`\n  ⚠  SMOKING GUN : l'atlas stocké a une indexation outdoor différente de la grid metadata actuelle.`);
    console.log(`      Les nouveaux buckets sont écrits avec le layout frais, mais l'atlas lit via l'ancien pointOutdoorIndex.`);
    console.log(`      → mismatch massif au lookup.`);
  } else {
    console.log(`\n  ✓ indexation identique. Bug ailleurs.`);
  }

  // Affiche les 10 premiers décalages pour inspection
  if (outdoorIdxDrift > 0) {
    console.log(`\n  10 premiers décalages pointOutdoorIndex :`);
    let shown = 0;
    let cursor = 0;
    for (let i = 0; i < atlas.pointCount && shown < 10; i++) {
      const atlasIndoor = (atlas.pointFlags[i] & 1) !== 0;
      const freshIndoorI = metadata.indoor[i] ?? false;
      const atlasOutIdx = atlas.pointOutdoorIndex[i];
      const freshOutIdx = freshIndoorI ? -1 : cursor;
      if (!freshIndoorI) cursor++;
      if (atlasOutIdx !== freshOutIdx || atlasIndoor !== freshIndoorI) {
        console.log(
          `    pointIdx=${i}  atlas(indoor=${atlasIndoor}, outIdx=${atlasOutIdx})  fresh(indoor=${freshIndoorI}, outIdx=${freshOutIdx})`,
        );
        shown++;
      }
    }
  }
}

main().catch((e) => {
  console.error(`[diag] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
