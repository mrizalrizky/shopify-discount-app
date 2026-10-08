import { Prisma, type PrismaClient, type Sale, type SaleRun } from "@prisma/client";
import { dueActions, type ScheduleKind, type ScheduleSale } from "../domain/schedule/due";
import type { RecurringSchedule } from "../domain/schedule/recurring";
import { applyRun } from "../sales/apply";
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

/** Another job holds the run's lease; thrown (not recorded) so pg-boss retries later. */
export class RunBusyError extends Error {}

export interface JobDeps {
  db: PrismaClient;
  gatewayFor(shop: string): Promise<ShopifyGateway>;
  send(queue: RunQueue, data: { runId: string }): Promise<void>;
  now(): Date;
}

export function createJobHandlers(deps: JobDeps) {
  const { db } = deps;

  async function withRun(runId: string, work: (run: SaleRun & { sale: Sale }, gateway: ShopifyGateway) => Promise<void>) {
    const until = new Date(deps.now().getTime() + LEASE_MS);
    const { count } = await db.saleRun.updateMany({
      where: { id: runId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: deps.now() } }] },
      data: { leaseUntil: until },
    });
    if (count === 0) throw new RunBusyError(`Run ${runId} is busy`);
    try {
      const run = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
      await work(run, await deps.gatewayFor(run.sale.shop));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.saleRun.update({ where: { id: runId }, data: { error: message } });
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
    for (const action of dueActions(toScheduleSale(sale), runs, now)) {
      if (action.kind === "start") {
        const run = await createRunIfAbsent(db, sale.id, action.windowStart, action.windowEnd);
        if (run) await deps.send(QUEUES.start, { runId: run.id });
      } else if (action.kind === "stop") {
        await deps.send(QUEUES.stop, { runId: action.runId });
      } else {
        await db.sale.update({ where: { id: sale.id }, data: { status: "ENDED" } });
      }
    }
    if (sale.autoRefresh) {
      for (const run of sale.runs) {
        const last = (run.lastRefreshedAt ?? run.startedAt)?.getTime();
        if (run.status === "ACTIVE" && last !== undefined && now.getTime() - last >= REFRESH_INTERVAL_MS) {
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
      await withRun(runId, async (run, gateway) => {
        const prepared = await prepareRun(db, gateway, runId);
        if (prepared.status === "overlap") return;
        const current = await db.saleRun.findUniqueOrThrow({ where: { id: runId } });
        if (current.status !== "APPLYING" && current.status !== "ACTIVE") return;
        await applyRun(db, gateway, runId);
        await db.sale.update({ where: { id: run.saleId }, data: { status: "ACTIVE" } });
      });
    },

    async stopRun(runId: string) {
      await withRun(runId, async (_run, gateway) => {
        await restoreRun(db, gateway, runId);
      });
    },

    async refreshRun(runId: string) {
      await withRun(runId, async (_run, gateway) => {
        await refreshRun(db, gateway, runId);
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
