"use client";

import { useEffect, useRef } from "react";

import { markTurnstileReady } from "@/lib/security/turnstile-ready";

/**
 * Invisible Cloudflare Turnstile widget mounted at the page root.
 *
 * Goal: filter out crawlers/bots before they hit our expensive SSE endpoints
 * (timeline/stream, instant/stream) and the viewport-places POST. Real users
 * have a browser that runs JS → Turnstile issues a token → the server
 * verifies it → an HttpOnly cookie is set → subsequent same-origin fetches
 * are accepted by `requireTurnstile`.
 *
 * Dev / no-keys mode: when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is not set we
 * return `null` and never inject the Turnstile script. This pairs with the
 * server-side dev mode (no `TURNSTILE_SECRET_KEY` → gates short-circuit to
 * ok=true) so local development works without any Cloudflare provisioning.
 * In that mode we still flip the global `ready` flag to `true` on mount so
 * client-side consumers (cf. `useTurnstileReady`) don't sit waiting forever.
 *
 * Lifecycle:
 *   1. On mount, inject `<script src=".../turnstile/v0/api.js">` once.
 *   2. When `window.turnstile` is ready, render the widget in `invisible`
 *      mode. Cloudflare executes the challenge in the background.
 *   3. On `callback(token)`, POST it to `/api/turnstile/verify` (same-origin
 *      so the resulting cookie sticks). On 200, mark the gate as ready so
 *      gated callers can fire (cf. `useTurnstileReady` / `getTurnstileReadyPromise`).
 *   4. On `error-callback` / `expired-callback`, reset the widget so the
 *      next interaction can trigger a fresh challenge. Errors stay silent
 *      from the user's perspective.
 *
 * The component renders a hidden anchor `<div>` outside the document flow.
 * We use a stable id so React's strict-mode double-invoke can't create two
 * widgets on the same node (Turnstile would throw a duplicate-id error).
 */

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const WIDGET_CONTAINER_ID = "mh-turnstile-container";
const VERIFY_ENDPOINT = "/api/turnstile/verify";

/**
 * Subset of the Cloudflare Turnstile JS API we actually call. Declared
 * inline (rather than in a global `.d.ts`) so the only file that references
 * `window.turnstile` is this component — no leaking ambient typings into
 * the rest of the app.
 */
interface TurnstileApi {
  render: (selector: string | HTMLElement, opts: TurnstileRenderOptions) =>
    | string
    | undefined;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  size?: "normal" | "compact" | "invisible" | "flexible";
  appearance?: "always" | "execute" | "interaction-only";
  retry?: "auto" | "never";
  "refresh-expired"?: "auto" | "manual" | "never";
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function TurnstileGate(): React.ReactElement | null {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const widgetIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!siteKey || siteKey.trim().length === 0) {
      // Dev / no-keys mode — gate is intentionally disabled. Mirror the
      // server-side bypass (cf. `isTurnstileEnabledServer` in
      // `src/lib/security/turnstile.ts`): flip the client-side ready flag to
      // `true` immediately so `useTurnstileReady()` resolves without ever
      // waiting on Cloudflare. Without this, the auto-fetch effects gated on
      // `turnstileReady` would never fire in local dev.
      markTurnstileReady();
      return;
    }
    // StrictMode in dev double-invokes effects; the widget would otherwise
    // be rendered twice into the same container. The ref guards against it
    // while still allowing a real unmount to clean up below.
    if (mountedRef.current) return;
    mountedRef.current = true;

    let cancelled = false;

    const ensureScript = (): Promise<void> =>
      new Promise((resolve, reject) => {
        if (typeof document === "undefined") {
          reject(new Error("No document"));
          return;
        }
        if (document.getElementById(SCRIPT_ID)) {
          // Already injected by an earlier mount; wait for `window.turnstile`
          // below in `waitForTurnstile`.
          resolve();
          return;
        }
        const script = document.createElement("script");
        script.id = SCRIPT_ID;
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Turnstile"));
        document.head.appendChild(script);
      });

