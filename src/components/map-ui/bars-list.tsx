"use client";

import { VenueCard, type VenueCardPlace } from "./venue-card";

interface BarsListProps {
  places: VenueCardPlace[];
  isLoading: boolean;
  mode: "instant" | "daily";
  localTime: string;
  selectedVenueId: string | null;
  onSelectVenue: (place: VenueCardPlace) => void;
}

export function BarsList(props: BarsListProps) {
  return (
    <div className="grid gap-2">
      {props.places.length === 0 && !props.isLoading ? (
        <p className="px-2 py-2 text-xs text-slate-500">
          Aucun etablissement ensoleille pour les filtres actuels.
        </p>
      ) : null}
      {props.places.map((place) => (
        <VenueCard
          key={place.id}
          place={place}
          mode={props.mode}
          localTime={props.localTime}
          selected={props.selectedVenueId === place.id}
          onSelect={() => props.onSelectVenue(place)}
        />
      ))}
    </div>
  );
}
