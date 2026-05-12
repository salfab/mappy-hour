"use client";

import { useRef, useState } from "react";

import { BarsList } from "./bars-list";
import { BackIcon, ChevronRightIcon } from "./icons";
import { VenueTerraceIcon } from "./venue-assets";
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
          return "h-[clamp(292px,38svh,360px)]";
        }
        if (dragPreview === "up") {
          return "h-[clamp(184px,24svh,228px)]";
        }
      }

      if (props.state === "middle") {
        if (dragPreview === "up-strong") {
          return "h-[clamp(430px,64svh,560px)]";
        }
        if (dragPreview === "up") {
          return "h-[clamp(360px,50svh,470px)]";
        }
        if (dragPreview === "down-strong") {
          return "h-[clamp(124px,16svh,152px)]";
        }
        if (dragPreview === "down") {
          return "h-[clamp(184px,24svh,228px)]";
        }
      }

      if (props.state === "expanded") {
        if (dragPreview === "down-strong") {
          return "h-[clamp(292px,38svh,360px)]";
        }
        if (dragPreview === "down") {
          return "h-[clamp(360px,50svh,470px)]";
        }
      }
    }

    // Compact bumped from clamp(124,16svh,152) to clamp(176,22svh,210) because
    // the previous size left ~85 px of content room, while the timeline label +
    // slider + tile-count line need ~95-100 px → forced overflow-y-auto to
    // scroll, with the bottom text getting clipped on every restart. The new
    // floor fits everything without scroll on standard mobile viewports.
    return props.state === "compact"
      ? "h-[clamp(176px,22svh,210px)]"
      : props.state === "middle"
        ? "h-[clamp(292px,38svh,360px)]"
        : "h-[clamp(430px,64svh,560px)]";
  };

  const stateHeightClass = getHeightClass();
  const contentGapClass = props.state === "compact" ? "gap-2.5" : "gap-3";

  // Drag preview / commit thresholds — tuned 2026-05-12 to be more responsive.
  // Previous 36 px commit threshold felt sluggish; 24 px still rejects accidental
  // micro-pans (≤ 20 px) while triggering on intentional swipes.
  const DRAG_PREVIEW_SMALL_PX = 14;
  const DRAG_PREVIEW_STRONG_PX = 80;
  const DRAG_COMMIT_PX = 24;

  const updateDragPreview = (clientY: number) => {
    const startY = dragStartYRef.current;
    if (startY === null) {
      return;
    }

    const deltaY = clientY - startY;
    if (deltaY < -DRAG_PREVIEW_STRONG_PX) {
      setDragPreview("up-strong");
    } else if (deltaY < -DRAG_PREVIEW_SMALL_PX) {
      setDragPreview("up");
    } else if (deltaY > DRAG_PREVIEW_STRONG_PX) {
      setDragPreview("down-strong");
    } else if (deltaY > DRAG_PREVIEW_SMALL_PX) {
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
    if (Math.abs(deltaY) < DRAG_COMMIT_PX) {
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
      {/* Full-width drag affordance: the entire top strip (not just the visible
          handle pill) catches pointer events. The container handles drag via
          the section-level onPointerDownCapture; the button keeps its keyboard
          + screen-reader semantics. Hit area went from 32×112 px → effectively
          ~52 px tall × full width because the section captures pointer events
          on this whole strip (which is non-interactive markup). */}
      <div className="flex justify-center px-12 py-2">
        <button
          type="button"
          className="grid h-10 w-32 touch-none place-items-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-amber-300"
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

      <div className={`grid min-h-0 ${contentGapClass} overflow-y-auto overscroll-contain pb-1`}>
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
              className="group grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-[1.75rem] border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-orange-50 px-3.5 py-3.5 text-left text-slate-950 shadow-sm shadow-amber-100/70 transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md hover:shadow-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              onClick={props.onOpenBars}
            >
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-slate-900 ring-1 ring-inset ring-amber-200">
                <VenueTerraceIcon className="h-7 w-7" />
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="text-base font-semibold leading-tight">Terrasses au soleil</span>
                <span className="text-xs font-medium text-slate-500">
                  {props.venueCount === 0
                    ? "Aucun etablissement trouve"
                    : props.venueCount === 1
                      ? "1 etablissement visible"
                      : `${props.venueCount} etablissements visibles`}
                </span>
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="rounded-full bg-white px-2.5 py-1 text-sm font-semibold text-amber-900 ring-1 ring-inset ring-amber-200">
                  {props.venueCount}
                </span>
                <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-950 text-white shadow-sm transition group-hover:bg-amber-500">
                  <ChevronRightIcon className="h-4 w-4" />
                </span>
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
