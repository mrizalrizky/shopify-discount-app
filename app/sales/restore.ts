import type { PriceSnapshot, PrismaClient } from "@prisma/client";
import type { ShopifyGateway } from "../shopify/gateway";
import { groupBy, snapshotMatches } from "./apply";
import { noGuard, type WriteGuard } from "./guard";
import { moneyFromDb, moneyToDb, optionalMoneyFromDb, optionalMoneyToDb } from "./money-db";

export async function restoreRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
  guard: WriteGuard = noGuard,
): Promise<{ restored: number; conflicts: number }> {
  const run = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
  if (run.status === "ENDED") return { restored: 0, conflicts: 0 };

  const claimedRun = await db.saleRun.updateMany({
    where: { id: runId, status: { in: ["PREPARING", "APPLYING", "ACTIVE", "RESTORING", "FAILED"] } },
    data: { status: "RESTORING" },
  });
  if (claimedRun.count === 0) {
    const now = await db.saleRun.findUniqueOrThrow({ where: { id: runId } });
    if (now.status === "ENDED") return { restored: 0, conflicts: 0 }; // ended concurrently
    throw new Error(`Run ${runId} cannot be restored in status ${now.status}`);
  }
  const snapshots = await db.priceSnapshot.findMany({
    where: { runId, status: { in: ["PENDING", "APPLIED"] } },
    orderBy: { variantId: "asc" },
  });
  const result = await restoreSnapshots(db, gateway, { runId, saleId: run.saleId, shop: run.sale.shop }, snapshots, guard);
  await restoreTags(db, gateway, runId, guard);
  await db.saleRun.updateMany({ where: { id: runId, status: "RESTORING" }, data: { status: "ENDED", endedAt: new Date() } });
  return result;
}

export interface RunContext {
  runId: string;
  saleId: string;
  shop: string;
}

export async function restoreSnapshots(
  db: PrismaClient,
  gateway: ShopifyGateway,
  { runId, saleId, shop }: RunContext,
  snapshots: PriceSnapshot[],
  guard: WriteGuard = noGuard,
): Promise<{ restored: number; conflicts: number }> {
  let restored = 0;
  let conflicts = 0;

  for (const [productId, snaps] of groupBy(snapshots, (s) => s.productId)) {
    // Read right before writing so an edit made while earlier products were restored is a conflict.
    const states = await gateway.getVariants(snaps.map((s) => s.variantId));
    const settled: PriceSnapshot[] = []; // gone, or already back at original prices
    const toWrite: PriceSnapshot[] = [];
    const conflicted: PriceSnapshot[] = [];
    const markersToClear: string[] = [];

    for (const snap of snaps) {
      const state = states.get(snap.variantId);
      if (!state) {
        settled.push(snap);
      } else if (snapshotMatches(state, snap.originalPrice, snap.originalCompareAt)) {
        settled.push(snap);
        if (state.marker) markersToClear.push(snap.variantId);
      } else if (snapshotMatches(state, snap.appliedPrice, snap.appliedCompareAt)) {
        toWrite.push(snap);
        markersToClear.push(snap.variantId);
      } else {
        conflicted.push(snap);
      }
    }

    await guard();
    if (toWrite.length > 0) {
      await gateway.writePrices(
        productId,
        toWrite.map((s) => ({
          variantId: s.variantId,
          price: moneyFromDb(s.originalPrice),
          compareAt: optionalMoneyFromDb(s.originalCompareAt),
        })),
      );
    }
    if (markersToClear.length > 0) await gateway.clearMarkers(markersToClear);

    // Settled APPLIED snapshots were restored by a crashed attempt: log them now.
    const logged = [...toWrite, ...settled.filter((s) => s.status === "APPLIED" && states.has(s.variantId))];
    const toRestore = [...settled, ...toWrite];
    if (toRestore.length > 0 || conflicted.length > 0) {
      await db.$transaction(async (tx) => {
        const claimed = await tx.priceSnapshot.updateMany({
          where: { id: { in: toRestore.map((s) => s.id) }, status: { in: ["PENDING", "APPLIED"] } },
          data: { status: "RESTORED" },
        });
        if (claimed.count !== toRestore.length) throw new Error(`Concurrent restore detected for run ${runId}`);
        const conflictClaim = await tx.priceSnapshot.updateMany({
          where: { id: { in: conflicted.map((s) => s.id) }, status: { in: ["PENDING", "APPLIED"] } },
          data: { status: "CONFLICT" },
        });
        if (conflictClaim.count !== conflicted.length) throw new Error(`Concurrent restore detected for run ${runId}`);
        await tx.priceChangeLog.createMany({
          data: logged.map((s) => ({
            shop,
            saleId,
            runId,
            variantId: s.variantId,
            action: "restore",
            oldPrice: s.appliedPrice,
            oldCompareAt: s.appliedCompareAt,
            newPrice: s.originalPrice,
            newCompareAt: s.originalCompareAt,
          })),
        });
      });
    }
    restored += settled.length + toWrite.length;
    conflicts += conflicted.length;
  }
  return { restored, conflicts };
}

