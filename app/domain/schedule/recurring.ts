import { DateTime } from "luxon";

export interface RecurringSchedule {
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  weekdays: number[];
  /** "HH:mm" in the shop timezone. */
  startTime: string;
  /** "HH:mm"; at or before startTime means the window ends the next day. */
  stopTime: string;
  /** "YYYY-MM-DD": first date a window may start on. */
  firstDate: string;
  /** "YYYY-MM-DD": last date a window may start on (inclusive). */
  lastDate: string;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** Returns the windows that overlap [from, to), sorted by start. */
export function expandRecurring(
  schedule: RecurringSchedule,
  timezone: string,
  from: Date,
  to: Date,
): TimeWindow[] {
  const start = parseTime(schedule.startTime);
  const stop = parseTime(schedule.stopTime);
  const startMinutes = start.hour * 60 + start.minute;
  const stopMinutes = stop.hour * 60 + stop.minute;
  if (startMinutes === stopMinutes) throw new Error("startTime and stopTime must differ");
  const crossesMidnight = stopMinutes < startMinutes;

  if (schedule.weekdays.length === 0) throw new Error("Select at least one weekday");
  for (const day of schedule.weekdays) {
    if (!Number.isInteger(day) || day < 1 || day > 7) throw new Error(`Invalid weekday: ${day}`);
  }

  const firstDate = parseDate(schedule.firstDate);
  const lastDate = parseDate(schedule.lastDate);
  if (lastDate < firstDate) throw new Error("lastDate must not be before firstDate");

  // Iterate calendar dates (in UTC, so no DST shifts) rather than instants in
  // the shop zone: some zones skip midnight, which would shift every later day.
  // Start one day early so an overnight window that began yesterday is found.
  const scanFrom = calendarDate(DateTime.fromJSDate(from, { zone: timezone })).minus({ days: 1 });
  const scanTo = calendarDate(DateTime.fromJSDate(to, { zone: timezone }));
  let date = DateTime.max(firstDate, scanFrom);
  const lastScanDate = DateTime.min(lastDate, scanTo);

  const windows: TimeWindow[] = [];
  while (date <= lastScanDate) {
    if (schedule.weekdays.includes(date.weekday)) {
      const windowStart = atLocalTime(date, start, timezone);
      const windowEnd = atLocalTime(crossesMidnight ? date.plus({ days: 1 }) : date, stop, timezone);
      const startDate = windowStart.toJSDate();
      const endDate = windowEnd.toJSDate();
      // A start inside a skipped DST hour is pushed forward and can land after the end.
      const valid = endDate > startDate;
      if (valid && endDate > from && startDate < to) windows.push({ start: startDate, end: endDate });
    }
    date = date.plus({ days: 1 });
  }
  return windows;
}

function calendarDate(dateTime: DateTime): DateTime {
  return DateTime.fromObject(
    { year: dateTime.year, month: dateTime.month, day: dateTime.day },
    { zone: "UTC" },
  );
}

function atLocalTime(date: DateTime, time: { hour: number; minute: number }, timezone: string): DateTime {
  return DateTime.fromObject(
    { year: date.year, month: date.month, day: date.day, hour: time.hour, minute: time.minute },
    { zone: timezone },
  );
}

/** A missed start is applied only while its window is still open. */
export function shouldStartLate(window: TimeWindow, now: Date): boolean {
  return now >= window.start && now < window.end;
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid time "${value}", expected HH:mm`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Parses a calendar date as UTC midnight, used only for date arithmetic. */
function parseDate(value: string): DateTime {
  const date = DateTime.fromISO(value, { zone: "UTC" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !date.isValid) {
    throw new Error(`Invalid date "${value}", expected YYYY-MM-DD`);
  }
  return date;
}
