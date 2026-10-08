import type { PriceSnapshot, PrismaClient, Sale, SaleRun } from "@prisma/client";
import type { ShopifyGateway, VariantState } from "../shopify/gateway";
import { noGuard, RunSupersededError, type WriteGuard } from "./guard";
import { moneyFromDb, optionalMoneyFromDb } from "./money-db";

/**
 * Writes sale prices product by product. Each product's Shopify state is read right
 * before its write, and `guard` (the job's lease) plus the run status are checked
 * between that read and the write, so a job that lost the run never writes.
 */
export async function applyRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
  guard: WriteGuard = noGuard,
): Promise<{ applied: number; conflicts: number }> {
  const run = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
  if (run.status !== "APPLYING" && run.status !== "ACTIVE") {
    throw new Error(`Run ${runId} cannot be applied in status ${run.status}`);
  }

  const pending = await db.priceSnapshot.findMany({
    where: { runId, status: "PENDING" },
    orderBy: { variantId: "asc" },
  });

  let applied = 0;
  let conflicts = 0;
  for (const [productId, snaps] of groupBy(pending, (s) => s.productId)) {
    const states = await gateway.getVariants(snaps.map((s) => s.variantId));
    const alreadyWritten: PriceSnapshot[] = [];
    const toWrite: PriceSnapshot[] = [];
    const conflicted: PriceSnapshot[] = [];

    for (const snap of snaps) {
      const state = states.get(snap.variantId);
      if (state && state.marker?.runId === runId && snapshotMatches(state, snap.appliedPrice, snap.appliedCompareAt)) {
        alreadyWritten.push(snap); // a previous attempt wrote it but crashed before the DB update
      } else if (state && snapshotMatches(state, snap.originalPrice, snap.originalCompareAt)) {
        toWrite.push(snap);
      } else {
        conflicted.push(snap); // changed by someone else since the snapshot, or deleted
      }
    }

    await guard();
    if (toWrite.length > 0) {
      await assertRunApplicable(db, runId);
      await gateway.writePrices(
        productId,
        toWrite.map((s) => ({
          variantId: s.variantId,
          price: moneyFromDb(s.appliedPrice),
          compareAt: moneyFromDb(s.appliedCompareAt),
          marker: {
            saleId: run.saleId,
            runId,
            originalPrice: moneyFromDb(s.originalPrice),
            originalCompareAt: optionalMoneyFromDb(s.originalCompareAt),
          },
        })),
      );
    }

    const nowApplied = [...alreadyWritten, ...toWrite];
    if (nowApplied.length > 0 || conflicted.length > 0) {
      await db.$transaction(async (tx) => {
        const claimed = await tx.priceSnapshot.updateMany({
          where: { id: { in: nowApplied.map((s) => s.id) }, status: "PENDING" },
          data: { status: "APPLIED" },
        });
        if (claimed.count !== nowApplied.length) {
          throw new Error(`Concurrent apply detected for run ${runId}`);
        }
        const conflictClaim = await tx.priceSnapshot.updateMany({
          where: { id: { in: conflicted.map((s) => s.id) }, status: "PENDING" },
          data: { status: "CONFLICT" },
        });
        if (conflictClaim.count !== conflicted.length) {
          throw new Error(`Concurrent apply detected for run ${runId}`);
        }
        await tx.priceChangeLog.createMany({
          data: nowApplied.map((s) => ({
            shop: run.sale.shop,
            saleId: run.saleId,
            runId,
            variantId: s.variantId,
            action: "apply",
            oldPrice: s.originalPrice,
            oldCompareAt: s.originalCompareAt,
            newPrice: s.appliedPrice,
            newCompareAt: s.appliedCompareAt,
          })),
        });
      });
    }
    applied += nowApplied.length;
    conflicts += conflicted.length;
  }

  await applyTags(db, gateway, run, guard);

  if (run.status === "APPLYING") {
    await db.saleRun.updateMany({ where: { id: runId, status: "APPLYING" }, data: { status: "ACTIVE", startedAt: new Date() } });
  }
  return { applied, conflicts };
}

async function assertRunApplicable(db: PrismaClient, runId: string) {
  const { status } = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
  if (status !== "APPLYING" && status !== "ACTIVE") {
    throw new RunSupersededError(`Run ${runId} moved to ${status} while applying`);
  }
}

/** Records the tag change first, then applies it, so a crash can always be undone. */
async function applyTags(db: PrismaClient, gateway: ShopifyGateway, run: SaleRun & { sale: Sale }, guard: WriteGuard) {
  const { tagsToAdd, tagsToRemove } = run.sale;
  if (tagsToAdd.length === 0 && tagsToRemove.length === 0) return;

  const appliedProducts = await db.priceSnapshot.findMany({
    where: { runId: run.id, status: "APPLIED" },
    distinct: ["productId"],
    select: { productId: true },
  });
  const recorded = await db.runProduct.findMany({ where: { runId: run.id } });
  const recordedIds = new Set(recorded.map((r) => r.productId));
  const newIds = appliedProducts.map((p) => p.productId).filter((id) => !recordedIds.has(id));

  const currentTags = await gateway.getProductTags(newIds);
  for (const productId of newIds) {
    const tags = new Set(currentTags.get(productId) ?? []);
    await db.runProduct.create({
      data: {
        runId: run.id,
        productId,
        addedTags: tagsToAdd.filter((t) => !tags.has(t)),
        removedTags: tagsToRemove.filter((t) => tags.has(t)),
      },
    });
  }

  const unapplied = await db.runProduct.findMany({ where: { runId: run.id, tagsApplied: false } });
  for (const row of unapplied) {
    await guard();
    await assertRunApplicable(db, run.id);
    await gateway.addTags(row.productId, row.addedTags);
    await gateway.removeTags(row.productId, row.removedTags);
    await db.runProduct.update({ where: { id: row.id }, data: { tagsApplied: true } });
  }
}

export function snapshotMatches(state: VariantState, price: bigint, compareAt: bigint | null): boolean {
  return state.price === moneyFromDb(price) && state.compareAt === optionalMoneyFromDb(compareAt);
}

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
