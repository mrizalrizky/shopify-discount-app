import type { Prisma, PrismaClient, SaleStatus } from "@prisma/client";
import type { Target } from "../app/domain/sales/resolver";

export const SHOP = "demo.myshopify.com";

export interface GroupFixture {
  targets: Target[];
  exclusions?: Target[];
  amountType?: "percentOff" | "fixedOff" | "fixedPrice";
  amount?: number;
  priority?: number;
}

export interface SaleFixture {
  shop?: string;
  status?: SaleStatus;
  groups: GroupFixture[];
  priceBase?: "compareAt" | "current";
  minPrice?: bigint | null;
  tagsToAdd?: string[];
  tagsToRemove?: string[];
  autoRefresh?: boolean;
  scheduleKind?: "manual" | "once" | "recurring";
  startsAt?: Date | null;
  endsAt?: Date | null;
  recurring?: Prisma.InputJsonValue;
  timezone?: string;
}

export async function createSale(db: PrismaClient, input: SaleFixture) {
  return db.sale.create({
    data: {
      shop: input.shop ?? SHOP,
      title: "Test sale",
      status: input.status ?? "SCHEDULED",
      timezone: input.timezone ?? "Asia/Jakarta",
      priceBase: input.priceBase ?? "compareAt",
      rounding: { kind: "none" },
      minPrice: input.minPrice ?? null,
      tagsToAdd: input.tagsToAdd ?? [],
      tagsToRemove: input.tagsToRemove ?? [],
      scheduleKind: input.scheduleKind ?? "manual",
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      recurring: input.recurring,
      autoRefresh: input.autoRefresh ?? false,
      ruleGroups: {
        create: input.groups.map((g, position) => ({
          position,
          priority: g.priority ?? 1,
          amountType: g.amountType ?? "percentOff",
          amount: g.amount ?? 30,
          targets: g.targets as unknown as Prisma.InputJsonValue,
          exclusions: (g.exclusions ?? []) as unknown as Prisma.InputJsonValue,
        })),
      },
    },
    include: { ruleGroups: true },
  });
}

export async function createRun(
  db: PrismaClient,
  saleId: string,
  windowStart = new Date("2026-11-01T00:00:00Z"),
  windowEnd: Date | null = null,
) {
  return db.saleRun.create({ data: { saleId, windowStart, windowEnd } });
}
