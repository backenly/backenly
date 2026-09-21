-- Recovery authority: what a rollback is allowed to undo.
--
-- The plan says what KIND of work should happen. Only the execution record can
-- say what actually happened, and rollback is reconstructed from here rather
-- than from the plan -- the plan does not even name the column, because that
-- arrives in the approval's bindings.
--
-- `preconditionEvidence` and `postconditionEvidence` already existed and are
-- NOT this. They hold the planner's declared sentences, made before the work
-- ran, which is the one thing a stale guard cannot be built from.
ALTER TABLE "maintenance_step_executions"
  -- What this step operated on, in real identifiers.
  ADD COLUMN "resourceIdentity"  JSONB,
  -- The resource's SHAPE before and after. Shape, not just name: a column name
  -- does not distinguish the one this ladder added from one recreated under the
  -- same name later, and dropping the second because the ledger remembers the
  -- first is how automatic recovery destroys somebody's work.
  ADD COLUMN "observedPreState"  JSONB,
  ADD COLUMN "observedPostState" JSONB,
  -- eligible | started | verified | failed | unverified | blocked_stale.
  -- `verified` is the ONLY value meaning the prior state was restored and
  -- independently confirmed.
  ADD COLUMN "rollbackStatus"    TEXT,
  ADD COLUMN "rollbackDetail"    TEXT,
  ADD COLUMN "rollbackAt"        TIMESTAMP(3);

CREATE INDEX "maintenance_step_executions_rollbackStatus_idx"
  ON "maintenance_step_executions"("rollbackStatus");
