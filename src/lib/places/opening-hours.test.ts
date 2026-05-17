import { describe, expect, it } from "vitest";

import { formatWeeklyOpeningHours, getOpeningHoursStatus } from "./opening-hours";

// 2026-05-17 is a Sunday (dow=0). We keep this fixed so the tests stay
// deterministic regardless of when they run.
const sundayAt = (h: number, m: number) => new Date(2026, 4, 17, h, m);
const fridayAt = (h: number, m: number) => new Date(2026, 4, 15, h, m);
const saturdayAt = (h: number, m: number) => new Date(2026, 4, 16, h, m);

describe("getOpeningHoursStatus", () => {
  it("returns knowable=false on empty / null / undefined spec", () => {
    expect(getOpeningHoursStatus("", sundayAt(12, 0)).knowable).toBe(false);
    expect(getOpeningHoursStatus(null, sundayAt(12, 0)).knowable).toBe(false);
    expect(getOpeningHoursStatus(undefined, sundayAt(12, 0)).knowable).toBe(false);
  });

  it("returns knowable=false on unparseable spec", () => {
    expect(getOpeningHoursStatus("garbage", sundayAt(12, 0)).knowable).toBe(false);
    // Pure month/year selectors we don't try to parse should be skipped, then
    // the whole spec produces no rules → unknowable.
    expect(getOpeningHoursStatus("Apr-Sep 09:00-18:00", sundayAt(12, 0)).knowable).toBe(false);
  });

  it("handles 24/7 as always open", () => {
    const r = getOpeningHoursStatus("24/7", sundayAt(3, 0));
    expect(r.isOpen).toBe(true);
    expect(r.todayLabel).toBe("Ouvert 24h/24");
  });

  it("flags Mo-Fr 08:00-22:00 as open on Friday at 14:30", () => {
    const r = getOpeningHoursStatus("Mo-Fr 08:00-22:00", fridayAt(14, 30));
    expect(r.knowable).toBe(true);
    expect(r.isOpen).toBe(true);
    expect(r.todayLabel).toBe("Ouvert 08:00–22:00");
  });

  it("flags weekdays-only spec as closed on Sunday and points at Monday", () => {
    const r = getOpeningHoursStatus("Mo-Fr 09:00-18:00", sundayAt(14, 0));
    expect(r.isOpen).toBe(false);
    expect(r.todayLabel).toBe("Fermé · ouvre demain 09:00");
  });

  it("points to the next open day even when not tomorrow", () => {
    // Saturday after-close, with Mo-Fr only → next open is Monday (skip Sunday).
    const r = getOpeningHoursStatus("Mo-Fr 09:00-18:00", saturdayAt(19, 0));
    expect(r.isOpen).toBe(false);
    expect(r.todayLabel).toBe("Fermé · ouvre lundi 09:00");
  });

  it("handles multi-interval days (lunch break) — closed between intervals", () => {
    const r = getOpeningHoursStatus("Mo-Su 08:00-12:00, 14:00-22:00", sundayAt(13, 0));
    expect(r.isOpen).toBe(false);
    expect(r.todayLabel).toBe("Fermé · ouvre à 14:00");
  });

  it("handles multi-rule spec with Su closed", () => {
    const r = getOpeningHoursStatus(
      "Mo-Fr 08:00-22:00; Sa 10:00-23:00; Su closed",
      sundayAt(14, 30),
    );
    expect(r.isOpen).toBe(false);
    // Tomorrow is Monday — first interval after closure is 08:00.
    expect(r.todayLabel).toBe("Fermé · ouvre demain 08:00");
  });

  it("clips past-midnight intervals to the same day (no carry-over)", () => {
    // "22:00-02:00" → treated as 22:00 to end-of-day on the rule's day.
    const r = getOpeningHoursStatus("Mo-Su 22:00-02:00", sundayAt(23, 0));
    expect(r.isOpen).toBe(true);
    expect(r.todayLabel).toBe("Ouvert 22:00–24:00");
  });

  it("reports closed status when before the first interval of the day", () => {
    const r = getOpeningHoursStatus("Mo-Fr 09:00-18:00", fridayAt(7, 0));
    expect(r.isOpen).toBe(false);
    expect(r.todayLabel).toBe("Fermé · ouvre à 09:00");
  });
});

describe("formatWeeklyOpeningHours", () => {
  it("returns null on empty / unparseable spec", () => {
    expect(formatWeeklyOpeningHours("")).toBe(null);
    expect(formatWeeklyOpeningHours("garbage")).toBe(null);
  });

  it("groups consecutive days with identical schedules", () => {
    const rows = formatWeeklyOpeningHours(
      "Mo-Fr 08:00-22:00; Sa 10:00-23:00; Su closed",
      1, // Monday
    );
    expect(rows).toEqual([
      { daysLabel: "Lun – Ven", intervals: ["08:00 – 22:00"], containsToday: true },
      { daysLabel: "Sam", intervals: ["10:00 – 23:00"], containsToday: false },
      { daysLabel: "Dim", intervals: null, containsToday: false },
    ]);
  });

  it("handles 24/7", () => {
    const rows = formatWeeklyOpeningHours("24/7", 3);
    expect(rows).toEqual([
      { daysLabel: "Lun – Dim", intervals: ["00:00 – 24:00"], containsToday: true },
    ]);
  });

  it("renders multi-interval days (lunch break)", () => {
    const rows = formatWeeklyOpeningHours("Mo-Su 08:00-12:00, 14:00-22:00", 0);
    expect(rows).toEqual([
      { daysLabel: "Lun – Dim", intervals: ["08:00 – 12:00", "14:00 – 22:00"], containsToday: true },
    ]);
  });

  it("flags only the current day's group with containsToday=true", () => {
    const rows = formatWeeklyOpeningHours("Mo-Fr 09:00-18:00; Sa-Su 10:00-16:00", 6); // Saturday
    expect(rows?.length).toBe(2);
    expect(rows?.[0].containsToday).toBe(false);
    expect(rows?.[1].containsToday).toBe(true);
    expect(rows?.[1].daysLabel).toBe("Sam – Dim");
  });
});
