import type { Money } from "../app/domain/pricing/money";
import type { CatalogIndex, Target } from "../app/domain/sales/resolver";
import type { PriceWrite, ShopifyGateway, VariantState } from "../app/shopify/gateway";

/** In-memory Shopify. `failAfterWrites` simulates a crash after N successful price writes. */
export class FakeShopify implements ShopifyGateway {
  variants = new Map<string, VariantState>();
  collections = new Map<string, string[]>();
  tags = new Map<string, string[]>();
  writeCount = 0;
  failAfterWrites: number | null = null;

  addVariant(variantId: string, productId: string, price: Money, compareAt: Money | null = null) {
    this.variants.set(variantId, { variantId, productId, price, compareAt, marker: null });
  }

  setCollection(collectionId: string, productIds: string[]) {
    this.collections.set(collectionId, productIds);
  }

  setTags(productId: string, tags: string[]) {
    this.tags.set(productId, [...tags]);
  }

  async loadCatalog(targets: readonly Target[]): Promise<CatalogIndex> {
    const collectionProducts = new Map<string, string[]>();
    for (const t of targets) {
      if (t.kind === "collection") collectionProducts.set(t.id, [...(this.collections.get(t.id) ?? [])]);
    }
    const productVariants = new Map<string, string[]>();
    for (const v of this.variants.values()) {
      productVariants.set(v.productId, [...(productVariants.get(v.productId) ?? []), v.variantId]);
    }
    return { collectionProducts, productVariants };
  }

  async getVariants(variantIds: readonly string[]) {
    const result = new Map<string, VariantState>();
    for (const id of variantIds) {
      const v = this.variants.get(id);
      if (v) result.set(id, { ...v, marker: v.marker ? { ...v.marker } : null });
    }
    return result;
  }

  async writePrices(productId: string, writes: readonly PriceWrite[]) {
    if (this.failAfterWrites !== null && this.writeCount >= this.failAfterWrites) {
      throw new Error("simulated crash");
    }
    for (const w of writes) {
      const v = this.variants.get(w.variantId);
      if (!v || v.productId !== productId) throw new Error(`Unknown variant ${w.variantId}`);
      v.price = w.price;
      v.compareAt = w.compareAt;
      if (w.marker) v.marker = { ...w.marker };
    }
    this.writeCount++;
  }

  async clearMarkers(variantIds: readonly string[]) {
    for (const id of variantIds) {
      const v = this.variants.get(id);
      if (v) v.marker = null;
    }
  }

  async getProductTags(productIds: readonly string[]) {
    return new Map(productIds.map((id) => [id, [...(this.tags.get(id) ?? [])]]));
  }

  async addTags(productId: string, tags: readonly string[]) {
    const current = this.tags.get(productId) ?? [];
    this.tags.set(productId, [...current, ...tags.filter((t) => !current.includes(t))]);
  }

  async removeTags(productId: string, tags: readonly string[]) {
    this.tags.set(productId, (this.tags.get(productId) ?? []).filter((t) => !tags.includes(t)));
  }
}
