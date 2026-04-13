import fs from "node:fs/promises";
import path from "node:path";

import { GENEVE_LOCAL_BBOX } from "../../src/lib/config/geneve";
import { bboxFromRadiusKm, type BBox, LAUSANNE_LOCAL_BBOX } from "../../src/lib/config/lausanne";
import { MORGES_LOCAL_BBOX } from "../../src/lib/config/morges";
import { NYON_LOCAL_BBOX } from "../../src/lib/config/nyon";
import { wgs84ToLv95 } from "../../src/lib/geo/projection";
import { loadPlacesByRegion, type PlacesFile } from "../../src/lib/places/lausanne-places";
import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "../../src/lib/precompute/constants";
import type { PrecomputedRegionName, RegionBbox } from "../../src/lib/precompute/sunlight-cache";
import { pointInBbox } from "../../src/lib/precompute/sunlight-cache";

interface Args {
  output: string;
  maxTilesPerArea: number;
  minTileScore: number;
  skipOverpass: boolean;
}

interface NormalizedPlace {
  id: string;
  name: string;
  category: "park" | "terrace_candidate";
  subcategory: string;
  hasOutdoorSeating: boolean;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat: number;
    lon: number;
  };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

interface TargetArea {
  id: string;
  label: string;
  region: PrecomputedRegionName;
  bbox: RegionBbox;
  source: "processed" | "overpass" | "manual";
  processedRegion?: "lausanne" | "nyon";
  notes?: string[];
  /** Limite de tuiles pour le profil top-priority, remplace le default global */
  maxTilesInTopPriority?: number;
  /** Tuiles forcées (source=manual) — incluses sans scoring */
  forcedTileIds?: string[];
  /** Tuiles à exclure même si elles seraient sélectionnées par scoring */
  excludeTileIds?: string[];
}

interface AreaTileStats {
  tileId: string;
  score: number;
  totalPlaces: number;
  parks: number;
  terraceCandidates: number;
  outdoorSeating: number;
  placeNames: string[];
}

interface GlobalTileAccumulator {
  region: PrecomputedRegionName;
  tileId: string;
  targetAreaIds: Set<string>;
  targetAreaLabels: Set<string>;
  placeIds: Set<string>;
  samplePlaceNames: Set<string>;
  parks: number;
  terraceCandidates: number;
  outdoorSeating: number;
  score: number;
  subcategories: Map<string, number>;
}

const DEFAULT_OUTPUT_PATH = path.join(
  process.cwd(),
  "data",
  "processed",
  "precompute",
  "high-value-tile-selection.json",
);

