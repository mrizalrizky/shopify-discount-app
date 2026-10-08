import { describe, expect, it } from "vitest";
import type { PricingOptions } from "../pricing/calculator";
import { computeSalePlan } from "./plan";
import type { RuleGroupInput } from "./resolver";

const RP = (rupiah: number) => rupiah * 100;
const options: PricingOptions = { priceBase: "compareAt", rounding: { kind: "none" }, minPrice: null };

const groups: RuleGroupInput[] = [
  { id: "g30", priority: 1, discount: { type: "percentOff", amount: 30 }, targets: [], exclusions: [] },
  { id: "gFixed", priority: 1, discount: { type: "fixedPrice", amount: RP(99_000) }, targets: [], exclusions: [] },
];

describe("computeSalePlan", () => {
  it("prices each variant with its own group's discount", () => {
    const plan = computeSalePlan(
      groups,
      [
        { variantId: "v1", productId: "p1", ruleGroupId: "g30" },
        { variantId: "v2", productId: "p2", ruleGroupId: "gFixed" },
      ],
      new Map([
        ["v1", { price: RP(200_000), compareAt: null }],
        ["v2", { price: RP(150_000), compareAt: RP(180_000) }],
      ]),
      options,
    );
    expect(plan.changes).toEqual([
      {
        variantId: "v1", productId: "p1", ruleGroupId: "g30",
        originalPrice: RP(200_000), originalCompareAt: null,
        newPrice: RP(140_000), newCompareAt: RP(200_000),
      },
      {
        variantId: "v2", productId: "p2", ruleGroupId: "gFixed",
        originalPrice: RP(150_000), originalCompareAt: RP(180_000),
        newPrice: RP(99_000), newCompareAt: RP(180_000),
      },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("reports skipped variants with the calculator's reason", () => {
    const plan = computeSalePlan(
      groups,
      [{ variantId: "v1", productId: "p1", ruleGroupId: "gFixed" }],
      new Map([["v1", { price: RP(90_000), compareAt: null }]]),
      options,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([{ variantId: "v1", productId: "p1", ruleGroupId: "gFixed", reason: "not_lower" }]);
  });

  it("reports variants with no price data as not_found", () => {
    const plan = computeSalePlan(groups, [{ variantId: "gone", productId: "p1", ruleGroupId: "g30" }], new Map(), options);
    expect(plan.skipped).toEqual([{ variantId: "gone", productId: "p1", ruleGroupId: "g30", reason: "not_found" }]);
  });
});
