/**
 * Debug-only mode override hook.
 *
 * Listens for global keyboard shortcuts to force the overlay render mode,
 * bypassing the LOD strategy. Intended for visual A/B comparisons while
 * developing — gated behind `NODE_ENV === "development"` so it never fires
 * in production builds.
 *
 *   Shift + B → force-bitmap
 *   Shift + V → force-vector
 *   Shift + R → reset (strategy-driven)
 *
 * The hook returns the current override and a setter. The component wires
 * the override into `selectRenderStrategy`'s output (overriding `mode` if
 * the override is non-null) and renders a badge showing the effective mode.
 *
 * The keyboard listener is split out of the hook into a separate function so
 * tests can drive the state machine without a real `window` — see
 * `use-mode-override.test.ts`.
 */

import { useEffect, useState } from "react";

import type { RenderMode } from "./render-strategy";

export type ModeOverride = RenderMode | null;

/**
 * Pure state transition. Given the current override and a keyboard event,
 * returns the new override (or `undefined` if the event is irrelevant — the
 * caller should leave state unchanged).
 *
 * Exposed for unit testing without a DOM.
 */
export function reduceModeOverrideKey(
  event: { key: string; shiftKey: boolean },
): ModeOverride | undefined {
  if (!event.shiftKey) return undefined;
  // Compare case-insensitively (shifted key may be "B" or "b" depending on
  // platform / event source).
  const k = event.key.toLowerCase();
  if (k === "b") return "bitmap";
  if (k === "v") return "vector";
  if (k === "r") return null;
  return undefined;
}

export interface UseModeOverrideOptions {
  /** Allow the hook to be active in non-dev builds. Defaults to false
   *  (strict NODE_ENV gating). Tests use this to bypass the env check. */
  forceEnable?: boolean;
}

export function useModeOverride(
  opts: UseModeOverrideOptions = {},
): [ModeOverride, (override: ModeOverride) => void] {
  const [override, setOverride] = useState<ModeOverride>(null);
  const enabled =
    opts.forceEnable === true ||
    (typeof process !== "undefined" && process.env?.NODE_ENV === "development");

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    const handler = (e: KeyboardEvent) => {
      const next = reduceModeOverrideKey(e);
      if (next !== undefined) {
        setOverride(next);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);

  return [override, setOverride];
}
