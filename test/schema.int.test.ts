import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "./db";
import { createRun, createSale } from "./factories";

const snapshot = (runId: string, variantId: string) => ({
  runId,
  variantId,
  productId: "p1",
  ruleGroupId: "g1",
  originalPrice: 20_000_000n,
  originalCompareAt: null,
  appliedPrice: 14_000_000n,
  appliedCompareAt: 20_000_000n,
});

describe("sale schema", () => {
  beforeEach(resetDb);

  it("stores a sale with rule groups and BigInt money", async () => {
    const sale = await createSale(testDb, {
      groups: [{ targets: [{ kind: "collection", id: "c1" }] }],
      minPrice: 5_000_000n,
    });
    expect(sale.ruleGroups).toHaveLength(1);
    expect(sale.minPrice).toBe(5_000_000n);
  });

  it("allows only one run per sale window", async () => {
    const sale = await createSale(testDb, { groups: [] });
    await createRun(testDb, sale.id);
    await expect(createRun(testDb, sale.id)).rejects.toThrow();
  });

  it("allows only one snapshot per variant per run", async () => {
    const sale = await createSale(testDb, { groups: [] });
    const run = await createRun(testDb, sale.id);
    await testDb.priceSnapshot.create({ data: snapshot(run.id, "v1") });
    await expect(testDb.priceSnapshot.create({ data: snapshot(run.id, "v1") })).rejects.toThrow();
  });
});
