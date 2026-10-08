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
    await lockShop(tx, run.sale.shop);
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
  }, SHOP_LOCK_TX_OPTIONS);

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

/** First key of the two-key advisory lock, so shop locks never collide with other advisory lock users. */
export const SHOP_LOCK_NAMESPACE = 0x53414c45; // "SALE"

/** Interactive transactions that take the shop lock: wait for it, and allow time for large catalogs. */
export const SHOP_LOCK_TX_OPTIONS = { maxWait: 30_000, timeout: 60_000 } as const;

const OVERLAP_CHUNK = 5_000;

export async function lockShop(tx: Prisma.TransactionClient, shop: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SHOP_LOCK_NAMESPACE}::int4, hashtext(${shop}))::text`;
}

export async function findActiveOverlaps(db: Prisma.TransactionClient, sale: Sale, variantIds: string[]): Promise<Overlap[]> {
  const unique = [...new Set(variantIds)];
  const rows: { variantId: string; run: { saleId: string } }[] = [];
  for (let i = 0; i < unique.length; i += OVERLAP_CHUNK) {
    rows.push(
      ...(await db.priceSnapshot.findMany({
        where: {
          variantId: { in: unique.slice(i, i + OVERLAP_CHUNK) },
          status: { in: ["PENDING", "APPLIED"] },
          run: { status: { in: ["APPLYING", "ACTIVE", "RESTORING"] }, sale: { shop: sale.shop, id: { not: sale.id } } },
        },
        select: { variantId: true, run: { select: { saleId: true } } },
      })),
    );
  }
  const bySale = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = bySale.get(row.run.saleId) ?? new Set<string>();
    set.add(row.variantId);
    bySale.set(row.run.saleId, set);
  }
  const others: SaleVariants[] = [...bySale].map(([saleId, ids]) => ({ saleId, variantIds: ids }));
  return findOverlaps(variantIds, others);
}
