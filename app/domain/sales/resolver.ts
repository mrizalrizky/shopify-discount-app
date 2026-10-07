import type { Discount } from "../pricing/calculator";

export type TargetKind = "collection" | "product" | "variant";

export interface Target {
  kind: TargetKind;
  id: string;
}

export interface RuleGroupInput {
  id: string;
  priority: number;
  discount: Discount;
  targets: Target[];
  exclusions: Target[];
}

/** Catalog membership fetched from Shopify before resolution. */
export interface CatalogIndex {
  collectionProducts: ReadonlyMap<string, readonly string[]>;
  productVariants: ReadonlyMap<string, readonly string[]>;
}

export interface ResolvedVariant {
  variantId: string;
  productId: string;
  ruleGroupId: string;
}

const SPECIFICITY: Record<TargetKind, number> = { collection: 1, product: 2, variant: 3 };

interface Claim {
  groupIndex: number;
  specificity: number;
  priority: number;
}

/**
 * Assigns each targeted variant to exactly one rule group.
 * Precedence: variant > product > collection, then lower priority number,
 * then earlier group.
 */
export function resolveSale(
  groups: readonly RuleGroupInput[],
  catalog: CatalogIndex,
): ResolvedVariant[] {
  const productOf = new Map<string, string>();
  for (const [productId, variantIds] of catalog.productVariants) {
    for (const variantId of variantIds) productOf.set(variantId, productId);
  }

  const claims = new Map<string, Claim>();
  groups.forEach((group, groupIndex) => {
    const excluded = new Set(group.exclusions.flatMap((t) => expandTarget(t, catalog)));
    for (const target of group.targets) {
      const claim = { groupIndex, specificity: SPECIFICITY[target.kind], priority: group.priority };
      for (const variantId of expandTarget(target, catalog)) {
        if (excluded.has(variantId) || !productOf.has(variantId)) continue;
        const current = claims.get(variantId);
        if (!current || beats(claim, current)) claims.set(variantId, claim);
      }
    }
  });

  return [...claims]
    .map(([variantId, claim]) => ({
      variantId,
      productId: productOf.get(variantId)!,
      ruleGroupId: groups[claim.groupIndex].id,
    }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
}

function beats(a: Claim, b: Claim): boolean {
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.groupIndex < b.groupIndex;
}

function expandTarget(target: Target, catalog: CatalogIndex): string[] {
  switch (target.kind) {
    case "variant":
      return [target.id];
    case "product":
      return [...(catalog.productVariants.get(target.id) ?? [])];
    case "collection":
      return (catalog.collectionProducts.get(target.id) ?? []).flatMap(
        (productId) => catalog.productVariants.get(productId) ?? [],
      );
  }
}