const DEFAULT_MAX_TILES_PER_AREA = 16;
const DEFAULT_MIN_TILE_SCORE = 4;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const TARGET_AREAS: TargetArea[] = [
  {
    id: "lausanne",
    label: "Lausanne",
    region: "lausanne",
    bbox: toRegionBbox(LAUSANNE_LOCAL_BBOX),
    source: "processed",
    processedRegion: "lausanne",
  },
  {
    id: "renens",
    label: "Renens",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.5889, 46.5394, 2.0)),
    source: "processed",
    processedRegion: "lausanne",
    notes: ["Sous-zone prioritaire a l'ouest de Lausanne"],
  },
  {
    id: "lausanne-montbenon",
    label: "Lausanne - Montbenon",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.6265, 46.5218, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Esplanade de Montbenon, terrasses panoramiques"],
  },
  {
    id: "lausanne-ouchy",
    label: "Lausanne - Ouchy",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.6317, 46.5072, 0.6)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Port d'Ouchy, rives du lac"],
  },
  {
    id: "lausanne-bourget",
    label: "Lausanne - Parc du Bourget",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.6183, 46.5073, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Parc du Bourget, promenade riveraine"],
  },
  {
    id: "lausanne-vidy",
    label: "Lausanne - Pyramides de Vidy",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.5965, 46.5130, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Parc de Vidy, Pyramides de Vidy"],
  },
  {
    id: "lausanne-hermitage",
    label: "Lausanne - Hermitage",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.6427, 46.5378, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Fondation de l'Hermitage, parc arbore"],
  },
  {
    id: "lausanne-montelly",
    label: "Lausanne - Parc de Montelly",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.6143, 46.5372, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Parc de Montelly, quartier Montelly"],
  },
  {
    id: "lausanne-milan",
    label: "Lausanne - Parc de Milan",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.6218, 46.5274, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Parc de Milan, quartier Sebeillon/Prelaz"],
  },
  {
    id: "lausanne-tunnel",
    label: "Lausanne - Zoo Burger / L'Ours",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.6327, 46.5210, 0.4)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Place du Tunnel, Zoo Burger, L'Ours"],
  },
  // ── Tuiles manuelles — sélection explicite pour couverture complète ───────────
  {
    id: "lausanne-waterfront",
    label: "Lausanne - Zone couverte (manuel)",
    region: "lausanne",
    bbox: toRegionBbox(LAUSANNE_LOCAL_BBOX),
    source: "manual",
    maxTilesInTopPriority: 143,
    notes: ["Sélection manuelle couvrant l'ensemble de Lausanne et du front lacustre"],
    forcedTileIds: [
      "e2537250_n1151000_s250","e2537500_n1151000_s250","e2537500_n1150750_s250",
      "e2537750_n1151000_s250","e2538000_n1151000_s250","e2538250_n1151000_s250",
      "e2538250_n1150750_s250","e2538500_n1150750_s250","e2538750_n1150750_s250",
      "e2538500_n1151000_s250","e2537250_n1151750_s250","e2537250_n1151500_s250",
      "e2537500_n1151500_s250","e2537500_n1151750_s250","e2537000_n1151750_s250",
      "e2536750_n1151250_s250","e2536250_n1151500_s250","e2536500_n1151250_s250",
      "e2535750_n1151500_s250","e2536000_n1151750_s250","e2536250_n1151750_s250",
      "e2535750_n1151750_s250","e2535500_n1151750_s250","e2535250_n1152000_s250",
      "e2535500_n1152000_s250","e2535750_n1152500_s250","e2535500_n1152500_s250",
      "e2536000_n1152500_s250","e2536000_n1152250_s250","e2535750_n1152250_s250",
      "e2535750_n1152000_s250","e2536000_n1152000_s250","e2535000_n1152000_s250",
      "e2534500_n1152250_s250","e2534750_n1152250_s250","e2534500_n1152000_s250",
      "e2535000_n1152250_s250","e2535500_n1152250_s250","e2538000_n1151250_s250",
      "e2537750_n1151250_s250","e2537500_n1151250_s250","e2537750_n1151750_s250",
      "e2537750_n1151500_s250","e2538750_n1152250_s250","e2539000_n1152000_s250",
      "e2539000_n1152250_s250","e2538750_n1152000_s250","e2537500_n1152250_s250",
      "e2537750_n1152250_s250","e2537500_n1152500_s250","e2537250_n1152250_s250",
      "e2537250_n1152500_s250","e2537500_n1152000_s250","e2537250_n1152000_s250",
      "e2536750_n1152250_s250","e2536500_n1152250_s250","e2538500_n1153250_s250",
      "e2538250_n1153000_s250","e2538500_n1153000_s250","e2538250_n1153250_s250",
      "e2538500_n1153500_s250","e2538250_n1152500_s250","e2538250_n1152750_s250",
      "e2538000_n1152750_s250","e2538500_n1152750_s250","e2538500_n1152500_s250",
      "e2538000_n1152250_s250","e2538250_n1152250_s250","e2538000_n1152000_s250",
      "e2538500_n1152000_s250","e2538250_n1152000_s250","e2538750_n1151000_s250",
      "e2538750_n1151250_s250","e2538500_n1151250_s250","e2538000_n1151500_s250",
      "e2538000_n1151750_s250","e2538250_n1151750_s250","e2538250_n1151500_s250",
      "e2538500_n1151500_s250","e2538500_n1151750_s250","e2538750_n1151500_s250",
      "e2538750_n1151750_s250","e2538750_n1152500_s250","e2538500_n1154000_s250",
      "e2537250_n1152750_s250","e2537500_n1152750_s250","e2537500_n1153000_s250",
      "e2537750_n1153000_s250","e2538000_n1153000_s250","e2537000_n1152250_s250",
      "e2537000_n1152500_s250","e2536750_n1152500_s250","e2537000_n1152750_s250",
      "e2536750_n1152750_s250","e2536500_n1151750_s250","e2536750_n1151750_s250",
      "e2536250_n1152000_s250","e2536500_n1152000_s250","e2536750_n1152000_s250",
      "e2537000_n1152000_s250","e2536250_n1152250_s250","e2536250_n1152500_s250",
      "e2536500_n1152500_s250","e2535500_n1152750_s250","e2535750_n1152750_s250",
      "e2536000_n1152750_s250","e2536250_n1152750_s250","e2536500_n1152750_s250",
      "e2536250_n1153250_s250","e2536500_n1153250_s250","e2536500_n1153000_s250",
      "e2536000_n1153000_s250","e2536250_n1153500_s250","e2536500_n1153500_s250",
      "e2536750_n1153000_s250","e2537000_n1153000_s250","e2536750_n1153250_s250",
      "e2537000_n1153250_s250","e2536000_n1153250_s250","e2535250_n1152250_s250",
      "e2534750_n1152000_s250","e2533750_n1152250_s250","e2533750_n1152000_s250",
      "e2534000_n1152250_s250","e2534250_n1152250_s250","e2534250_n1152000_s250",
      "e2534000_n1152000_s250","e2532250_n1151000_s250","e2532500_n1151000_s250",
      "e2532250_n1151250_s250","e2531250_n1151000_s250","e2531000_n1151000_s250",
      "e2531250_n1151250_s250","e2531000_n1151250_s250","e2531500_n1151250_s250",
      "e2531750_n1151250_s250","e2532000_n1151250_s250","e2532000_n1151000_s250",
      "e2531500_n1151000_s250","e2531750_n1151000_s250",
      // ajout 2026-04-10
      "e2536750_n1151500_s250","e2537000_n1151500_s250","e2537000_n1151250_s250",
      "e2537250_n1151250_s250","e2537000_n1151000_s250","e2536000_n1151500_s250",
      "e2535500_n1151500_s250","e2533000_n1152250_s250","e2533250_n1152250_s250",
      "e2533250_n1152500_s250","e2532750_n1152250_s250","e2532750_n1152500_s250",
      "e2532500_n1152000_s250","e2532750_n1152000_s250","e2533000_n1152000_s250",
      "e2533250_n1152000_s250","e2533500_n1152000_s250","e2533500_n1151750_s250",
    ],
  },
  // Les tuiles entièrement dans le lac ne peuvent pas apparaître ici :
  // le scoring est basé sur les lieux OSM, et il n'y en a pas dans le lac.
  {
    id: "lausanne-st-sulpice",
    label: "Lausanne - St-Sulpice",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.558, 46.511, 0.8)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Village lacustre de St-Sulpice, plage"],
  },
  {
    id: "lausanne-vidy-quai",
    label: "Lausanne - Quai de Vidy",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.606, 46.510, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Quai de Vidy, Camping Vidy, entre Vidy et Bourget"],
  },
  {
    id: "lausanne-bellerive",
    label: "Lausanne - Bellerive",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.647, 46.512, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Quai de Bellerive, plage est de Lausanne"],
  },
  // ── Quartiers nord / centre ──────────────────────────────────────────────────
  {
    id: "lausanne-malley",
    label: "Lausanne - Malley",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.607, 46.530, 0.7)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Quartier Malley, zone de renouvellement urbain, stade"],
  },
  {
    id: "lausanne-mon-repos",
    label: "Lausanne - Mon-Repos",
    region: "lausanne",
    bbox: toRegionBbox(bboxFromRadiusKm(6.643, 46.521, 0.5)),
    source: "processed",
    processedRegion: "lausanne",
    maxTilesInTopPriority: 1,
    notes: ["Parc Mon-Repos, quartier du Tribunal federal"],
  },
  {
    id: "morges",
    label: "Morges",
    region: "morges",
    bbox: toRegionBbox(MORGES_LOCAL_BBOX),
    source: "overpass",
  },
  {
    id: "morges-waterfront",
    label: "Morges - Front lacustre (manuel)",
    region: "morges",
    bbox: toRegionBbox(MORGES_LOCAL_BBOX),
    source: "manual",
    maxTilesInTopPriority: 8,
    notes: ["Tuiles manuelles couvrant le front lacustre de Morges"],
    forcedTileIds: [
      "e2527000_n1150750_s250","e2527250_n1150750_s250","e2527250_n1150500_s250",
      "e2527500_n1150750_s250","e2527500_n1151250_s250","e2527500_n1151000_s250",
      "e2527250_n1151000_s250","e2527250_n1151250_s250",
    ],
  },
  {
    id: "nyon",
    label: "Nyon",
    region: "nyon",
    bbox: toRegionBbox(NYON_LOCAL_BBOX),
    source: "processed",
    processedRegion: "nyon",
  },
  {
    id: "geneve",
    label: "Geneve",
    region: "geneve",
    bbox: toRegionBbox(GENEVE_LOCAL_BBOX),
    source: "overpass",
    excludeTileIds: [
      // Annemasse (France) — hors périmètre
      "e2507000_n1116750_s250",
      "e2507000_n1116500_s250",
    ],
  },
];

