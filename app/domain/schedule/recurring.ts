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

  const firstDate = parseDate(schedule.firstDate, timezone);
  const lastDate = parseDate(schedule.lastDate, timezone);
  if (lastDate < firstDate) throw new Error("lastDate must not be before firstDate");

  // Start one day early so an overnight window that began yesterday is found.
  const scanFrom = DateTime.fromJSDate(from, { zone: timezone }).startOf("day").minus({ days: 1 });
  const scanTo = DateTime.fromJSDate(to, { zone: timezone }).startOf("day");
  let day = DateTime.max(firstDate, scanFrom);
  const lastDay = DateTime.min(lastDate, scanTo);

  const windows: TimeWindow[] = [];
  while (day <= lastDay) {
    if (schedule.weekdays.includes(day.weekday)) {
      const windowStart = day.set({ ...start, second: 0, millisecond: 0 });
      const windowEnd = (crossesMidnight ? day.plus({ days: 1 }) : day).set({
        ...stop,
        second: 0,
        millisecond: 0,
      });
      const startDate = windowStart.toJSDate();
      const endDate = windowEnd.toJSDate();
      if (endDate > from && startDate < to) windows.push({ start: startDate, end: endDate });
    }
    day = day.plus({ days: 1 });
  }
  return windows;
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

function parseDate(value: string, timezone: string): DateTime {
  const date = DateTime.fromISO(value, { zone: timezone });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !date.isValid) {
    throw new Error(`Invalid date "${value}", expected YYYY-MM-DD`);
  }
  return date.startOf("day");
}
