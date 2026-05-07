/**
 * Inspecte le contenu d'une tuile VHM pré-composée pour vérifier qu'elle
 * ne contient que {terrain + canopée}. Si le max des "hauteurs relatives"
 * (pixel - min_pixel) dépasse ~40m, il y a probablement un bâtiment.
 */
import { fromFile } from "geotiff";

const CELLS = [
  "2536-1151",
  "2537-1151",
  "2537-1152",
  "2538-1151",
];

async function inspectTile(cell: string) {
  const vhmPath = `data/raw/swisstopo/swisssurface3d_raster/swisssurface3d-raster_vhm_${cell}/swisssurface3d-raster_vhm_${cell}.tif`;
  const dsmPath = `data/raw/swisstopo/swisssurface3d_raster/swisssurface3d-raster_2019_${cell}/swisssurface3d-raster_2019_${cell}_0.5_2056_5728.tif`;
  console.log(`\n── ${cell} ──`);
  for (const [label, filePath] of [["VHM", vhmPath], ["DSM", dsmPath]] as const) {
    try {
      const tiff = await fromFile(filePath);
      const image = await tiff.getImage();
      const raster = (await image.readRasters({ interleave: true, pool: null })) as Float32Array | Uint8Array;
      const w = image.getWidth();
      const h = image.getHeight();
      const nodata = image.getGDALNoData();
      let min = Infinity, max = -Infinity, sum = 0, count = 0;
      const values = raster as Float32Array;
      const tallies = new Map<number, number>(); // bucket heights
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === nodata || Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        count++;
      }
      const mean = sum / count;
      // Compute distribution of (v - min) to detect building-like heights relative to ground
      const relHeights = [0, 2, 5, 10, 20, 30, 50, 100];
      const histo = new Array(relHeights.length).fill(0);
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === nodata || Number.isNaN(v)) continue;
        const rel = v - min;
        for (let b = relHeights.length - 1; b >= 0; b--) {
          if (rel >= relHeights[b]) {
            histo[b]++;
            break;
          }
        }
      }
      console.log(
        `  ${label.padEnd(3)} ${w}×${h}  min=${min.toFixed(1)}m  max=${max.toFixed(1)}m  mean=${mean.toFixed(1)}m  spread=${(max - min).toFixed(1)}m`,
      );
      const pcts = histo.map((n) => ((n / count) * 100).toFixed(1));
      console.log(`       rel>=${relHeights.join("m,>=")}m  :  ${pcts.join("%, ")}%`);
    } catch (e) {
      console.log(`  ${label}: NOT FOUND`);
    }
  }
}

async function main() {
  for (const c of CELLS) await inspectTile(c);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
