/**
 * Lightweight OSM `opening_hours` parser, sized to handle the ~95% of real
 * specs we see in the wild without pulling the 150 kB `opening_hours` npm
 * package. Supports:
 *   - day specs:   "Mo", "Tu", "We", "Th", "Fr", "Sa", "Su", "PH" (treated
 *                  as no-op), ranges like "Mo-Fr", lists like "Mo,We,Fr"
 *   - times:       "HH:MM-HH:MM" (multiple intervals allowed: "08:00-12:00,14:00-22:00")
 *                  Past-midnight intervals like "22:00-02:00" are clipped to
 *                  the same day (we don't carry over to the next day).
 *   - keywords:    "24/7" (always open), "off" / "closed" (explicit close)
 *   - rule sep:    ";" between top-level rules; "," between days/intervals
 *   - "PH"/months/weeks/exceptions: ignored gracefully (rules we can't parse
 *                  are skipped — never throw).
 *
 * If parsing fails or the spec is too exotic, `getOpeningHoursStatus`
 * returns `{ knowable: false }` so callers can fall back to "horaires non
 * renseignés" rather than display garbage.
 */

const DAY_INDEX: Record<string, number> = {
  Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 0,
};
const DAY_LABEL_FR: Record<number, string> = {
  0: "Dimanche", 1: "Lundi", 2: "Mardi", 3: "Mercredi",
  4: "Jeudi", 5: "Vendredi", 6: "Samedi",
};

interface TimeInterval {
  /** Minutes since midnight, inclusive. */
  startMin: number;
  /** Minutes since midnight, exclusive. */
  endMin: number;
}

interface DaySchedule {
  /** null when explicitly closed for the day. */
  intervals: TimeInterval[] | null;
}

type WeekSchedule = Record<number, DaySchedule | undefined>;

function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 28 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function expandDaySpec(spec: string): number[] {
  // Comma list at the top, then each token is either a single day or "Day-Day"
  const out = new Set<number>();
  for (const token of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (token === "PH" || token === "SH") continue; // ignored
    const range = /^([A-Z][a-z])-([A-Z][a-z])$/.exec(token);
    if (range) {
      const a = DAY_INDEX[range[1]];
      const b = DAY_INDEX[range[2]];
      if (a === undefined || b === undefined) return [];
      // Walk forward (handling Sa-Mo wrap if a > b).
      let cur = a;
      // OSM convention: Mo-Fr means Mo,Tu,We,Th,Fr (5 days).
      for (let i = 0; i < 7; i++) {
        out.add(cur);
        if (cur === b) break;
        cur = (cur + 1) % 7;
      }
      continue;
    }
    const single = DAY_INDEX[token];
    if (single !== undefined) out.add(single);
  }
  return Array.from(out);
}

function parseIntervals(spec: string): TimeInterval[] | null {
  if (spec === "off" || spec === "closed") return null;
  const out: TimeInterval[] = [];
  for (const range of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (range === "off" || range === "closed") continue;
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(range);
    if (!m) return null;
    const startMin = parseHHMM(m[1]);
    const endMin = parseHHMM(m[2]);
    if (startMin === null || endMin === null) return null;
    // Clip past-midnight intervals (22:00-02:00) to same day (22:00-24:00).
    const clippedEnd = endMin <= startMin ? 24 * 60 : endMin;
    out.push({ startMin, endMin: clippedEnd });
  }
  return out;
}