    const waitForTurnstile = (timeoutMs = 8000): Promise<TurnstileApi> =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (cancelled) return;
          if (typeof window !== "undefined" && window.turnstile) {
            resolve(window.turnstile);
            return;
          }
          if (Date.now() - start > timeoutMs) {
            reject(new Error("Turnstile script never initialised"));
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      });

    const submitToken = (token: string) => {
      // Same-origin POST so the `Set-Cookie` response header lands on this
      // origin. `credentials: "same-origin"` is the default but we make it
      // explicit — without it, subsequent fetches would not carry the cookie
      // back on certain dev proxy setups.
      fetch(VERIFY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token }),
      })
        .then((response) => {
          // Only mark ready on a 2xx — a 400 (token rejected) or 502
          // (siteverify unreachable) leaves the cookie unset, so the gated
          // routes would still 403. Cloudflare's `retry: "auto"` will fire
          // the callback again on token refresh; the next successful POST
          // flips the flag. We intentionally don't track the partial state
          // (the UI stays in "checking" mode until the gate clears).
          if (response.ok) {
            markTurnstileReady();
          } else {
            console.warn(
              `[turnstile] verify endpoint returned ${response.status}; gated routes will keep returning 403 until the next challenge`,
            );
          }
        })
        .catch((err) => {
          // We intentionally do not surface the error to the UI; the gate
          // is best-effort. If verification fails the subsequent SSE calls
          // will simply be rejected with 403 and the user can refresh.
          console.warn("[turnstile] verify endpoint POST failed:", err);
        });
    };

    const run = async () => {
      try {
        await ensureScript();
        const api = await waitForTurnstile();
        if (cancelled) return;

        // Make sure the host element exists in the DOM. We append it lazily
        // (instead of rendering it from JSX) so a hot-reload that re-runs
        // the effect can't end up with two stale containers competing for
        // the same id.
        let container = document.getElementById(WIDGET_CONTAINER_ID);
        if (!container) {
          container = document.createElement("div");
          container.id = WIDGET_CONTAINER_ID;
          // Pinned to bottom-right, *with* room to grow. With `appearance:
          // "execute"` the widget stays 0×0 for trusted traffic — but when
          // Cloudflare escalates to an interactive challenge (typical on
          // mobile / unknown IP / first visit) it injects a ~300×65 iframe
          // and the user must be able to see and click it. We previously
          // pinned the container to 0×0 + overflow:hidden, which silently
          // dropped escalations and left the gate stuck on "Vérification…"
          // forever.
          container.style.position = "fixed";
          container.style.bottom = "16px";
          container.style.right = "16px";
          container.style.zIndex = "9999";
          document.body.appendChild(container);
        }

        const widgetId = api.render(`#${WIDGET_CONTAINER_ID}`, {
          sitekey: siteKey,
          // `size: "invisible"` is not a valid Turnstile parameter — the
          // Cloudflare widget throws `Invalid value for parameter "size"`
          // and refuses to render. The correct way to get an invisible
          // experience for non-suspicious traffic is `appearance: "execute"`
          // (challenge runs without UI) combined with the default size.
          // When Cloudflare escalates to an interactive challenge, the
          // widget will pop up — that's expected and rare.
          appearance: "execute",
          retry: "auto",
          "refresh-expired": "auto",
          callback: (token: string) => {
            submitToken(token);
          },
          "error-callback": () => {
            // Reset so a future user interaction (or auto-refresh) can
            // re-issue a challenge.
            try {
              if (widgetIdRef.current) {
                api.reset(widgetIdRef.current);
              }
            } catch {
              /* ignore */
            }
          },
          "expired-callback": () => {
            try {
              if (widgetIdRef.current) {
                api.reset(widgetIdRef.current);
              }
            } catch {
              /* ignore */
            }
          },
        });

        widgetIdRef.current = widgetId ?? null;
      } catch (err) {
        console.warn("[turnstile] init failed:", err);
      }
    };

    void run();

    return () => {
      cancelled = true;
      const api = typeof window !== "undefined" ? window.turnstile : undefined;
      if (api && widgetIdRef.current) {
        try {
          api.remove(widgetIdRef.current);
        } catch {
          /* ignore */
        }
      }
      widgetIdRef.current = null;
      mountedRef.current = false;
    };
  }, [siteKey]);

  return null;
}

export default TurnstileGate;
