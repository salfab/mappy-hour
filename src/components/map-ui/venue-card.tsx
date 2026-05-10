"use client";

export type VenueType = "restaurant" | "bar" | "snack" | "foodtruck" | "other";

export interface VenueCardPlace {
  id: string;
  name: string;
  venueType: VenueType;
  lat: number;
  lon: number;
  evaluationLat?: number;
  evaluationLon?: number;
  selectionStrategy: "original" | "terrace_offset" | "indoor_fallback";
  selectionOffsetMeters: number;
  isSunnyNow: boolean | null;
  sunnyMinutes: number;
  sunlightStartLocalTime: string | null;
  sunlightEndLocalTime: string | null;
}

interface VenueCardProps {
  place: VenueCardPlace;
  mode: "instant" | "daily";
  localTime: string;
  selected: boolean;
  onSelect: () => void;
}

const VENUE_TYPE_LABELS: Record<VenueType, string> = {
  restaurant: "Resto",
  bar: "Bar",
  snack: "Snack",
  foodtruck: "Food truck",
  other: "Lieu",
};

const VENUE_TYPE_CLASSES: Record<VenueType, string> = {
  restaurant: "bg-red-600",
  bar: "bg-amber-600",
  snack: "bg-orange-600",
  foodtruck: "bg-teal-600",
  other: "bg-slate-600",
};

export function venueTypeBadgeLabel(venueType: VenueType): string {
  return VENUE_TYPE_LABELS[venueType];
}

export function venueTypeMarkerColor(venueType: VenueType): string {
  switch (venueType) {
    case "restaurant":
      return "#dc2626";
    case "bar":
      return "#d97706";
    case "snack":
      return "#ea580c";
    case "foodtruck":
      return "#0d9488";
    case "other":
      return "#64748b";
  }
}

export function VenueCard(props: VenueCardProps) {
  const sunlightLabel =
    props.mode === "instant"
      ? props.place.isSunnyNow
        ? `Soleil maintenant (${props.localTime})`
        : "A l'ombre maintenant"
      : `${props.place.sunlightStartLocalTime ?? "--:--"} -> ${
          props.place.sunlightEndLocalTime ?? "--:--"
        } (${props.place.sunnyMinutes} min)`;

  return (
    <button
      type="button"
      className={`grid gap-1 rounded-lg border px-3 py-3 text-left text-sm transition ${
        props.selected
          ? "border-yellow-300 bg-yellow-300/15"
          : "border-white/15 bg-white/5 hover:bg-white/10"
      }`}
      onClick={props.onSelect}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{props.place.name}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] text-white ${
            VENUE_TYPE_CLASSES[props.place.venueType]
          }`}
        >
          {VENUE_TYPE_LABELS[props.place.venueType]}
        </span>
      </div>
      <div className="text-xs text-slate-300">{sunlightLabel}</div>
      {props.place.selectionStrategy !== "original" ? (
        <div className="text-[11px] text-amber-200">
          Terrasse decalee ({props.place.selectionOffsetMeters}m) pour eviter un point indoor.
        </div>
      ) : null}
    </button>
  );
}
