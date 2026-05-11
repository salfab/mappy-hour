import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

// Vraie ville de Vevey (commune de Vevey + La Tour-de-Peilz + Corseaux)
// sans le Lavaux. Le bbox englobe les 56 tuiles 250m issues de
// commune-vevey-land-tiles.json (commune OSM moins Lac Léman).
//
// NOTE : "vevey" (sans suffixe) reste défini dans ./vevey.ts et couvre en
// réalité Lavaux + Vevey étendu. Un re-groupement scientifique des régions
// est prévu (cf. memory project_region_regrouping_todo).
export const VEVEY_CITY_CENTER = {
  lat: 46.4628,
  lon: 6.8419,
};

export const VEVEY_CITY_LOCAL_BBOX: BBox = [6.83, 46.45, 6.89, 46.48];

export const VEVEY_CITY_HORIZON_RADIUS_KM = 120;

export const VEVEY_CITY_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  VEVEY_CITY_CENTER.lon,
  VEVEY_CITY_CENTER.lat,
  VEVEY_CITY_HORIZON_RADIUS_KM,
);

export const VEVEY_CITY_CONFIG = {
  center: VEVEY_CITY_CENTER,
  localBbox: VEVEY_CITY_LOCAL_BBOX,
  horizonBbox: VEVEY_CITY_HORIZON_BBOX,
  horizonRadiusKm: VEVEY_CITY_HORIZON_RADIUS_KM,
} as const;
