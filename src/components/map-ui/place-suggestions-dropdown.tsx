"use client";

import { useEffect, useState } from "react";

export interface PlaceSuggestion {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: "park" | "terrace_candidate";
  subcategory: string;
  hasOutdoorSeating: boolean;
}

interface PlaceSuggestionsDropdownProps {
  query: string;
  /** Called when the user clicks a suggestion. */
  onSelect: (suggestion: PlaceSuggestion) => void;
  /** Visual variant — `floating` for mobile (under FloatingSearch) vs `inline` for desktop. */
  variant: "floating" | "inline";
  /** Optional CSS class for the wrapping container (positioning, z-index). */
  className?: string;
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
};

function formatLabel(suggestion: PlaceSuggestion): string {
  return SUBCATEGORY_LABEL[suggestion.subcategory] ?? suggestion.subcategory;
}

export function PlaceSuggestionsDropdown(props: PlaceSuggestionsDropdownProps) {
  const debouncedQuery = useDebouncedValue(props.query.trim(), 200);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [isVisible, setIsVisible] = useState(false);

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
          setIsVisible((data.suggestions ?? []).length > 0);
        }
      } catch {
        // Aborted or network error — leave previous state (will be cleared on next stroke)
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedQuery]);

  if (!isVisible || suggestions.length === 0) {
    return null;
  }

  const base = "z-[600] divide-y divide-slate-100 overflow-hidden rounded-2xl border border-white/70 bg-white/96 text-slate-900 shadow-2xl backdrop-blur";
  const positioning =
    props.variant === "floating"
      ? "absolute left-4 right-4 top-[68px] max-h-[60vh] overflow-y-auto"
      : "absolute left-0 top-[calc(100%+8px)] w-80 max-h-[60vh] overflow-y-auto";

  return (
    <ul className={`${base} ${positioning} ${props.className ?? ""}`} role="listbox">
      {suggestions.map((suggestion) => (
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
            <span className="text-sm font-semibold text-slate-950">{suggestion.name}</span>
            <span className="text-xs text-slate-500">{formatLabel(suggestion)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
