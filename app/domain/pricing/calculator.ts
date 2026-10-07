import type { Money } from "./money";
import { applyRounding, type RoundingRule } from "./rounding";

export type AmountType = "percentOff" | "fixedOff" | "fixedPrice";

/** `amount` is a percentage (0 < x <= 100) for percentOff, otherwise Money. */
export interface Discount {
  type: AmountType;
  amount: number;
}

export type PriceBase = "compareAt" | "current";

export interface VariantPrice {
  price: Money;
  compareAt: Money | null;
}

export interface PricingOptions {
  priceBase: PriceBase;
  rounding: RoundingRule;
  minPrice: Money | null;
}

export type SkipReason = "not_lower" | "non_positive";

export type PriceResult =
  | { ok: true; newPrice: Money; newCompareAt: Money }
  | { ok: false; reason: SkipReason };

export function calculateSalePrice(
  variant: VariantPrice,
  discount: Discount,
  options: PricingOptions,
): PriceResult {
  validateDiscount(discount);
  assertMoney(variant.price, "price");
  if (variant.compareAt !== null) assertMoney(variant.compareAt, "compareAt");
  if (options.minPrice !== null) assertMoney(options.minPrice, "minPrice");

  const hasValidCompareAt = variant.compareAt !== null && variant.compareAt > variant.price;
  const base =
    options.priceBase === "compareAt" && hasValidCompareAt ? variant.compareAt! : variant.price;

  let newPrice = applyRounding(discountedAmount(base, discount), options.rounding);
  if (options.minPrice !== null && newPrice < options.minPrice) newPrice = options.minPrice;

  if (newPrice <= 0) return { ok: false, reason: "non_positive" };
  if (newPrice >= variant.price) return { ok: false, reason: "not_lower" };

  const newCompareAt = hasValidCompareAt ? variant.compareAt! : variant.price;
  return { ok: true, newPrice, newCompareAt };
}

function discountedAmount(base: Money, discount: Discount): Money {
  switch (discount.type) {
    case "percentOff":
      return Math.round((base * (100 - discount.amount)) / 100);
    case "fixedOff":
      return base - discount.amount;
    case "fixedPrice":
      return discount.amount;
  }
}

function validateDiscount(discount: Discount): void {
  if (discount.type === "percentOff") {
    if (!(discount.amount > 0 && discount.amount <= 100)) {
      throw new Error(`Percentage must be in (0, 100], got ${discount.amount}`);
    }
    return;
  }
  assertMoney(discount.amount, "discount amount");
}

function assertMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer in minor units, got ${value}`);
  }
}