function parseArgs(argv: string[]): Args {
  const result: Args = {
    output: DEFAULT_OUTPUT_PATH,
    maxTilesPerArea: DEFAULT_MAX_TILES_PER_AREA,
    minTileScore: DEFAULT_MIN_TILE_SCORE,
    skipOverpass: false,
  };

  for (const arg of argv) {
    if (arg === "--skip-overpass") {
      result.skipOverpass = true;
      continue;
    }
    if (arg.startsWith("--output=")) {
      result.output = path.resolve(process.cwd(), arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--max-tiles-per-area=")) {
      const parsed = Number(arg.slice("--max-tiles-per-area=".length));
      if (Number.isInteger(parsed) && parsed >= 1) {
        result.maxTilesPerArea = parsed;
      }
      continue;
    }
    if (arg.startsWith("--min-tile-score=")) {
      const parsed = Number(arg.slice("--min-tile-score=".length));
      if (Number.isFinite(parsed) && parsed >= 0) {
        result.minTileScore = parsed;
      }
    }
  }

  return result;
}

function toRegionBbox(bbox: BBox): RegionBbox {
  return {
    minLon: bbox[0],
    minLat: bbox[1],
    maxLon: bbox[2],
    maxLat: bbox[3],
  };
}

function buildOverpassQuery(bbox: RegionBbox): string {
  const bboxString = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  return `
[out:json][timeout:120];
(
  node["leisure"="park"](${bboxString});
  way["leisure"="park"](${bboxString});
  relation["leisure"="park"](${bboxString});
  node["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bboxString});
  way["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bboxString});
  relation["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bboxString});
);
out center tags;
  `.trim();
}

function getCoordinates(element: OverpassElement): { lat: number; lon: number } | null {
  if (element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lon: element.lon };
  }
  if (element.center?.lat !== undefined && element.center?.lon !== undefined) {
    return { lat: element.center.lat, lon: element.center.lon };
  }
  return null;
}