async function restoreTags(db: PrismaClient, gateway: ShopifyGateway, runId: string, guard: WriteGuard) {
  const rows = await db.runProduct.findMany({ where: { runId, tagsRestored: false } });
  for (const row of rows) {
    await guard();
    await gateway.removeTags(row.productId, row.addedTags);
    await gateway.addTags(row.productId, row.removedTags);
    await db.runProduct.update({ where: { id: row.id }, data: { tagsRestored: true } });
  }
}

export async function resolveConflict(
  db: PrismaClient,
  gateway: ShopifyGateway,
  snapshotId: string,
  choice: "restore" | "keep",
): Promise<void> {
  const snap = await db.priceSnapshot.findUniqueOrThrow({ where: { id: snapshotId }, include: { run: { include: { sale: true } } } });
  if (snap.status !== "CONFLICT") return; // already resolved: idempotent no-op

  const current = (await gateway.getVariants([snap.variantId])).get(snap.variantId);
  const nextStatus = choice === "restore" ? "RESTORED" : "KEPT";
  let needsLog = false;

  if (current) {
    if (choice === "restore" && !snapshotMatches(current, snap.originalPrice, snap.originalCompareAt)) {
      await gateway.writePrices(snap.productId, [
        { variantId: snap.variantId, price: moneyFromDb(snap.originalPrice), compareAt: optionalMoneyFromDb(snap.originalCompareAt) },
      ]);
      needsLog = true;
    }
    await gateway.clearMarkers([snap.variantId]);
  }

  await db.$transaction(async (tx) => {
    const claimed = await tx.priceSnapshot.updateMany({ where: { id: snapshotId, status: "CONFLICT" }, data: { status: nextStatus } });
    if (claimed.count !== 1) return; // already resolved by a concurrent call or an earlier attempt
    if (needsLog && current) {
      await tx.priceChangeLog.create({
        data: {
          shop: snap.run.sale.shop,
          saleId: snap.run.saleId,
          runId: snap.runId,
          variantId: snap.variantId,
          action: "restore",
          oldPrice: moneyToDb(current.price),
          oldCompareAt: optionalMoneyToDb(current.compareAt),
          newPrice: snap.originalPrice,
          newCompareAt: snap.originalCompareAt,
        },
      });
    }
  });
}

/** Last-resort recovery using the original prices stored on each variant (spec §5.5). */
export async function recoverFromMetafields(gateway: ShopifyGateway, variantIds: string[]): Promise<number> {
  const states = [...(await gateway.getVariants(variantIds)).values()].filter((s) => s.marker);
  for (const [productId, group] of groupBy(states, (s) => s.productId)) {
    await gateway.writePrices(
      productId,
      group.map((s) => ({ variantId: s.variantId, price: s.marker!.originalPrice, compareAt: s.marker!.originalCompareAt })),
    );
  }
  await gateway.clearMarkers(states.map((s) => s.variantId));
  return states.length;
}
