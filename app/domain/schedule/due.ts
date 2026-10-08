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
      if (!pastEnd && now >= sale.startsAt && !hasRun(sale.startsAt)) {
        actions.push({ kind: "start", windowStart: sale.startsAt, windowEnd: sale.endsAt });
      }
      if (!anyOpen && (pastEnd || hasRun(sale.startsAt))) actions.push({ kind: "complete" });
      return actions;
    }

    case "recurring": {
      if (!sale.recurring) throw new Error("A recurring sale needs a recurring schedule");
      const openWindows = expandRecurring(sale.recurring, sale.timezone, now, new Date(now.getTime() + 1));
      for (const window of openWindows) {
        if (!hasRun(window.start)) actions.push({ kind: "start", windowStart: window.start, windowEnd: window.end });
      }
      const afterLastWindow = DateTime.fromISO(sale.recurring.lastDate, { zone: sale.timezone })
        .plus({ days: 2 })
        .toJSDate();
      if (!anyOpen && now >= afterLastWindow) actions.push({ kind: "complete" });
      return actions;
    }
  }
}
