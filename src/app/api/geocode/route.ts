import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface NominatimResult {
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
  display_name?: string;
}

const LAKE_GENEVA_VIEWBOX = "5.85,46.70,7.05,46.10";

function parseBoundingBox(raw: NominatimResult["boundingbox"]) {
  if (!raw) {
    return null;
  }
  const [south, north, west, east] = raw.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) {
    return null;
  }
  return [west, south, east, north] as [number, number, number, number];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ error: "Missing query." }, { status: 400 });
  }

  const searchUrl = new URL("https://nominatim.openstreetmap.org/search");
  searchUrl.searchParams.set("format", "jsonv2");
  searchUrl.searchParams.set("limit", "1");
  searchUrl.searchParams.set("addressdetails", "0");
  searchUrl.searchParams.set("viewbox", LAKE_GENEVA_VIEWBOX);
  searchUrl.searchParams.set("bounded", "0");
  searchUrl.searchParams.set("q", query);

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": "mappy-hour/0.1 geocode",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    return NextResponse.json(
      { error: `Geocoding failed with HTTP ${response.status}.` },
      { status: 502 },
    );
  }

  const results = (await response.json()) as NominatimResult[];
  const first = results[0];
  if (!first) {
    return NextResponse.json({ error: "Aucun resultat trouve." }, { status: 404 });
  }

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "Invalid geocoding result." }, { status: 502 });
  }

  return NextResponse.json({
    lat,
    lon,
    bbox: parseBoundingBox(first.boundingbox),
    label: first.display_name ?? query,
  });
}
