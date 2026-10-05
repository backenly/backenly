-- Billing accounts: plan allowances move from the user to the account that
-- pays for them (an organization on Backenly Cloud, the owning account where
-- there are no organizations).
--
-- Additive: two new tables, three new nullable columns and their indexes, two
-- mirror triggers, and a copy of the per-user counters and balances into the
-- new tables under the SAME ids they were kept under. No existing row is changed or removed, so the
-- application that predates this migration keeps reading what it always read,
-- and the migration survives a rollback of the release that uses it.
--
-- Moving the copied rows from a user's id to that user's organization is NOT
-- done here. It is a Backenly Cloud decision about Cloud data and runs as a
-- release step of the Cloud overlay, after this migration. A deployment with
-- no organizations keeps the user id as its billing account, so for it this
-- copy is the whole change.
--
-- A rolling deploy serves the previous release alongside the new one for a few
-- minutes, and the previous release still writes the per-user counters and
-- balances. Triggers at the end of this file carry each such write into the new
-- tables, so the copy loses nothing written after it.
--
-- The whole file runs as one transaction. Writers to the two sources are held
-- off from the start, before any other lock is taken, so that the copy and the
-- triggers see the same rows: a write lands before the copy and is copied, or
-- after the triggers exist and is mirrored.
LOCK TABLE "users", "user_ai_usage" IN SHARE ROW EXCLUSIVE MODE;

-- AlterTable
ALTER TABLE "credit_reservations" ADD COLUMN     "billingAccountId" TEXT;

-- AlterTable
ALTER TABLE "credit_ledger_entries" ADD COLUMN     "billingAccountId" TEXT;

-- AlterTable
ALTER TABLE "ai_credit_purchases" ADD COLUMN     "billingAccountId" TEXT;

-- CreateTable
CREATE TABLE "account_ai_usage" (
    "id" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "intentCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "apiRequestCount" BIGINT NOT NULL DEFAULT 0,
    "aiFunctionInvocations" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_credits" (
    "billingAccountId" TEXT NOT NULL,
    "bonusCredits" INTEGER NOT NULL DEFAULT 0,
    "purchasedCredits" INTEGER NOT NULL DEFAULT 0,
    "bonusReconciledThrough" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_credits_pkey" PRIMARY KEY ("billingAccountId")
);

-- CreateIndex
CREATE INDEX "account_ai_usage_date_idx" ON "account_ai_usage"("date");

-- CreateIndex
CREATE UNIQUE INDEX "account_ai_usage_billingAccountId_date_key" ON "account_ai_usage"("billingAccountId", "date");

-- CreateIndex
CREATE INDEX "credit_reservations_billingAccountId_date_idx" ON "credit_reservations"("billingAccountId", "date");

