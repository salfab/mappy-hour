"use client";

import { useEffect, useState } from "react";

interface GeolocateToastProps {
  /** Message to display, or `null` to hide the toast. */
  message: string | null;
  /** Auto-dismiss timer in ms. Default 3000. */
  durationMs?: number;
  /** Called after auto-dismiss so the parent can clear `message` state. */
  onDismiss: () => void;
}

type FadePhase = "visible" | "fading";

/**
 * Lightweight ephemeral banner shown above the map after a geolocation
 * attempt. Auto-dismisses after `durationMs` (default 3s) and fades out via
 * Tailwind transitions. Sits in the same vertical slot whether on desktop or
 * mobile (centered, just below the search banner) to avoid juggling layout
 * across breakpoints.
 *
 * No close button — the toast is fire-and-forget. If the user does need an
 * action, the "Me localiser" floating button stays interactive throughout.
 *
 * The fade phase is driven by timers inside `useEffect` (not by a synchronous
 * setState) so the React lint rule `react-hooks/set-state-in-effect` stays
 * happy. The parent owns the "show / hide" toggle via `message`.
 */
export function GeolocateToast({
  message,
  durationMs = 3_000,
  onDismiss,
}: GeolocateToastProps): React.JSX.Element | null {
  const [phase, setPhase] = useState<FadePhase>("visible");

  useEffect(() => {
    if (message === null) return;
    // Fresh message → reset to visible, then schedule the fade-out and the
    // final dismissal. We start the fade slightly before the dismiss callback
    // fires so the user sees the opacity transition complete.
    const fadeTimer = window.setTimeout(() => setPhase("fading"), durationMs - 200);
    const dismissTimer = window.setTimeout(() => {
      setPhase("visible"); // reset for next message
      onDismiss();
    }, durationMs);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(dismissTimer);
    };
  }, [message, durationMs, onDismiss]);

  if (message === null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2 transform rounded-full border border-amber-200/60 bg-[oklch(0.985_0.018_85)] px-4 py-2 text-sm text-stone-800 shadow-md transition-opacity duration-200 lg:top-20 ${
        phase === "visible" ? "opacity-100" : "opacity-0"
      }`}
    >
      {message}
    </div>
  );
}
