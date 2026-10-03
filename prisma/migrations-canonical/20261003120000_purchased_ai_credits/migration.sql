-- Purchased AI credits: a balance bought outright (one-time Stripe Checkout in
-- Cloud), and one fulfilment row per paid Checkout Session.
--
-- Purely additive: a column defaulting to 0 and a new table. Code that does not
-- know about either keeps working, so this can run ahead of the release that
-- uses it and survives a rollback of that release.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "purchasedCredits" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ai_credit_purchases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_credit_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_credit_purchases_stripeSessionId_key" ON "ai_credit_purchases"("stripeSessionId");

-- CreateIndex
CREATE INDEX "ai_credit_purchases_userId_createdAt_idx" ON "ai_credit_purchases"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ai_credit_purchases" ADD CONSTRAINT "ai_credit_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
