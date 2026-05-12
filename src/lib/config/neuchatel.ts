import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

// Ville de Neuchâtel (commune OSM minus Lac de Neuchâtel).
// Bbox restreinte 5×3 km couvrant le centre historique + Serrières + La Coudre.
// Mêmes conventions que vevey_city : la sélection précise des tuiles vient
// d'un filtre OSM commune-land au moment du précalcul.
export const NEUCHATEL_CENTER = {
  lat: 46.992,
  lon: 6.931,
};

// Bbox locale élargie pour englober toute l'enveloppe LV95 du polygone
// commune réel (E=[2554750, 2566250] N=[1203000, 1212750] d'après l'OSM
// relation 1685519, BFS 6458). Une bbox plus étroite filtrait les tuiles
// nord/est du précompute via `getIntersectingTileIds`. Marge ~150m sur
// chaque axe pour absorber les arrondis de projection LV95↔WGS84.
export const NEUCHATEL_LOCAL_BBOX: BBox = [6.90, 46.97, 7.00, 47.04];

// Lac de Neuchâtel rétroprojette des obstacles montagneux jusqu'au Jura
// occidental + Alpes bernoises ; même rayon que les autres régions lakeside.
export const NEUCHATEL_HORIZON_RADIUS_KM = 120;

export const NEUCHATEL_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  NEUCHATEL_CENTER.lon,
  NEUCHATEL_CENTER.lat,
  NEUCHATEL_HORIZON_RADIUS_KM,
);

export const NEUCHATEL_CONFIG = {
  center: NEUCHATEL_CENTER,
  localBbox: NEUCHATEL_LOCAL_BBOX,
  horizonBbox: NEUCHATEL_HORIZON_BBOX,
  horizonRadiusKm: NEUCHATEL_HORIZON_RADIUS_KM,
} as const;
