import path from "node:path";

const PROJECT_ROOT = process.cwd();

export const DATA_ROOT = path.join(PROJECT_ROOT, "data");

export const RAW_DATA_ROOT = path.join(DATA_ROOT, "raw");
export const RAW_SWISSTOPO_ROOT = path.join(RAW_DATA_ROOT, "swisstopo");
export const RAW_OSM_ROOT = path.join(RAW_DATA_ROOT, "osm");
export const RAW_BUILDINGS_DIR = path.join(
  RAW_SWISSTOPO_ROOT,
  "swissbuildings3d_2",
);
export const RAW_TERRAIN_CH_DIR = path.join(RAW_SWISSTOPO_ROOT, "swissalti3d_2m");
export const RAW_HORIZON_DEM_DIR = path.join(RAW_DATA_ROOT, "copernicus-dem30");
export const RAW_LAUSANNE_PLACES_PATH = path.join(
  RAW_OSM_ROOT,
  "lausanne-places-overpass.json",
);

export const PROCESSED_ROOT = path.join(DATA_ROOT, "processed");
export const PROCESSED_HORIZON_DIR = path.join(PROCESSED_ROOT, "horizon");
export const PROCESSED_HORIZON_MASK_PATH = path.join(
  PROCESSED_HORIZON_DIR,
  "lausanne-horizon-mask.json",
);
export const PROCESSED_BUILDINGS_DIR = path.join(PROCESSED_ROOT, "buildings");
export const PROCESSED_BUILDINGS_INDEX_PATH = path.join(
  PROCESSED_BUILDINGS_DIR,
  "lausanne-buildings-index.json",
);
export const PROCESSED_PLACES_DIR = path.join(PROCESSED_ROOT, "places");
export const PROCESSED_LAUSANNE_PLACES_PATH = path.join(
  PROCESSED_PLACES_DIR,
  "lausanne-places.json",
);
