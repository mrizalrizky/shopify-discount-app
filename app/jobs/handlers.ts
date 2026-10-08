import { Prisma, type PrismaClient, type Sale, type SaleRun } from "@prisma/client";
import { dueActions, type ScheduleKind, type ScheduleSale } from "../domain/schedule/due";
import type { RecurringSchedule } from "../domain/schedule/recurring";
import { applyRun } from "../sales/apply";
import { LeaseLostError, RunSupersededError, type WriteGuard } from "../sales/guard";
import { prepareRun } from "../sales/prepare";
import { refreshRun } from "../sales/refresh";
import { restoreRun } from "../sales/restore";
import type { ShopifyGateway } from "../shopify/gateway";

export const QUEUES = {
  tick: "sale-tick",
  start: "run-start",
  stop: "run-stop",
  refresh: "run-refresh",
} as const;

export type RunQueue = (typeof QUEUES)["start" | "stop" | "refresh"];

export const REFRESH_INTERVAL_MS = 20 * 60 * 1000;
export const LEASE_MS = 15 * 60 * 1000;

const OPEN_STATUSES = new Set(["PREPARING", "APPLYING", "ACTIVE", "RESTORING"]);

/** Another job holds the run's lease; thrown (not recorded). The tick re-sends the job once the lease is free. */
export class RunBusyError extends Error {}

/**
 * Moves the run's lease from `token` (the value this job last set) to `next`. Returns false when
 * the lease no longer holds `token`, i.e. another job claimed the run after it expired. A claim
 * only takes a lease that is null or in the past and sets now + LEASE_MS, so it never equals an
 * older token.
 */
export async function renewLease(db: PrismaClient, runId: string, token: Date, next: Date): Promise<boolean> {
  const { count } = await db.saleRun.updateMany({ where: { id: runId, leaseUntil: token }, data: { leaseUntil: next } });
  return count === 1;
}

export interface JobDeps {
  db: PrismaClient;
  gatewayFor(shop: string): Promise<ShopifyGateway>;
  send(queue: RunQueue, data: { runId: string }): Promise<void>;
  now(): Date;
}

