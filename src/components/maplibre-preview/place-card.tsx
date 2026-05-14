"use client";

import {
  formatCardClock,
  viewportCardEmoji,
  type SunlightWindow,
  type ViewportPlaceLite,
} from "./places-source";

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
        {place.openingHours ? (
          <ul className="vpo-card-hours-list">
            {place.openingHours
              .split(";")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
              .map((segment, idx) => (
                <li key={idx}>{segment}</li>
              ))}
          </ul>
        ) : (
          <p className="vpo-card-muted">Horaires non renseignés</p>
        )}
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
