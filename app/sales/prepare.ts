import type { PrismaClient, Sale } from "@prisma/client";
import type { SkippedVariant } from "../domain/sales/plan";
import { findOverlaps, type Overlap, type SaleVariants } from "../domain/sales/overlap";
import type { ShopifyGateway } from "../shopify/gateway";
import { planForSale, toSnapshotRow } from "./load";

export type PrepareResult =
  | { status: "ready"; count: number; skipped: SkippedVariant[] }
  | { status: "already_prepared" }
  | { status: "overlap"; overlaps: Overlap[] };

export async function prepareRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
): Promise<PrepareResult> {
  const run = await db.saleRun.findUniqueOrThrow({
    where: { id: runId },
    include: { sale: { include: { ruleGroups: true } } },
  });
  if (run.status !== "PREPARING") return { status: "already_prepared" };

  const plan = await planForSale(gateway, run.sale, runId);

  const overlaps = await findActiveOverlaps(db, run.sale, plan.changes.map((c) => c.variantId));
  if (overlaps.length > 0) {
    await db.saleRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        error: `Products overlap with active sales: ${overlaps.map((o) => o.saleId).join(", ")}`,
      },
    });
    return { status: "overlap", overlaps };
  }

  // All snapshots or none, verified, before Shopify is touched (spec §5.4 steps 2–3).
  await db.$transaction(async (tx) => {
    await tx.priceSnapshot.createMany({ data: plan.changes.map((c) => toSnapshotRow(runId, c)) });
    const saved = await tx.priceSnapshot.count({ where: { runId } });
    if (saved !== plan.changes.length) {
      throw new Error(`Snapshot count mismatch: expected ${plan.changes.length}, saved ${saved}`);
    }
    await tx.saleRun.update({ where: { id: runId }, data: { status: "APPLYING" } });
  });

  return { status: "ready", count: plan.changes.length, skipped: plan.skipped };
}

async function findActiveOverlaps(db: PrismaClient, sale: Sale, variantIds: string[]): Promise<Overlap[]> {
  const rows = await db.priceSnapshot.findMany({
    where: {
      status: { in: ["PENDING", "APPLIED"] },
      run: { status: { in: ["APPLYING", "ACTIVE", "RESTORING"] }, sale: { shop: sale.shop, id: { not: sale.id } } },
    },
    select: { variantId: true, run: { select: { saleId: true } } },
  });
  const bySale = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = bySale.get(row.run.saleId) ?? new Set<string>();
    set.add(row.variantId);
    bySale.set(row.run.saleId, set);
  }
  const others: SaleVariants[] = [...bySale].map(([saleId, ids]) => ({ saleId, variantIds: ids }));
  return findOverlaps(variantIds, others);
}
