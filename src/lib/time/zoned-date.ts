interface DateParts {
  year: number;
  month: number;
  day: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timeZone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  formatterCache.set(timeZone, formatter);
  return formatter;
}

function parseDateInput(value: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date format "${value}". Expected YYYY-MM-DD.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const check = new Date(Date.UTC(year, month - 1, day));
  const valid =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;

  if (!valid) {
    throw new Error(`Invalid calendar date "${value}".`);
  }

  return { year, month, day };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = getFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const record: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      record[part.type] = part.value;
    }
  }

  const asUtc = Date.UTC(
    Number(record.year),
    Number(record.month) - 1,
    Number(record.day),
    Number(record.hour),
    Number(record.minute),
    Number(record.second),
  );

  return (asUtc - date.getTime()) / 60_000;
}

function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);

  const firstOffset = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
  let adjustedTimestamp = utcGuess - firstOffset * 60_000;

  const secondOffset = getTimeZoneOffsetMinutes(
    new Date(adjustedTimestamp),
    timeZone,
  );
  if (secondOffset !== firstOffset) {
    adjustedTimestamp = utcGuess - secondOffset * 60_000;
  }

  return new Date(adjustedTimestamp);
}

export function getZonedDayRangeUtc(
  dateInput: string,
  timeZone: string,
): { startUtc: Date; endUtc: Date } {
  const parsed = parseDateInput(dateInput);
  const startUtc = zonedTimeToUtc(
    parsed.year,
    parsed.month,
    parsed.day,
    0,
    0,
    0,
    timeZone,
  );

  const nextDayUtc = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0),
  );
  nextDayUtc.setUTCDate(nextDayUtc.getUTCDate() + 1);

  const endUtc = zonedTimeToUtc(
    nextDayUtc.getUTCFullYear(),
    nextDayUtc.getUTCMonth() + 1,
    nextDayUtc.getUTCDate(),
    0,
    0,
    0,
    timeZone,
  );

  return { startUtc, endUtc };
}
