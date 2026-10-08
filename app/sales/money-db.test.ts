import { describe, expect, it } from "vitest";
import { moneyFromDb, moneyToDb, optionalMoneyFromDb, optionalMoneyToDb } from "./money-db";

describe("money-db", () => {
  it("converts between BigInt columns and Money", () => {
    expect(moneyFromDb(14_900_000n)).toBe(14_900_000);
    expect(moneyToDb(14_900_000)).toBe(14_900_000n);
    expect(optionalMoneyFromDb(null)).toBeNull();
    expect(optionalMoneyToDb(null)).toBeNull();
    expect(optionalMoneyToDb(5)).toBe(5n);
  });

  it("refuses values that are not safe integers", () => {
    expect(() => moneyFromDb(2n ** 60n)).toThrow();
    expect(() => moneyToDb(1.5)).toThrow();
    expect(() => moneyToDb(Number.NaN)).toThrow();
  });
});
