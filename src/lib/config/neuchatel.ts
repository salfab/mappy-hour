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
// relation 1685519, BFS 6458) + l'extension Auvernier (village rattaché à
// Milvignes, OSM relation 2758642, ~3 km SW de Neuchâtel ; bbox de coverage
// [6.86, 46.945, 6.90, 46.965]) + extension est 2026-05-13 pour Hauterive (NE)
// (OSM historic relation 1685491) et Saint-Blaise (1685530), fusionnés dans
// Laténa en 2021 (BFS 6513). Tiles s'étendent jusqu'à lon~7.013/lat~47.025
// pour Saint-Blaise. Marge ~150m (~0.0014° lat, ~0.002° lon) absorbée par
// l'arrondi extérieur.
export const NEUCHATEL_LOCAL_BBOX: BBox = [6.84, 46.95, 7.02, 47.07];

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
