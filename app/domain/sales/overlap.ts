export interface SaleVariants {
  saleId: string;
  variantIds: ReadonlySet<string>;
}

export interface Overlap {
  saleId: string;
  variantIds: string[];
}

/** v1: a variant may belong to only one active or scheduled sale. */
export function findOverlaps(
  candidateVariantIds: Iterable<string>,
  otherSales: readonly SaleVariants[],
): Overlap[] {
  const candidates = [...new Set(candidateVariantIds)];
  return otherSales
    .map((sale) => ({
      saleId: sale.saleId,
      variantIds: candidates.filter((id) => sale.variantIds.has(id)).sort(),
    }))
    .filter((overlap) => overlap.variantIds.length > 0);
}