export function createJobHandlers(deps: JobDeps) {
  const { db } = deps;

  /**
   * Runs `work` while holding the run's lease. The lease is a fencing token: `work` gets a
   * guard that the services call right before every Shopify write. The guard renews the lease
   * only while it still holds the value this job last set; if another job claimed the run after
   * the lease expired, it throws LeaseLostError before anything more is written.
   */
  async function withRun(
    runId: string,
    work: (run: SaleRun & { sale: Sale }, gateway: ShopifyGateway, guard: WriteGuard) => Promise<void>,
  ) {
    let until = new Date(deps.now().getTime() + LEASE_MS);
    const { count } = await db.saleRun.updateMany({
      where: { id: runId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: deps.now() } }] },
      data: { leaseUntil: until },
    });
    if (count === 0) throw new RunBusyError(`Run ${runId} is busy`);

    const guard: WriteGuard = async () => {
      const next = new Date(deps.now().getTime() + LEASE_MS);
      if (!(await renewLease(db, runId, until, next))) {
        throw new LeaseLostError(`Run ${runId}: lease lost to another job`);
      }
      until = next;
    };

    try {
      const run = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
      await work(run, await deps.gatewayFor(run.sale.shop), guard);
      await db.saleRun.updateMany({ where: { id: runId, leaseUntil: until }, data: { error: null } });
    } catch (error) {
      // Superseded: another job owns the run now, so this is not the run's failure to record.
      if (!(error instanceof RunSupersededError)) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await db.saleRun.updateMany({ where: { id: runId }, data: { error: message } });
        } catch (recordError) {
          console.error(`[run ${runId}] failed to record error`, recordError);
        }
      }
      throw error;
    } finally {
      await db.saleRun.updateMany({ where: { id: runId, leaseUntil: until }, data: { leaseUntil: null } });
    }
  }

  async function tickSale(sale: Sale & { runs: SaleRun[] }, now: Date) {
    const runs = sale.runs.map((r) => ({
      id: r.id,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      open: OPEN_STATUSES.has(r.status),
    }));
    // A run with a live lease has a job working on it right now. Sending another job for it
    // would only queue a duplicate behind the active one, which can block the whole queue
    // (see worker.ts). Stops, stranded starts and refreshes are re-evaluated every tick, so
    // they go out on the first tick after the lease is released or expires.
    const leased = new Set(sale.runs.filter((r) => r.leaseUntil !== null && r.leaseUntil > now).map((r) => r.id));
    for (const action of dueActions(toScheduleSale(sale), runs, now)) {
      if (action.kind === "start") {
        const run = await createRunIfAbsent(db, sale.id, action.windowStart, action.windowEnd);
        if (run) await deps.send(QUEUES.start, { runId: run.id });
      } else if (action.kind === "stop") {
        if (!leased.has(action.runId)) await deps.send(QUEUES.stop, { runId: action.runId });
      } else {
        await db.sale.update({ where: { id: sale.id }, data: { status: "ENDED" } });
      }
    }
    // Re-queue starts for runs stranded by a failed or lost start job (run jobs are not retried by pg-boss).
    for (const run of sale.runs) {
      const windowOpen = run.windowEnd === null || run.windowEnd.getTime() > now.getTime();
      if ((run.status === "PREPARING" || run.status === "APPLYING") && windowOpen && !leased.has(run.id)) {
        await deps.send(QUEUES.start, { runId: run.id });
      }
    }
    if (sale.autoRefresh) {
      for (const run of sale.runs) {
        const last = (run.lastRefreshedAt ?? run.startedAt)?.getTime();
        const due = last !== undefined && now.getTime() - last >= REFRESH_INTERVAL_MS;
        if (run.status === "ACTIVE" && due && !leased.has(run.id)) {
          await deps.send(QUEUES.refresh, { runId: run.id });
        }
      }
    }
  }

  return {
    async tick() {
      const now = deps.now();
      const sales = await db.sale.findMany({
        where: { status: { in: ["SCHEDULED", "ACTIVE"] } },
        include: { runs: true },
      });
      for (const sale of sales) {
        try {
          await tickSale(sale, now);
        } catch (error) {
          console.error(`[tick] sale ${sale.id} failed`, error);
        }
      }
    },

    async startRun(runId: string) {
      await withRun(runId, async (run, gateway, guard) => {
        const prepared = await prepareRun(db, gateway, runId);
        if (prepared.status === "overlap") return;
        const current = await db.saleRun.findUniqueOrThrow({ where: { id: runId } });
        if (current.status !== "APPLYING" && current.status !== "ACTIVE") return;
        await applyRun(db, gateway, runId, guard);
        await db.sale.update({ where: { id: run.saleId }, data: { status: "ACTIVE" } });
      });
    },

    async stopRun(runId: string) {
      await withRun(runId, async (_run, gateway, guard) => {
        await restoreRun(db, gateway, runId, guard);
      });
    },

    async refreshRun(runId: string) {
      await withRun(runId, async (_run, gateway, guard) => {
        await refreshRun(db, gateway, runId, guard);
      });
    },
  };
}

function toScheduleSale(sale: Sale): ScheduleSale {
  return {
    scheduleKind: sale.scheduleKind as ScheduleKind,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    recurring: (sale.recurring as unknown as RecurringSchedule | null) ?? null,
    timezone: sale.timezone,
  };
}

async function createRunIfAbsent(db: PrismaClient, saleId: string, windowStart: Date, windowEnd: Date | null) {
  try {
    return await db.saleRun.create({ data: { saleId, windowStart, windowEnd } });
  } catch (error) {
    // Unique (saleId, windowStart): another tick already created this run.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}
