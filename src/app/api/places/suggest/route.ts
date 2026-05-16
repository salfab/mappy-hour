import { NextResponse } from "next/server";

import { loadAllPlaces } from "@/lib/places/lausanne-places";

export const runtime = "nodejs";
// Always evaluate at request time — `q` is user input, no point caching the
// per-prefix response, and the underlying places dataset can change between
// container restarts (Posture 4 startup check).
export const dynamic = "force-dynamic";

type SuggestionSource = "local" | "nominatim";

interface Suggestion {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: "park" | "terrace_candidate" | "geo";
  subcategory: string;
  hasOutdoorSeating: boolean;
  source: SuggestionSource;
  /** Best-effort city/town name (OSM `addr:city`/`addr:suburb`, or Nominatim address segment). */
  locality?: string;
  /** OSM `addr:street` for local venues. Useful to disambiguate homonyms (e.g. multiple "The Green Van Company" branches). */
  street?: string;
  /** Nominatim bounding box `[minLon, minLat, maxLon, maxLat]` — used to fitBounds for cities/regions. */
  bbox?: [number, number, number, number];
}

const LAKE_GENEVA_VIEWBOX = "5.85,46.70,7.05,46.10";

/**
 * Last-resort locality fallback when an OSM venue has none of
 * `addr:{city,suburb,place,village}` — we derive a human-readable label
 * from the region slug the place was ingested under.
 *
 * Empirically ~70% of OSM places in our dataset have no `addr:*` tags
 * at all (audit 2026-05-16: 31% coverage on Lausanne, 24% on Geneva).
 * Without this fallback, the dropdown shows "The Green Van Company —
 * Fast-food" with no way to disambiguate between branches.
 *
 * The slug-to-label mapping mirrors the per-region configs in
 * `src/lib/config/{region}.ts` — kept inline because there's no
 * central registry yet.
 */
const REGION_LABEL: Record<string, string> = {
  lausanne: "Lausanne",
  geneve: "Genève",
  morges: "Morges",
  vevey: "Vevey",
  vevey_city: "Vevey",
  neuchatel: "Neuchâtel",
  la_chaux_de_fonds: "La Chaux-de-Fonds",
  bern: "Bern",
  zurich: "Zürich",
  thun: "Thun",
  nyon: "Nyon",
};

interface NominatimResult {
  place_id: number;
  lat: string;
  lon: string;
  display_name?: string;
  name?: string;
  type?: string;
  class?: string;
  addresstype?: string;
  /** Nominatim's bounding box is `[south, north, west, east]` as strings. */
  boundingbox?: [string, string, string, string];
}

function parseNominatimBbox(
  raw: NominatimResult["boundingbox"],
): [number, number, number, number] | undefined {
  if (!raw) return undefined;
  const [south, north, west, east] = raw.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return undefined;
  // Standardize on [minLon, minLat, maxLon, maxLat].
  return [west, south, east, north];
}

