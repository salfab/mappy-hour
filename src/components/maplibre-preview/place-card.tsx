"use client";

import {
  formatCardClock,
  viewportCardEmoji,
  type SunlightWindow,
  type ViewportPlaceLite,
} from "./places-source";
import { formatWeeklyOpeningHours, getOpeningHoursStatus } from "@/lib/places/opening-hours";

interface PlaceDetailCardProps {
  place: ViewportPlaceLite;
  sunlightWindows: SunlightWindow[] | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
}

export function PlaceDetailCard({
  place, sunlightWindows, isLoading, error, onClose,
}: PlaceDetailCardProps) {
  return (
    <div className="vpo-card" role="dialog" aria-label="Détails du lieu">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            {viewportCardEmoji(place)} {place.name}
          </p>
          <p className="text-xs text-slate-500">
            {place.subcategory || place.category}
          </p>
        </div>
        <button
          type="button"
          className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          onClick={onClose}
          aria-label="Fermer"
        >
          ×
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
            place.hasOutdoorSeating
              ? "bg-amber-100 text-amber-900 ring-amber-200"
              : place.hasOutdoorSeatingUnknown
                ? "bg-slate-100 text-slate-600 ring-slate-200"
                : "bg-rose-100 text-rose-700 ring-rose-200"
          }`}
        >
          {place.hasOutdoorSeating
            ? "Terrasse ✓"
            : place.hasOutdoorSeatingUnknown
              ? "Terrasse ?"
              : "Pas de terrasse"}
        </span>
      </div>

      <div className="vpo-card-divider" />
      <div className="vpo-card-section">
        <p className="vpo-card-section-title">Heures d&apos;ouverture</p>
        <OpeningHoursBlock spec={place.openingHours} />
      </div>

      <div className="vpo-card-divider" />
      <div className="vpo-card-section">
        <p className="vpo-card-section-title">Ensoleillement aujourd&apos;hui</p>
        {isLoading ? (
          <p className="vpo-card-muted">Calcul en cours…</p>
        ) : error ? (
          <p className="vpo-card-muted">{error}</p>
        ) : sunlightWindows && sunlightWindows.length > 0 ? (
          <div className="vpo-card-sun-pills">
            {sunlightWindows.map((w, idx) => (
              <span key={idx} className="vpo-card-sun-pill">
                {formatCardClock(w.startLocalTime)} – {formatCardClock(w.endLocalTime)}
              </span>
            ))}
          </div>
        ) : (
          <p className="vpo-card-muted">Aucune fenêtre ensoleillée ce jour</p>
        )}
      </div>

      <a
        className="mt-3 inline-block text-xs font-semibold text-amber-700 hover:text-amber-900"
        href={`https://www.openstreetmap.org/${place.osmType}/${place.osmId}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Voir sur OpenStreetMap →
      </a>
    </div>
  );
}

/**
 * French-friendly weekly schedule for a place's OSM opening_hours. Groups
 * consecutive days with identical intervals (e.g. "Lun – Ven : 08:00 – 22:00")
 * and highlights the row that contains today. Falls back gracefully when the
 * spec is unparseable.
 */
function OpeningHoursBlock({ spec }: { spec: string | null | undefined }): React.JSX.Element {
  const rows = formatWeeklyOpeningHours(spec ?? null);
  const status = getOpeningHoursStatus(spec ?? null, new Date());

  if (!rows) {
    return <p className="vpo-card-muted">Horaires non renseignés</p>;
  }
  return (
    <div className="grid gap-1.5">
      <span
        className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
          status.isOpen
            ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
            : "bg-slate-100 text-slate-600 ring-slate-200"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${
            status.isOpen ? "bg-emerald-500" : "bg-slate-400"
          }`}
        />
        {status.isOpen ? "Ouvert" : "Fermé"}
        <span className="font-normal opacity-80">· {status.todayLabel.replace(/^Ouvert |^Fermé\s*·\s*/, "")}</span>
      </span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map((row, idx) => (
          <div key={idx} className="contents">
            <dt
              className={`tabular-nums ${
                row.containsToday ? "font-semibold text-slate-900" : "text-slate-500"
              }`}
            >
              {row.daysLabel}
            </dt>
            <dd
              className={`tabular-nums ${
                row.intervals === null
                  ? "italic text-slate-400"
                  : row.containsToday
                    ? "font-semibold text-slate-900"
                    : "text-slate-700"
              }`}
            >
              {row.intervals === null ? "Fermé" : row.intervals.join(", ")}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
