/**
 * Download VHM (Vegetationshöhenmodell) tiles and pre-compose with terrain.
 *
 * Replaces the old SwissSURFACE3D DSM-based vegetation rasters with clean
 * canopy-only data from the Swiss National Forest Inventory (NFI) VHM.
 *
 * The VHM is a single Cloud-Optimized GeoTIFF covering all of Switzerland at
 * 1m resolution, hosted on EnviDat. This script extracts regional windows via
 * HTTP range requests (rasterio COG support), then pre-composes each 1km tile
 * with the corresponding SwissALTI3D terrain tile:
 *
 *   canopy_elevation = terrain_elevation + max(0, vhm_height)
 *
 * The output tiles have the same format/semantics as the old SwissSURFACE3D
 * tiles (absolute elevation), so no shader or ray-march changes are needed.
 *
 * Usage: npx tsx scripts/ingest/download-vegetation-vhm.ts --region=nyon
 *        npx tsx scripts/ingest/download-vegetation-vhm.ts --region=all
 *
 * Requires: Python 3 + rasterio (pip install rasterio)
 */
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fromFile } from "geotiff";
import { wgs84ToLv95 } from "@/lib/geo/projection";
import { LAUSANNE_CONFIG } from "@/lib/config/lausanne";
import { NYON_CONFIG } from "@/lib/config/nyon";
import { MORGES_CONFIG } from "@/lib/config/morges";
import { GENEVE_CONFIG } from "@/lib/config/geneve";

const VHM_COG_URL =
  "https://os.zhdk.cloud.switch.ch/envicloud/doi/1000001.1/2022/landesforstinventar-vegetationshoehenmodell_stereo_2022_2056.tif";

const PYTHON = process.env.PYTHON_PATH ??
  "C:\\Users\\fabio.salvalai\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

const TERRAIN_ROOT = path.join(process.cwd(), "data", "raw", "swisstopo", "swissalti3d_2m");
const OUTPUT_ROOT = path.join(process.cwd(), "data", "raw", "swisstopo", "swisssurface3d_raster");

const REGIONS: Record<string, { localBbox: readonly [number, number, number, number] }> = {
  lausanne: LAUSANNE_CONFIG,
  nyon: NYON_CONFIG,
  morges: MORGES_CONFIG,
  geneve: GENEVE_CONFIG,
};

const TILE_SIZE_M = 1000; // SwissTopo 1km tile grid

function bboxToLv95(bbox: readonly [number, number, number, number]) {
  const sw = wgs84ToLv95(bbox[0], bbox[1]);
  const ne = wgs84ToLv95(bbox[2], bbox[3]);
  return {
    minE: Math.floor(sw.easting / TILE_SIZE_M) * TILE_SIZE_M,
    minN: Math.floor(sw.northing / TILE_SIZE_M) * TILE_SIZE_M,
    maxE: Math.ceil(ne.easting / TILE_SIZE_M) * TILE_SIZE_M,
    maxN: Math.ceil(ne.northing / TILE_SIZE_M) * TILE_SIZE_M,
  };
}

/** Extract a window from the remote VHM COG via Python/rasterio. */
function extractVhmWindow(
  minE: number, minN: number, maxE: number, maxN: number, outPath: string,
): { width: number; height: number } {
  const script = `
import rasterio, json, numpy as np
from rasterio.windows import from_bounds
with rasterio.open("${VHM_COG_URL}") as src:
    w = from_bounds(${minE}, ${minN}, ${maxE}, ${maxN}, src.transform)
    data = src.read(1, window=w)
    nodata = src.nodata
    # Replace nodata with 0 (no vegetation)
    mask = (data == nodata) | np.isnan(data)
    data[mask] = 0.0
    data = np.maximum(data, 0.0)  # clamp negatives
    result = {"width": int(data.shape[1]), "height": int(data.shape[0]),
              "vhm": data.astype(np.float32).flatten().tolist()}
    with open(r"${outPath.replace(/\\/g, "\\\\")}", "w") as f:
        json.dump(result, f)
    print(json.dumps({"width": result["width"], "height": result["height"]}))
`;
  const result = execSync(`"${PYTHON}" -c "${script.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`, {
    encoding: "utf8",
    timeout: 120_000,
  });
  return JSON.parse(result.trim());
}

async function loadTerrainTile(easting: number, northing: number): Promise<Float32Array | null> {
  // Find terrain tile — try multiple years
  const tileKey = `${Math.floor(easting / TILE_SIZE_M)}-${Math.floor(northing / TILE_SIZE_M)}`;
  const candidates = await fs.readdir(TERRAIN_ROOT).catch(() => []);
  const match = candidates
    .filter((d) => d.includes(tileKey))
    .sort()
    .pop(); // latest year
  if (!match) return null;
  const tifDir = path.join(TERRAIN_ROOT, match);
  const tifs = (await fs.readdir(tifDir)).filter((f) => f.endsWith(".tif"));
  if (tifs.length === 0) return null;
  const tiff = await fromFile(path.join(tifDir, tifs[0]));
  const image = await tiff.getImage();
  const [data] = await image.readRasters() as [Float32Array];
  return data;
}

