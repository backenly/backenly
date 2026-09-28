-- Usage limits: the spend limit, alerts sent once, and grace-period state.
--
-- usage_spend_limits: the most a billing account allows beyond its included
--   usage in a month, in cents. No row means 0 (every quota a hard cap).
-- usage_alerts: one row per account, month, axis and level crossed, so each
--   alert is sent exactly once across processes and restarts.
-- usage_limit_states: since when an account has been over its effective limit
--   on an axis whose limit behaviour starts with a grace period.
--
-- Purely additive: three new tables and their indexes. No existing table or
-- row is touched.

-- CreateTable
CREATE TABLE "usage_spend_limits" (
    "billingAccountId" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL DEFAULT 0,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_spend_limits_pkey" PRIMARY KEY ("billingAccountId")
);

-- CreateTable
CREATE TABLE "usage_alerts" (
    "id" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "observed" BIGINT NOT NULL,
    "limit" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_limit_states" (
    "billingAccountId" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "overSince" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_limit_states_pkey" PRIMARY KEY ("billingAccountId","axis")
);

-- CreateIndex
CREATE INDEX "usage_alerts_billingAccountId_period_idx" ON "usage_alerts"("billingAccountId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "usage_alerts_billingAccountId_period_axis_level_key" ON "usage_alerts"("billingAccountId", "period", "axis", "level");
