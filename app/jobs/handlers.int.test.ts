import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { LeaseLostError } from "../sales/guard";
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
    // A racing tick may re-send start for the same run (deduped by the stately queue); never a second run.
    expect(new Set(sent.filter((s) => s.queue === "run-start").map((s) => s.runId)).size).toBe(1);
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

  it("re-sends start for a stranded run on the next tick, then applies prices", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { shopify, sent, handlers } = setup(clock);
    await onceSale();
    await handlers.tick();
    shopify.failAfterWrites = 0;
    await expect(handlers.startRun(sent[0].runId)).rejects.toThrow("simulated crash");
    shopify.failAfterWrites = null;

    await handlers.tick();

    expect(sent.at(-1)).toEqual({ queue: "run-start", runId: sent[0].runId });
    await handlers.startRun(sent[0].runId);
    expect(shopify.variants.get("v1")!.price).toBe(RP(140_000));
    expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: sent[0].runId } })).error).toBeNull();
  });

  it("releases the lease and records the error after a failed job", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { shopify, sent, handlers } = setup(clock);
    await onceSale();
    await handlers.tick();
    shopify.failAfterWrites = 0;

    await expect(handlers.startRun(sent[0].runId)).rejects.toThrow("simulated crash");

    const run = await testDb.saleRun.findUniqueOrThrow({ where: { id: sent[0].runId } });
    expect(run.leaseUntil).toBeNull();
    expect(run.error).toBe("simulated crash");
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

  describe("lease fencing", () => {
    it("a stop that takes over an expired lease mid-apply leaves no variant discounted", async () => {
      const clock = { now: new Date("2026-11-06T12:00:30Z") };
      const { shopify, sent, handlers } = setup(clock);
      shopify.addVariant("v3", "p3", RP(300_000));
      shopify.setCollection("summer", ["p1", "p3"]);
      await onceSale();
      await handlers.tick();
      const runId = sent[0].runId;

      let stop: Promise<void> | null = null;
      shopify.beforeCall = async () => {
        if (shopify.writeCount !== 1 || stop) return; // p1 written; p3 not yet
        // The apply has been slow: its lease expired and the window ended, so a stop takes over.
        clock.now = new Date(END.getTime() + LEASE_MS);
        stop = handlers.stopRun(runId);
        await stop;
      };

      await expect(handlers.startRun(runId)).rejects.toBeInstanceOf(LeaseLostError);

      expect(shopify.variants.get("v1")).toMatchObject({ price: RP(200_000), compareAt: null, marker: null });
      expect(shopify.variants.get("v3")).toMatchObject({ price: RP(300_000), compareAt: null, marker: null });
      const snaps = await testDb.priceSnapshot.findMany({ where: { runId } });
      expect(snaps.map((s) => s.status)).toEqual(["RESTORED", "RESTORED"]);
      const run = await testDb.saleRun.findUniqueOrThrow({ where: { id: runId } });
      expect(run.status).toBe("ENDED");
      expect(run.error).toBeNull(); // losing the lease is not a run failure
    });

    it("a stop that takes over an expired lease mid-refresh leaves no new variant discounted", async () => {
      const clock = { now: new Date("2026-11-06T12:00:30Z") };
      const { shopify, sent, handlers } = setup(clock);
      await onceSale(true);
      await handlers.tick();
      const runId = sent[0].runId;
      await handlers.startRun(runId);
      shopify.addVariant("v3", "p3", RP(300_000));
      shopify.setCollection("summer", ["p1", "p3"]);
      clock.now = new Date(clock.now.getTime() + REFRESH_INTERVAL_MS);

      let calls = 0;
      let stop: Promise<void> | null = null;
      shopify.beforeCall = async (method) => {
        if (method !== "getVariants" || stop || ++calls < 2) return; // after the refresh planned, before it applies
        clock.now = new Date(END.getTime() + LEASE_MS);
        stop = handlers.stopRun(runId);
        await stop;
      };

      await expect(handlers.refreshRun(runId)).rejects.toBeInstanceOf(LeaseLostError);

      expect(shopify.variants.get("v1")).toMatchObject({ price: RP(200_000), marker: null });
      expect(shopify.variants.get("v3")).toMatchObject({ price: RP(300_000), marker: null });
      expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("ENDED");
    });

    it("renews the lease while working and releases it afterwards", async () => {
      const clock = { now: new Date("2026-11-06T12:00:30Z") };
      const { shopify, sent, handlers } = setup(clock);
      shopify.addVariant("v3", "p3", RP(300_000));
      shopify.setCollection("summer", ["p1", "p3"]);
      await onceSale();
      await handlers.tick();
      const runId = sent[0].runId;
      const leases: (Date | null)[] = [];
      shopify.beforeCall = async (method) => {
        if (method !== "writePrices") return;
        leases.push((await testDb.saleRun.findUniqueOrThrow({ where: { id: runId } })).leaseUntil);
        clock.now = new Date(clock.now.getTime() + 10 * 60 * 1000); // each product takes 10 minutes
      };

      await handlers.startRun(runId);

      // The 2nd product starts 10 minutes after the 1st and is still leased for a full LEASE_MS from then.
      expect(leases[1]!.getTime()).toBe(new Date("2026-11-06T12:10:30Z").getTime() + LEASE_MS);
      expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: runId } })).leaseUntil).toBeNull();
      expect(shopify.variants.get("v3")!.price).toBe(RP(210_000));
    });
  });

  describe("tick and live leases", () => {
    async function leased(runId: string, until: Date | null) {
      await testDb.saleRun.update({ where: { id: runId }, data: { leaseUntil: until } });
    }

    it("does not re-send a stranded start while a job holds the run's lease", async () => {
      const clock = { now: new Date("2026-11-06T12:00:30Z") };
      const { sent, handlers } = setup(clock);
      await onceSale();
      await handlers.tick();
      const runId = sent[0].runId;
      await leased(runId, new Date(clock.now.getTime() + 60_000));

      await handlers.tick();
      expect(sent).toHaveLength(1);

      await leased(runId, new Date(clock.now.getTime() - 1)); // expired: the job holding it died
      await handlers.tick();
      expect(sent.at(-1)).toEqual({ queue: "run-start", runId });
    });

    it("does not send a stop or a refresh while a job holds the run's lease", async () => {
      const clock = { now: new Date("2026-11-06T12:00:30Z") };
      const { sent, handlers } = setup(clock);
      await onceSale(true);
      await handlers.tick();
      const runId = sent[0].runId;
      await handlers.startRun(runId);

      clock.now = new Date(clock.now.getTime() + REFRESH_INTERVAL_MS);
      await leased(runId, new Date(clock.now.getTime() + 60_000));
      await handlers.tick();
      expect(sent).toHaveLength(1);

      clock.now = END;
      await leased(runId, new Date(clock.now.getTime() + 60_000));
      await handlers.tick();
      expect(sent).toHaveLength(1);

      await leased(runId, null);
      await handlers.tick();
      expect(sent.slice(1)).toContainEqual({ queue: "run-stop", runId });
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
