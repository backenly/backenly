-- Billing-grade usage ledger.
--
-- usage_daily: one row per project, axis, UTC day and measurement source.
--   Counter axes add up; gauge axes keep the day's maximum. No foreign key to
--   projects on purpose: usage outlives a deleted project.
-- usage_period_closes: one immutable row per billing account, month and axis,
--   written once by the monthly close.
-- usage_applied_batches: the exactly-once guard. A flush batch, a replayed
--   spool file or an ingested access-log object inserts its id here in the same
--   transaction as its increments, so nothing can be counted twice.
--
-- Purely additive: three new tables and their indexes, plus a trigger on the
-- new close table. No existing table or row is touched.

-- CreateTable
CREATE TABLE "usage_daily" (
    "id" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "quantity" BIGINT NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_period_closes" (
    "id" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "unit" TEXT NOT NULL,
    "detail" JSONB,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_period_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_applied_batches" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entries" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_applied_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_daily_billingAccountId_day_idx" ON "usage_daily"("billingAccountId", "day");

-- CreateIndex
CREATE INDEX "usage_daily_day_idx" ON "usage_daily"("day");

-- CreateIndex
CREATE UNIQUE INDEX "usage_daily_projectId_axis_day_source_key" ON "usage_daily"("projectId", "axis", "day", "source");

-- CreateIndex
CREATE INDEX "usage_period_closes_period_idx" ON "usage_period_closes"("period");

-- CreateIndex
CREATE UNIQUE INDEX "usage_period_closes_billingAccountId_period_axis_key" ON "usage_period_closes"("billingAccountId", "period", "axis");

-- CreateIndex
CREATE INDEX "usage_applied_batches_appliedAt_idx" ON "usage_applied_batches"("appliedAt");

-- A closed period is a billing fact. Refuse any UPDATE, whoever issues it.
-- (DELETE stays possible for account erasure.)
CREATE OR REPLACE FUNCTION "usage_period_closes_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'usage_period_closes is insert-only (% % %)', OLD."billingAccountId", OLD."period", OLD."axis";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "usage_period_closes_no_update"
  BEFORE UPDATE ON "usage_period_closes"
  FOR EACH ROW EXECUTE FUNCTION "usage_period_closes_refuse_update"();