function normalizeOverpassPlace(element: OverpassElement): NormalizedPlace | null {
  const tags = element.tags ?? {};
  const coordinates = getCoordinates(element);
  if (!coordinates) {
    return null;
  }

  const amenity = tags.amenity;
  const leisure = tags.leisure;
  let category: NormalizedPlace["category"] | null = null;
  let subcategory = "unknown";

  if (leisure === "park") {
    category = "park";
    subcategory = "park";
  } else if (
    amenity === "cafe" ||
    amenity === "bar" ||
    amenity === "pub" ||
    amenity === "restaurant" ||
    amenity === "biergarten" ||
    amenity === "fast_food" ||
    amenity === "food_court"
  ) {
    category = "terrace_candidate";
    subcategory = amenity;
  }

  if (!category) {
    return null;
  }

  const hasOutdoorSeating =
    tags.outdoor_seating === "yes" ||
    tags.terrace === "yes" ||
    tags.garden === "yes";

  return {
    id: `osm:${element.type}:${element.id}`,
    name: tags.name ?? `${subcategory}-${element.type}-${element.id}`,
    category,
    subcategory,
    hasOutdoorSeating,
    lat: Math.round(coordinates.lat * 1_000_000) / 1_000_000,
    lon: Math.round(coordinates.lon * 1_000_000) / 1_000_000,
    tags,
  };
}

