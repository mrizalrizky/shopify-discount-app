import type { Prisma, Sale } from "@prisma/client";
import type { AmountType, PriceBase, PricingOptions, VariantPrice } from "../domain/pricing/calculator";
import type { RoundingRule } from "../domain/pricing/rounding";
import { computeSalePlan, type PlannedChange, type SalePlan } from "../domain/sales/plan";
import { resolveSale, type RuleGroupInput, type Target } from "../domain/sales/resolver";
import type { ShopifyGateway } from "../shopify/gateway";
import { moneyToDb, optionalMoneyFromDb, optionalMoneyToDb } from "./money-db";

export type SaleWithGroups = Prisma.SaleGetPayload<{ include: { ruleGroups: true } }>;

export function toRuleGroupInputs(sale: SaleWithGroups): RuleGroupInput[] {
  return [...sale.ruleGroups]
    .sort((a, b) => a.position - b.position)
    .map((g) => ({
      id: g.id,
      priority: g.priority,
      discount: { type: g.amountType as AmountType, amount: g.amount },
      targets: g.targets as unknown as Target[],
      exclusions: g.exclusions as unknown as Target[],
    }));
}

export function toPricingOptions(sale: Sale): PricingOptions {
  return {
    priceBase: sale.priceBase as PriceBase,
    rounding: sale.rounding as unknown as RoundingRule,
    minPrice: optionalMoneyFromDb(sale.minPrice),
  };
}

/**
 * Resolves the sale against the live catalog and prices each variant.
 * Variants marked by another run are skipped; variants marked by `runId`
 * are priced from their recorded originals (they are already discounted).
 */
export async function planForSale(
  gateway: ShopifyGateway,
  sale: SaleWithGroups,
  runId: string | null,
): Promise<SalePlan> {
  const groups = toRuleGroupInputs(sale);
  const catalog = await gateway.loadCatalog(groups.flatMap((g) => [...g.targets, ...g.exclusions]));
  const resolved = resolveSale(groups, catalog);
  const states = await gateway.getVariants(resolved.map((r) => r.variantId));

  const prices = new Map<string, VariantPrice>();
  const inOtherSale = new Set<string>();
  for (const r of resolved) {
    const state = states.get(r.variantId);
    if (!state) continue;
    if (state.marker && state.marker.runId !== runId) {
      inOtherSale.add(r.variantId);
    } else if (state.marker) {
      prices.set(r.variantId, { price: state.marker.originalPrice, compareAt: state.marker.originalCompareAt });
    } else {
      prices.set(r.variantId, { price: state.price, compareAt: state.compareAt });
    }
  }

  const plan = computeSalePlan(
    groups,
    resolved.filter((r) => !inOtherSale.has(r.variantId)),
    prices,
    toPricingOptions(sale),
  );
  for (const r of resolved) {
    if (inOtherSale.has(r.variantId)) plan.skipped.push({ ...r, reason: "in_other_sale" });
  }
  return plan;
}

export function toSnapshotRow(runId: string, change: PlannedChange): Prisma.PriceSnapshotCreateManyInput {
  return {
    runId,
    variantId: change.variantId,
    productId: change.productId,
    ruleGroupId: change.ruleGroupId,
    originalPrice: moneyToDb(change.originalPrice),
    originalCompareAt: optionalMoneyToDb(change.originalCompareAt),
    appliedPrice: moneyToDb(change.newPrice),
    appliedCompareAt: moneyToDb(change.newCompareAt),
  };
}
