-- Inactivity pause: the state a project is in, and what a plan says about it.
--
-- Backenly Cloud pauses a Free project that has seen no real use for a while.
-- These columns hold that state. Nothing in the public product writes
-- `pausedAt`, so on a self-hosted deployment every column below stays NULL and
-- the runtime serves exactly as before.
--
-- Every column is nullable and every NULL means "nothing changes": a project
-- that was never paused is not paused, and a plan row that was never seeded
-- with pause values never pauses anyone. An unseeded database therefore fails
-- safe rather than pausing projects on a default nobody chose.

-- A delivery withdrawn because its project was paused. Terminal and never
-- retried: holding it instead would fire a weeks-old event on resume.
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "plans"
    -- Days without real use before a project on this plan is paused.
    ADD COLUMN "inactivityPauseDays" INTEGER,
    -- Days after pausing that resuming stays free on this plan.
    ADD COLUMN "pausedFreeResumeDays" INTEGER;

ALTER TABLE "projects"
    ADD COLUMN "pausedAt" TIMESTAMP(3),
    ADD COLUMN "pauseReason" TEXT,
    -- When the warning was DELIVERED, not when it was attempted. The sweep
    -- refuses to pause a project it could not warn.
    ADD COLUMN "pauseWarnedAt" TIMESTAMP(3),
    -- Real use only. Deliberately not backfilled: history cannot be trusted to
    -- say what counted, and `pausePolicySince` gives every project a full
    -- window from the day the policy first applies to it instead.
    ADD COLUMN "lastActivityAt" TIMESTAMP(3),
    ADD COLUMN "pausePolicySince" TIMESTAMP(3);

-- Every background pass filters on `pausedAt IS NULL`.
CREATE INDEX "projects_pausedAt_idx" ON "projects"("pausedAt");
