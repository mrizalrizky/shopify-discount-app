import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createRun, createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { applyRun } from "./apply";
import { LeaseLostError, RunSupersededError } from "./guard";
import { prepareRun } from "./prepare";
import { restoreRun } from "./restore";

const RP = (rupiah: number) => rupiah * 100;

async function preparedRun(shopify: FakeShopify, extra: { tagsToAdd?: string[]; tagsToRemove?: string[] } = {}) {
  const sale = await createSale(testDb, {
    groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }],
    ...extra,
  });
  const run = await createRun(testDb, sale.id);
  await prepareRun(testDb, shopify, run.id);
  return { sale, run };
}

function store() {
  const shopify = new FakeShopify();
  shopify.addVariant("v1", "p1", RP(200_000));
  shopify.addVariant("v2", "p1", RP(100_000));
  shopify.addVariant("v3", "p2", RP(300_000));
  shopify.setCollection("summer", ["p1", "p2"]);
  return shopify;
}

describe("applyRun", () => {
  beforeEach(resetDb);

  it("writes sale prices with markers, logs them, and activates the run", async () => {
    const shopify = store();
    const { sale, run } = await preparedRun(shopify);

    expect(await applyRun(testDb, shopify, run.id)).toEqual({ applied: 3, conflicts: 0 });

    expect(shopify.variants.get("v1")).toMatchObject({
      price: RP(140_000),
      compareAt: RP(200_000),
      marker: { saleId: sale.id, runId: run.id, originalPrice: RP(200_000), originalCompareAt: null },
    });
    expect(await testDb.priceSnapshot.count({ where: { runId: run.id, status: "APPLIED" } })).toBe(3);
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id, action: "apply" } })).toBe(3);
    expect(await testDb.priceChangeLog.count({ where: { saleId: sale.id, action: "apply" } })).toBe(3);
    const active = await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(active.status).toBe("ACTIVE");
    expect(active.startedAt).not.toBeNull();
  });

  it("recovers from a crash without writing or logging twice", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    shopify.failAfterWrites = 1; // p1 is written, then the "worker" dies before p2

    await expect(applyRun(testDb, shopify, run.id)).rejects.toThrow("simulated crash");
    shopify.failAfterWrites = null;
    const writesBeforeRetry = shopify.writeCount;

    expect(await applyRun(testDb, shopify, run.id)).toEqual({ applied: 1, conflicts: 0 });
    expect(shopify.writeCount).toBe(writesBeforeRetry + 1); // only p2 written on retry
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id } })).toBe(3);
    expect(shopify.variants.get("v3")!.price).toBe(RP(210_000));
  });

  it("reconciles a write that succeeded right before the DB update failed", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    // Simulate: Shopify already has the sale price + marker, DB still says PENDING.
    const snap = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v3" } });
    await shopify.writePrices("p2", [{
      variantId: "v3", price: RP(210_000), compareAt: RP(300_000),
      marker: { saleId: "s", runId: run.id, originalPrice: RP(300_000), originalCompareAt: null },
    }]);
    const writes = shopify.writeCount;

    await applyRun(testDb, shopify, run.id);

    expect(shopify.writeCount).toBe(writes + 1); // p1 only; p2 reconciled, not rewritten
    expect((await testDb.priceSnapshot.findUniqueOrThrow({ where: { id: snap.id } })).status).toBe("APPLIED");
  });

  it("marks a conflict and keeps the merchant's price if it changed after the snapshot", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    shopify.variants.get("v1")!.price = RP(180_000); // merchant edit between prepare and apply

    expect(await applyRun(testDb, shopify, run.id)).toEqual({ applied: 2, conflicts: 1 });
    expect(shopify.variants.get("v1")).toMatchObject({ price: RP(180_000), marker: null });
    const snap = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v1" } });
    expect(snap.status).toBe("CONFLICT");
  });

  it("adds only missing tags and removes requested ones, recording both", async () => {
    const shopify = store();
    shopify.setTags("p1", ["sale", "new-in"]);
    shopify.setTags("p2", ["basics"]);
    const { run } = await preparedRun(shopify, { tagsToAdd: ["sale"], tagsToRemove: ["new-in"] });

    await applyRun(testDb, shopify, run.id);

    expect(shopify.tags.get("p1")).toEqual(["sale"]);
    expect(shopify.tags.get("p2")).toEqual(["basics", "sale"]);
    const rows = await testDb.runProduct.findMany({ where: { runId: run.id }, orderBy: { productId: "asc" } });
    expect(rows.map((r) => [r.productId, r.addedTags, r.removedTags, r.tagsApplied])).toEqual([
      ["p1", [], ["new-in"], true],
      ["p2", ["sale"], [], true],
    ]);
  });

  it("marks a snapshot CONFLICT when its variant was deleted from Shopify", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    shopify.variants.delete("v3");

    expect(await applyRun(testDb, shopify, run.id)).toEqual({ applied: 2, conflicts: 1 });
    const snap = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v3" } });
    expect(snap.status).toBe("CONFLICT");
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id, variantId: "v3" } })).toBe(0);
  });

  it("does not double-log when two applies race on the same run", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);

    await Promise.allSettled([applyRun(testDb, shopify, run.id), applyRun(testDb, shopify, run.id)]);
    await applyRun(testDb, shopify, run.id); // reconcile anything the loser rolled back

    for (const v of ["v1", "v2", "v3"]) {
      expect(await testDb.priceChangeLog.count({ where: { runId: run.id, variantId: v, action: "apply" } })).toBe(1);
    }
    expect(await testDb.priceSnapshot.count({ where: { runId: run.id, status: "APPLIED" } })).toBe(3);
  });

  it("refuses runs that are not prepared", async () => {
    const shopify = store();
    const sale = await createSale(testDb, { groups: [] });
    const run = await createRun(testDb, sale.id);
    await expect(applyRun(testDb, shopify, run.id)).rejects.toThrow(/PREPARING/);
  });
});

describe("applyRun mid-run changes", () => {
  beforeEach(resetDb);

  it("reads each product right before writing it, so a merchant edit made meanwhile is a conflict", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    shopify.beforeCall = async () => {
      if (shopify.writeCount === 1) shopify.variants.get("v3")!.price = RP(250_000); // merchant edits p2 after p1 is written
    };

    expect(await applyRun(testDb, shopify, run.id)).toEqual({ applied: 2, conflicts: 1 });

    expect(shopify.variants.get("v3")).toMatchObject({ price: RP(250_000), marker: null });
    expect((await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v3" } })).status).toBe("CONFLICT");
  });

  it("stops before writing when the run is ended while it is applying", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    let ended: Promise<unknown> | null = null;
    shopify.beforeCall = async () => {
      if (shopify.writeCount !== 1 || ended) return;
      ended = restoreRun(testDb, shopify, run.id);
      await ended;
    };

    await expect(applyRun(testDb, shopify, run.id)).rejects.toBeInstanceOf(RunSupersededError);

    expect(shopify.variants.get("v3")).toMatchObject({ price: RP(300_000), marker: null });
    expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("ENDED");
  });

  it("checks the write guard before each product and stops when it throws", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    let calls = 0;
    const guard = async () => {
      if (++calls === 2) throw new LeaseLostError("lease lost");
    };

    await expect(applyRun(testDb, shopify, run.id, guard)).rejects.toBeInstanceOf(LeaseLostError);

    expect(shopify.writeCount).toBe(1);
    expect(shopify.variants.get("v3")!.price).toBe(RP(300_000));
  });
});
