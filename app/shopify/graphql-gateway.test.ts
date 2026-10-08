import { describe, expect, it, vi } from "vitest";
import { serializeMarker } from "./gateway";
import {
  createGraphqlGateway,
  ShopifyGraphqlError,
  withThrottleRetry,
  type GraphqlFn,
} from "./graphql-gateway";

type Handler = (vars: any) => any;

function scripted(handlers: Record<string, Handler>) {
  const calls: { name: string; vars: any }[] = [];
  const fn: GraphqlFn = async (query, vars) => {
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)![1];
    calls.push({ name, vars });
    const handler = handlers[name];
    if (!handler) throw new Error(`Unexpected operation ${name}`);
    return handler(vars);
  };
  return { fn, calls };
}

const page = (ids: string[], endCursor: string | null) => ({
  nodes: ids.map((id) => ({ id })),
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

describe("createGraphqlGateway", () => {
  it("loads collection products across pages, then each product's variants", async () => {
    const { fn } = scripted({
      CollectionProducts: (v) => ({
        collection: { products: v.after ? page(["p2"], null) : page(["p1"], "c1") },
      }),
      VariantProducts: () => ({ nodes: [{ id: "v9", product: { id: "p3" } }] }),
      ProductVariants: (v) => ({ product: { variants: page([`${v.id}-a`, `${v.id}-b`], null) } }),
    });
    const catalog = await createGraphqlGateway(fn).loadCatalog([
      { kind: "collection", id: "col" },
      { kind: "variant", id: "v9" },
    ]);
    expect(catalog.collectionProducts.get("col")).toEqual(["p1", "p2"]);
    expect([...catalog.productVariants.keys()].sort()).toEqual(["p1", "p2", "p3"]);
    expect(catalog.productVariants.get("p1")).toEqual(["p1-a", "p1-b"]);
  });

  it("maps variant prices and the sale marker", async () => {
    const marker = { saleId: "s1", runId: "r1", originalPrice: 20_000_000, originalCompareAt: null };
    const { fn } = scripted({
      VariantStates: () => ({
        nodes: [
          {
            id: "v1",
            price: "140000.00",
            compareAtPrice: "200000.00",
            product: { id: "p1" },
            metafield: { value: serializeMarker(marker) },
          },
          { id: "v2", price: "50000.00", compareAtPrice: null, product: { id: "p1" }, metafield: null },
          null,
        ],
      }),
    });
    const states = await createGraphqlGateway(fn).getVariants(["v1", "v2", "deleted"]);
    expect(states.get("v1")).toEqual({
      variantId: "v1", productId: "p1", price: 14_000_000, compareAt: 20_000_000, marker,
    });
    expect(states.get("v2")?.marker).toBeNull();
    expect(states.has("deleted")).toBe(false);
  });

  it("writes formatted prices and the marker metafield only when given", async () => {
    const { fn, calls } = scripted({
      VariantsBulkUpdate: () => ({ productVariantsBulkUpdate: { userErrors: [] } }),
    });
    await createGraphqlGateway(fn).writePrices("p1", [
      { variantId: "v1", price: 14_000_000, compareAt: 20_000_000,
        marker: { saleId: "s", runId: "r", originalPrice: 20_000_000, originalCompareAt: null } },
      { variantId: "v2", price: 5_000_000, compareAt: null },
    ]);
    const variants = calls[0].vars.variants;
    expect(calls[0].vars.productId).toBe("p1");
    expect(variants[0]).toMatchObject({ id: "v1", price: "140000.00", compareAtPrice: "200000.00" });
    expect(variants[0].metafields[0]).toMatchObject({ namespace: "$app", key: "sale_state", type: "json" });
    expect(variants[1]).toEqual({ id: "v2", price: "50000.00", compareAtPrice: null });
  });

  it("throws on user errors", async () => {
    const { fn } = scripted({
      VariantsBulkUpdate: () => ({
        productVariantsBulkUpdate: { userErrors: [{ field: ["price"], message: "bad", code: "INVALID" }] },
      }),
    });
    await expect(
      createGraphqlGateway(fn).writePrices("p1", [{ variantId: "v1", price: 1, compareAt: null }]),
    ).rejects.toThrow(/bad/);
  });

  it("clears markers with metafield identifiers", async () => {
    const { fn, calls } = scripted({ ClearSaleMarkers: () => ({ metafieldsDelete: { userErrors: [] } }) });
    await createGraphqlGateway(fn).clearMarkers(["v1"]);
    expect(calls[0].vars.metafields).toEqual([{ ownerId: "v1", namespace: "$app", key: "sale_state" }]);
  });
});

describe("withThrottleRetry", () => {
  it("retries throttled errors with backoff, then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let attempts = 0;
    const result = await withThrottleRetry(async () => {
      if (++attempts < 3) throw new ShopifyGraphqlError("Throttled", true);
      return "ok";
    }, sleep);
    expect(result).toBe("ok");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("rethrows non-throttled errors immediately", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(
      withThrottleRetry(async () => { throw new ShopifyGraphqlError("Access denied", false); }, sleep),
    ).rejects.toThrow("Access denied");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the retry limit", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(
      withThrottleRetry(async () => { throw new ShopifyGraphqlError("Throttled", true); }, sleep, 2),
    ).rejects.toThrow("Throttled");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
