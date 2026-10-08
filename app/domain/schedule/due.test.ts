import { describe, expect, it } from "vitest";
import { dueActions, type ScheduleRun, type ScheduleSale } from "./due";

const at = (iso: string) => new Date(iso);

const once: ScheduleSale = {
  scheduleKind: "once",
  startsAt: at("2026-11-06T12:00:00Z"),
  endsAt: at("2026-11-08T12:00:00Z"),
  recurring: null,
  timezone: "Asia/Jakarta",
};

const run = (patch: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: "r1",
  windowStart: at("2026-11-06T12:00:00Z"),
  windowEnd: at("2026-11-08T12:00:00Z"),
  open: true,
  ...patch,
});

describe("dueActions — once", () => {
  it("does nothing before the start", () => {
    expect(dueActions(once, [], at("2026-11-06T11:59:00Z"))).toEqual([]);
  });

  it("starts at or after the start time while the window is open", () => {
    expect(dueActions(once, [], at("2026-11-07T00:00:00Z"))).toEqual([
      { kind: "start", windowStart: once.startsAt, windowEnd: once.endsAt },
    ]);
  });

  it("does not start twice", () => {
    expect(dueActions(once, [run()], at("2026-11-07T00:00:00Z"))).toEqual([]);
  });

  it("stops the open run at the end", () => {
    expect(dueActions(once, [run()], at("2026-11-08T12:00:00Z"))).toEqual([{ kind: "stop", runId: "r1" }]);
  });

  it("completes once the run is closed", () => {
    expect(dueActions(once, [run({ open: false })], at("2026-11-08T12:01:00Z"))).toEqual([{ kind: "complete" }]);
  });

  it("never starts a sale whose whole window was missed, and completes it", () => {
    expect(dueActions(once, [], at("2026-11-09T00:00:00Z"))).toEqual([{ kind: "complete" }]);
  });

  it("a closed run consumes its window: no retry, and the sale completes", () => {
    const closed = run({ open: false });
    expect(dueActions(once, [closed], at("2026-11-07T00:00:00Z"))).toEqual([{ kind: "complete" }]);
  });

  it("does not start while an open run from a previous schedule exists", () => {
    const oldRun = run({ windowStart: at("2026-11-01T12:00:00Z"), windowEnd: at("2026-11-10T12:00:00Z") });
    const earlier = { ...once, startsAt: at("2026-11-05T12:00:00Z") };
    expect(dueActions(earlier, [oldRun], at("2026-11-06T00:00:00Z"))).toEqual([]);
    const later = { ...once, startsAt: at("2026-11-06T18:00:00Z") };
    expect(dueActions(later, [oldRun], at("2026-11-07T00:00:00Z"))).toEqual([]);
  });

  it("with no end date, completes only after its run is closed", () => {
    const openEnded = { ...once, endsAt: null };
    expect(dueActions(openEnded, [run({ windowEnd: null })], at("2026-12-01T00:00:00Z"))).toEqual([]);
    expect(dueActions(openEnded, [run({ windowEnd: null, open: false })], at("2026-12-01T00:00:00Z"))).toEqual([
      { kind: "complete" },
    ]);
  });
});

describe("dueActions — recurring", () => {
  const recurring: ScheduleSale = {
    scheduleKind: "recurring",
    startsAt: null,
    endsAt: null,
    timezone: "Asia/Jakarta",
    recurring: { weekdays: [5], startTime: "19:00", stopTime: "23:00", firstDate: "2026-11-06", lastDate: "2026-11-13" },
  };

  it("starts the window that is open now", () => {
    expect(dueActions(recurring, [], at("2026-11-06T13:00:00Z"))).toEqual([
      { kind: "start", windowStart: at("2026-11-06T12:00:00Z"), windowEnd: at("2026-11-06T16:00:00Z") },
    ]);
  });

  it("does nothing between windows", () => {
    const past = run({ windowStart: at("2026-11-06T12:00:00Z"), windowEnd: at("2026-11-06T16:00:00Z"), open: false });
    expect(dueActions(recurring, [past], at("2026-11-09T00:00:00Z"))).toEqual([]);
  });

  it("stops a window at its end", () => {
    const current = run({ windowStart: at("2026-11-06T12:00:00Z"), windowEnd: at("2026-11-06T16:00:00Z") });
    expect(dueActions(recurring, [current], at("2026-11-06T16:00:00Z"))).toEqual([{ kind: "stop", runId: "r1" }]);
  });

  it("returns only the stop for an expired open run, starting the new window on a later tick", () => {
    const oldRun = run({ windowStart: at("2026-11-06T12:00:00Z"), windowEnd: at("2026-11-06T16:00:00Z") });
    expect(dueActions(recurring, [oldRun], at("2026-11-13T13:00:00Z"))).toEqual([{ kind: "stop", runId: "r1" }]);
  });

  it("completes after the last date", () => {
    expect(dueActions(recurring, [], at("2026-11-16T00:00:00Z"))).toEqual([{ kind: "complete" }]);
  });
});

describe("dueActions — manual", () => {
  it("never schedules anything", () => {
    const manual: ScheduleSale = { scheduleKind: "manual", startsAt: null, endsAt: null, recurring: null, timezone: "Asia/Jakarta" };
    expect(dueActions(manual, [run({ windowEnd: null })], at("2030-01-01T00:00:00Z"))).toEqual([]);
  });
});
