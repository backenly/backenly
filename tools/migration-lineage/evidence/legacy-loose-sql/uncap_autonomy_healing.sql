-- Uncap self-healing on every plan.
--
-- Healing was metered as a conversion lever: Free 5 fixes per rolling hour and
-- ~120 healing windows a month, Pro 20, Enterprise 50. That sells the exact
-- failure this product exists to remove — a backend that stops repairing itself
-- once you hit a quota is a broken backend, whatever tier it is on.
--
-- After this migration NULL means UNLIMITED for both levers, and every plan is
-- NULL. Plans separate on capacity (projects, MAU, storage, AI credits), never
-- on whether the loop is allowed to keep working.
--
-- Runaway protection does NOT come from these columns any more. It comes from
-- the plan-independent anti-storm ceiling in lib/autonomy/circuit-breaker.ts
-- (AUTONOMY_STORM_CEILING, default 500/hour) which exists solely to catch a
-- flapping detector and sits far above any legitimate workload.

-- 1. Allow NULL (= unlimited). The column was NOT NULL DEFAULT 3.
ALTER TABLE "plans" ALTER COLUMN "autonomyMaxActionsPerWindow" DROP NOT NULL;
ALTER TABLE "plans" ALTER COLUMN "autonomyMaxActionsPerWindow" DROP DEFAULT;

-- 2. Lift the cap on every existing plan row, including any custom Enterprise
--    contract seeded outside prisma/seed-billing.ts.
UPDATE "plans" SET "autonomyMaxActionsPerWindow" = NULL;

-- 3. Free's monthly healing-window budget (120, then detect-only). Paid tiers
--    were already NULL; this makes it unconditional.
UPDATE "plans" SET "autonomyMonthlyScanBudget" = NULL;
