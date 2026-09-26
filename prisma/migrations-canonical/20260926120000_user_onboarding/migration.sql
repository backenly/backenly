-- The Getting Started guide's stored state: a user's choice to hide or reopen
-- it, and which funnel milestones have already been reported.
--
-- Step completion is not stored here. It is derived on every read from the
-- product state that proves it (lib/onboarding), so nothing in this table can
-- tell the guide a step is done.
--
-- A new table rather than columns on "users". The session lookup loads the whole
-- user row on every authenticated request, so a column there would break sign-in
-- for as long as a release ran ahead of this migration. Without this table only
-- the guide is affected, and it reads the table defensively.
--
-- Additive: no existing table, column or row changes.

-- CreateTable
CREATE TABLE "user_onboarding" (
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "reportedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_onboarding_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
