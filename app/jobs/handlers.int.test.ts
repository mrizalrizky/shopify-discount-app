import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { createJobHandlers, LEASE_MS, REFRESH_INTERVAL_MS, RunBusyError, type RunQueue } from "./handlers";

const RP = (rupiah: number) => rupiah * 100;
const START = new Date("2026-11-06T12:00:00Z");
const END = new Date("2026-11-07T12:00:00Z");

function setup(nowRef: { now: Date }) {
  const shopify = new FakeShopify();
  shopify.addVariant("v1", "p1", RP(200_000));
  shopify.setCollection("summer", ["p1"]);
  const sent: { queue: RunQueue; runId: string }[] = [];
  const handlers = createJobHandlers({
    db: testDb,
    gatewayFor: async () => shopify,
    send: async (queue, data) => { sent.push({ queue, runId: data.runId }); },
    now: () => nowRef.now,
  });
  return { shopify, sent, handlers };
}

async function onceSale(autoRefresh = false) {
  return createSale(testDb, {
    groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }],
    scheduleKind: "once",
    startsAt: START,
    endsAt: END,
    autoRefresh,
  });
}

describe("job handlers", () => {
  beforeEach(resetDb);

  it("runs a one-time sale end to end: start, apply, stop, restore, complete", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { shopify, sent, handlers } = setup(clock);
    const sale = await onceSale();

    await handlers.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].queue).toBe("run-start");
    await handlers.startRun(sent[0].runId);
    expect(shopify.variants.get("v1")!.price).toBe(RP(140_000));
    expect((await testDb.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("ACTIVE");

    clock.now = END;
    await handlers.tick();
    expect(sent[1]).toEqual({ queue: "run-stop", runId: sent[0].runId });
    await handlers.stopRun(sent[1].runId);
    expect(shopify.variants.get("v1")!.price).toBe(RP(200_000));

    await handlers.tick();
    expect((await testDb.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("ENDED");
  });

  it("creates only one run per window even if the tick runs twice", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { sent, handlers } = setup(clock);
    await onceSale();

    await Promise.all([handlers.tick(), handlers.tick()]);

    expect(await testDb.saleRun.count()).toBe(1);
    expect(sent.filter((s) => s.queue === "run-start")).toHaveLength(1);
  });

  it("queues a refresh for auto-refresh sales every 20 minutes", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { sent, handlers } = setup(clock);
    await onceSale(true);
    await handlers.tick();
    await handlers.startRun(sent[0].runId);

    clock.now = new Date(clock.now.getTime() + REFRESH_INTERVAL_MS);
    await handlers.tick();

    expect(sent.at(-1)).toEqual({ queue: "run-refresh", runId: sent[0].runId });
  });

  it("records the error on the run and rethrows so the job is retried", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { shopify, sent, handlers } = setup(clock);
    await onceSale();
    await handlers.tick();
    shopify.failAfterWrites = 0;

    await expect(handlers.startRun(sent[0].runId)).rejects.toThrow("simulated crash");
    expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: sent[0].runId } })).error).toBe("simulated crash");
  });

  describe("per-run lease", () => {
    async function activeRun() {
      const clock = { now: new Date("2026-11-06T12:00:30Z") };
      const ctx = setup(clock);
      await onceSale();
      await ctx.handlers.tick();
      await ctx.handlers.startRun(ctx.sent[0].runId);
      return { clock, runId: ctx.sent[0].runId, ...ctx };
    }

    it("rejects with RunBusyError while another job holds the lease, leaving prices untouched", async () => {
      const { clock, runId, shopify, handlers } = await activeRun();
      await testDb.saleRun.update({
        where: { id: runId },
        data: { leaseUntil: new Date(clock.now.getTime() + 60_000) },
      });

      await expect(handlers.stopRun(runId)).rejects.toBeInstanceOf(RunBusyError);

      expect(shopify.variants.get("v1")!.price).toBe(RP(140_000));
      expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: runId } })).error).toBeNull();
    });

    it("claims an expired lease and proceeds", async () => {
      const { clock, runId, shopify, handlers } = await activeRun();
      await testDb.saleRun.update({
        where: { id: runId },
        data: { leaseUntil: new Date(clock.now.getTime() - 1) },
      });

      await handlers.stopRun(runId);

      expect(shopify.variants.get("v1")!.price).toBe(RP(200_000));
    });

    it("releases the lease after a successful job", async () => {
      const { runId, handlers } = await activeRun();
      expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: runId } })).leaseUntil).toBeNull();

      await handlers.stopRun(runId);

      expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: runId } })).leaseUntil).toBeNull();
      expect(LEASE_MS).toBe(15 * 60 * 1000);
    });
  });

  it("keeps ticking other sales when one sale has a malformed schedule", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { sent, handlers } = setup(clock);
    await createSale(testDb, {
      groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 10 }],
      scheduleKind: "recurring",
      recurring: { weekdays: [5], startTime: "10:00", stopTime: "10:00", firstDate: "2026-11-01", lastDate: "2026-12-01" },
    });
    const good = await onceSale();

    await handlers.tick();

    const runs = await testDb.saleRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0].saleId).toBe(good.id);
    expect(sent.filter((s) => s.queue === "run-start")).toHaveLength(1);
  });
});
