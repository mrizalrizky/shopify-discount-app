import type { PriceSnapshot, PrismaClient } from "@prisma/client";
import type { ShopifyGateway } from "../shopify/gateway";
import { groupBy, snapshotMatches } from "./apply";
import { moneyFromDb, moneyToDb, optionalMoneyFromDb, optionalMoneyToDb } from "./money-db";

export async function restoreRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
): Promise<{ restored: number; conflicts: number }> {
  const run = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
  if (run.status === "ENDED") return { restored: 0, conflicts: 0 };

  const claimedRun = await db.saleRun.updateMany({
    where: { id: runId, status: { in: ["APPLYING", "ACTIVE", "RESTORING", "FAILED"] } },
    data: { status: "RESTORING" },
  });
  if (claimedRun.count === 0) return { restored: 0, conflicts: 0 }; // ended concurrently
  const snapshots = await db.priceSnapshot.findMany({
    where: { runId, status: { in: ["PENDING", "APPLIED"] } },
    orderBy: { variantId: "asc" },
  });
  const result = await restoreSnapshots(db, gateway, run.sale.shop, runId, snapshots);
  await restoreTags(db, gateway, runId);
  await db.saleRun.updateMany({ where: { id: runId, status: "RESTORING" }, data: { status: "ENDED", endedAt: new Date() } });
  return result;
}

export async function restoreSnapshots(
  db: PrismaClient,
  gateway: ShopifyGateway,
  shop: string,
  runId: string,
  snapshots: PriceSnapshot[],
): Promise<{ restored: number; conflicts: number }> {
  const states = await gateway.getVariants(snapshots.map((s) => s.variantId));
  let restored = 0;
  let conflicts = 0;

  for (const [productId, snaps] of groupBy(snapshots, (s) => s.productId)) {
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

async function restoreTags(db: PrismaClient, gateway: ShopifyGateway, runId: string) {
  const rows = await db.runProduct.findMany({ where: { runId, tagsRestored: false } });
  for (const row of rows) {
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
  if (snap.status !== "CONFLICT") throw new Error(`Snapshot ${snapshotId} is not in conflict`);

  if (choice === "restore") {
    const current = (await gateway.getVariants([snap.variantId])).get(snap.variantId);
    await gateway.writePrices(snap.productId, [
      { variantId: snap.variantId, price: moneyFromDb(snap.originalPrice), compareAt: optionalMoneyFromDb(snap.originalCompareAt) },
    ]);
    if (current) {
      await db.priceChangeLog.create({
        data: {
          shop: snap.run.sale.shop,
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
  }
  await gateway.clearMarkers([snap.variantId]);
  await db.priceSnapshot.update({
    where: { id: snapshotId },
    data: { status: choice === "restore" ? "RESTORED" : "KEPT" },
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
