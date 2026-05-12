import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

// Ville de La Chaux-de-Fonds (centre urbain).
// La commune complète (~55 km², BFS 6421, wikidata Q68124, OSM relation
// 1685495) inclut une large bande de forêts/pâturages du Jura. On restreint
// volontairement la couverture au damier urbain + Eplatures + Le Crêt-du-Locle
// est (≈5×4 km) via une bbox locale étroite. Le précompute intersecte ensuite
// le polygone commune avec cette bbox pour éliminer les tuiles forestières.
export const LA_CHAUX_DE_FONDS_CENTER = {
  lat: 47.103,
  lon: 6.825,
};

// Bbox locale serrée autour du centre urbain (≈5×4 km).
// Couvre le damier historique (Place du Marché, Avenue Léopold-Robert), les
// Eplatures à l'ouest et la partie est de Le Crêt-du-Locle. Exclut la zone
// forestière qui constitue la majeure partie de la commune au sud et au nord.
// Cf. consigne projet : on ne précompute que le centre-ville, pas le Jura.
export const LA_CHAUX_DE_FONDS_LOCAL_BBOX: BBox = [6.79, 47.085, 6.86, 47.12];

// Même rayon que les autres régions : 120 km couvre Jura, Alpes bernoises et
// massifs voisins qui peuvent rétroprojeter des horizons sur le plateau.
export const LA_CHAUX_DE_FONDS_HORIZON_RADIUS_KM = 120;

export const LA_CHAUX_DE_FONDS_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  LA_CHAUX_DE_FONDS_CENTER.lon,
  LA_CHAUX_DE_FONDS_CENTER.lat,
  LA_CHAUX_DE_FONDS_HORIZON_RADIUS_KM,
);

export const LA_CHAUX_DE_FONDS_CONFIG = {
  center: LA_CHAUX_DE_FONDS_CENTER,
  localBbox: LA_CHAUX_DE_FONDS_LOCAL_BBOX,
  horizonBbox: LA_CHAUX_DE_FONDS_HORIZON_BBOX,
  horizonRadiusKm: LA_CHAUX_DE_FONDS_HORIZON_RADIUS_KM,
} as const;