async function fetchNominatimSuggestions(query: string, limit: number): Promise<Suggestion[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("viewbox", LAKE_GENEVA_VIEWBOX);
  url.searchParams.set("bounded", "0");
  // Hard-restrict to Switzerland — a search for "morges" should never bring
  // up the French commune of "Morges-Mareyssac". The Lake Geneva viewbox
  // already biases toward CH results, but `countrycodes=ch` is a hard filter
  // (Nominatim drops anything else regardless of relevance score).
  url.searchParams.set("countrycodes", "ch");
  url.searchParams.set("q", query);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "mappy-hour/0.1 suggest",
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const results = (await response.json()) as NominatimResult[];
    return results
      .map<Suggestion | null>((result) => {
        const lat = Number(result.lat);
        const lon = Number(result.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        // Prefer the canonical short name; fall back to the first display_name segment.
        const segments = result.display_name?.split(",").map((s) => s.trim()) ?? [];
        const label = result.name?.trim() || segments[0] || result.display_name?.trim() || query;
        // The next segment after the name is usually the locality (suburb, city)
        // for points; for cities themselves it's the canton/region. Good enough.
        const locality = segments.length > 1 ? segments[1] : undefined;
        return {
          id: `nominatim-${result.place_id}`,
          name: label,
          lat,
          lon,
          category: "geo",
          subcategory: result.addresstype ?? result.type ?? result.class ?? "place",
          hasOutdoorSeating: false,
          source: "nominatim",
          locality,
          bbox: parseNominatimBbox(result.boundingbox),
        };
      })
      .filter((item): item is Suggestion => item !== null);
  } catch {
    // Timeout, DNS, parse error… → no suggestions, the local list still shows if any.
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/** Strip accents + lowercase. Used for accent-insensitive prefix matching. */
function normalize(value: string): string {
  // Strip combining diacritical marks (U+0300–U+036F).
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? "8")));

  // 2-char minimum: shorter prefixes flood the dropdown with low-signal hits.
  if (query.length < 2) {
    return NextResponse.json({ query, suggestions: [] satisfies Suggestion[] });
  }

  const placesFile = await loadAllPlaces();
  if (!placesFile) {
    return NextResponse.json({ query, suggestions: [] satisfies Suggestion[] });
  }

  const needle = normalize(query);

  // Score:
  //   3 = name starts with needle (best match — typing "rip" → "Riponne" wins)
  //   2 = a word inside the name starts with needle ("great" → "The Great Escape")
  //   1 = needle is a substring of the name (loosest)
  // Higher scores rank first; ties broken by lexicographic name order.
  const scored: Array<{ place: (typeof placesFile.places)[number]; score: number }> = [];
  for (const place of placesFile.places) {
    if (!place.name) continue;
    const hay = normalize(place.name);
    let score = 0;
    if (hay.startsWith(needle)) {
      score = 3;
    } else if (hay.split(/\s+/).some((word) => word.startsWith(needle))) {
      score = 2;
    } else if (hay.includes(needle)) {
      score = 1;
    }
    if (score > 0) {
      scored.push({ place, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.place.name.localeCompare(b.place.name));

  const localSuggestions: Suggestion[] = scored.slice(0, limit).map(({ place }) => {
    // OSM tags already carry locality info — no schema change to the places JSON.
    // Priority order: `addr:city` is canonical for venues in cities; fall
    // back to `addr:suburb` (districts like "Maupas" in Lausanne), then
    // `addr:place` (hamlets), then `addr:village` (small communes outside
    // cities). Empirically the last three are < 1% coverage combined in our
    // CH dataset, so the real coverage gain comes from the region fallback
    // below.
    const tagLocality =
      place.tags["addr:city"] ??
      place.tags["addr:suburb"] ??
      place.tags["addr:place"] ??
      place.tags["addr:village"] ??
      undefined;
    // Region-derived fallback: ~70% of OSM venues have no `addr:*` tags,
    // and "The Green Van Company — Fast-food" without a city is useless
    // when there's one in Lausanne and one in Geneva. Better to surface
    // the region label (which is itself a city/commune for our 11 covered
    // areas) than to leave it blank.
    const regionLocality =
      place.region && REGION_LABEL[place.region] ? REGION_LABEL[place.region] : undefined;
    return {
      id: place.id,
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      category: place.category,
      subcategory: place.subcategory,
      hasOutdoorSeating: place.hasOutdoorSeating,
      source: "local",
      locality: tagLocality ?? regionLocality,
      street: place.tags["addr:street"] ?? undefined,
    };
  });

  // Always query Nominatim in parallel — even when we have local hits, we
  // want city/commune names to surface (e.g. typing "renens" should show
  // "Le Monde Snack Renens" as a venue *and* "Renens" as a town). Cap each
  // source's contribution so neither dominates the dropdown:
  //   - Local: up to `limit` (full quota — venues are the app's primary signal)
  //   - Nominatim: up to 3 supplemental geographic hits, appended after locals
  //     and deduped against them by (lat,lon) proximity.
  const nominatimSlots = Math.min(3, limit);
  const geoSuggestions = await fetchNominatimSuggestions(query, nominatimSlots);

  const isDuplicate = (a: Suggestion, b: Suggestion) => {
    // ~50 m at lat 46 — tight enough to catch the same venue, loose enough
    // to merge a Nominatim point on top of a local venue.
    const dLat = Math.abs(a.lat - b.lat);
    const dLon = Math.abs(a.lon - b.lon);
    return dLat < 0.0005 && dLon < 0.0007;
  };
  const dedupedGeo = geoSuggestions.filter(
    (g) => !localSuggestions.some((l) => isDuplicate(g, l)),
  );

  const merged = [...localSuggestions, ...dedupedGeo].slice(0, limit);
  return NextResponse.json({ query, suggestions: merged });
}
