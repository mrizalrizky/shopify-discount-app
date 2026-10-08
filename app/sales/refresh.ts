import type { PrismaClient } from "@prisma/client";
import type { ShopifyGateway } from "../shopify/gateway";
import { applyRun } from "./apply";
import { planForSale, toSnapshotRow } from "./load";
import { findActiveOverlaps, lockShop } from "./prepare";
import { restoreSnapshots } from "./restore";

export async function refreshRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
): Promise<{ added: number; removed: number }> {
  const run = await db.saleRun.findUniqueOrThrow({
    where: { id: runId },
    include: { sale: { include: { ruleGroups: true } } },
  });
  if (run.status !== "ACTIVE" || !run.sale.autoRefresh) return { added: 0, removed: 0 };

  const plan = await planForSale(gateway, run.sale, runId);
  const snapshots = await db.priceSnapshot.findMany({ where: { runId } });
  const known = new Set(snapshots.map((s) => s.variantId));
  const planned = new Set(plan.changes.map((c) => c.variantId));

  const candidates = plan.changes.filter((c) => !known.has(c.variantId));
  // Insert under the per-shop lock, skipping variants that belong to another active sale.
  const added = await db.$transaction(async (tx) => {
    if (candidates.length === 0) return [];
    await lockShop(tx, run.sale.shop);
    const overlaps = await findActiveOverlaps(tx, run.sale, candidates.map((c) => c.variantId));
    const blocked = new Set(overlaps.flatMap((o) => o.variantIds));
    const fresh = candidates.filter((c) => !blocked.has(c.variantId));
    if (fresh.length > 0) {
      await tx.priceSnapshot.createMany({ data: fresh.map((c) => toSnapshotRow(runId, c)), skipDuplicates: true });
    }
    return fresh;
  });

  const leaving = snapshots.filter((s) => s.status === "APPLIED" && !planned.has(s.variantId));
  if (leaving.length > 0) await restoreSnapshots(db, gateway, run.sale.shop, runId, leaving);
  const stranded = snapshots.some((s) => s.status === "PENDING");
  if (added.length > 0 || stranded) await applyRun(db, gateway, runId);

  await db.saleRun.update({ where: { id: runId }, data: { lastRefreshedAt: new Date() } });
  return { added: added.length, removed: leaving.length };
}
