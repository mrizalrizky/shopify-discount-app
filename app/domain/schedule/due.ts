import { DateTime } from "luxon";
import { expandRecurring, type RecurringSchedule } from "./recurring";

export type ScheduleKind = "manual" | "once" | "recurring";

export interface ScheduleSale {
  scheduleKind: ScheduleKind;
  startsAt: Date | null;
  endsAt: Date | null;
  recurring: RecurringSchedule | null;
  timezone: string;
}

/**
 * A run consumes its window: once a run exists for a window's start, that window is never
 * started again, whatever the run's outcome. A FAILED run therefore is not retried here
 * (runs only FAIL on overlap; transient errors keep the run open for the job queue to retry).
 */
export interface ScheduleRun {
  id: string;
  windowStart: Date;
  windowEnd: Date | null;
  /** PREPARING, APPLYING, ACTIVE or RESTORING. */
  open: boolean;
}

export type DueAction =
  | { kind: "start"; windowStart: Date; windowEnd: Date | null }
  | { kind: "stop"; runId: string }
  | { kind: "complete" };

/**
 * Decides what the scheduler should do for one sale at `now`.
 *
 * - Open runs whose `windowEnd <= now` get a `stop`.
 * - A `start` is emitted only when the window has no run yet (runs consume their window, see
 *   ScheduleRun) and no run of the sale is open. Editing the schedule while a run is open
 *   therefore never starts a second run over it; the new window starts on a later tick, after
 *   the open run has been stopped.
 * - `complete` is emitted only when no run is open.
 */
export function dueActions(sale: ScheduleSale, runs: readonly ScheduleRun[], now: Date): DueAction[] {
  const actions: DueAction[] = [];
  for (const run of runs) {
    if (run.open && run.windowEnd && run.windowEnd <= now) actions.push({ kind: "stop", runId: run.id });
  }
  const anyOpen = runs.some((r) => r.open);
  const hasRun = (start: Date) => runs.some((r) => r.windowStart.getTime() === start.getTime());

  switch (sale.scheduleKind) {
    case "manual":
      return actions;

    case "once": {
      if (!sale.startsAt) throw new Error("A one-time sale needs startsAt");
      const pastEnd = sale.endsAt !== null && now >= sale.endsAt;
      if (!anyOpen && !pastEnd && now >= sale.startsAt && !hasRun(sale.startsAt)) {
        actions.push({ kind: "start", windowStart: sale.startsAt, windowEnd: sale.endsAt });
      }
      if (!anyOpen && (pastEnd || hasRun(sale.startsAt))) actions.push({ kind: "complete" });
      return actions;
    }

    case "recurring": {
      if (!sale.recurring) throw new Error("A recurring sale needs a recurring schedule");
      const openWindows = expandRecurring(sale.recurring, sale.timezone, now, new Date(now.getTime() + 1));
      if (!anyOpen) {
        for (const window of openWindows) {
          if (!hasRun(window.start)) actions.push({ kind: "start", windowStart: window.start, windowEnd: window.end });
        }
      }
      const afterLastWindow = DateTime.fromISO(sale.recurring.lastDate, { zone: sale.timezone })
        .plus({ days: 2 })
        .toJSDate();
      if (!anyOpen && now >= afterLastWindow) actions.push({ kind: "complete" });
      return actions;
    }
  }
}
