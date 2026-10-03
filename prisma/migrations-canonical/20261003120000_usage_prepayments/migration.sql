-- Usage prepayments: money an account paid in advance, through Stripe
-- Checkout, for usage beyond its plan. One row per paid Checkout Session; the
-- prepaid balance is these payments less the usage drawn from them
-- (usage_charges rows with status 'drawn').
--
-- Purely additive: one new table and its indexes. No existing table or row is
-- touched, so the application that predates this migration keeps working and
-- the migration survives a rollback of the release that uses it.

-- CreateTable
CREATE TABLE "usage_prepayments" (
    "id" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_prepayments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_prepayments_stripeSessionId_key" ON "usage_prepayments"("stripeSessionId");

-- CreateIndex
CREATE INDEX "usage_prepayments_billingAccountId_status_idx" ON "usage_prepayments"("billingAccountId", "status");
