import { NextResponse } from "next/server";

import { loadAllPlaces } from "@/lib/places/lausanne-places";

export const runtime = "nodejs";

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
  /** Nominatim bounding box `[minLon, minLat, maxLon, maxLat]` — used to fitBounds for cities/regions. */
  bbox?: [number, number, number, number];
}

const LAKE_GENEVA_VIEWBOX = "5.85,46.70,7.05,46.10";

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

  const localSuggestions: Suggestion[] = scored.slice(0, limit).map(({ place }) => ({
    id: place.id,
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    category: place.category,
    subcategory: place.subcategory,
    hasOutdoorSeating: place.hasOutdoorSeating,
    source: "local",
    // OSM tags already carry locality info — no schema change to the places JSON.
    // Order: `addr:city` is the canonical hit; fall back to `addr:suburb`
    // (used for districts like "Maupas" in Lausanne), then `addr:place` for
    // hamlets.
    locality:
      place.tags["addr:city"] ??
      place.tags["addr:suburb"] ??
      place.tags["addr:place"] ??
      undefined,
  }));

  // If the local dataset has no match (typical for city/commune queries like
  // "Renens" or "Lutry"), fall back to Nominatim so the typeahead still works
  // for geographic place names. Local is always preferred when present —
  // bars/restaurants are higher signal in this app's context.
  if (localSuggestions.length === 0) {
    const geo = await fetchNominatimSuggestions(query, limit);
    return NextResponse.json({ query, suggestions: geo });
  }

  return NextResponse.json({ query, suggestions: localSuggestions });
}
