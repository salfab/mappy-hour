"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  PlaceSuggestionsDropdown,
  type PlaceSuggestion,
} from "@/components/map-ui/place-suggestions-dropdown";

// Same value as the Leaflet client: zoom 19 lands at street level with the
// surrounding tiles visible, without over-zooming a city bbox.
const SUGGESTION_TARGET_ZOOM = 19;

interface SearchPanelProps {
  mapRef: RefObject<MapLibreMap | null>;
}

function flyToBbox(map: MapLibreMap, bbox: [number, number, number, number]) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  map.fitBounds(
    [[minLon, minLat], [maxLon, maxLat]],
    { padding: 40, animate: true, maxZoom: SUGGESTION_TARGET_ZOOM },
  );
}

function flyToPoint(map: MapLibreMap, lon: number, lat: number) {
  map.flyTo({
    center: [lon, lat],
    zoom: Math.max(map.getZoom(), SUGGESTION_TARGET_ZOOM),
    animate: true,
  });
}

export function SearchPanel({ mapRef }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeSignal, setCloseSignal] = useState(0);

  const submit = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      const result = (await response.json().catch(() => null)) as {
        lat?: number; lon?: number; bbox?: [number, number, number, number]; error?: string;
      } | null;
      if (!response.ok || !result?.lat || !result?.lon) {
        throw new Error(result?.error ?? "Aucun résultat trouvé.");
      }
      const map = mapRef.current;
      if (map) {
        if (result.bbox) flyToBbox(map, result.bbox);
        else flyToPoint(map, result.lon, result.lat);
      }
      setCloseSignal((c) => c + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recherche impossible.");
    } finally {
      setIsLoading(false);
    }
  }, [query, mapRef]);

  const handleSelect = useCallback(
    (suggestion: PlaceSuggestion) => {
      const map = mapRef.current;
      if (map) {
        if (suggestion.bbox) flyToBbox(map, suggestion.bbox);
        else flyToPoint(map, suggestion.lon, suggestion.lat);
      }
      setQuery(suggestion.name);
      setError(null);
      setCloseSignal((c) => c + 1);
    },
    [mapRef],
  );

  // Close the dropdown on any pointerdown outside the search root.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-maplibre-search-root]")) {
        return;
      }
      setCloseSignal((c) => c + 1);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  return (
    <div className="relative" data-maplibre-search-root>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <input
          className="min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-amber-300"
          value={query}
          placeholder="Chercher une adresse ou un lieu"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="submit"
          className="rounded-full bg-amber-300 px-3 py-1.5 text-sm font-semibold text-slate-950 disabled:bg-slate-300 disabled:text-slate-500"
          disabled={isLoading || query.trim().length === 0}
        >
          {isLoading ? "…" : "OK"}
        </button>
      </form>
      {error ? (
        <p className="mt-1 px-1 text-xs text-rose-600">{error}</p>
      ) : null}
      <PlaceSuggestionsDropdown
        query={query}
        onSelect={handleSelect}
        variant="inline"
        closeSignal={closeSignal}
      />
    </div>
  );
}
