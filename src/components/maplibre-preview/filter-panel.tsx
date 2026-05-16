"use client";

export interface CategoryFilters {
  cafe: boolean;
  bar: boolean;
  restaurant: boolean;
  other: boolean;
}

export const DEFAULT_FILTERS: CategoryFilters = {
  cafe: true,
  bar: true,
  restaurant: true,
  other: true,
};

interface FilterPanelProps {
  filters: CategoryFilters;
  onChange: (next: CategoryFilters) => void;
}

interface Chip {
  key: keyof CategoryFilters;
  label: string;
  emoji: string;
}

const CHIPS: Chip[] = [
  { key: "cafe",       label: "Cafés",       emoji: "☕" },
  { key: "bar",        label: "Bars",        emoji: "🍺" },
  { key: "restaurant", label: "Restos",      emoji: "🍴" },
  { key: "other",      label: "Autres",      emoji: "📍" },
];

export function FilterPanel({ filters, onChange }: FilterPanelProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CHIPS.map((c) => {
        const active = filters[c.key];
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onChange({ ...filters, [c.key]: !active })}
            className={
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition " +
              (active
                ? "bg-amber-100/80 text-amber-900 ring-1 ring-amber-200/70"
                : "bg-white/60 text-stone-400 ring-1 ring-amber-100/60 hover:bg-amber-50/80")
            }
            aria-pressed={active}
          >
            <span>{c.emoji}</span>
            <span>{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Map a place subcategory + category onto a chip key, so filters work
 *  even when subcategory is missing or unexpected. */
export function placeChipKey(
  _category: string,
  subcategory: string,
): keyof CategoryFilters {
  switch (subcategory) {
    case "cafe":        return "cafe";
    case "bar":
    case "pub":
    case "biergarten":  return "bar";
    case "restaurant":  return "restaurant";
    case "fast_food":   return "other";
    default:            return "other";
  }
}
