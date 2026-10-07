import { describe, expect, it } from "vitest";
import { expandRecurring, shouldStartLate, type RecurringSchedule } from "./recurring";

const JAKARTA = "Asia/Jakarta";
const iso = (d: Date) => d.toISOString();
const span = (w: { start: Date; end: Date }) => [iso(w.start), iso(w.end)];

const fridaySaturdayEvenings: RecurringSchedule = {
  weekdays: [5, 6],
  startTime: "19:00",
  stopTime: "23:00",
  firstDate: "2026-11-06",
  lastDate: "2026-11-14",
};

describe("expandRecurring", () => {
  it("creates one window per selected weekday in the shop timezone", () => {
    const windows = expandRecurring(
      fridaySaturdayEvenings,
      JAKARTA,
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-12-01T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([
      ["2026-11-06T12:00:00.000Z", "2026-11-06T16:00:00.000Z"],
      ["2026-11-07T12:00:00.000Z", "2026-11-07T16:00:00.000Z"],
      ["2026-11-13T12:00:00.000Z", "2026-11-13T16:00:00.000Z"],
      ["2026-11-14T12:00:00.000Z", "2026-11-14T16:00:00.000Z"],
    ]);
  });

  it("handles windows that cross midnight, including one starting on lastDate", () => {
    const windows = expandRecurring(
      { weekdays: [5], startTime: "22:00", stopTime: "02:00", firstDate: "2026-11-06", lastDate: "2026-11-13" },
      JAKARTA,
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-12-01T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([
      ["2026-11-06T15:00:00.000Z", "2026-11-06T19:00:00.000Z"],
      ["2026-11-13T15:00:00.000Z", "2026-11-13T19:00:00.000Z"],
    ]);
  });

  it("includes a window already in progress at 'from' and excludes ones outside the range", () => {
    const windows = expandRecurring(
      fridaySaturdayEvenings,
      JAKARTA,
      new Date("2026-11-07T14:00:00Z"), // mid-way through Saturday's window
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([["2026-11-07T12:00:00.000Z", "2026-11-07T16:00:00.000Z"]]);
  });

  it("includes an overnight window from the previous day still open at 'from'", () => {
    const windows = expandRecurring(
      { weekdays: [5], startTime: "22:00", stopTime: "02:00", firstDate: "2026-11-06", lastDate: "2026-11-06" },
      JAKARTA,
      new Date("2026-11-06T18:00:00Z"), // 01:00 WIB on Saturday
      new Date("2026-11-08T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([["2026-11-06T15:00:00.000Z", "2026-11-06T19:00:00.000Z"]]);
  });

  it("follows daylight-saving changes in zones that have them", () => {
    const windows = expandRecurring(
      { weekdays: [7], startTime: "09:00", stopTime: "17:00", firstDate: "2026-03-01", lastDate: "2026-03-08" },
      "America/New_York",
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([
      ["2026-03-01T14:00:00.000Z", "2026-03-01T22:00:00.000Z"], // EST, UTC-5
      ["2026-03-08T13:00:00.000Z", "2026-03-08T21:00:00.000Z"], // EDT, UTC-4
    ]);
  });

  it("rejects invalid schedules", () => {
    const from = new Date("2026-11-01T00:00:00Z");
    const to = new Date("2026-12-01T00:00:00Z");
    const bad = (patch: Partial<RecurringSchedule>) =>
      expandRecurring({ ...fridaySaturdayEvenings, ...patch }, JAKARTA, from, to);
    expect(() => bad({ startTime: "19:00", stopTime: "19:00" })).toThrow();
    expect(() => bad({ lastDate: "2026-11-01" })).toThrow();
    expect(() => bad({ weekdays: [0] })).toThrow();
    expect(() => bad({ weekdays: [] })).toThrow();
    expect(() => bad({ startTime: "25:00" })).toThrow();
    expect(() => bad({ firstDate: "2026-13-01" })).toThrow();
  });
});

describe("shouldStartLate", () => {
  const window = { start: new Date("2026-11-06T12:00:00Z"), end: new Date("2026-11-06T16:00:00Z") };

  it("is true while the window is open", () => {
    expect(shouldStartLate(window, new Date("2026-11-06T12:00:00Z"))).toBe(true);
    expect(shouldStartLate(window, new Date("2026-11-06T15:59:00Z"))).toBe(true);
  });

  it("is false before the start or once the window has ended", () => {
    expect(shouldStartLate(window, new Date("2026-11-06T11:59:00Z"))).toBe(false);
    expect(shouldStartLate(window, new Date("2026-11-06T16:00:00Z"))).toBe(false);
  });
});
