import { NextResponse } from "next/server";

import { loadAllPlaces } from "@/lib/places/lausanne-places";

export const runtime = "nodejs";

interface Suggestion {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: "park" | "terrace_candidate";
  subcategory: string;
  hasOutdoorSeating: boolean;
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

  const suggestions: Suggestion[] = scored.slice(0, limit).map(({ place }) => ({
    id: place.id,
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    category: place.category,
    subcategory: place.subcategory,
    hasOutdoorSeating: place.hasOutdoorSeating,
  }));

  return NextResponse.json({ query, suggestions });
}
