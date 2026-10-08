import type { Prisma, PrismaClient, Sale } from "@prisma/client";
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

  // The overlap check and snapshot write share one transaction guarded by a
  // per-shop advisory lock, so concurrent prepares for the same shop serialize.
  const overlaps = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${run.sale.shop}))::text`;
    const found = await findActiveOverlaps(tx, run.sale, plan.changes.map((c) => c.variantId));
    if (found.length > 0) return found;

    // All snapshots or none, verified, before Shopify is touched (spec §5.4 steps 2–3).
    await tx.priceSnapshot.createMany({ data: plan.changes.map((c) => toSnapshotRow(runId, c)) });
    const saved = await tx.priceSnapshot.count({ where: { runId } });
    if (saved !== plan.changes.length) {
      throw new Error(`Snapshot count mismatch: expected ${plan.changes.length}, saved ${saved}`);
    }
    const moved = await tx.saleRun.updateMany({
      where: { id: runId, status: "PREPARING" },
      data: { status: "APPLYING" },
    });
    if (moved.count !== 1) throw new Error(`Run ${runId} is no longer PREPARING`);
    return [];
  });

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

  return { status: "ready", count: plan.changes.length, skipped: plan.skipped };
}

async function findActiveOverlaps(db: Prisma.TransactionClient, sale: Sale, variantIds: string[]): Promise<Overlap[]> {
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
