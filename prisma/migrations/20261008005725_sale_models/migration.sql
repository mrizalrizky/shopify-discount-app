-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PREPARING', 'APPLYING', 'ACTIVE', 'RESTORING', 'ENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('PENDING', 'APPLIED', 'RESTORED', 'CONFLICT', 'KEPT');

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'DRAFT',
    "timezone" TEXT NOT NULL,
    "priceBase" TEXT NOT NULL,
    "rounding" JSONB NOT NULL,
    "minPrice" BIGINT,
    "tagsToAdd" TEXT[],
    "tagsToRemove" TEXT[],
    "scheduleKind" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "recurring" JSONB,
    "autoRefresh" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleGroup" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL,
    "amountType" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "targets" JSONB NOT NULL,
    "exclusions" JSONB NOT NULL,

    CONSTRAINT "RuleGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleRun" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PREPARING',
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "SaleRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ruleGroupId" TEXT NOT NULL,
    "originalPrice" BIGINT NOT NULL,
    "originalCompareAt" BIGINT,
    "appliedPrice" BIGINT NOT NULL,
    "appliedCompareAt" BIGINT NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'PENDING',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunProduct" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "addedTags" TEXT[],
    "removedTags" TEXT[],
    "tagsApplied" BOOLEAN NOT NULL DEFAULT false,
    "tagsRestored" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RunProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceChangeLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldPrice" BIGINT NOT NULL,
    "oldCompareAt" BIGINT,
    "newPrice" BIGINT NOT NULL,
    "newCompareAt" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sale_shop_status_idx" ON "Sale"("shop", "status");

-- CreateIndex
CREATE INDEX "RuleGroup_saleId_idx" ON "RuleGroup"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleRun_saleId_windowStart_key" ON "SaleRun"("saleId", "windowStart");

-- CreateIndex
CREATE INDEX "PriceSnapshot_runId_status_idx" ON "PriceSnapshot"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PriceSnapshot_runId_variantId_key" ON "PriceSnapshot"("runId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "RunProduct_runId_productId_key" ON "RunProduct"("runId", "productId");

-- CreateIndex
CREATE INDEX "PriceChangeLog_shop_createdAt_idx" ON "PriceChangeLog"("shop", "createdAt");

-- AddForeignKey
ALTER TABLE "RuleGroup" ADD CONSTRAINT "RuleGroup_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleRun" ADD CONSTRAINT "SaleRun_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SaleRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunProduct" ADD CONSTRAINT "RunProduct_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SaleRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
