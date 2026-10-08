import { describe, expect, it, vi } from "vitest";
import { serializeMarker } from "./gateway";
import {
  adminGraphql,
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

describe("adminGraphql", () => {
  const okResponse = (body: unknown) => ({ json: async () => body }) as unknown as Response;
  const sleepFn = () => vi.fn(async (_ms: number) => {});

  function adminWith(steps: (() => Promise<Response>)[]) {
    let i = 0;
    return { graphql: vi.fn(async () => steps[Math.min(i++, steps.length - 1)]()) };
  }

  it("returns body.data on success", async () => {
    const admin = adminWith([async () => okResponse({ data: { shop: 1 } })]);
    await expect(adminGraphql(admin, sleepFn())("query X { a }", { a: 1 })).resolves.toEqual({ shop: 1 });
    expect(admin.graphql).toHaveBeenCalledWith("query X { a }", { variables: { a: 1 } });
  });

  it("retries a THROTTLED GraphQL error (GraphqlQueryError shape), then succeeds", async () => {
    const throttled = Object.assign(new Error("Throttled"), {
      body: { errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } },
    });
    const sleep = sleepFn();
    const admin = adminWith([
      async () => { throw throttled; },
      async () => okResponse({ data: { ok: true } }),
    ]);
    await expect(adminGraphql(admin, sleep)("query X { a }")).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000]);
  });

  it("retries a throttled error carried in the response body", async () => {
    const sleep = sleepFn();
    const admin = adminWith([
      async () => okResponse({ errors: [{ message: "Limit", extensions: { code: "THROTTLED" } }] }),
      async () => okResponse({ data: 1 }),
    ]);
    await expect(adminGraphql(admin, sleep)("query X { a }")).resolves.toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries an HTTP 429 HttpThrottlingError", async () => {
    const http429 = Object.assign(new Error("Shopify is throttling requests"), {
      response: { code: 429, statusText: "Too Many Requests", body: {}, headers: {} },
    });
    const sleep = sleepFn();
    const admin = adminWith([
      async () => { throw http429; },
      async () => okResponse({ data: "ok" }),
    ]);
    await expect(adminGraphql(admin, sleep)("query X { a }")).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown Response with status 429", async () => {
    const sleep = sleepFn();
    const admin = adminWith([
      async () => { throw new Response("{}", { status: 429, statusText: "Too Many Requests" }); },
      async () => okResponse({ data: "ok" }),
    ]);
    await expect(adminGraphql(admin, sleep)("query X { a }")).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry a thrown Response 401 and reports the status", async () => {
    const sleep = sleepFn();
    const admin = adminWith([
      async () => { throw new Response("{}", { status: 401, statusText: "Unauthorized" }); },
    ]);
    await expect(adminGraphql(admin, sleep)("query X { a }")).rejects.toThrow(/HTTP 401 Unauthorized/);
    expect(sleep).not.toHaveBeenCalled();
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });
});
