import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

// Ville de Thoune (centre urbain — vieille ville, île entre les bras de l'Aar,
// rive nord du Thunersee). Commune BFS 942, wikidata Q68978, OSM relation
// 1682682. Bbox locale serrée (~4.6×4.4 km) ; le précompute intersecte ensuite
// le polygone commune avec cette bbox + filtre le Thunersee.
export const THUN_CENTER = {
  lat: 46.76,
  lon: 7.629,
};

// Bbox locale autour du centre-ville (≈5×5 km).
// Couvre la vieille ville, l'île entre les deux bras de l'Aar, et la rive nord
// du Thunersee. Exclut les quartiers ruraux périphériques de la commune.
// Étendue 2026-05-13 (W + S) pour inclure 5 tuiles de la sélection top-priority
// hors bbox d'origine (commit feature/maplibre-migration).
export const THUN_LOCAL_BBOX: BBox = [7.5986, 46.7347, 7.66, 46.78];

// Même rayon que les autres régions : 120 km couvre l'Eiger, le Mönch, la
// Jungfrau, les Préalpes bernoises et l'arc alpin proche.
export const THUN_HORIZON_RADIUS_KM = 120;

export const THUN_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  THUN_CENTER.lon,
  THUN_CENTER.lat,
  THUN_HORIZON_RADIUS_KM,
);

export const THUN_CONFIG = {
  center: THUN_CENTER,
  localBbox: THUN_LOCAL_BBOX,
  horizonBbox: THUN_HORIZON_BBOX,
  horizonRadiusKm: THUN_HORIZON_RADIUS_KM,
} as const;
