-- Backenly Enterprise: the contracts the founders record when they add an
-- enterprise customer in the Cloud admin console. Backenly never charges them;
-- Stripe invoices them. A row says who is on Enterprise, for which term and
-- what the deal is worth, and carries the founders' renewal reminders.
--
-- Purely additive: one new table, its indexes, and two nullable foreign keys
-- (to users and organizations). No existing table, column or row is touched.
-- Written and read only by the Backenly Cloud overlay, so a self-hosted
-- install keeps it empty.

-- CreateTable
CREATE TABLE "enterprise_contracts" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "subscriptionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "companyName" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT NOT NULL,
    "termStartsAt" TIMESTAMP(3) NOT NULL,
    "termEndsAt" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "billingPeriod" TEXT,
    "stripeCustomerId" TEXT,
    "note" TEXT,
    "welcomeSentAt" TIMESTAMP(3),
    "firstSignInAt" TIMESTAMP(3),
    "reminder30SentAt" TIMESTAMP(3),
    "reminder7SentAt" TIMESTAMP(3),
    "endedNoticeSentAt" TIMESTAMP(3),
    "lastOverdueNoticeAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enterprise_contracts_status_idx" ON "enterprise_contracts"("status");

-- CreateIndex
CREATE INDEX "enterprise_contracts_termEndsAt_idx" ON "enterprise_contracts"("termEndsAt");

-- CreateIndex
CREATE INDEX "enterprise_contracts_userId_idx" ON "enterprise_contracts"("userId");

-- CreateIndex
CREATE INDEX "enterprise_contracts_organizationId_idx" ON "enterprise_contracts"("organizationId");

-- AddForeignKey
ALTER TABLE "enterprise_contracts" ADD CONSTRAINT "enterprise_contracts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_contracts" ADD CONSTRAINT "enterprise_contracts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

