import {
  calculateSalePrice,
  type PricingOptions,
  type SkipReason,
  type VariantPrice,
} from "../pricing/calculator";
import type { Money } from "../pricing/money";
import type { ResolvedVariant, RuleGroupInput } from "./resolver";

export type PlanSkipReason = SkipReason | "not_found" | "in_other_sale";

export interface PlannedChange {
  variantId: string;
  productId: string;
  ruleGroupId: string;
  originalPrice: Money;
  originalCompareAt: Money | null;
  newPrice: Money;
  newCompareAt: Money;
}

export interface SkippedVariant {
  variantId: string;
  productId: string;
  ruleGroupId: string;
  reason: PlanSkipReason;
}

export interface SalePlan {
  changes: PlannedChange[];
  skipped: SkippedVariant[];
}

export function computeSalePlan(
  groups: readonly RuleGroupInput[],
  resolved: readonly ResolvedVariant[],
  prices: ReadonlyMap<string, VariantPrice>,
  options: PricingOptions,
): SalePlan {
  const discounts = new Map(groups.map((g) => [g.id, g.discount]));
  const plan: SalePlan = { changes: [], skipped: [] };

  for (const variant of resolved) {
    const price = prices.get(variant.variantId);
    const discount = discounts.get(variant.ruleGroupId);
    if (!price || !discount) {
      plan.skipped.push({ ...variant, reason: "not_found" });
      continue;
    }
    const result = calculateSalePrice(price, discount, options);
    if (result.ok) {
      plan.changes.push({
        ...variant,
        originalPrice: price.price,
        originalCompareAt: price.compareAt,
        newPrice: result.newPrice,
        newCompareAt: result.newCompareAt,
      });
    } else {
      plan.skipped.push({ ...variant, reason: result.reason });
    }
  }
  return plan;
}
