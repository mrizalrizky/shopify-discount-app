import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney } from "./money";

describe("parseMoney", () => {
  it("parses Shopify decimal strings into minor units", () => {
    expect(parseMoney("149000.00")).toBe(14_900_000);
    expect(parseMoney("149000")).toBe(14_900_000);
    expect(parseMoney("149000.5")).toBe(14_900_050);
    expect(parseMoney(" 0.99 ")).toBe(99);
  });

  it("rejects invalid values", () => {
    expect(() => parseMoney("abc")).toThrow();
    expect(() => parseMoney("-1.00")).toThrow();
    expect(() => parseMoney("1.999")).toThrow();
    expect(() => parseMoney("")).toThrow();
  });
});

describe("formatMoney", () => {
  it("formats minor units as a Shopify decimal string", () => {
    expect(formatMoney(14_900_050)).toBe("149000.50");
    expect(formatMoney(0)).toBe("0.00");
    expect(formatMoney(5)).toBe("0.05");
  });

  it("rejects negative or fractional amounts", () => {
    expect(() => formatMoney(-1)).toThrow();
    expect(() => formatMoney(1.5)).toThrow();
  });

  it("round-trips", () => {
    expect(parseMoney(formatMoney(12_345_678))).toBe(12_345_678);
  });
});
