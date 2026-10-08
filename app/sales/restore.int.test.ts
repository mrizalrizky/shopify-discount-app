import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createRun, createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { applyRun } from "./apply";
import { prepareRun } from "./prepare";
import { recoverFromMetafields, resolveConflict, restoreRun } from "./restore";

const RP = (rupiah: number) => rupiah * 100;

function store() {
  const shopify = new FakeShopify();
  shopify.addVariant("v1", "p1", RP(200_000));
  shopify.addVariant("v2", "p1", RP(400_000), RP(500_000));
  shopify.addVariant("v3", "p2", RP(300_000));
  shopify.setCollection("summer", ["p1", "p2"]);
  return shopify;
}

async function activeRun(shopify: FakeShopify, tags: { tagsToAdd?: string[]; tagsToRemove?: string[] } = {}) {
  const sale = await createSale(testDb, {
    groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }],
    ...tags,
  });
  const run = await createRun(testDb, sale.id);
  await prepareRun(testDb, shopify, run.id);
  await applyRun(testDb, shopify, run.id);
  return run;
}

describe("restoreRun", () => {
  beforeEach(resetDb);

  it("restores original prices, clears markers, logs, and ends the run", async () => {
    const shopify = store();
    const run = await activeRun(shopify);

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 3, conflicts: 0 });

    expect(shopify.variants.get("v1")).toMatchObject({ price: RP(200_000), compareAt: null, marker: null });
    expect(shopify.variants.get("v2")).toMatchObject({ price: RP(400_000), compareAt: RP(500_000), marker: null });
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id, action: "restore" } })).toBe(3);
    expect(await testDb.priceChangeLog.count({ where: { saleId: run.saleId, action: "restore" } })).toBe(3);
    const ended = await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(ended.status).toBe("ENDED");
    expect(ended.endedAt).not.toBeNull();
  });

  it("never overwrites a price edited by hand during the sale", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    shopify.variants.get("v1")!.price = RP(99_000);

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 2, conflicts: 1 });
    expect(shopify.variants.get("v1")!.price).toBe(RP(99_000));
    const snap = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v1" } });
    expect(snap.status).toBe("CONFLICT");
  });

  it("finishes a restore that crashed after writing prices but before clearing markers", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    // Simulate the crash: original prices written back, markers still present, DB still APPLIED.
    await shopify.writePrices("p2", [{ variantId: "v3", price: RP(300_000), compareAt: null }]);

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 3, conflicts: 0 });
    expect(shopify.variants.get("v3")!.marker).toBeNull();
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id, action: "restore" } })).toBe(3);
  });

  it("treats a variant deleted during the sale as restored", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    shopify.variants.delete("v3");

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 3, conflicts: 0 });
  });

  it("removes only the tags it added and puts back the tags it removed", async () => {
    const shopify = store();
    shopify.setTags("p1", ["sale", "new-in"]);
    shopify.setTags("p2", []);
    const run = await activeRun(shopify, { tagsToAdd: ["sale"], tagsToRemove: ["new-in"] });

    await restoreRun(testDb, shopify, run.id);

    expect(shopify.tags.get("p1")!.sort()).toEqual(["new-in", "sale"]); // "sale" was there before
    expect(shopify.tags.get("p2")).toEqual([]);
  });

  it("restores a run that never left PREPARING and ends it", async () => {
    const shopify = store();
    const sale = await createSale(testDb, { groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }] });
    const run = await createRun(testDb, sale.id);

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 0, conflicts: 0 });
    expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("ENDED");
  });

  it("is a no-op for an ended run", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    await restoreRun(testDb, shopify, run.id);
    const writes = shopify.writeCount;

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 0, conflicts: 0 });
    expect(shopify.writeCount).toBe(writes);
  });
});

describe("resolveConflict", () => {
  beforeEach(resetDb);

  it("restores anyway, or keeps the current price", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    shopify.variants.get("v1")!.price = RP(99_000);
    shopify.variants.get("v3")!.price = RP(250_000);
    await restoreRun(testDb, shopify, run.id);
    const v1 = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v1" } });
    const v3 = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v3" } });

    await resolveConflict(testDb, shopify, v1.id, "restore");
    await resolveConflict(testDb, shopify, v3.id, "keep");

    expect(shopify.variants.get("v1")).toMatchObject({ price: RP(200_000), compareAt: null, marker: null });
    expect(shopify.variants.get("v3")).toMatchObject({ price: RP(250_000), marker: null });
    expect((await testDb.priceSnapshot.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("RESTORED");
    expect((await testDb.priceSnapshot.findUniqueOrThrow({ where: { id: v3.id } })).status).toBe("KEPT");
    const resolvedLog = await testDb.priceChangeLog.findFirstOrThrow({ where: { variantId: "v1", action: "restore" } });
    expect(resolvedLog.saleId).toBe(run.saleId);
  });
});

describe("resolveConflict idempotence", () => {
  beforeEach(resetDb);

  it("second restore resolution is a no-op and logs once", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    shopify.variants.get("v1")!.price = RP(99_000);
    await restoreRun(testDb, shopify, run.id);
    const v1 = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v1" } });

    await resolveConflict(testDb, shopify, v1.id, "restore");
    await resolveConflict(testDb, shopify, v1.id, "restore");

    expect(await testDb.priceChangeLog.count({ where: { runId: run.id, variantId: "v1", action: "restore" } })).toBe(1);
  });

  it("resolving a conflict for a deleted variant marks it RESTORED without logging", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    shopify.variants.get("v1")!.price = RP(99_000);
    await restoreRun(testDb, shopify, run.id);
    const v1 = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v1" } });
    shopify.variants.delete("v1");

    await resolveConflict(testDb, shopify, v1.id, "restore");

    expect((await testDb.priceSnapshot.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("RESTORED");
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id, variantId: "v1", action: "restore" } })).toBe(0);
  });
});

describe("recoverFromMetafields", () => {
  it("restores originals from markers when DB snapshots are unavailable", async () => {
    const shopify = store();
    await shopify.writePrices("p1", [{
      variantId: "v2", price: RP(280_000), compareAt: RP(500_000),
      marker: { saleId: "s", runId: "r", originalPrice: RP(400_000), originalCompareAt: RP(500_000) },
    }]);

    expect(await recoverFromMetafields(shopify, ["v1", "v2"])).toBe(1);
    expect(shopify.variants.get("v2")).toMatchObject({ price: RP(400_000), compareAt: RP(500_000), marker: null });
  });
});

describe("restoreRun concurrency", () => {
  beforeEach(resetDb);

  it("writes exactly one restore log row per variant when two restores race", async () => {
    const shopify = store();
    const run = await activeRun(shopify);

    await Promise.allSettled([restoreRun(testDb, shopify, run.id), restoreRun(testDb, shopify, run.id)]);
    await restoreRun(testDb, shopify, run.id);

    for (const variantId of ["v1", "v2", "v3"]) {
      expect(await testDb.priceChangeLog.count({ where: { runId: run.id, variantId, action: "restore" } })).toBe(1);
    }
    expect(shopify.variants.get("v1")).toMatchObject({ price: RP(200_000), compareAt: null, marker: null });
    expect(shopify.variants.get("v2")).toMatchObject({ price: RP(400_000), compareAt: RP(500_000), marker: null });
    expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("ENDED");
  });
});