async function composeTile(
  tileE: number, tileN: number, region: string, dryRun: boolean,
): Promise<"composed" | "skipped" | "no-terrain"> {
  const tileKey = `${Math.floor(tileE / TILE_SIZE_M)}-${Math.floor(tileN / TILE_SIZE_M)}`;
  // Output path matches old SwissSURFACE3D naming for drop-in compatibility
  const outDirName = `swisssurface3d-raster_vhm_${tileKey}`;
  const outDir = path.join(OUTPUT_ROOT, outDirName);
  const outTif = path.join(outDir, `${outDirName}.tif`);

  if (await fs.access(outTif).then(() => true).catch(() => false)) {
    return "skipped";
  }
  if (dryRun) {
    console.log(`  [dry-run] would compose ${tileKey}`);
    return "skipped";
  }

  // Load terrain
  const terrain = await loadTerrainTile(tileE, tileN);
  if (!terrain) return "no-terrain";
  const terrainSize = Math.round(Math.sqrt(terrain.length)); // 500×500 for 2m in 1km

  // Extract VHM window
  const tmpJson = path.join(process.cwd(), "data", "tmp", `vhm-${tileKey}.json`);
  await fs.mkdir(path.dirname(tmpJson), { recursive: true });
  const { width: vhmW, height: vhmH } = extractVhmWindow(
    tileE, tileN, tileE + TILE_SIZE_M, tileN + TILE_SIZE_M, tmpJson,
  );
  const vhmData: { vhm: number[] } = JSON.parse(await fs.readFile(tmpJson, "utf8"));
  await fs.unlink(tmpJson).catch(() => {});

  // Pre-compose: canopy = terrain + vhm (upscale terrain from 2m to 1m)
  const canopy = new Float32Array(vhmW * vhmH);
  for (let y = 0; y < vhmH; y++) {
    for (let x = 0; x < vhmW; x++) {
      const tx = Math.min(Math.floor(x * terrainSize / vhmW), terrainSize - 1);
      const ty = Math.min(Math.floor(y * terrainSize / vhmH), terrainSize - 1);
      const terrElev = terrain[ty * terrainSize + tx];
      const vhm = vhmData.vhm[y * vhmW + x];
      canopy[y * vhmW + x] = terrElev + Math.max(0, vhm);
    }
  }

  // Write as raw GeoTIFF (minimal — just enough for our geotiff.js reader)
  // For simplicity, write as JSON that our existing loader can read,
  // then we can convert to GeoTIFF later if needed.
  await fs.mkdir(outDir, { recursive: true });
  // Actually write a proper GeoTIFF using Python
  const writeTifScript = `
import rasterio, numpy as np, json
from rasterio.transform import from_bounds
with open(r"${tmpJson.replace(/\\/g, "\\\\")}") as f:
    d = json.load(f)
canopy = np.array(d["canopy"], dtype=np.float32).reshape(${vhmH}, ${vhmW})
transform = from_bounds(${tileE}, ${tileN}, ${tileE + TILE_SIZE_M}, ${tileN + TILE_SIZE_M}, ${vhmW}, ${vhmH})
with rasterio.open(r"${outTif.replace(/\\/g, "\\\\")}", "w", driver="GTiff",
    width=${vhmW}, height=${vhmH}, count=1, dtype="float32",
    crs="EPSG:2056", transform=transform, compress="deflate") as dst:
    dst.write(canopy, 1)
print("ok")
`;
  // Write canopy as temp JSON for Python
  const canopyJson = { canopy: Array.from(canopy) };
  await fs.writeFile(tmpJson, JSON.stringify(canopyJson));
  execSync(`"${PYTHON}" -c "${writeTifScript.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`, {
    encoding: "utf8",
    timeout: 60_000,
  });
  await fs.unlink(tmpJson).catch(() => {});

  return "composed";
}

async function main() {
  const args = process.argv.slice(2);
  const regionArg = args.find((a) => a.startsWith("--region="))?.slice(9) ?? "";
  const dryRun = args.includes("--dry-run");

  const regionNames = regionArg === "all" ? Object.keys(REGIONS) : [regionArg];
  for (const region of regionNames) {
    const config = REGIONS[region];
    if (!config) { console.error(`Unknown region: ${region}`); process.exit(1); }

    const lv95 = bboxToLv95(config.localBbox);
    console.log(`[vhm:${region}] LV95 bbox: E${lv95.minE}-${lv95.maxE} N${lv95.minN}-${lv95.maxN}`);

    let composed = 0, skipped = 0, noTerrain = 0;
    for (let e = lv95.minE; e < lv95.maxE; e += TILE_SIZE_M) {
      for (let n = lv95.minN; n < lv95.maxN; n += TILE_SIZE_M) {
        const result = await composeTile(e, n, region, dryRun);
        if (result === "composed") { composed++; process.stdout.write("."); }
        else if (result === "skipped") { skipped++; process.stdout.write("s"); }
        else { noTerrain++; process.stdout.write("x"); }
      }
    }
    console.log(`\n[vhm:${region}] Done: ${composed} composed, ${skipped} skipped, ${noTerrain} no-terrain`);

    // Write manifest
    const manifestPath = path.join(OUTPUT_ROOT, `manifest-${region}-vhm.json`);
    const manifest = {
      generatedAt: new Date().toISOString(),
      source: "VHM NFI 2022 (EnviDat COG)",
      cogUrl: VHM_COG_URL,
      region,
      lv95Bbox: lv95,
      composed,
      skipped,
      noTerrain,
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }
}

main().catch((e) => { console.error(`Failed: ${e}`); process.exitCode = 1; });
