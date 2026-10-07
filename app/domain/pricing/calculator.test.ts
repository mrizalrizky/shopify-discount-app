import { describe, expect, it } from "vitest";
import { calculateSalePrice, type PricingOptions } from "./calculator";

const RP = (rupiah: number) => rupiah * 100;
const plain: PricingOptions = { priceBase: "compareAt", rounding: { kind: "none" }, minPrice: null };

describe("calculateSalePrice", () => {
  it("takes 30% off the compare-at price when priceBase is compareAt", () => {
    const result = calculateSalePrice(
      { price: RP(400_000), compareAt: RP(500_000) },
      { type: "percentOff", amount: 30 },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(350_000), newCompareAt: RP(500_000) });
  });

  it("takes 30% off the current price when priceBase is current", () => {
    const result = calculateSalePrice(
      { price: RP(400_000), compareAt: RP(500_000) },
      { type: "percentOff", amount: 30 },
      { ...plain, priceBase: "current" },
    );
    expect(result).toEqual({ ok: true, newPrice: RP(280_000), newCompareAt: RP(500_000) });
  });

  it("uses the price as crossed-out price when there is no compare-at", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "percentOff", amount: 20 },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(160_000), newCompareAt: RP(200_000) });
  });

  it("ignores a compare-at that is not above the price (bad data)", () => {
    const result = calculateSalePrice(
      { price: RP(400_000), compareAt: RP(350_000) },
      { type: "percentOff", amount: 50 },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(200_000), newCompareAt: RP(400_000) });
  });

  it("applies a fixed amount off", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "fixedOff", amount: RP(50_000) },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(150_000), newCompareAt: RP(200_000) });
  });

  it("sets a fixed final price", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "fixedPrice", amount: RP(99_000) },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(99_000), newCompareAt: RP(200_000) });
  });

  it("rounds after discounting", () => {
    const result = calculateSalePrice(
      { price: RP(149_900), compareAt: null },
      { type: "percentOff", amount: 30 },
      { ...plain, rounding: { kind: "roundDown", step: RP(1_000) } },
    );
    expect(result).toEqual({ ok: true, newPrice: RP(104_000), newCompareAt: RP(149_900) });
  });

  it("raises the result to the minimum price", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "percentOff", amount: 90 },
      { ...plain, minPrice: RP(50_000) },
    );
    expect(result).toEqual({ ok: true, newPrice: RP(50_000), newCompareAt: RP(200_000) });
  });

  it("supports 100% off plus a minimum price as a fixed sale price", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "percentOff", amount: 100 },
      { ...plain, minPrice: RP(99_000) },
    );
    expect(result).toEqual({ ok: true, newPrice: RP(99_000), newCompareAt: RP(200_000) });
  });

  describe("skip rules", () => {
    it("skips when a fixed price is not lower than the current price", () => {
      const result = calculateSalePrice(
        { price: RP(200_000), compareAt: null },
        { type: "fixedPrice", amount: RP(250_000) },
        plain,
      );
      expect(result).toEqual({ ok: false, reason: "not_lower" });
    });

    it("skips when a discount off compare-at is still above the current price", () => {
      const result = calculateSalePrice(
        { price: RP(400_000), compareAt: RP(500_000) },
        { type: "percentOff", amount: 10 },
        plain,
      );
      expect(result).toEqual({ ok: false, reason: "not_lower" });
    });

    it("skips when the minimum price is not lower than the current price", () => {
      const result = calculateSalePrice(
        { price: RP(200_000), compareAt: null },
        { type: "percentOff", amount: 50 },
        { ...plain, minPrice: RP(250_000) },
      );
      expect(result).toEqual({ ok: false, reason: "not_lower" });
    });

    it("skips when a fixed amount off exceeds the price", () => {
      const result = calculateSalePrice(
        { price: RP(40_000), compareAt: null },
        { type: "fixedOff", amount: RP(50_000) },
        plain,
      );
      expect(result).toEqual({ ok: false, reason: "non_positive" });
    });

    it("skips 100% off without a minimum price", () => {
      const result = calculateSalePrice(
        { price: RP(200_000), compareAt: null },
        { type: "percentOff", amount: 100 },
        plain,
      );
      expect(result).toEqual({ ok: false, reason: "non_positive" });
    });

    it("skips when rounding to an ending drops below zero", () => {
      const result = calculateSalePrice(
        { price: RP(1_000), compareAt: null },
        { type: "percentOff", amount: 50 },
        { ...plain, rounding: { kind: "endsWith", ending: RP(900), modulus: RP(1_000) } },
      );
      expect(result).toEqual({ ok: false, reason: "non_positive" });
    });
  });

  describe("input validation", () => {
    it("rejects a percentage outside (0, 100]", () => {
      const v = { price: RP(100_000), compareAt: null };
      expect(() => calculateSalePrice(v, { type: "percentOff", amount: 0 }, plain)).toThrow();
      expect(() => calculateSalePrice(v, { type: "percentOff", amount: 101 }, plain)).toThrow();
    });

    it("rejects negative or fractional money amounts", () => {
      const v = { price: RP(100_000), compareAt: null };
      expect(() => calculateSalePrice(v, { type: "fixedOff", amount: -1 }, plain)).toThrow();
      expect(() => calculateSalePrice(v, { type: "fixedPrice", amount: 1.5 }, plain)).toThrow();
    });
  });
});
