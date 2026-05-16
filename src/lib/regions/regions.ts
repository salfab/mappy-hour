/**
 * Client-safe region metadata: bounding boxes and the canonical list of
 * regions we have precomputed sunlight coverage for.
 *
 * Extracted from `src/lib/precompute/sunlight-cache.ts` because that module
 * imports `node:fs`, `node:zlib` and `@/lib/storage/data-paths` (server-only)
 * and thus cannot be pulled into the client bundle. Anything that only needs
 * the bbox / name lookups (browser geolocation, region pickers, etc.) should
 * import from here directly.
 *
 * No server imports allowed in this file — keep it strictly dependent on
 * the pure `@/lib/config/*` modules.
 */

import { LAUSANNE_CONFIG } from "@/lib/config/lausanne";
import { NYON_CONFIG } from "@/lib/config/nyon";
import { MORGES_CONFIG } from "@/lib/config/morges";
import { GENEVE_CONFIG } from "@/lib/config/geneve";
import { VEVEY_CONFIG } from "@/lib/config/vevey";
import { VEVEY_CITY_CONFIG } from "@/lib/config/vevey_city";
import { NEUCHATEL_CONFIG } from "@/lib/config/neuchatel";
import { LA_CHAUX_DE_FONDS_CONFIG } from "@/lib/config/la_chaux_de_fonds";
import { BERN_CONFIG } from "@/lib/config/bern";
import { ZURICH_CONFIG } from "@/lib/config/zurich";
import { THUN_CONFIG } from "@/lib/config/thun";

export type PrecomputedRegionName =
  | "lausanne"
  | "nyon"
  | "morges"
  | "geneve"
  | "vevey"
  | "vevey_city"
  | "neuchatel"
  | "la_chaux_de_fonds"
  | "bern"
  | "zurich"
  | "thun";

export interface RegionBbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export const REGION_BBOXES: Record<PrecomputedRegionName, RegionBbox> = {
  lausanne: {
    minLon: LAUSANNE_CONFIG.localBbox[0],
    minLat: LAUSANNE_CONFIG.localBbox[1],
    maxLon: LAUSANNE_CONFIG.localBbox[2],
    maxLat: LAUSANNE_CONFIG.localBbox[3],
  },
  nyon: {
    minLon: NYON_CONFIG.localBbox[0],
    minLat: NYON_CONFIG.localBbox[1],
    maxLon: NYON_CONFIG.localBbox[2],
    maxLat: NYON_CONFIG.localBbox[3],
  },
  morges: {
    minLon: MORGES_CONFIG.localBbox[0],
    minLat: MORGES_CONFIG.localBbox[1],
    maxLon: MORGES_CONFIG.localBbox[2],
    maxLat: MORGES_CONFIG.localBbox[3],
  },
  geneve: {
    minLon: GENEVE_CONFIG.localBbox[0],
    minLat: GENEVE_CONFIG.localBbox[1],
    maxLon: GENEVE_CONFIG.localBbox[2],
    maxLat: GENEVE_CONFIG.localBbox[3],
  },
  vevey: {
    minLon: VEVEY_CONFIG.localBbox[0],
    minLat: VEVEY_CONFIG.localBbox[1],
    maxLon: VEVEY_CONFIG.localBbox[2],
    maxLat: VEVEY_CONFIG.localBbox[3],
  },
  vevey_city: {
    minLon: VEVEY_CITY_CONFIG.localBbox[0],
    minLat: VEVEY_CITY_CONFIG.localBbox[1],
    maxLon: VEVEY_CITY_CONFIG.localBbox[2],
    maxLat: VEVEY_CITY_CONFIG.localBbox[3],
  },
  neuchatel: {
    minLon: NEUCHATEL_CONFIG.localBbox[0],
    minLat: NEUCHATEL_CONFIG.localBbox[1],
    maxLon: NEUCHATEL_CONFIG.localBbox[2],
    maxLat: NEUCHATEL_CONFIG.localBbox[3],
  },
  la_chaux_de_fonds: {
    minLon: LA_CHAUX_DE_FONDS_CONFIG.localBbox[0],
    minLat: LA_CHAUX_DE_FONDS_CONFIG.localBbox[1],
    maxLon: LA_CHAUX_DE_FONDS_CONFIG.localBbox[2],
    maxLat: LA_CHAUX_DE_FONDS_CONFIG.localBbox[3],
  },
  bern: {
    minLon: BERN_CONFIG.localBbox[0],
    minLat: BERN_CONFIG.localBbox[1],
    maxLon: BERN_CONFIG.localBbox[2],
    maxLat: BERN_CONFIG.localBbox[3],
  },
  zurich: {
    minLon: ZURICH_CONFIG.localBbox[0],
    minLat: ZURICH_CONFIG.localBbox[1],
    maxLon: ZURICH_CONFIG.localBbox[2],
    maxLat: ZURICH_CONFIG.localBbox[3],
  },
  thun: {
    minLon: THUN_CONFIG.localBbox[0],
    minLat: THUN_CONFIG.localBbox[1],
    maxLon: THUN_CONFIG.localBbox[2],
    maxLat: THUN_CONFIG.localBbox[3],
  },
};

export function getPrecomputedRegionBbox(region: PrecomputedRegionName): RegionBbox {
  return REGION_BBOXES[region];
}

/**
 * Names of every region we have precomputed sunlight coverage for. Frozen so
 * callers cannot mutate the source-of-truth list. Order is informative
 * (Lausanne first = historical default region used as map fallback).
 */
export const PRECOMPUTED_REGION_NAMES: readonly PrecomputedRegionName[] = Object.freeze([
  "lausanne",
  "nyon",
  "morges",
  "geneve",
  "vevey",
  "vevey_city",
  "neuchatel",
  "la_chaux_de_fonds",
  "bern",
  "zurich",
  "thun",
] as const);

/**
 * Returns the (lat, lon) → containing region for any supported region, or
 * `null` if the point is outside every region's bounding box. Used client-side
 * to decide whether a browser geolocation result should drive the initial map
 * center (and which fallback to use otherwise).
 *
 * Bbox containment is intentionally permissive — we accept any point within
 * a region's `localBbox`, even if no atlas tile covers it precisely. The map
 * center will simply land on the user's position; tile coverage is handled
 * separately by the overlay code.
 */
export function findContainingPrecomputedRegion(
  lat: number,
  lon: number,
): PrecomputedRegionName | null {
  for (const region of PRECOMPUTED_REGION_NAMES) {
    const bbox = REGION_BBOXES[region];
    if (
      lon >= bbox.minLon &&
      lon <= bbox.maxLon &&
      lat >= bbox.minLat &&
      lat <= bbox.maxLat
    ) {
      return region;
    }
  }
  return null;
}
