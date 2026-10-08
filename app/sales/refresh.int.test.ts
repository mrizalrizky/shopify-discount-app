import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createRun, createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { applyRun } from "./apply";
import { prepareRun } from "./prepare";
import { refreshRun } from "./refresh";

const RP = (rupiah: number) => rupiah * 100;

async function activeRun(shopify: FakeShopify, autoRefresh = true) {
  const sale = await createSale(testDb, {
    groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }],
    autoRefresh,
  });
  const run = await createRun(testDb, sale.id);
  await prepareRun(testDb, shopify, run.id);
  await applyRun(testDb, shopify, run.id);
  return run;
}

describe("refreshRun", () => {
  beforeEach(resetDb);

  it("applies the sale to products added to the collection and restores products that left", async () => {
    const shopify = new FakeShopify();
    shopify.addVariant("v1", "p1", RP(200_000));
    shopify.addVariant("v2", "p2", RP(100_000));
    shopify.addVariant("v3", "p3", RP(300_000));
    shopify.setCollection("summer", ["p1", "p2"]);
    const run = await activeRun(shopify);

    shopify.setCollection("summer", ["p1", "p3"]); // p2 removed, p3 added

    expect(await refreshRun(testDb, shopify, run.id)).toEqual({ added: 1, removed: 1 });
    expect(shopify.variants.get("v1")!.price).toBe(RP(140_000)); // untouched
    expect(shopify.variants.get("v2")).toMatchObject({ price: RP(100_000), marker: null });
    expect(shopify.variants.get("v3")!.price).toBe(RP(210_000));
    const refreshed = await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(refreshed.status).toBe("ACTIVE");
    expect(refreshed.lastRefreshedAt).not.toBeNull();
  });

  it("does nothing when auto-refresh is off", async () => {
    const shopify = new FakeShopify();
    shopify.addVariant("v1", "p1", RP(200_000));
    shopify.addVariant("v3", "p3", RP(300_000));
    shopify.setCollection("summer", ["p1"]);
    const run = await activeRun(shopify, false);
    shopify.setCollection("summer", ["p1", "p3"]);

    expect(await refreshRun(testDb, shopify, run.id)).toEqual({ added: 0, removed: 0 });
    expect(shopify.variants.get("v3")!.price).toBe(RP(300_000));
  });
});
