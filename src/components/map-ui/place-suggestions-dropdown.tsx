"use client";

import { useEffect, useState } from "react";

export interface PlaceSuggestion {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** `geo` = Nominatim fallback (cities, addresses); other values come from local dataset. */
  category: "park" | "terrace_candidate" | "geo";
  subcategory: string;
  hasOutdoorSeating: boolean;
  source: "local" | "nominatim";
  /** Best-effort city/suburb name (OSM `addr:city`/`addr:suburb` for local, address segment for Nominatim). */
  locality?: string;
  /**
   * Best-effort street (with house number when available) — used to disambiguate
   * homonyms in the dropdown (e.g. two "The Green Van Company" in Lausanne).
   */
  street?: string;
  /** Bounding box `[minLon, minLat, maxLon, maxLat]` — present for Nominatim city/town results. */
  bbox?: [number, number, number, number];
}

interface PlaceSuggestionsDropdownProps {
  query: string;
  /** Called when the user clicks a suggestion. */
  onSelect: (suggestion: PlaceSuggestion) => void;
  /** Visual variant — `floating` for mobile (under FloatingSearch) vs `inline` for desktop. */
  variant: "floating" | "inline";
  /** Optional CSS class for the wrapping container (positioning, z-index). */
  className?: string;
  /**
   * Increment to force the dropdown to hide (e.g. after the parent's submit/select handler).
   * The current `query` at the moment of the bump is memoized so a subsequent query change
   * required to re-open the dropdown — without this, `setSearchQuery(suggestion.name)`
   * after a select would re-fetch and re-show the same dropdown on the same value.
   */
  closeSignal?: number;
}

/** Tiny in-process debounce hook: returns `value` only after `delayMs` of stillness. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

const SUBCATEGORY_LABEL: Record<string, string> = {
  restaurant: "Restaurant",
  bar: "Bar",
  cafe: "Café",
  pub: "Pub",
  biergarten: "Biergarten",
  fast_food: "Fast-food",
  food_court: "Food court",
  park: "Parc",
  city: "Ville",
  town: "Ville",
  village: "Village",
  suburb: "Quartier",
  neighbourhood: "Quartier",
  hamlet: "Hameau",
  residential: "Quartier",
  administrative: "Commune",
};

function formatLabel(suggestion: PlaceSuggestion): string {
  if (suggestion.source === "nominatim") {
    return SUBCATEGORY_LABEL[suggestion.subcategory] ?? "Adresse";
  }
  return SUBCATEGORY_LABEL[suggestion.subcategory] ?? suggestion.subcategory;
}

export function PlaceSuggestionsDropdown(props: PlaceSuggestionsDropdownProps) {
  const debouncedQuery = useDebouncedValue(props.query.trim(), 200);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [isVisible, setIsVisible] = useState(false);
  const [lastClosedQuery, setLastClosedQuery] = useState<string | null>(null);

  // External close (parent bumps `closeSignal` after submit/select).
  // We memoize the query value at the moment of the close so the fetch effect
  // below doesn't re-open the dropdown on the exact same value: when the parent
  // does `setSearchQuery(suggestion.name)` then bumps closeSignal, the next
  // debounced fetch would otherwise re-show the dropdown with the same item.
  useEffect(() => {
    if (props.closeSignal === undefined) return;
    setIsVisible(false);
    setLastClosedQuery(props.query.trim());
    // Intentionally only depend on closeSignal; props.query is read at the time
    // of the close, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.closeSignal]);

  useEffect(() => {
    let cancelled = false;
    if (debouncedQuery.length < 2) {
      setSuggestions([]);
      setIsVisible(false);
      return;
    }

    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(
          `/api/places/suggest?q=${encodeURIComponent(debouncedQuery)}&limit=8`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          if (!cancelled) {
            setSuggestions([]);
            setIsVisible(false);
          }
          return;
        }
        const data = (await response.json()) as { suggestions?: PlaceSuggestion[] };
        if (!cancelled) {
          setSuggestions(data.suggestions ?? []);
          // Stay hidden if the current query is exactly the one we were just
          // explicitly closed on (typical post-select case).
          const shouldShow =
            (data.suggestions ?? []).length > 0 && debouncedQuery !== lastClosedQuery;
          setIsVisible(shouldShow);
        }
      } catch {
        // Aborted or network error — leave previous state (will be cleared on next stroke)
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedQuery, lastClosedQuery]);

  if (!isVisible || suggestions.length === 0) {
    return null;
  }

  // Detect homonyms — entries sharing the exact same `name` + `locality` pair
  // (including the "no locality" case where two venues with the same name both
  // lack `addr:city`). When such a collision exists, we append `street` to the
  // meta line of each colliding entry so the user can tell them apart.
  const collisionCounts = new Map<string, number>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.name}|${suggestion.locality ?? ""}`;
    collisionCounts.set(key, (collisionCounts.get(key) ?? 0) + 1);
  }
  const collidingKeys = new Set<string>();
  for (const [key, count] of collisionCounts) {
    if (count > 1) collidingKeys.add(key);
  }

  const base = "z-[600] divide-y divide-slate-100 overflow-hidden rounded-2xl border border-white/70 bg-white/96 text-slate-900 shadow-2xl backdrop-blur";
  const positioning =
    props.variant === "floating"
      ? "absolute left-4 right-4 top-[68px] max-h-[60vh] overflow-y-auto"
      : "absolute left-0 top-[calc(100%+8px)] w-80 max-h-[60vh] overflow-y-auto";

  return (
    <ul className={`${base} ${positioning} ${props.className ?? ""}`} role="listbox">
      {suggestions.map((suggestion) => {
        const collisionKey = `${suggestion.name}|${suggestion.locality ?? ""}`;
        const isColliding = collidingKeys.has(collisionKey);
        // Show street only when we actually need to disambiguate AND we have it.
        // Silent fallback when we don't (no `(commune inconnue)` noise — the
        // homonym remains ambiguous, which is honest given missing data).
        const showStreet = isColliding && Boolean(suggestion.street);
        return (
          <li key={suggestion.id}>
            <button
              type="button"
              role="option"
              aria-selected="false"
              className="flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left transition hover:bg-amber-50 focus:bg-amber-100 focus:outline-none"
              onMouseDown={(event) => {
                // mousedown (not click) so the button fires before the input's blur
                // tears the dropdown down via focus-out.
                event.preventDefault();
                props.onSelect(suggestion);
                setIsVisible(false);
              }}
            >
              <span className="w-full truncate text-sm font-semibold text-slate-950">
                {suggestion.name}
              </span>
              <span className="w-full truncate text-xs text-slate-500">
                {formatLabel(suggestion)}
                {suggestion.locality ? ` · ${suggestion.locality}` : null}
                {showStreet ? ` · ${suggestion.street}` : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
