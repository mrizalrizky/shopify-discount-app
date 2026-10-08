import type { CatalogIndex, Target } from "../domain/sales/resolver";
import { formatMoney, parseMoney, type Money } from "../domain/pricing/money";

export const MARKER_NAMESPACE = "$app";
export const MARKER_KEY = "sale_state";

/** Stored on each variant while it is on sale: marker for the Function + copy of originals. */
export interface SaleMarker {
  saleId: string;
  runId: string;
  originalPrice: Money;
  originalCompareAt: Money | null;
}

export interface VariantState {
  variantId: string;
  productId: string;
  price: Money;
  compareAt: Money | null;
  marker: SaleMarker | null;
}

export interface PriceWrite {
  variantId: string;
  price: Money;
  compareAt: Money | null;
  /** Set to write the sale marker metafield; omit to leave it untouched. */
  marker?: SaleMarker;
}

export interface ShopifyGateway {
  loadCatalog(targets: readonly Target[]): Promise<CatalogIndex>;
  getVariants(variantIds: readonly string[]): Promise<Map<string, VariantState>>;
  writePrices(productId: string, writes: readonly PriceWrite[]): Promise<void>;
  clearMarkers(variantIds: readonly string[]): Promise<void>;
  getProductTags(productIds: readonly string[]): Promise<Map<string, string[]>>;
  addTags(productId: string, tags: readonly string[]): Promise<void>;
  removeTags(productId: string, tags: readonly string[]): Promise<void>;
}

export function serializeMarker(marker: SaleMarker): string {
  return JSON.stringify({
    saleId: marker.saleId,
    runId: marker.runId,
    originalPrice: formatMoney(marker.originalPrice),
    originalCompareAt: marker.originalCompareAt === null ? null : formatMoney(marker.originalCompareAt),
  });
}

export function parseMarker(value: string | null | undefined): SaleMarker | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value);
    if (typeof raw.saleId !== "string" || typeof raw.runId !== "string") return null;
    return {
      saleId: raw.saleId,
      runId: raw.runId,
      originalPrice: parseMoney(raw.originalPrice),
      originalCompareAt: raw.originalCompareAt === null ? null : parseMoney(raw.originalCompareAt),
    };
  } catch {
    return null;
  }
}
