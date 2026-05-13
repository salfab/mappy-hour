import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

// Ville de Berne (centre urbain — Altstadt, Bundeshaus, Lorraine, Länggasse,
// Marzili). La commune complète (BFS 351, wikidata Q70, OSM relation 1682378)
// s'étend bien au-delà du centre historique : Bümpliz, Bethlehem, Bottigen à
// l'ouest, qui sortent du tissu dense. On restreint volontairement la
// couverture au centre via une bbox locale (~5×4.4 km). Le précompute
// intersecte ensuite le polygone commune avec cette bbox.
export const BERN_CENTER = {
  lat: 46.948,
  lon: 7.447,
};

// Bbox locale autour du centre-ville (≈5×4.4 km).
// Couvre la vieille ville UNESCO, le Bundeshaus, Marzili, Lorraine, Länggasse.
// Exclut les grandes banlieues ouest hors du noyau historique.
export const BERN_LOCAL_BBOX: BBox = [7.42, 46.93, 7.48, 46.97];

// Même rayon que les autres régions : 120 km couvre Jura, Préalpes bernoises,
// massifs alpins voisins susceptibles de rétroprojeter des horizons.
export const BERN_HORIZON_RADIUS_KM = 120;

export const BERN_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  BERN_CENTER.lon,
  BERN_CENTER.lat,
  BERN_HORIZON_RADIUS_KM,
);

export const BERN_CONFIG = {
  center: BERN_CENTER,
  localBbox: BERN_LOCAL_BBOX,
  horizonBbox: BERN_HORIZON_BBOX,
  horizonRadiusKm: BERN_HORIZON_RADIUS_KM,
} as const;
