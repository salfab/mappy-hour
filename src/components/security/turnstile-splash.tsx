"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { useTurnstileReady } from "@/lib/security/use-turnstile-ready";

/**
 * Splash screen displayed while the Cloudflare Turnstile challenge is still
 * running on mount. Disappears with a fade-out the moment `useTurnstileReady`
 * flips to `true` (either after a successful `/api/turnstile/verify` POST
 * or, in dev/no-keys mode, almost immediately when `<TurnstileGate>` mounts
 * and short-circuits the flag).
 *
 * Visual choices
 * --------------
 * - Background: the existing OG hero (`/og/mappy-hour-v2.jpg`, ~165 KB)
 *   served via `next/image` with `priority` so it counts as the LCP element.
 *   `fill + object-cover` lets it span the viewport without aspect-ratio
 *   distortion. The image is landscape (~1200×630); on portrait mobile the
 *   sides get cropped, which is fine — the focal subject sits near the
 *   center/top of the frame.
 * - Dark overlay (slate-900 gradient) layered on top for text contrast
 *   without killing the image's natural warmth.
 * - Title in Fraunces (`--font-display`) to match the editorial display
 *   typography used elsewhere on the site (date panel, design lab).
 * - Minimal three-dot pulse spinner — no bouncing animations, no fancy
 *   gradients, no shimmer. The whole interstitial only lives for 1–3 s.
 *
 * Z-index
 * -------
 * Sits at `z-9000`, deliberately **below** the Turnstile widget container
 * (`#mh-turnstile-container`, `z-index:9999`). If Cloudflare escalates to
 * an interactive challenge (rare; mobile / unknown IP / first visit) the
 * widget's iframe pops above the splash and the user can click it. The
 * footer note tells them this can happen.
 *
 * Cloudflare badge visibility
 * ---------------------------
 * Once `ready === true`, we hide `#mh-turnstile-container` with
 * `display:none` (kept in the DOM so Cloudflare can reuse it for
 * `retry: "auto"` / expired token refresh). Crucially we do **not** hide
 * it while `ready === false`: that's exactly the window where Cloudflare
 * may need to surface an interactive challenge.
 */

const FADE_OUT_MS = 400;
const TURNSTILE_CONTAINER_ID = "mh-turnstile-container";

export function TurnstileSplash(): React.ReactElement | null {
  const ready = useTurnstileReady();
  // `mounted` flips to `false` after the fade-out completes, then sets
  // `display:none` so the overlay no longer participates in compositing
  // (saves a fullscreen GPU layer once the user is on the real page).
  const [mounted, setMounted] = useState(true);
  // Tracks whether the consumer has hydrated. Until then we keep the splash
  // visible to match SSR markup — `useTurnstileReady()` always returns
  // `false` server-side, so this is consistent.
  const hydratedRef = useRef(false);

  useEffect(() => {
    hydratedRef.current = true;
  }, []);

  // Toggle the Cloudflare widget container's visibility based on `ready`.
  // We never remove the node — Cloudflare retains a reference and reuses
  // it for the `retry: "auto"` / `refresh-expired` flows.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const container = document.getElementById(TURNSTILE_CONTAINER_ID);
    if (!container) return;
    if (ready) {
      container.style.display = "none";
    } else {
      // Reset to empty so any inline rule we set earlier doesn't override
      // Turnstile's own positioning (`position:fixed; bottom:16px; ...` is
      // applied via `container.style.*` in <TurnstileGate>, but those
      // properties are independent from `display`).
      container.style.display = "";
    }
  }, [ready]);

  // Schedule the unmount once `ready` flips, with a tiny grace period so
  // the opacity transition has time to play before the node disappears.
  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => {
      setMounted(false);
    }, FADE_OUT_MS + 50);
    return () => window.clearTimeout(id);
  }, [ready]);

  if (!mounted) return null;

  return (
    <div
      aria-hidden={ready ? "true" : "false"}
      // role="status" so screen readers announce the loading state. Once
      // `ready` flips we drop the role to let the focus return to the
      // underlying page.
      role={ready ? undefined : "status"}
      className={[
        "fixed inset-0",
        // z-9000 < 9999 (TurnstileGate container) so an interactive challenge
        // can pop above the splash if Cloudflare escalates.
        "z-[9000]",
        "flex items-center justify-center",
        "transition-opacity duration-[400ms] ease-out",
        ready ? "opacity-0 pointer-events-none" : "opacity-100",
      ].join(" ")}
    >
      {/* Background image — fills the viewport, cropped on portrait. */}
      <div className="absolute inset-0 overflow-hidden">
        <Image
          src="/og/mappy-hour-v2.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />
      </div>

      {/* Dark overlay for text contrast. A gradient (top darker than the
          bottom) keeps the image's warm tones visible at the base while
          giving the headline enough contrast against the brighter sky in
          the upper half of the OG image. */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-slate-950/75 via-slate-950/55 to-slate-950/70"
        aria-hidden="true"
      />

      {/* Content */}
      <div className="relative z-10 mx-6 flex max-w-md flex-col items-center text-center text-stone-50">
        <p className="font-[var(--font-display)] text-xs uppercase tracking-[0.4em] text-amber-200/80">
          Bienvenue
        </p>
        <h1 className="mt-3 font-[var(--font-display)] text-5xl font-light leading-none tracking-tight text-stone-50 md:text-6xl">
          Mappy Hour
        </h1>
        <p className="mt-4 font-[var(--font-display)] text-base italic text-stone-200/90 md:text-lg">
          Trouve les terrasses au soleil.
        </p>

        {/* Status line + spinner */}
        <div className="mt-10 flex flex-col items-center gap-3">
          <ThreeDotsSpinner />
          <p className="text-xs uppercase tracking-[0.28em] text-stone-200/70">
            Vérification anti-bot en cours
          </p>
        </div>
      </div>

      {/* Footer note — explains the optional interactive challenge. */}
      <p className="absolute inset-x-6 bottom-6 text-center text-[11px] leading-relaxed text-stone-300/70 md:text-xs">
        Une vérification Cloudflare peut apparaître ci-dessous —
        cliquez si nécessaire pour continuer.
      </p>
    </div>
  );
}

/**
 * Three dots that pulse in sequence. Pure CSS via Tailwind's built-in
 * `animate-pulse`, staggered with inline `animationDelay`. Subtle enough
 * to not draw attention but still signals "something is happening" — and
 * costs effectively zero (no JS animation loop, no SVG).
 */
function ThreeDotsSpinner(): React.ReactElement {
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block h-2 w-2 rounded-full bg-amber-300/90 animate-pulse"
          style={{ animationDelay: `${i * 180}ms`, animationDuration: "1200ms" }}
        />
      ))}
    </div>
  );
}

export default TurnstileSplash;
