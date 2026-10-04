-- Backenly for Startups: applications for the startup pass (Pro at no cost for
-- a fixed period), from verification through review to the pass ending.
--
-- Purely additive: one new table, its indexes, and a nullable foreign key to
-- users. No existing table or row is touched. Written and read only by the
-- Backenly Cloud overlay, so a self-hosted install keeps it empty.

-- CreateTable
CREATE TABLE "startup_applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unclaimed',
    "companyName" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "teamSize" TEXT NOT NULL,
    "currentBackend" TEXT NOT NULL,
    "building" TEXT NOT NULL,
    "applicantName" TEXT NOT NULL,
    "applicantRole" TEXT NOT NULL,
    "profileUrl" TEXT,
    "workEmail" TEXT NOT NULL,
    "workEmailVerifiedAt" TIMESTAMP(3) NOT NULL,
    "signals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "claimTokenHash" TEXT,
    "submittedIp" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "passStartsAt" TIMESTAMP(3),
    "passEndsAt" TIMESTAMP(3),
    "subscriptionId" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "startup_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "startup_applications_userId_key" ON "startup_applications"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "startup_applications_claimTokenHash_key" ON "startup_applications"("claimTokenHash");

-- CreateIndex
CREATE INDEX "startup_applications_status_idx" ON "startup_applications"("status");

-- CreateIndex
CREATE INDEX "startup_applications_domain_idx" ON "startup_applications"("domain");

-- CreateIndex
CREATE INDEX "startup_applications_passEndsAt_idx" ON "startup_applications"("passEndsAt");

-- AddForeignKey
ALTER TABLE "startup_applications" ADD CONSTRAINT "startup_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
