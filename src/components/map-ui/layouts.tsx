"use client";

import { useRef, useState } from "react";

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
    <div className="relative h-dvh max-h-dvh overflow-hidden bg-slate-950 lg:hidden">
      {props.map}
      {props.search}
      {props.bottomSheet}
      {props.barsView}
    </div>
  );
}

export function DesktopMapLayout(props: DesktopMapLayoutProps) {
  return (
    <div className="relative hidden h-dvh max-h-dvh overflow-hidden bg-slate-950 lg:block">
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
  const dragStartYRef = useRef<number | null>(null);
  const [dragPreview, setDragPreview] = useState<"down-strong" | "down" | "up" | "up-strong" | null>(null);

  const isInteractiveDragTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return Boolean(
      target.closest(
        "button,input,select,textarea,a,label,summary,[role='button'],[data-bottom-sheet-no-drag]",
      ),
    );
  };

  const getHeightClass = () => {
    if (dragPreview !== null) {
      if (props.state === "compact") {
        if (dragPreview === "up-strong") {
          return "h-[min(calc(100svh-116px),560px)]";
        }
        if (dragPreview === "up") {
          return "h-[clamp(218px,34svh,300px)]";
        }
      }

      if (props.state === "middle") {
        if (dragPreview === "up-strong") {
          return "h-[calc(100svh-40px)]";
        }
        if (dragPreview === "up") {
          return "h-[min(calc(100svh-80px),640px)]";
        }
        if (dragPreview === "down-strong") {
          return "h-[clamp(176px,24svh,220px)]";
        }
        if (dragPreview === "down") {
          return "h-[clamp(230px,36svh,320px)]";
        }
      }

      if (props.state === "expanded") {
        if (dragPreview === "down-strong") {
          return "h-[min(calc(100svh-116px),560px)]";
        }
        if (dragPreview === "down") {
          return "h-[min(calc(100svh-72px),660px)]";
        }
      }
    }

    return props.state === "compact"
      ? "h-[clamp(176px,24svh,220px)]"
      : props.state === "middle"
        ? "h-[min(calc(100svh-116px),560px)]"
        : "h-[calc(100svh-40px)]";
  };

  const stateHeightClass = getHeightClass();

  const updateDragPreview = (clientY: number) => {
    const startY = dragStartYRef.current;
    if (startY === null) {
      return;
    }

    const deltaY = clientY - startY;
    if (deltaY < -96) {
      setDragPreview("up-strong");
    } else if (deltaY < -18) {
      setDragPreview("up");
    } else if (deltaY > 96) {
      setDragPreview("down-strong");
    } else if (deltaY > 18) {
      setDragPreview("down");
    } else {
      setDragPreview(null);
    }
  };

  const goToNextState = (direction: "up" | "down") => {
    const states: BottomSheetState[] = ["compact", "middle", "expanded"];
    const currentIndex = states.indexOf(props.state);
    const nextIndex =
      direction === "up"
        ? Math.min(states.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1);
    props.onStateChange(states[nextIndex]);
  };

  const finishDrag = (clientY: number) => {
    const startY = dragStartYRef.current;
    dragStartYRef.current = null;
    setDragPreview(null);
    if (startY === null) {
      return;
    }

    const deltaY = clientY - startY;
    if (Math.abs(deltaY) < 36) {
      return;
    }
    goToNextState(deltaY < 0 ? "up" : "down");
  };

  return (
    <section
      className={`absolute inset-x-0 bottom-0 z-[460] grid grid-rows-[auto_1fr] overflow-hidden rounded-t-[2rem] border border-b-0 border-white/70 bg-white/92 px-4 pb-[calc(env(safe-area-inset-bottom)+34px)] pt-2 text-slate-900 shadow-2xl backdrop-blur transition-[height] duration-150 ${stateHeightClass}`}
      aria-label="Controle de la carte"
      onPointerDownCapture={(event) => {
        if (isInteractiveDragTarget(event.target)) {
          return;
        }
        dragStartYRef.current = event.clientY;
        setDragPreview(null);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => updateDragPreview(event.clientY)}
      onPointerUp={(event) => finishDrag(event.clientY)}
      onPointerCancel={() => {
        dragStartYRef.current = null;
        setDragPreview(null);
      }}
    >
      <div className="flex justify-center pb-3">
        <button
          type="button"
          className="grid h-8 w-28 touch-none place-items-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-amber-300"
          aria-label="Glisser pour agrandir ou reduire le panneau"
          onPointerDown={(event) => {
            dragStartYRef.current = event.clientY;
            setDragPreview(null);
            event.currentTarget.setPointerCapture(event.pointerId);
            event.stopPropagation();
          }}
          onPointerMove={(event) => updateDragPreview(event.clientY)}
          onPointerUp={(event) => {
            finishDrag(event.clientY);
            event.stopPropagation();
          }}
          onPointerCancel={() => {
            dragStartYRef.current = null;
            setDragPreview(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              goToNextState("up");
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              goToNextState("down");
            }
          }}
        >
          <span
            className={`h-1.5 rounded-full bg-slate-300 transition-[width,background-color] duration-150 ${
              dragPreview === null ? "w-14" : "w-20 bg-amber-300"
            }`}
          />
        </button>
      </div>

      <div className="grid min-h-0 gap-4 overflow-y-auto overscroll-contain pb-1">
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
    <section className="absolute inset-0 z-[520] grid grid-rows-[auto_1fr] bg-slate-50 text-slate-950 lg:hidden">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white/92 px-4 py-3 shadow-sm backdrop-blur">
        <button
          type="button"
          className="grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-800 shadow-sm"
          aria-label="Retour a la carte"
          onClick={props.onClose}
        >
          <BackIcon />
        </button>
        <div>
          <h2 className="text-lg font-semibold">Terrasses au soleil</h2>
          <p className="text-xs text-slate-500">
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