async function fetchOverpassPlaces(area: TargetArea): Promise<NormalizedPlace[]> {
  const query = buildOverpassQuery(area.bbox);
  let lastError: unknown = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: `data=${encodeURIComponent(query)}`,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${endpoint}`);
      }

      const payload = (await response.json()) as OverpassResponse;
      return payload.elements
        .map(normalizeOverpassPlace)
        .filter((place): place is NormalizedPlace => place !== null);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `All Overpass endpoints failed for ${area.id}. Last error: ${
      lastError instanceof Error ? lastError.message : "Unknown error"
    }`,
  );
}

function toNormalizedPlaces(file: PlacesFile): NormalizedPlace[] {
  return file.places.map((place: PlacesFile["places"][number]) => ({
    id: place.id,
    name: place.name,
    category: place.category,
    subcategory: place.subcategory,
    hasOutdoorSeating: place.hasOutdoorSeating,
    lat: place.lat,
    lon: place.lon,
    tags: place.tags,
  }));
}

async function loadPlacesForArea(area: TargetArea): Promise<NormalizedPlace[]> {
  if (area.source === "processed" && area.processedRegion) {
    const file = await loadPlacesByRegion(area.processedRegion);
    if (!file) {
      throw new Error(`Missing processed places dataset for region=${area.processedRegion}.`);
    }
    return toNormalizedPlaces(file).filter((place) => pointInBbox(place.lon, place.lat, area.bbox));
  }

  return fetchOverpassPlaces(area);
}

function scorePlace(place: NormalizedPlace): number {
  if (place.category === "park") {
    return 3;
  }

  let score = 2;
  if (place.hasOutdoorSeating) {
    score += 4;
  }
  if (
    place.subcategory === "bar" ||
    place.subcategory === "pub" ||
    place.subcategory === "biergarten"
  ) {
    score += 2;
  }
  if (place.subcategory === "cafe" || place.subcategory === "restaurant") {
    score += 1;
  }
  return score;
}

function tileIdForPlace(place: NormalizedPlace): string {
  const point = wgs84ToLv95(place.lon, place.lat);
  const tileSize = CANONICAL_PRECOMPUTE_TILE_SIZE_METERS;
  const minEasting = Math.floor(point.easting / tileSize) * tileSize;
  const minNorthing = Math.floor(point.northing / tileSize) * tileSize;
  return `e${Math.round(minEasting)}_n${Math.round(minNorthing)}_s${tileSize}`;
}

function compareAreaTileStats(left: AreaTileStats, right: AreaTileStats): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.outdoorSeating !== left.outdoorSeating) {
    return right.outdoorSeating - left.outdoorSeating;
  }
  if (right.terraceCandidates !== left.terraceCandidates) {
    return right.terraceCandidates - left.terraceCandidates;
  }
  if (right.parks !== left.parks) {
    return right.parks - left.parks;
  }
  return left.tileId.localeCompare(right.tileId);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const globalTiles = new Map<string, GlobalTileAccumulator>();
  const areaSummaries: Array<Record<string, unknown>> = [];
  const selectedTileKeys = new Set<string>();

  // When skipping overpass, carry forward existing overpass areas from the output file
  if (args.skipOverpass) {
    try {
      const existing = JSON.parse(await fs.readFile(args.output, "utf8")) as {
        areas: Array<Record<string, unknown>>;
        tiles: Array<{ region: string; tileId: string; [k: string]: unknown }>;
      };
      for (const area of existing.areas) {
        if (area.source === "overpass") {
          const areaConfig = TARGET_AREAS.find((a) => a.id === (area.id as string));
          const excluded = new Set(areaConfig?.excludeTileIds ?? []);
          const selectedTiles = area.selectedTiles as Array<{ tileId: string }> | undefined;
          const filteredTiles = excluded.size > 0
            ? (selectedTiles ?? []).filter((t) => !excluded.has(t.tileId))
            : (selectedTiles ?? []);
          areaSummaries.push({ ...area, selectedTiles: filteredTiles });
          for (const t of filteredTiles) {
            selectedTileKeys.add(`${area.region as string}:${t.tileId}`);
          }
        }
      }
      for (const tile of existing.tiles) {
        const key = `${tile.region}:${tile.tileId}`;
        if (selectedTileKeys.has(key)) {
          // Reconstruct a minimal GlobalTileAccumulator so the final map merge works
          globalTiles.set(key, {
            region: tile.region as PrecomputedRegionName,
            tileId: tile.tileId,
            targetAreaIds: new Set((tile.targetAreaIds as string[] | undefined) ?? []),
            targetAreaLabels: new Set((tile.targetAreaLabels as string[] | undefined) ?? []),
            placeIds: new Set(),
            samplePlaceNames: new Set((tile.samplePlaceNames as string[] | undefined) ?? []),
            parks: (tile.counts as { parks: number })?.parks ?? 0,
            terraceCandidates: (tile.counts as { terraceCandidates: number })?.terraceCandidates ?? 0,
            outdoorSeating: (tile.counts as { outdoorSeating: number })?.outdoorSeating ?? 0,
            score: tile.score as number,
            subcategories: new Map(
              Object.entries((tile.subcategories as Record<string, number> | undefined) ?? {}),
            ),
          });
        }
      }
      console.log(`[high-value-tiles] --skip-overpass: carried forward ${areaSummaries.length} overpass area(s) from existing file`);
    } catch {
      console.warn(`[high-value-tiles] --skip-overpass: could not read existing file, overpass areas will be empty`);
    }
  }

  for (const area of TARGET_AREAS) {
    if (args.skipOverpass && area.source === "overpass") {
      console.log(`[high-value-tiles] skipping overpass area: ${area.id}`);
      continue;
    }

    // Manual areas: forced tile list, no place scoring
    if (area.source === "manual" && area.forcedTileIds) {
      const emptyTile = (tileId: string) => ({
        tileId, score: 0, totalPlaces: 0, parks: 0, terraceCandidates: 0, outdoorSeating: 0, placeNames: [] as string[],
      });
      for (const tileId of area.forcedTileIds) {
        const tileKey = `${area.region}:${tileId}`;
        selectedTileKeys.add(tileKey);
        let globalStat = globalTiles.get(tileKey);
        if (!globalStat) {
          globalStat = {
            region: area.region, tileId,
            targetAreaIds: new Set<string>(),
            targetAreaLabels: new Set<string>(),
            placeIds: new Set<string>(),
            samplePlaceNames: new Set<string>(),
            parks: 0, terraceCandidates: 0, outdoorSeating: 0, score: 0,
            subcategories: new Map<string, number>(),
          };
          globalTiles.set(tileKey, globalStat);
        }
        globalStat.targetAreaIds.add(area.id);
        globalStat.targetAreaLabels.add(area.label);
      }
      areaSummaries.push({
        id: area.id, label: area.label, region: area.region, bbox: area.bbox, source: area.source,
        totalPlaces: 0, parks: 0, terraceCandidates: 0, outdoorSeating: 0,
        notes: area.notes ?? [],
        ...(area.maxTilesInTopPriority !== undefined ? { maxTilesInTopPriority: area.maxTilesInTopPriority } : {}),
        selectedTiles: area.forcedTileIds.map(emptyTile),
      });
      continue;
    }

    const places = await loadPlacesForArea(area);
    const areaTiles = new Map<string, AreaTileStats>();

    for (const place of places) {
      const tileId = tileIdForPlace(place);
      const tileKey = `${area.region}:${tileId}`;

      let areaStat = areaTiles.get(tileId);
      if (!areaStat) {
        areaStat = {
          tileId,
          score: 0,
          totalPlaces: 0,
          parks: 0,
          terraceCandidates: 0,
          outdoorSeating: 0,
          placeNames: [],
        };
        areaTiles.set(tileId, areaStat);
      }

      areaStat.score += scorePlace(place);
      areaStat.totalPlaces += 1;
      if (place.category === "park") {
        areaStat.parks += 1;
      } else {
        areaStat.terraceCandidates += 1;
      }
      if (place.hasOutdoorSeating) {
        areaStat.outdoorSeating += 1;
      }
      if (areaStat.placeNames.length < 8) {
        areaStat.placeNames.push(place.name);
      }

      let globalStat = globalTiles.get(tileKey);
      if (!globalStat) {
        globalStat = {
          region: area.region,
          tileId,
          targetAreaIds: new Set<string>(),
          targetAreaLabels: new Set<string>(),
          placeIds: new Set<string>(),
          samplePlaceNames: new Set<string>(),
          parks: 0,
          terraceCandidates: 0,
          outdoorSeating: 0,
          score: 0,
          subcategories: new Map<string, number>(),
        };
        globalTiles.set(tileKey, globalStat);
      }

      globalStat.targetAreaIds.add(area.id);
      globalStat.targetAreaLabels.add(area.label);

      if (!globalStat.placeIds.has(place.id)) {
        globalStat.placeIds.add(place.id);
        globalStat.score += scorePlace(place);
        globalStat.samplePlaceNames.add(place.name);
        if (place.category === "park") {
          globalStat.parks += 1;
        } else {
          globalStat.terraceCandidates += 1;
        }
        if (place.hasOutdoorSeating) {
          globalStat.outdoorSeating += 1;
        }
        globalStat.subcategories.set(
          place.subcategory,
          (globalStat.subcategories.get(place.subcategory) ?? 0) + 1,
        );
      }
    }

    const excluded = new Set(area.excludeTileIds ?? []);
    const rankedTiles = Array.from(areaTiles.values())
      .filter((tile) => !excluded.has(tile.tileId))
      .sort(compareAreaTileStats);
    const selectedTiles = rankedTiles
      .filter((tile) => tile.score >= args.minTileScore)
      .slice(0, args.maxTilesPerArea);
    const effectiveSelection =
      selectedTiles.length > 0
        ? selectedTiles
        : rankedTiles.slice(0, Math.min(args.maxTilesPerArea, rankedTiles.length));

    for (const tile of effectiveSelection) {
      selectedTileKeys.add(`${area.region}:${tile.tileId}`);
    }

    areaSummaries.push({
      id: area.id,
      label: area.label,
      region: area.region,
      bbox: area.bbox,
      source: area.source,
      totalPlaces: places.length,
      parks: places.filter((place) => place.category === "park").length,
      terraceCandidates: places.filter((place) => place.category === "terrace_candidate").length,
      outdoorSeating: places.filter((place) => place.hasOutdoorSeating).length,
      notes: area.notes ?? [],
      ...(area.maxTilesInTopPriority !== undefined
        ? { maxTilesInTopPriority: area.maxTilesInTopPriority }
        : {}),
      selectedTiles: effectiveSelection.map((tile) => ({
        tileId: tile.tileId,
        score: tile.score,
        totalPlaces: tile.totalPlaces,
        parks: tile.parks,
        terraceCandidates: tile.terraceCandidates,
        outdoorSeating: tile.outdoorSeating,
        samplePlaceNames: tile.placeNames,
      })),
    });
  }

  const tiles = Array.from(selectedTileKeys)
    .map((tileKey) => globalTiles.get(tileKey))
    .filter((tile): tile is GlobalTileAccumulator => tile !== undefined)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.outdoorSeating !== left.outdoorSeating) {
        return right.outdoorSeating - left.outdoorSeating;
      }
      if (right.terraceCandidates !== left.terraceCandidates) {
        return right.terraceCandidates - left.terraceCandidates;
      }
      if (right.parks !== left.parks) {
        return right.parks - left.parks;
      }
      return `${left.region}:${left.tileId}`.localeCompare(`${right.region}:${right.tileId}`);
    })
    .map((tile) => ({
      region: tile.region,
      tileId: tile.tileId,
      score: tile.score,
      targetAreaIds: Array.from(tile.targetAreaIds).sort(),
      targetAreaLabels: Array.from(tile.targetAreaLabels).sort(),
      counts: {
        totalPlaces: tile.placeIds.size,
        parks: tile.parks,
        terraceCandidates: tile.terraceCandidates,
        outdoorSeating: tile.outdoorSeating,
      },
      subcategories: Object.fromEntries(
        Array.from(tile.subcategories.entries()).sort((left, right) =>
          left[0].localeCompare(right[0]),
        ),
      ),
      samplePlaceNames: Array.from(tile.samplePlaceNames).sort().slice(0, 10),
      notes:
        tile.outdoorSeating > 0
          ? ["Contient au moins un lieu avec terrasse/outdoor seating explicite"]
          : [],
    }));

  const payload = {
    generatedAt: new Date().toISOString(),
    selectionVersion: 1,
    source: "processed regional places + live Overpass for missing regions",
    tileSizeMeters: CANONICAL_PRECOMPUTE_TILE_SIZE_METERS,
    selectionPolicy: {
      maxTilesPerArea: args.maxTilesPerArea,
      minTileScore: args.minTileScore,
      weights: {
        park: 3,
        terraceCandidateBase: 2,
        outdoorSeatingYes: 4,
        barPubBiergartenBonus: 2,
        cafeRestaurantBonus: 1,
      },
    },
    areas: areaSummaries,
    tiles,
  };

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `[high-value-tiles] wrote ${tiles.length} tiles across ${TARGET_AREAS.length} target areas to ${args.output}`,
  );
}

void main().catch((error) => {
  console.error(
    `[high-value-tiles] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});