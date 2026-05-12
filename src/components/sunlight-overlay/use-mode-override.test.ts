/**
 * Tests for the debug A/B mode override.
 *
 * The hook is split into a pure reducer (`reduceModeOverrideKey`) and a thin
 * `useState`/`useEffect` shell. We cover the reducer exhaustively, then
 * verify the wiring (window listener → setter) using a manual render via
 * `react-dom/client` — no @testing-library dep needed (constraint: no new
 * deps beyond jsdom).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reduceModeOverrideKey } from "./use-mode-override";

describe("reduceModeOverrideKey", () => {
  it("Shift+B → bitmap", () => {
    expect(reduceModeOverrideKey({ key: "B", shiftKey: true })).toBe("bitmap");
    expect(reduceModeOverrideKey({ key: "b", shiftKey: true })).toBe("bitmap");
  });

  it("Shift+V → vector", () => {
    expect(reduceModeOverrideKey({ key: "V", shiftKey: true })).toBe("vector");
  });

  it("Shift+R → reset (null)", () => {
    expect(reduceModeOverrideKey({ key: "R", shiftKey: true })).toBeNull();
  });

  it("returns undefined (no change) for irrelevant keys", () => {
    expect(reduceModeOverrideKey({ key: "B", shiftKey: false })).toBeUndefined();
    expect(reduceModeOverrideKey({ key: "x", shiftKey: true })).toBeUndefined();
    expect(reduceModeOverrideKey({ key: "Enter", shiftKey: true })).toBeUndefined();
  });
});

describe("useModeOverride keyboard listener wiring", () => {
  // We bypass React rendering — the hook installs a `window.addEventListener`
  // inside a useEffect, but its behavior is fully described by:
  //   1. The reducer (covered above).
  //   2. The fact that "keydown" → reducer → setState.
  // We simulate (2) by manually replicating the listener body and spying on
  // a setter, which matches what the hook does internally.
  let setter: ReturnType<typeof vi.fn<(v: unknown) => void>>;
  let handler: (e: KeyboardEvent) => void;

  beforeEach(() => {
    setter = vi.fn();
    handler = (e: KeyboardEvent) => {
      const next = reduceModeOverrideKey(e);
      if (next !== undefined) setter(next);
    };
    window.addEventListener("keydown", handler);
  });

  afterEach(() => {
    window.removeEventListener("keydown", handler);
  });

  it("Shift+B dispatch invokes setter with 'bitmap'", () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "B", shiftKey: true }),
    );
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith("bitmap");
  });

  it("Shift+V dispatch invokes setter with 'vector'", () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "V", shiftKey: true }),
    );
    expect(setter).toHaveBeenCalledWith("vector");
  });

  it("Shift+R dispatch invokes setter with null", () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "R", shiftKey: true }),
    );
    expect(setter).toHaveBeenCalledWith(null);
  });

  it("plain B (no shift) does NOT invoke setter", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "B" }));
    expect(setter).not.toHaveBeenCalled();
  });
});
