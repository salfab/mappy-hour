"use client";

import { getOpeningHoursStatus } from "@/lib/places/opening-hours";

import { getVenueSunStatus, VenueSunStatusIcon, VenueTypeIcon } from "./venue-assets";

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
  /** Raw OSM `opening_hours` tag value, when known. Optional so legacy
   * SunlitPlaceEntry consumers (Leaflet client) can pass their objects as-is
   * without bubbling the field through every place pipeline. */
  openingHours?: string | null;
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
  restaurant: "bg-rose-100 text-rose-800 ring-rose-200",
  bar: "bg-amber-100 text-amber-900 ring-amber-200",
  snack: "bg-orange-100 text-orange-800 ring-orange-200",
  foodtruck: "bg-teal-100 text-teal-800 ring-teal-200",
  other: "bg-slate-100 text-slate-700 ring-slate-200",
};

export function VenueCard(props: VenueCardProps) {
  const sunStatus = getVenueSunStatus(props.place);
  const sunlightLabel =
    props.mode === "instant"
      ? props.place.isSunnyNow
        ? `Soleil maintenant (${props.localTime})`
        : "À l'ombre maintenant"
      : `${props.place.sunlightStartLocalTime ?? "--:--"} -> ${
          props.place.sunlightEndLocalTime ?? "--:--"
        } (${props.place.sunnyMinutes} min)`;
  // Opening-hours status computed against "now". Using the user's local
  // wall-clock is the right reference: opening_hours specs are written in
  // the venue's local time, and the user is overwhelmingly browsing nearby.
  const hoursStatus = getOpeningHoursStatus(props.place.openingHours ?? null, new Date());

  return (
    <button
      type="button"
      className={`grid gap-3 rounded-2xl border px-3 py-3 text-left text-sm shadow-sm transition ${
        props.selected
          ? "border-amber-300 bg-amber-50 shadow-amber-100"
          : "border-slate-200 bg-white hover:border-amber-200 hover:bg-amber-50"
      }`}
      onClick={props.onSelect}
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
        <span
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${
            sunStatus.tone === "shadow"
              ? "bg-slate-100 text-slate-500"
              : "bg-amber-100 text-amber-600"
          }`}
        >
          <VenueTypeIcon venueType={props.place.venueType} className="h-6 w-6" />
        </span>
        <span className="grid min-w-0 gap-1">
          <span className="truncate font-semibold text-slate-950">{props.place.name}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                sunStatus.tone === "shadow"
                  ? "bg-slate-100 text-slate-600 ring-slate-200"
                  : "bg-amber-100 text-amber-900 ring-amber-200"
              }`}
            >
              <VenueSunStatusIcon tone={sunStatus.tone} className="h-3.5 w-3.5" />
              {sunStatus.label}
            </span>
            {props.mode === "daily" ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                {props.place.sunnyMinutes} min
              </span>
            ) : null}
            {hoursStatus.knowable ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                  hoursStatus.isOpen
                    ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                    : "bg-slate-100 text-slate-600 ring-slate-200"
                }`}
                title={props.place.openingHours ?? undefined}
                /* The raw OSM spec lives in the title for power-users on
                   desktop hover; mobile silently ignores it. */
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    hoursStatus.isOpen ? "bg-emerald-500" : "bg-slate-400"
                  }`}
                />
                {hoursStatus.isOpen ? "Ouvert" : "Fermé"}
              </span>
            ) : null}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ring-inset ${
            VENUE_TYPE_CLASSES[props.place.venueType]
          }`}
        >
          {VENUE_TYPE_LABELS[props.place.venueType]}
        </span>
      </div>
      <div className="pl-14 text-xs font-medium text-slate-500">{sunlightLabel}</div>
      {hoursStatus.knowable ? (
        <div className="pl-14 text-[11px] font-medium text-slate-500">
          <span
            className={
              hoursStatus.isOpen
                ? "text-emerald-700"
                : "text-slate-500"
            }
          >
            {hoursStatus.todayLabel}
          </span>
        </div>
      ) : null}
      {props.place.selectionStrategy !== "original" ? (
        <div className="pl-14 text-[11px] text-amber-700">
          Terrasse décalée ({props.place.selectionOffsetMeters}m) pour éviter un point indoor.
        </div>
      ) : null}
    </button>
  );
}
