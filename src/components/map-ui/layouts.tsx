"use client";

import { BarsList } from "./bars-list";
import { BackIcon, ChevronRightIcon } from "./icons";
import type { VenueCardPlace } from "./venue-card";

export type BottomSheetState = "compact" | "middle" | "expanded";

interface MobileBottomSheetProps {
  state: BottomSheetState;
  venueCount: number;
  timeline: React.ReactNode;
  controls: React.ReactNode;
  filters: React.ReactNode;
  coverage: React.ReactNode;
  onStateChange: (state: BottomSheetState) => void;
  onOpenBars: () => void;
}

interface DesktopMapLayoutProps {
  map: React.ReactNode;
  search: React.ReactNode;
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  statusBar: React.ReactNode;
}

interface MobileMapLayoutProps {
  map: React.ReactNode;
  search: React.ReactNode;
  bottomSheet: React.ReactNode;
  barsView: React.ReactNode;
}

interface MobileBarsViewProps {
  open: boolean;
  places: VenueCardPlace[];
  isLoading: boolean;
  mode: "instant" | "daily";
  localTime: string;
  selectedVenueId: string | null;
  onClose: () => void;
  onSelectVenue: (place: VenueCardPlace) => void;
}

export function MobileMapLayout(props: MobileMapLayoutProps) {
  return (
    <div className="relative h-dvh min-h-screen overflow-hidden bg-slate-950 lg:hidden">
      {props.map}
      {props.search}
      {props.bottomSheet}
      {props.barsView}
    </div>
  );
}

export function DesktopMapLayout(props: DesktopMapLayoutProps) {
  return (
    <div className="relative hidden h-dvh min-h-screen overflow-hidden bg-slate-950 lg:block">
      {props.map}
      {props.search}
      <div className="absolute left-5 top-5 z-[450] grid max-h-[calc(100dvh-96px)] w-[390px] gap-3 overflow-y-auto rounded-2xl border border-white/18 bg-slate-950/82 p-4 shadow-2xl backdrop-blur">
        {props.leftPanel}
      </div>
      <div className="absolute right-5 top-5 z-[450] h-[calc(100dvh-96px)] w-[360px] overflow-hidden rounded-2xl border border-white/18 bg-slate-950/82 shadow-2xl backdrop-blur">
        {props.rightPanel}
      </div>
      <div className="absolute bottom-4 left-1/2 z-[440] w-[min(760px,calc(100vw-48px))] -translate-x-1/2 rounded-full border border-white/14 bg-slate-950/75 px-4 py-2 text-xs text-slate-200 shadow-xl backdrop-blur">
        {props.statusBar}
      </div>
    </div>
  );
}

export function MobileBottomSheet(props: MobileBottomSheetProps) {
  const stateHeightClass =
    props.state === "compact"
      ? "max-h-[150px]"
      : props.state === "middle"
        ? "max-h-[430px]"
        : "max-h-[78dvh]";

  return (
    <section
      className={`absolute inset-x-0 bottom-0 z-[460] overflow-hidden rounded-t-[2rem] border border-white/70 bg-white/92 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-2 text-slate-900 shadow-2xl backdrop-blur transition-[max-height] duration-200 ${stateHeightClass}`}
      aria-label="Controle de la carte"
    >
      <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-slate-300" />
      <div className="mb-3 flex justify-center gap-2">
        {(["compact", "middle", "expanded"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={`h-2 w-8 rounded-full transition ${
              props.state === option ? "bg-amber-300" : "bg-slate-200"
            }`}
            aria-label={`Afficher la feuille ${option}`}
            onClick={() => props.onStateChange(option)}
          />
        ))}
      </div>

      <div className="grid gap-4">
        {props.timeline}
        {props.state !== "compact" ? (
          <>
            {props.controls}
            {props.filters}
          </>
        ) : null}
        {props.state === "expanded" ? (
          <>
            {props.coverage}
            <button
              type="button"
              className="flex items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-left text-sm text-slate-900 transition hover:bg-amber-100"
              onClick={props.onOpenBars}
            >
              <span>Terrasses au soleil</span>
              <span className="inline-flex items-center gap-2 text-slate-500">
                {props.venueCount}
                <ChevronRightIcon className="h-4 w-4" />
              </span>
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

export function MobileBarsView(props: MobileBarsViewProps) {
  if (!props.open) {
    return null;
  }

  return (
    <section className="absolute inset-0 z-[520] grid grid-rows-[auto_1fr] bg-slate-950 text-white lg:hidden">
      <header className="flex items-center gap-3 border-b border-white/12 px-4 py-3">
        <button
          type="button"
          className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-white/10"
          aria-label="Retour a la carte"
          onClick={props.onClose}
        >
          <BackIcon />
        </button>
        <div>
          <h2 className="text-lg font-semibold">Terrasses au soleil</h2>
          <p className="text-xs text-slate-300">
            {props.isLoading ? "Calcul terrasses en cours..." : `${props.places.length} etablissements visibles`}
          </p>
        </div>
      </header>
      <div className="overflow-y-auto px-3 py-3">
        <BarsList
          places={props.places}
          isLoading={props.isLoading}
          mode={props.mode}
          localTime={props.localTime}
          selectedVenueId={props.selectedVenueId}
          onSelectVenue={props.onSelectVenue}
        />
      </div>
    </section>
  );
}
