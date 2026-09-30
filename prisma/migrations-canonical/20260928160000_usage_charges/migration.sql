-- Usage charges: what usage past a plan came to per account, month and axis,
-- and what became of it (shadow, carried, invoiced, charged, failed, waived).
--
-- Purely additive: one new table and its indexes. No existing table or row is
-- touched.

-- CreateTable
CREATE TABLE "usage_charges" (
    "id" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "overQuantity" BIGINT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "stripeInvoiceId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_charges_status_idx" ON "usage_charges"("status");

-- CreateIndex
CREATE INDEX "usage_charges_stripeInvoiceId_idx" ON "usage_charges"("stripeInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "usage_charges_billingAccountId_period_axis_key" ON "usage_charges"("billingAccountId", "period", "axis");

