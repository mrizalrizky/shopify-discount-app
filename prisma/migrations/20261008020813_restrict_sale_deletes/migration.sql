-- Deleting a sale (or run) must never silently drop the snapshots that hold the
-- original prices of variants that may still be discounted.

-- DropForeignKey
ALTER TABLE "PriceSnapshot" DROP CONSTRAINT "PriceSnapshot_runId_fkey";

-- DropForeignKey
ALTER TABLE "SaleRun" DROP CONSTRAINT "SaleRun_saleId_fkey";

-- AlterTable: add saleId, backfilled from the run for existing rows.
ALTER TABLE "PriceChangeLog" ADD COLUMN "saleId" TEXT;
UPDATE "PriceChangeLog" l SET "saleId" = r."saleId" FROM "SaleRun" r WHERE r."id" = l."runId";
-- Rows whose run was already cascade-deleted keep an empty sale id.
UPDATE "PriceChangeLog" SET "saleId" = '' WHERE "saleId" IS NULL;
ALTER TABLE "PriceChangeLog" ALTER COLUMN "saleId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "SaleRun" ADD CONSTRAINT "SaleRun_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SaleRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
