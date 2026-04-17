/**
 * Ingest VHM (Vegetationshöhenmodell NFI) for a region.
 *
 * Thin Node wrapper around `compose-vhm-canopy.py` — the heavy lifting
 * (HTTP range requests to the EnviDat COG + pre-composition with
 * SwissALTI3D terrain) happens in Python for access to the LERC codec
 * that our GDAL/Node stack does not support.
 *
 * Output: GeoTIFF canopy tiles (terrain + VHM) in
 *   data/raw/swisstopo/swisssurface3d_raster/swisssurface3d-raster_vhm_<e>-<n>/*.tif
 * These are picked up automatically by vegetation-shadow.ts (VHM tiles win
 * over DSM tiles for the same km cell — see commit ad72538).
 *
 * Usage: npx tsx scripts/ingest/download-vegetation-vhm.ts --region=nyon
 *        npx tsx scripts/ingest/download-vegetation-vhm.ts --region=all
 *        npx tsx scripts/ingest/download-vegetation-vhm.ts --region=nyon --overwrite
 *
 * Requires: Python 3 + rasterio (pip install rasterio). Override the Python
 * path with MAPPY_VHM_PYTHON if needed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const DEFAULT_PYTHON =
  "C:\\Users\\fabio.salvalai\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

const REGIONS = ["lausanne", "morges", "nyon", "geneve"] as const;
type Region = typeof REGIONS[number];

function parseArgs(argv: string[]): { regions: Region[]; overwrite: boolean } {
  const regionArg = argv.find((a) => a.startsWith("--region="))?.slice(9) ?? "";
  const overwrite = argv.includes("--overwrite");
  if (!regionArg) {
    console.error(`Usage: --region=${REGIONS.join("|")}|all [--overwrite]`);
    process.exit(1);
  }
  const regions: Region[] = regionArg === "all"
    ? [...REGIONS]
    : [regionArg as Region];
  for (const r of regions) {
    if (!REGIONS.includes(r)) {
      console.error(`Unknown region: ${r}. Expected one of: ${REGIONS.join(", ")} or 'all'.`);
      process.exit(1);
    }
  }
  return { regions, overwrite };
}

function main(): void {
  const { regions, overwrite } = parseArgs(process.argv.slice(2));
  const python = process.env.MAPPY_VHM_PYTHON ?? DEFAULT_PYTHON;
  const script = path.join(process.cwd(), "scripts", "ingest", "compose-vhm-canopy.py");

  for (const region of regions) {
    const args = [script, `--region=${region}`];
    if (overwrite) args.push("--overwrite");
    console.log(`[vhm:${region}] python ${script} --region=${region}${overwrite ? " --overwrite" : ""}`);
    const result = spawnSync(python, args, { stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`[vhm:${region}] failed with code ${result.status}`);
      process.exitCode = 1;
      return;
    }
  }
}

main();
