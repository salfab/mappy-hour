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

// Bbox élargie pour couvrir les 97 tuiles 250m de la sélection vevey_city :
// - 56 tuiles issues de commune-vevey-land-tiles.json (commune OSM ∖ Lac Léman)
// - 41 tuiles ajoutées manuellement 2026-05-11 (annexes de la ville)
// Union LV95 : E 2552000-2556000, N 1144000-1148000 ≈ WGS84 [6.82, 46.44, 6.89, 46.49].
export const VEVEY_CITY_LOCAL_BBOX: BBox = [6.82, 46.44, 6.89, 46.49];

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
