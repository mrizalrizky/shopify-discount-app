import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createRun, createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { prepareRun } from "./prepare";

const RP = (rupiah: number) => rupiah * 100;

function store() {
  const shopify = new FakeShopify();
  shopify.addVariant("v1", "p1", RP(200_000));
  shopify.addVariant("v2", "p1", RP(400_000), RP(500_000));
  shopify.addVariant("v3", "p2", RP(90_000));
  shopify.setCollection("summer", ["p1", "p2"]);
  return shopify;
}

describe("prepareRun", () => {
  beforeEach(resetDb);

  it("saves one snapshot per changed variant and moves the run to APPLYING", async () => {
    const shopify = store();
    const sale = await createSale(testDb, {
      groups: [{ targets: [{ kind: "collection", id: "summer" }], amountType: "fixedPrice", amount: RP(100_000) }],
    });
    const run = await createRun(testDb, sale.id);

    const result = await prepareRun(testDb, shopify, run.id);

    expect(result).toMatchObject({ status: "ready", count: 2 });
    if (result.status === "ready") {
      expect(result.skipped).toEqual([{ variantId: "v3", productId: "p2", ruleGroupId: expect.any(String), reason: "not_lower" }]);
    }
    const snaps = await testDb.priceSnapshot.findMany({ where: { runId: run.id }, orderBy: { variantId: "asc" } });
    expect(snaps.map((s) => [s.variantId, s.originalPrice, s.originalCompareAt, s.appliedPrice, s.appliedCompareAt, s.status])).toEqual([
      ["v1", 20_000_000n, null, 10_000_000n, 20_000_000n, "PENDING"],
      ["v2", 40_000_000n, 50_000_000n, 10_000_000n, 50_000_000n, "PENDING"],
    ]);
    expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("APPLYING");
    expect(shopify.writeCount).toBe(0);
  });

  it("does nothing for a run that is already prepared", async () => {
    const shopify = store();
    const sale = await createSale(testDb, { groups: [{ targets: [{ kind: "product", id: "p1" }] }] });
    const run = await createRun(testDb, sale.id);
    await prepareRun(testDb, shopify, run.id);

    expect(await prepareRun(testDb, shopify, run.id)).toEqual({ status: "already_prepared" });
    expect(await testDb.priceSnapshot.count({ where: { runId: run.id } })).toBe(2);
  });

  it("fails the run when variants are already in another active sale", async () => {
    const shopify = store();
    const other = await createSale(testDb, { groups: [{ targets: [{ kind: "product", id: "p1" }] }] });
    const otherRun = await createRun(testDb, other.id);
    await prepareRun(testDb, shopify, otherRun.id);

    const sale = await createSale(testDb, { groups: [{ targets: [{ kind: "collection", id: "summer" }] }] });
    const run = await createRun(testDb, sale.id);
    const result = await prepareRun(testDb, shopify, run.id);

    expect(result).toEqual({ status: "overlap", overlaps: [{ saleId: other.id, variantIds: ["v1", "v2"] }] });
    const failed = await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toContain(other.id);
    expect(await testDb.priceSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  it("skips variants still marked by another run", async () => {
    const shopify = store();
    shopify.variants.get("v1")!.marker = { saleId: "old", runId: "old-run", originalPrice: 1, originalCompareAt: null };
    const sale = await createSale(testDb, { groups: [{ targets: [{ kind: "product", id: "p1" }] }] });
    const run = await createRun(testDb, sale.id);

    const result = await prepareRun(testDb, shopify, run.id);

    expect(result).toMatchObject({ status: "ready", count: 1 });
    if (result.status === "ready") expect(result.skipped.map((s) => [s.variantId, s.reason])).toEqual([["v1", "in_other_sale"]]);
  });

  it("lets only one of two concurrent prepares for overlapping sales succeed", async () => {
    const shopify = store();
    const saleA = await createSale(testDb, { groups: [{ targets: [{ kind: "product", id: "p1" }] }] });
    const saleB = await createSale(testDb, { groups: [{ targets: [{ kind: "product", id: "p1" }] }] });
    const runA = await createRun(testDb, saleA.id);
    const runB = await createRun(testDb, saleB.id);

    const settled = await Promise.allSettled([
      prepareRun(testDb, shopify, runA.id),
      prepareRun(testDb, shopify, runB.id),
    ]);

    const values = settled.map((r) => (r.status === "fulfilled" ? r.value.status : "rejected"));
    expect(values.sort()).toEqual(["overlap", "ready"]);
    const snaps = await testDb.priceSnapshot.findMany({ where: { variantId: { in: ["v1", "v2"] } } });
    expect(snaps).toHaveLength(2);
    expect(new Set(snaps.map((x) => x.runId)).size).toBe(1);
  });
});
