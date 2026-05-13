import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

// Ville de Zurich (centre urbain — Altstadt, Bahnhofstrasse, Niederdorf,
// Kreis 4/5, rive nord du Zürichsee). La commune complète (BFS 261, wikidata
// Q72, OSM relation 1682248) inclut de nombreux Kreise extérieurs (Wipkingen,
// Witikon, Wollishofen, etc.). On restreint volontairement la couverture au
// centre dense via une bbox locale (~6×4.4 km). Le précompute intersecte
// ensuite le polygone commune avec cette bbox + filtre le Zürichsee.
export const ZURICH_CENTER = {
  lat: 47.376,
  lon: 8.541,
};

// Bbox locale autour du centre-ville (≈6×4.4 km).
// Couvre Altstadt, Bahnhofstrasse, Niederdorf, Kreis 4/5, rive nord du
// Zürichsee. Exclut les grands quartiers périphériques.
export const ZURICH_LOCAL_BBOX: BBox = [8.5, 47.36, 8.58, 47.4];

// Même rayon que les autres régions : 120 km couvre l'Alpstein, le Glaernisch,
// le Säntis et l'arc alpin susceptibles de rétroprojeter des horizons.
export const ZURICH_HORIZON_RADIUS_KM = 120;

export const ZURICH_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  ZURICH_CENTER.lon,
  ZURICH_CENTER.lat,
  ZURICH_HORIZON_RADIUS_KM,
);

export const ZURICH_CONFIG = {
  center: ZURICH_CENTER,
  localBbox: ZURICH_LOCAL_BBOX,
  horizonBbox: ZURICH_HORIZON_BBOX,
  horizonRadiusKm: ZURICH_HORIZON_RADIUS_KM,
} as const;