function parseOpeningHours(spec: string): WeekSchedule | null {
  if (!spec || typeof spec !== "string") return null;
  const trimmed = spec.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "24/7") {
    const all: WeekSchedule = {};
    for (let d = 0; d < 7; d++) {
      all[d] = { intervals: [{ startMin: 0, endMin: 24 * 60 }] };
    }
    return all;
  }
  const out: WeekSchedule = {};
  let parsedAtLeastOne = false;
  for (const rule of trimmed.split(";").map((s) => s.trim()).filter(Boolean)) {
    // Skip rules with year/month/week selectors we cannot parse.
    if (/\d{4}/.test(rule) || /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(rule)) {
      continue;
    }
    // Split into "days times" or just "times" (= every day).
    const dayTimeMatch = /^([A-Z][a-z](?:[-,][A-Z][a-z])*(?:,[A-Z][a-z](?:-[A-Z][a-z])?)*)\s+(.+)$/.exec(rule);
    let days: number[];
    let timeSpec: string;
    if (dayTimeMatch) {
      days = expandDaySpec(dayTimeMatch[1]);
      timeSpec = dayTimeMatch[2].trim();
    } else if (/^[A-Z][a-z]([-,][A-Z][a-z])*\s*(off|closed)$/.test(rule)) {
      const parts = rule.split(/\s+/);
      days = expandDaySpec(parts[0]);
      timeSpec = parts[1];
    } else if (rule === "off" || rule === "closed") {
      days = [0, 1, 2, 3, 4, 5, 6];
      timeSpec = "off";
    } else {
      // Bare time like "08:00-22:00" (means every day).
      days = [0, 1, 2, 3, 4, 5, 6];
      timeSpec = rule;
    }
    if (days.length === 0) continue;
    const intervals = parseIntervals(timeSpec);
    // intervals === null means parse error OR explicit closed.
    if (intervals === null && timeSpec !== "off" && timeSpec !== "closed") {
      continue; // unparseable time, skip rule
    }
    parsedAtLeastOne = true;
    for (const d of days) {
      out[d] = { intervals };
    }
  }
  return parsedAtLeastOne ? out : null;
}

function formatInterval(iv: TimeInterval): string {
  const fmt = (m: number) => {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  return `${fmt(iv.startMin)}–${fmt(iv.endMin)}`;
}

export interface OpeningHoursStatus {
  /** False when the spec was unparseable or empty — display "non renseigné". */
  knowable: boolean;
  /** True when the current time falls inside one of today's intervals. */
  isOpen: boolean;
  /**
   * Compact label for today's hours. Examples:
   *   "Ouvert 08:00–22:00"
   *   "Ouvert 08:00–12:00, 14:00–22:00"
   *   "Fermé · ouvre demain 10:00"
   *   "Fermé aujourd'hui"
   *   "Ouvert 24h/24"
   */
  todayLabel: string;
}

/**
 * Compute the open/closed status of a place at the given local Date.
 * Returns `knowable: false` whenever the spec cannot be parsed (unknown
 * keywords, exotic month/year selectors, malformed input). Callers should
 * render "horaires non renseignés" in that case.
 */
export function getOpeningHoursStatus(
  spec: string | null | undefined,
  now: Date,
): OpeningHoursStatus {
  if (!spec) return { knowable: false, isOpen: false, todayLabel: "" };
  const week = parseOpeningHours(spec);
  if (!week) return { knowable: false, isOpen: false, todayLabel: "" };
  const dow = now.getDay();
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const today = week[dow];

  // 24/7 fast-path
  const isAlwaysOpen = Object.values(week).every(
    (d) =>
      d?.intervals?.length === 1 &&
      d.intervals[0].startMin === 0 &&
      d.intervals[0].endMin === 24 * 60,
  );
  if (isAlwaysOpen) {
    return { knowable: true, isOpen: true, todayLabel: "Ouvert 24h/24" };
  }

  if (!today || today.intervals === null) {
    // Closed today — point at the next open day if any
    for (let i = 1; i <= 7; i++) {
      const nextDow = (dow + i) % 7;
      const next = week[nextDow];
      if (next?.intervals && next.intervals.length > 0) {
        const dayLabel = i === 1 ? "demain" : DAY_LABEL_FR[nextDow].toLowerCase();
        return {
          knowable: true,
          isOpen: false,
          todayLabel: `Fermé · ouvre ${dayLabel} ${formatTime(next.intervals[0].startMin)}`,
        };
      }
    }
    return { knowable: true, isOpen: false, todayLabel: "Fermé aujourd'hui" };
  }

  const activeNow = today.intervals.find(
    (iv) => iv.startMin <= minutesNow && minutesNow < iv.endMin,
  );
  const labelHours = today.intervals.map(formatInterval).join(", ");
  if (activeNow) {
    return { knowable: true, isOpen: true, todayLabel: `Ouvert ${labelHours}` };
  }
  // Closed right now but the place opens later today
  const upcoming = today.intervals.find((iv) => iv.startMin > minutesNow);
  if (upcoming) {
    return {
      knowable: true,
      isOpen: false,
      todayLabel: `Fermé · ouvre à ${formatTime(upcoming.startMin)}`,
    };
  }
  // Past last interval of the day
  return { knowable: true, isOpen: false, todayLabel: `Fermé · horaires ${labelHours}` };
}

function formatTime(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
