import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetForTests as resetActiveSse,
  increment as incrementActiveSse,
} from "@/lib/observability/active-sse";
import {
  __resetForTests as resetWarnings,
  getRecentWarnings,
  recordIfWarning,
  type SystemSnapshot,
} from "@/lib/observability/cpu-warnings";

/**
 * Build a minimal snapshot with a static timestamp. Tests override only
 * the fields relevant to the rule under test.
 */
function buildSnapshot(overrides: Partial<{
  maxCorePercent: number;
  coreCount: number;
  loadAvg1m: number | null;
  timestamp: string;
}> = {}): SystemSnapshot {
  const {
    maxCorePercent = 50,
    coreCount = 4,
    loadAvg1m = 0.5,
    timestamp = "2026-05-16T10:00:00.000Z",
  } = overrides;
  return {
    timestamp,
    cpu: {
      maxCorePercent,
      coreCount,
      loadAvg:
        loadAvg1m === null
          ? null
          : { oneMin: loadAvg1m, fiveMin: loadAvg1m, fifteenMin: loadAvg1m },
    },
  };
}

describe("recordIfWarning", () => {
  beforeEach(() => {
    resetWarnings();
    resetActiveSse();
  });

  afterEach(() => {
    resetWarnings();
    resetActiveSse();
  });

  it("returns null when SSE activity is below the floor (no concurrent load)", () => {
    incrementActiveSse("timeline-stream");
    const result = recordIfWarning(
      buildSnapshot({ maxCorePercent: 95, loadAvg1m: 10 }),
      { now: () => 1_000 },
    );
    expect(result).toBeNull();
    expect(getRecentWarnings()).toHaveLength(0);
  });

  it("returns null when CPU under threshold and loadavg under core count", () => {
    incrementActiveSse("timeline-stream");
    incrementActiveSse("places-viewport");
    const result = recordIfWarning(
      buildSnapshot({ maxCorePercent: 50, coreCount: 4, loadAvg1m: 1 }),
      { now: () => 1_000 },
    );
    expect(result).toBeNull();
    expect(getRecentWarnings()).toHaveLength(0);
  });

  it("records a cpu-high warning when CPU > 75 and SSE >= 2", () => {
    incrementActiveSse("timeline-stream");
    incrementActiveSse("places-viewport");
    const result = recordIfWarning(
      buildSnapshot({ maxCorePercent: 87.3, coreCount: 4, loadAvg1m: 1 }),
      { now: () => 1_000 },
    );
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("cpu-high");
    expect(result?.cpuMaxCorePercent).toBe(87.3);
    expect(result?.activeSseTotal).toBe(2);
    expect(result?.activeSseByRoute).toEqual({
      "timeline-stream": 1,
      "places-viewport": 1,
    });
    expect(getRecentWarnings()).toHaveLength(1);
  });

  it("records loadavg-high when load > cores but CPU under threshold", () => {
    incrementActiveSse("timeline-stream");
    incrementActiveSse("places-viewport");
    const result = recordIfWarning(
      buildSnapshot({ maxCorePercent: 30, coreCount: 4, loadAvg1m: 5.2 }),
      { now: () => 1_000 },
    );
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("loadavg-high");
    expect(result?.loadAvg1m).toBe(5.2);
  });

  it("records 'both' when CPU and loadavg are both over threshold", () => {
    incrementActiveSse("timeline-stream");
    incrementActiveSse("places-viewport");
    const result = recordIfWarning(
      buildSnapshot({ maxCorePercent: 92, coreCount: 4, loadAvg1m: 6 }),
      { now: () => 1_000 },
    );
    expect(result?.reason).toBe("both");
  });

  it("coalesces consecutive samples inside the 5s window", () => {
    incrementActiveSse("timeline-stream");
    incrementActiveSse("places-viewport");
    const snap = buildSnapshot({ maxCorePercent: 90, coreCount: 4, loadAvg1m: 1 });

    expect(
      recordIfWarning(snap, { now: () => 1_000 }),
    ).not.toBeNull();
    // 2s later — still hot, still inside 5s window: must not be recorded.
    expect(
      recordIfWarning(snap, { now: () => 3_000 }),
    ).toBeNull();
    // 4.9s later — boundary still inside the window.
    expect(
      recordIfWarning(snap, { now: () => 5_900 }),
    ).toBeNull();
    expect(getRecentWarnings()).toHaveLength(1);

    // 5.1s later — first rafale closed, this counts as a new event.
    expect(
      recordIfWarning(snap, { now: () => 6_200 }),
    ).not.toBeNull();
    expect(getRecentWarnings()).toHaveLength(2);
  });

  it("treats loadavg=null (Windows) as missing and falls back to CPU-only", () => {
    incrementActiveSse("timeline-stream");
    incrementActiveSse("places-viewport");
    const result = recordIfWarning(
      buildSnapshot({ maxCorePercent: 80, coreCount: 4, loadAvg1m: null }),
      { now: () => 1_000 },
    );
    expect(result?.reason).toBe("cpu-high");
    expect(result?.loadAvg1m).toBeNull();
  });

  it("keeps the buffer bounded at 50 entries", () => {
    incrementActiveSse("timeline-stream");
    incrementActiveSse("places-viewport");
    // 60 distinct over-threshold events, each 10s apart so the coalesce
    // window doesn't drop them.
    for (let i = 0; i < 60; i++) {
      recordIfWarning(
        buildSnapshot({
          maxCorePercent: 90,
          coreCount: 4,
          loadAvg1m: 1,
          timestamp: `2026-05-16T10:00:${String(i).padStart(2, "0")}.000Z`,
        }),
        { now: () => i * 10_000 },
      );
    }
    expect(getRecentWarnings()).toHaveLength(50);
    // Newest first: index 59 was the last pushed.
    expect(getRecentWarnings(1)[0].timestamp).toBe("2026-05-16T10:00:59.000Z");
  });

  it("returns warnings newest-first and respects the limit argument", () => {
    incrementActiveSse("timeline-stream");
    incrementActiveSse("places-viewport");
    recordIfWarning(
      buildSnapshot({
        maxCorePercent: 90,
        timestamp: "2026-05-16T10:00:00.000Z",
      }),
      { now: () => 0 },
    );
    recordIfWarning(
      buildSnapshot({
        maxCorePercent: 91,
        timestamp: "2026-05-16T10:00:10.000Z",
      }),
      { now: () => 10_000 },
    );
    recordIfWarning(
      buildSnapshot({
        maxCorePercent: 92,
        timestamp: "2026-05-16T10:00:20.000Z",
      }),
      { now: () => 20_000 },
    );
    const top2 = getRecentWarnings(2);
    expect(top2.map((w) => w.timestamp)).toEqual([
      "2026-05-16T10:00:20.000Z",
      "2026-05-16T10:00:10.000Z",
    ]);
  });
});
