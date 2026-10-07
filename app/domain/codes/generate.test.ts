import { describe, expect, it } from "vitest";
import {
  codeAlphabet,
  codeCapacity,
  generateCodes,
  needsLongerCodes,
  type GeneratorOptions,
} from "./generate";

const base: GeneratorOptions = { prefix: "GDI23-OL", length: 3, charset: "both", excludeLookalikes: false };

/** Deterministic randomInt that walks 0, 1, 2, ... modulo max. */
function sequence() {
  let next = 0;
  return (max: number) => next++ % max;
}

describe("codeAlphabet / codeCapacity", () => {
  it("builds the alphabet for each charset", () => {
    expect(codeAlphabet({ ...base, charset: "letters" })).toHaveLength(26);
    expect(codeAlphabet({ ...base, charset: "numbers" })).toBe("0123456789");
    expect(codeAlphabet(base)).toHaveLength(36);
  });

  it("removes look-alike characters", () => {
    const alphabet = codeAlphabet({ ...base, excludeLookalikes: true });
    expect(alphabet).toHaveLength(31);
    for (const ch of "0O1IL") expect(alphabet).not.toContain(ch);
  });

  it("computes capacity", () => {
    expect(codeCapacity(base)).toBe(36 ** 3);
    expect(codeCapacity({ ...base, charset: "letters" })).toBe(17_576);
  });
});

describe("needsLongerCodes", () => {
  it("warns when the request is more than 10% of capacity", () => {
    expect(needsLongerCodes(500, base)).toBe(false); // capacity 46,656
    expect(needsLongerCodes(10_000, base)).toBe(true);
  });
});

describe("generateCodes", () => {
  it("generates the requested number of unique, prefixed codes", () => {
    const codes = generateCodes(500, base, new Set());
    expect(codes).toHaveLength(500);
    expect(new Set(codes).size).toBe(500);
    for (const code of codes) expect(code).toMatch(/^GDI23-OL[A-Z0-9]{3}$/);
  });

  it("never uses look-alike characters when excluded", () => {
    const codes = generateCodes(300, { ...base, prefix: "", length: 6, excludeLookalikes: true }, new Set());
    for (const code of codes) expect(code).not.toMatch(/[0O1IL]/);
  });

  it("skips codes that already exist, case-insensitively", () => {
    const options: GeneratorOptions = { prefix: "p", length: 1, charset: "numbers", excludeLookalikes: false };
    const existing = new Set(["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]);
    expect(generateCodes(1, options, existing, sequence())).toEqual(["p9"]);
  });

  it("throws when the requested count exceeds the available combinations", () => {
    const options: GeneratorOptions = { prefix: "X", length: 1, charset: "numbers", excludeLookalikes: false };
    expect(() => generateCodes(11, options, new Set())).toThrow(/longer/);
    expect(() => generateCodes(2, options, new Set(["X0", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8"]))).toThrow(
      /longer/,
    );
  });

  it("rejects invalid options", () => {
    expect(() => generateCodes(1, { ...base, length: 0 }, new Set())).toThrow();
    expect(() => generateCodes(1, { ...base, prefix: "HAS SPACE" }, new Set())).toThrow();
    expect(() => generateCodes(1, { ...base, prefix: "A".repeat(254), length: 3 }, new Set())).toThrow();
  });
});
