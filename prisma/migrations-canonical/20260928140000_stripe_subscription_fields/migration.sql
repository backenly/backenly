-- Stripe subscription fields, for Backenly Cloud's move from Paddle to Stripe.
--
-- Five nullable columns on subscriptions and two indexes. Existing rows keep
-- NULL (they are Paddle, comped or free), so nothing is backfilled and no
-- existing value changes. The unique index is over a column that is NULL on
-- every existing row.

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "billingInterval" TEXT,
ADD COLUMN     "currentPeriodStart" TIMESTAMP(3),
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripePriceId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripeSubscriptionId_key" ON "subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_stripeCustomerId_idx" ON "subscriptions"("stripeCustomerId");

