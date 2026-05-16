"use client";

import { useEffect, useState } from "react";

import {
  TURNSTILE_READY_EVENT,
  isTurnstileReady,
} from "@/lib/security/turnstile-ready";

/**
 * React hook that returns `true` once the Cloudflare Turnstile challenge has
 * completed and the `/api/turnstile/verify` POST has set the
 * `mh-turnstile-ok` cookie — i.e. the moment subsequent same-origin fetches
 * to gated routes are accepted by `requireTurnstile`.
 *
 * Why a hook (and not React context)
 * ----------------------------------
 * The signal is page-global and read from many places (auto-fetch effects,
 * disabled-button props, skeleton placeholders). A context would force the
 * `<TurnstileGate>` to live above every consumer; instead we anchor the flag
 * on `globalThis` (cf. `turnstile-ready.ts`) and the hook subscribes to a
 * window event for re-renders.
 *
 * SSR
 * ---
 * `useState` initialises from the (always-`false`) server-side flag, then
 * reads the real value in a `useEffect` after hydration. This avoids a
 * hydration mismatch — the first render in the browser matches the server
 * markup (button disabled, skeleton showing) and then flips on the next
 * tick if Turnstile has already completed by then.
 */
export function useTurnstileReady(): boolean {
  // SSR-safe initial value — flips to the real flag in the effect below.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Read once on mount: the gate may have completed between SSR markup
    // generation and component hydration (rare but possible on a warm cache).
    if (isTurnstileReady()) {
      setReady(true);
      return;
    }
    // Listen for the one-shot ready event. `once: true` removes the
    // listener after the first fire so we don't keep a dangling subscription
    // for the rest of the page lifecycle. Capture-phase is unnecessary —
    // the event is dispatched directly on `window` and bubbles by default.
    const handler = () => setReady(true);
    window.addEventListener(TURNSTILE_READY_EVENT, handler, { once: true });
    return () => {
      window.removeEventListener(TURNSTILE_READY_EVENT, handler);
    };
  }, []);

  return ready;
}