-- CreateIndex
CREATE INDEX "credit_ledger_entries_billingAccountId_createdAt_idx" ON "credit_ledger_entries"("billingAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_credit_purchases_billingAccountId_createdAt_idx" ON "ai_credit_purchases"("billingAccountId", "createdAt");


-- Copy: the monthly counters, one row per user and month.
INSERT INTO "account_ai_usage" (
    "id", "billingAccountId", "date", "intentCount", "reservedCount", "tokenCount",
    "apiRequestCount", "aiFunctionInvocations", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text, u."userId", u."date", u."intentCount", u."reservedCount", u."tokenCount",
    u."apiRequestCount", u."aiFunctionInvocations", u."createdAt", u."updatedAt"
FROM "user_ai_usage" u
ON CONFLICT ("billingAccountId", "date") DO NOTHING;

-- Copy: the credit balances, for every account that has one to carry.
INSERT INTO "account_credits" (
    "billingAccountId", "bonusCredits", "purchasedCredits", "bonusReconciledThrough", "createdAt", "updatedAt"
)
SELECT u."id", u."bonusCredits", u."purchasedCredits", u."bonusReconciledThrough", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users" u
WHERE u."bonusCredits" <> 0 OR u."purchasedCredits" <> 0 OR u."bonusReconciledThrough" IS NOT NULL
ON CONFLICT ("billingAccountId") DO NOTHING;

-- Backfill: every existing movement, purchase and reservation was the user's.
UPDATE "credit_ledger_entries" SET "billingAccountId" = "userId" WHERE "billingAccountId" IS NULL;
UPDATE "ai_credit_purchases" SET "billingAccountId" = "userId" WHERE "billingAccountId" IS NULL;
UPDATE "credit_reservations" SET "billingAccountId" = "userId" WHERE "billingAccountId" IS NULL;

-- Mirror: a rolling deploy serves the previous release alongside this one for
-- a few minutes, and the previous release still writes the per-user counters
-- and balances. Each such write is carried into the per-account tables as the
-- change it made, so nothing recorded in that window is lost or counted twice.
-- The release that reads the new tables writes neither source, so once the
-- previous release has stopped these never fire again; a later migration
-- drops them with the old columns. Deletes are not mirrored: the old monthly
-- purge removes old months, and the new one purges account_ai_usage itself.
CREATE FUNCTION "account_ai_usage_mirror"() RETURNS trigger AS $$
DECLARE
  d_intent   INTEGER := NEW."intentCount";
  d_reserved INTEGER := NEW."reservedCount";
  d_tokens   INTEGER := NEW."tokenCount";
  d_requests BIGINT  := NEW."apiRequestCount";
  d_runs     INTEGER := NEW."aiFunctionInvocations";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    d_intent   := NEW."intentCount" - OLD."intentCount";
    d_reserved := NEW."reservedCount" - OLD."reservedCount";
    d_tokens   := NEW."tokenCount" - OLD."tokenCount";
    d_requests := NEW."apiRequestCount" - OLD."apiRequestCount";
    d_runs     := NEW."aiFunctionInvocations" - OLD."aiFunctionInvocations";
  END IF;
  IF d_intent = 0 AND d_reserved = 0 AND d_tokens = 0 AND d_requests = 0 AND d_runs = 0 THEN
    RETURN NULL;
  END IF;
  INSERT INTO "account_ai_usage" (
      "id", "billingAccountId", "date", "intentCount", "reservedCount", "tokenCount",
      "apiRequestCount", "aiFunctionInvocations", "createdAt", "updatedAt"
  )
  VALUES (
      gen_random_uuid()::text, NEW."userId", NEW."date", d_intent, d_reserved, d_tokens,
      d_requests, d_runs, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("billingAccountId", "date") DO UPDATE SET
      "intentCount"           = "account_ai_usage"."intentCount" + EXCLUDED."intentCount",
      "reservedCount"         = "account_ai_usage"."reservedCount" + EXCLUDED."reservedCount",
      "tokenCount"            = "account_ai_usage"."tokenCount" + EXCLUDED."tokenCount",
      "apiRequestCount"       = "account_ai_usage"."apiRequestCount" + EXCLUDED."apiRequestCount",
      "aiFunctionInvocations" = "account_ai_usage"."aiFunctionInvocations" + EXCLUDED."aiFunctionInvocations",
      "updatedAt"             = CURRENT_TIMESTAMP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "user_ai_usage_mirror"
  AFTER INSERT OR UPDATE ON "user_ai_usage"
  FOR EACH ROW EXECUTE FUNCTION "account_ai_usage_mirror"();

CREATE FUNCTION "account_credits_mirror"() RETURNS trigger AS $$
DECLARE
  d_bonus     INTEGER := NEW."bonusCredits";
  d_purchased INTEGER := NEW."purchasedCredits";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    d_bonus     := NEW."bonusCredits" - OLD."bonusCredits";
    d_purchased := NEW."purchasedCredits" - OLD."purchasedCredits";
  END IF;
  INSERT INTO "account_credits" (
      "billingAccountId", "bonusCredits", "purchasedCredits", "bonusReconciledThrough", "createdAt", "updatedAt"
  )
  VALUES (NEW."id", d_bonus, d_purchased, NEW."bonusReconciledThrough", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("billingAccountId") DO UPDATE SET
      "bonusCredits"           = "account_credits"."bonusCredits" + EXCLUDED."bonusCredits",
      "purchasedCredits"       = "account_credits"."purchasedCredits" + EXCLUDED."purchasedCredits",
      -- Months as YYYY-MM sort as text; GREATEST ignores a NULL.
      "bonusReconciledThrough" = GREATEST("account_credits"."bonusReconciledThrough", EXCLUDED."bonusReconciledThrough"),
      "updatedAt"              = CURRENT_TIMESTAMP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "users_credits_mirror_insert"
  AFTER INSERT ON "users"
  FOR EACH ROW
  WHEN (NEW."bonusCredits" <> 0 OR NEW."purchasedCredits" <> 0 OR NEW."bonusReconciledThrough" IS NOT NULL)
  EXECUTE FUNCTION "account_credits_mirror"();

CREATE TRIGGER "users_credits_mirror_update"
  AFTER UPDATE OF "bonusCredits", "purchasedCredits", "bonusReconciledThrough" ON "users"
  FOR EACH ROW
  WHEN (
    OLD."bonusCredits" IS DISTINCT FROM NEW."bonusCredits"
    OR OLD."purchasedCredits" IS DISTINCT FROM NEW."purchasedCredits"
    OR OLD."bonusReconciledThrough" IS DISTINCT FROM NEW."bonusReconciledThrough"
  )
  EXECUTE FUNCTION "account_credits_mirror"();
