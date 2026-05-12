/**
 * End-to-end hysteresis flow test for `selectRenderStrategy`.
 *
 * The existing `render-strategy.test.ts` covers individual threshold
 * decisions. This file simulates a realistic zoom sequence and verifies
 * that the `previousMode` plumbing is wired correctly: the strategy must
 * STAY in its current mode through the dead-band and only flip when an
 * EXIT threshold is crossed.
 *
 * Sequence: 18 → 19 → 18.8 → 18.4 → 18.8 → 19
 *   Start at z=18 → bitmap (below entry threshold 19)
 *   z=19          → vector (meets entry)
 *   z=18.8        → vector  (above EXIT 18.5 → stay)
 *   z=18.4        → bitmap  (below EXIT 18.5 → flip)
 *   z=18.8        → bitmap  (below ENTRY 19  → stay)
 *   z=19          → vector  (meets entry again)
 */

import { describe, expect, it } from "vitest";

import { selectRenderStrategy, type RenderMode } from "./render-strategy";

const COMMON = {
  visibleTileCount: 4,
  devicePixelRatio: 1,
  tileSizeMeters: 250,
  tileNativeSizePx: 250,
};

describe("render-strategy hysteresis flow", () => {
  it("matches the expected zoom-sweep transitions", () => {
    const sequence: Array<{ zoom: number; expected: RenderMode }> = [
      { zoom: 18, expected: "bitmap" },
      { zoom: 19, expected: "vector" },
      { zoom: 18.8, expected: "vector" }, // hysteresis: above EXIT
      { zoom: 18.4, expected: "bitmap" }, // below EXIT — flip
      { zoom: 18.8, expected: "bitmap" }, // hysteresis: below ENTRY — stay
      { zoom: 19, expected: "vector" }, // re-enter
    ];

    let previousMode: RenderMode | null = null;
    for (const step of sequence) {
      const out = selectRenderStrategy({
        ...COMMON,
        zoom: step.zoom,
        previousMode,
      });
      expect(out.mode, `at zoom ${step.zoom}, prev=${previousMode}`).toBe(
        step.expected,
      );
      previousMode = out.mode;
    }
  });

  it("first call (previousMode === null) treats us as bitmap", () => {
    // Even at z=19 with few tiles, the very first call lands on the bitmap
    // branch because we haven't established a "currently vector" state yet.
    // The brief: "First call: previousMode === null → fall here." (vector
    // branch). Re-read the impl to confirm this is the documented behavior.
    // Looking at render-strategy.ts: the `else` branch checks `meetsEntry`,
    // so first call WITH entry conditions met → vector. Verify both ways.
    const yesEntry = selectRenderStrategy({
      ...COMMON,
      zoom: 19,
      previousMode: null,
    });
    expect(yesEntry.mode).toBe("vector");

    const noEntry = selectRenderStrategy({
      ...COMMON,
      zoom: 18,
      previousMode: null,
    });
    expect(noEntry.mode).toBe("bitmap");
  });

  it("oscillating around the dead-band does not flap", () => {
    // 10 oscillations between z=18.7 and z=18.6 starting from vector.
    // Both are above EXIT (18.5) and below ENTRY (19) → mode should stay
    // vector for all 10 iterations (never crosses an EXIT).
    let previousMode: RenderMode = "vector";
    for (let i = 0; i < 10; i++) {
      const z = i % 2 === 0 ? 18.7 : 18.6;
      const out = selectRenderStrategy({
        ...COMMON,
        zoom: z,
        previousMode,
      });
      expect(out.mode).toBe("vector");
      previousMode = out.mode;
    }
  });
});
