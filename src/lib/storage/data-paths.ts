import path from "node:path";
import fsSync from "node:fs";

const PROJECT_ROOT = process.cwd();
const ENV_DATA_ROOT = process.env.MAPPY_DATA_ROOT?.trim();
const RESOLVED_ENV_DATA_ROOT =
  ENV_DATA_ROOT && ENV_DATA_ROOT.length > 0
    ? path.isAbsolute(ENV_DATA_ROOT)
      ? ENV_DATA_ROOT
      : path.resolve(PROJECT_ROOT, ENV_DATA_ROOT)
    : null;

export const DATA_ROOT = RESOLVED_ENV_DATA_ROOT ?? path.join(PROJECT_ROOT, "data");

export const RAW_DATA_ROOT = path.join(DATA_ROOT, "raw");
export const RAW_SWISSTOPO_ROOT = path.join(RAW_DATA_ROOT, "swisstopo");
export const RAW_OSM_ROOT = path.join(RAW_DATA_ROOT, "osm");
export const RAW_BUILDINGS_DIR = path.join(
  RAW_SWISSTOPO_ROOT,
  "swissbuildings3d_2",
);
export const RAW_BUILDINGS_MANIFEST_LAUSANNE_PATH = path.join(
  RAW_BUILDINGS_DIR,
  "manifest-lausanne.json",
);
export const RAW_BUILDINGS_MANIFEST_NYON_PATH = path.join(
  RAW_BUILDINGS_DIR,
  "manifest-nyon.json",
);
export const RAW_TERRAIN_CH_DIR = path.join(RAW_SWISSTOPO_ROOT, "swissalti3d_2m");
export const RAW_TERRAIN_CH_MANIFEST_LAUSANNE_PATH = path.join(
  RAW_TERRAIN_CH_DIR,
  "manifest-lausanne.json",
);
export const RAW_TERRAIN_CH_MANIFEST_NYON_PATH = path.join(
  RAW_TERRAIN_CH_DIR,
  "manifest-nyon.json",
);
export const RAW_VEGETATION_SURFACE_DIR = path.join(
  RAW_SWISSTOPO_ROOT,
  "swisssurface3d_raster",
);
export const RAW_VEGETATION_SURFACE_MANIFEST_LAUSANNE_PATH = path.join(
  RAW_VEGETATION_SURFACE_DIR,
  "manifest-lausanne.json",
);
export const RAW_VEGETATION_SURFACE_MANIFEST_NYON_PATH = path.join(
  RAW_VEGETATION_SURFACE_DIR,
  "manifest-nyon.json",
);
export const RAW_HORIZON_DEM_DIR = path.join(RAW_DATA_ROOT, "copernicus-dem30");
export const RAW_HORIZON_DEM_MANIFEST_LAUSANNE_PATH = path.join(
  RAW_HORIZON_DEM_DIR,
  "manifest-lausanne-horizon.json",
);
export const RAW_HORIZON_DEM_MANIFEST_NYON_PATH = path.join(
  RAW_HORIZON_DEM_DIR,
  "manifest-nyon-horizon.json",
);
export const RAW_LAUSANNE_PLACES_PATH = path.join(
  RAW_OSM_ROOT,
  "lausanne-places-overpass.json",
);
export const RAW_NYON_PLACES_PATH = path.join(
  RAW_OSM_ROOT,
  "nyon-places-overpass.json",
);

export const PROCESSED_ROOT = path.join(DATA_ROOT, "processed");
export const CACHE_ROOT = path.join(DATA_ROOT, "cache");
// Override sunlight cache only (= atlases + sidecars + horizon caches), keeping
// inputs (raw, processed) at the regular DATA_ROOT. Useful for benches that
// need an isolated cache without copying the entire data tree.
const ENV_CACHE_SUNLIGHT_DIR = process.env.MAPPY_CACHE_SUNLIGHT_DIR?.trim();
export const CACHE_SUNLIGHT_DIR =
  ENV_CACHE_SUNLIGHT_DIR && ENV_CACHE_SUNLIGHT_DIR.length > 0
    ? path.isAbsolute(ENV_CACHE_SUNLIGHT_DIR)
      ? ENV_CACHE_SUNLIGHT_DIR
      : path.resolve(PROJECT_ROOT, ENV_CACHE_SUNLIGHT_DIR)
    : path.join(CACHE_ROOT, "sunlight");
export const CACHE_TILE_GRID_METADATA_DIR = path.join(CACHE_ROOT, "tile-grid-metadata");
export const PROCESSED_HORIZON_DIR = path.join(PROCESSED_ROOT, "horizon");
export const PROCESSED_HORIZON_SHARING_DIR = path.join(
  PROCESSED_HORIZON_DIR,
  "adaptive-sharing",
);
export const PROCESSED_HORIZON_MASK_PATH = path.join(
  PROCESSED_HORIZON_DIR,
  "lausanne-horizon-mask.json",
);
export const PROCESSED_BUILDINGS_DIR = path.join(PROCESSED_ROOT, "buildings");

/**
 * Regions that share a single buildings index (the historical Lausanne cluster).
 * Adding Bern/Zurich/etc. to this set would merge their data into the shared
 * index, invalidating cache for all cluster members — don't do that.
 */
const LAUSANNE_CLUSTER_REGIONS = new Set([
  "lausanne",
  "morges",
  "nyon",
  "vevey",
  "vevey_city",
  "geneve",
]);

/**
 * Returns the path to the buildings index JSON for a given region.
 *
 * - Lausanne-cluster regions (lausanne, morges, nyon, vevey, vevey_city,
 *   geneve) all share `buildings-index.json` so that adding one does not
 *   bust the atlas cache of the others.
 * - Other regions use `{region}-buildings-index.json` when present,
 *   falling back to `buildings-index.json` if no region-specific file
 *   exists yet (graceful degradation during initial ingest).
 */
export function getBuildingsIndexPath(region: string): string {
  if (LAUSANNE_CLUSTER_REGIONS.has(region)) {
    return path.join(PROCESSED_BUILDINGS_DIR, "buildings-index.json");
  }
  const regionSpecific = path.join(
    PROCESSED_BUILDINGS_DIR,
    `${region}-buildings-index.json`,
  );
  if (fsSync.existsSync(regionSpecific)) {
    return regionSpecific;
  }
  return path.join(PROCESSED_BUILDINGS_DIR, "buildings-index.json");
}
export const PROCESSED_PLACES_DIR = path.join(PROCESSED_ROOT, "places");
export const PROCESSED_LAUSANNE_PLACES_PATH = path.join(
  PROCESSED_PLACES_DIR,
  "lausanne-places.json",
);
export const PROCESSED_NYON_PLACES_PATH = path.join(
  PROCESSED_PLACES_DIR,
  "nyon-places.json",
);
