"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  requestUserGeolocation,
  type GeolocationOutcome,
} from "@/lib/geo/geolocation";

interface GeolocateButtonProps {
  /** Called with the result. Caller decides whether to fly the map. */
  onResult: (outcome: GeolocationOutcome) => void;
  /** Optional className override (e.g. `bottom-24` if zoom controls overlap). */
  className?: string;
  /** Optional title attribute for tooltip. */
  title?: string;
}

/**
 * Floating "locate me" control. Renders a circular icon button in the
 * bottom-right of the map; clicking it triggers a fresh geolocation prompt
 * (bypassing the persisted decision so the user can change their mind).
 *
 * The button stays disabled for `BUTTON_LOCK_MS` after each click to prevent
 * the user from spamming the prompt — `getCurrentPosition` is cheap on warm
 * cache, but on cold GPS a flurry of overlapping prompts can confuse the
 * browser. 1.5s is short enough to feel responsive, long enough to let the
 * previous fetch resolve.
 */
const BUTTON_LOCK_MS = 1_500;

export function GeolocateButton({
  onResult,
  className,
  title = "Me localiser",
}: GeolocateButtonProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // `force: true` bypasses any prior "refused" decision so the user can
      // re-grant permission via the native prompt.
      const outcome = await requestUserGeolocation({ force: true });
      if (mountedRef.current) onResult(outcome);
    } finally {
      // Always lock for a short while so the button cannot be clicked twice
      // in rapid succession (mobile fat-finger / browser spam guard).
      setTimeout(() => {
        if (mountedRef.current) setBusy(false);
      }, BUTTON_LOCK_MS);
    }
  }, [busy, onResult]);

  const baseClass =
    "absolute z-10 grid h-9 w-9 place-items-center rounded-full border border-amber-200/60 bg-[oklch(0.985_0.018_85)/0.92] text-stone-700 shadow-md backdrop-blur-xl transition-colors hover:bg-amber-50 hover:text-amber-900 disabled:opacity-50 disabled:cursor-not-allowed";
  const positionClass = className ?? "bottom-24 right-3";

  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={() => void handleClick()}
      disabled={busy}
      className={`${baseClass} ${positionClass}`}
    >
      {/* Target / locate icon — crosshair with a center dot. 18px stroke. */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="8" />
        <line x1="12" y1="2" x2="12" y2="5" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="2" y1="12" x2="5" y2="12" />
        <line x1="19" y1="12" x2="22" y2="12" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}
