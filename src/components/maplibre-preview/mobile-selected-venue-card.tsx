"use client";

import { useEffect, useRef, useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, CloseIcon } from "@/components/map-ui/icons";

import {
  formatCardClock,
  viewportCardEmoji,
  type SunlightWindow,
  type ViewportPlaceLite,
} from "./places-source";

interface MobileSelectedVenueCardProps {
  place: ViewportPlaceLite;
  sunlightWindows: SunlightWindow[] | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  /** Optional callback invoked when the user expands the inline details and
   *  the parent sheet is too small to host them without scroll (e.g. compact).
   *  Caller can bump the sheet from `compact` to `middle`. */
  onRequestSheetExpand?: () => void;
}

/** Inline replacement of `PlaceDetailCard` for mobile. Lives inside the bottom
 *  sheet (above the timeline) instead of floating on top of the map. The card
 *  has two visual modes:
 *
 *   • collapsed (default): one-line venue header with type icon, name,
 *     subcategory, a close button and an expand chevron.
 *   • expanded: same header + opening hours, today's sunlight windows,
 *     OpenStreetMap deep link. Equivalent to the desktop overlay content.
 *
 *  Expansion is local state — toggling it does NOT change the bottom-sheet
 *  state by itself, so the user keeps the height they chose. We do nudge the
 *  sheet from `compact` to `middle` once (via `onRequestSheetExpand`) so the
 *  expanded card has room to breathe without scroll. */
export function MobileSelectedVenueCard({
  place,
  sunlightWindows,
  isLoading,
  error,
  onClose,
  onRequestSheetExpand,
}: MobileSelectedVenueCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  // Reset the expand state whenever the selected place changes — otherwise
  // selecting a new venue while the previous card was expanded would inherit
  // that expansion state without the user asking for it.
  const lastPlaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastPlaceIdRef.current !== place.id) {
      lastPlaceIdRef.current = place.id;
      setIsExpanded(false);
    }
  }, [place.id]);

  const subtitle = place.subcategory || place.category;
  const terraceTone = place.hasOutdoorSeating
    ? "bg-amber-100 text-amber-900 ring-amber-200"
    : place.hasOutdoorSeatingUnknown
      ? "bg-slate-100 text-slate-600 ring-slate-200"
      : "bg-rose-100 text-rose-700 ring-rose-200";
  const terraceLabel = place.hasOutdoorSeating
    ? "Terrasse"
    : place.hasOutdoorSeatingUnknown
      ? "Terrasse ?"
      : "Pas de terrasse";

  const handleToggleExpand = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    if (next) {
      onRequestSheetExpand?.();
    }
  };

  return (
    <section
      // Match the "papier kraft" / amber accent used by the surrounding cards
      // (terrasses CTA, VenueCard selected state). Border kept thin so the card
      // does not visually fight with the timeline below.
      className="grid gap-2 rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-orange-50 px-3 py-2.5 shadow-sm shadow-amber-100/60"
      aria-label="Lieu sélectionné"
      // The bottom-sheet treats this card content as a drag-zone otherwise.
      // Marking it as a non-drag target keeps tap-to-toggle and tap-to-close
      // working reliably on small screens.
      data-bottom-sheet-no-drag
    >
      <div className="flex items-center gap-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-100 text-base ring-1 ring-inset ring-amber-200">
          <span aria-hidden="true">{viewportCardEmoji(place)}</span>
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate text-sm font-semibold text-slate-950">
            {place.name}
          </p>
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            <span className="truncate">{subtitle}</span>
            <span
              className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${terraceTone}`}
            >
              {terraceLabel}
            </span>
          </p>
        </div>
        <button
          type="button"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
          onClick={handleToggleExpand}
          aria-label={isExpanded ? "Réduire les détails" : "Plus d'infos"}
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <ChevronDownIcon className="h-4 w-4" />
          ) : (
            <ChevronRightIcon className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
          onClick={onClose}
          aria-label="Désélectionner ce lieu"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {isExpanded ? (
        <div className="grid gap-2.5 border-t border-amber-200/70 pt-2 text-sm text-slate-900">
          <div className="grid gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Heures d&apos;ouverture
            </p>
            {place.openingHours ? (
              <ul className="m-0 grid list-none gap-0.5 p-0 text-xs text-slate-800">
                {place.openingHours
                  .split(";")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0)
                  .map((segment, idx) => (
                    <li key={idx}>{segment}</li>
                  ))}
              </ul>
            ) : (
              <p className="m-0 text-xs italic text-slate-500">
                Horaires non renseignés
              </p>
            )}
          </div>

          <div className="grid gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Ensoleillement aujourd&apos;hui
            </p>
            {isLoading ? (
              <p className="m-0 text-xs italic text-slate-500">Calcul en cours…</p>
            ) : error ? (
              <p className="m-0 text-xs italic text-slate-500">{error}</p>
            ) : sunlightWindows && sunlightWindows.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {sunlightWindows.map((w, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900 ring-1 ring-inset ring-amber-200"
                  >
                    {formatCardClock(w.startLocalTime)} – {formatCardClock(w.endLocalTime)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="m-0 text-xs italic text-slate-500">
                Aucune fenêtre ensoleillée ce jour
              </p>
            )}
          </div>

          <a
            className="text-xs font-semibold text-amber-700 hover:text-amber-900"
            href={`https://www.openstreetmap.org/${place.osmType}/${place.osmId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Voir sur OpenStreetMap →
          </a>
        </div>
      ) : null}
    </section>
  );
}
