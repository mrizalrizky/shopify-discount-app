import { describe, expect, it } from "vitest";
import { applyRounding } from "./rounding";

const RP = (rupiah: number) => rupiah * 100;

describe("applyRounding", () => {
  it("leaves the amount unchanged for 'none'", () => {
    expect(applyRounding(RP(149_250), { kind: "none" })).toBe(RP(149_250));
  });

  it("rounds down to a step", () => {
    const rule = { kind: "roundDown", step: RP(1_000) } as const;
    expect(applyRounding(RP(149_250), rule)).toBe(RP(149_000));
    expect(applyRounding(RP(149_000), rule)).toBe(RP(149_000));
    expect(applyRounding(RP(999), rule)).toBe(0);
  });

  it("rounds down to the nearest amount with the given ending", () => {
    const rule = { kind: "endsWith", ending: RP(900), modulus: RP(1_000) } as const;
    expect(applyRounding(RP(149_250), rule)).toBe(RP(148_900));
    expect(applyRounding(RP(149_950), rule)).toBe(RP(149_900));
    expect(applyRounding(RP(149_900), rule)).toBe(RP(149_900));
  });

  it("never rounds up: an amount below the ending goes negative", () => {
    const rule = { kind: "endsWith", ending: RP(900), modulus: RP(1_000) } as const;
    expect(applyRounding(RP(500), rule)).toBeLessThan(0);
  });

  it("rejects invalid rules", () => {
    expect(() => applyRounding(100, { kind: "roundDown", step: 0 })).toThrow();
    expect(() => applyRounding(100, { kind: "endsWith", ending: 1000, modulus: 1000 })).toThrow();
    expect(() => applyRounding(100, { kind: "endsWith", ending: -1, modulus: 1000 })).toThrow();
  });
});
