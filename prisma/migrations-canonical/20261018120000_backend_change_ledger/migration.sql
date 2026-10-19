-- Governed backend changes: every change to a project's production backend,
-- with the checkpoint taken before it, the protected verification after it,
-- and its recovery (lib/changes, docs/CHANGE_RECOVERY.md).
--
--   backend_changes        one row per change. `checkpoint` holds what the
--                          change touched as it was before (per resource; only
--                          "database" today), `resultState` as it left it,
--                          `preserved` the vault schema
--                          (workspace_<project>_r<seq>) keeping data the change
--                          would otherwise have destroyed. A recovery is a
--                          change of its own (kind = 'recovery', recoversId).
--   backend_change_events  the lifecycle, one row per transition, append-only.
--
-- Additive. Nothing that predates this migration reads either table, so it can
-- run before the release that writes them and survives an application rollback.

-- CreateTable
CREATE TABLE "backend_changes" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'change',
    "resources" TEXT[] DEFAULT ARRAY['database']::TEXT[],
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "risk" TEXT,
    "actorUserId" TEXT,
    "apiKeyId" TEXT,
    "groupId" TEXT,
    "parentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'applying',
    "error" TEXT,
    "steps" JSONB,
    "statements" JSONB,
    "checkpoint" JSONB NOT NULL,
    "resultState" JSONB,
    "footprint" JSONB,
    "preserved" JSONB,
    "checkpointHash" TEXT,
    "verification" JSONB,
    "recoversId" TEXT,
    "recoveredById" TEXT,
    "recoveredAt" TIMESTAMP(3),
    "recoveryClaim" TEXT,
    "recoveryLeaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "backend_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backend_change_events" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backend_change_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backend_changes_projectId_createdAt_idx" ON "backend_changes"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "backend_changes_projectId_status_idx" ON "backend_changes"("projectId", "status");

-- CreateIndex
CREATE INDEX "backend_changes_groupId_idx" ON "backend_changes"("groupId");

-- CreateIndex
CREATE INDEX "backend_changes_recoversId_idx" ON "backend_changes"("recoversId");

-- CreateIndex
CREATE UNIQUE INDEX "backend_changes_projectId_seq_key" ON "backend_changes"("projectId", "seq");

-- CreateIndex
CREATE INDEX "backend_change_events_changeId_at_idx" ON "backend_change_events"("changeId", "at");

-- CreateIndex
CREATE INDEX "backend_change_events_projectId_at_idx" ON "backend_change_events"("projectId", "at");

-- AddForeignKey
ALTER TABLE "backend_changes" ADD CONSTRAINT "backend_changes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backend_change_events" ADD CONSTRAINT "backend_change_events_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "backend_changes"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── The audit trail cannot be rewritten ──────────────────────────────────────
--
-- These rows are the evidence that a production change happened, what it did,
-- how it was verified and how it was recovered. The application is their only
-- writer (lib/changes/lifecycle.ts), and these triggers hold it to what that
-- module promises, whatever issues the statement: identity and attribution
-- never change, evidence is written once when the change closes, status moves
-- only along the lifecycle's edges, events are append-only, and nothing is
-- deleted except a change withdrawn before it recorded anything, or everything
-- together with its project.
--
-- `prisma db push` does not create triggers. Tests that depend on them install
-- this section from this file (tests/helpers/change-ledger-guard.ts).

-- BEGIN backend change guard
CREATE OR REPLACE FUNCTION "backend_changes_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'applying' AND OLD."completedAt" IS NULL AND OLD."footprint" IS NULL THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."projectId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'backend_changes is permanent: change % cannot be deleted', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."seq" IS DISTINCT FROM OLD."seq" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."source" IS DISTINCT FROM OLD."source" OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR NEW."apiKeyId" IS DISTINCT FROM OLD."apiKeyId"
     OR NEW."groupId" IS DISTINCT FROM OLD."groupId" OR NEW."parentId" IS DISTINCT FROM OLD."parentId"
     OR NEW."recoversId" IS DISTINCT FROM OLD."recoversId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'backend_changes: identity and attribution of change % are immutable', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD."completedAt" IS NOT NULL AND (
       NEW."checkpoint" IS DISTINCT FROM OLD."checkpoint" OR NEW."resultState" IS DISTINCT FROM OLD."resultState"
       OR NEW."footprint" IS DISTINCT FROM OLD."footprint" OR NEW."statements" IS DISTINCT FROM OLD."statements"
       OR NEW."steps" IS DISTINCT FROM OLD."steps" OR NEW."verification" IS DISTINCT FROM OLD."verification"
       OR NEW."checkpointHash" IS DISTINCT FROM OLD."checkpointHash" OR NEW."summary" IS DISTINCT FROM OLD."summary"
       OR NEW."risk" IS DISTINCT FROM OLD."risk" OR NEW."error" IS DISTINCT FROM OLD."error"
       OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt") THEN
    RAISE EXCEPTION 'backend_changes: the evidence of change % is write-once', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('applying', 'verifying'), ('applying', 'failed'), ('applying', 'partially_applied'),
      ('applying', 'manual_intervention_required'),
      ('verifying', 'healthy'), ('verifying', 'unverified'), ('verifying', 'verification_failed'),
      ('verifying', 'manual_intervention_required'),
      ('healthy', 'recovering'), ('unverified', 'recovering'),
      ('partially_applied', 'recovering'), ('partially_applied', 'awaiting_approval'),
      ('partially_applied', 'manual_intervention_required'),
      ('verification_failed', 'recovering'), ('verification_failed', 'awaiting_approval'),
      ('verification_failed', 'manual_intervention_required'),
      ('awaiting_approval', 'recovering'), ('awaiting_approval', 'manual_intervention_required'),
      ('awaiting_approval', 'kept'),
      ('recovering', 'recovered'), ('recovering', 'restored'), ('recovering', 'recovery_failed'),
      ('recovering', 'healthy'), ('recovering', 'unverified'), ('recovering', 'partially_applied'),
      ('recovering', 'verification_failed'), ('recovering', 'awaiting_approval'),
      ('recovering', 'manual_intervention_required'), ('recovering', 'kept'),
      ('recovery_failed', 'recovering'), ('recovery_failed', 'manual_intervention_required'),
      ('manual_intervention_required', 'recovering'), ('manual_intervention_required', 'kept'),
      ('kept', 'recovering'),
      ('restored', 'healthy')
    ) AS t(from_status, to_status)
    WHERE t.from_status = OLD."status" AND t.to_status = NEW."status"
  ) THEN
    RAISE EXCEPTION 'backend_changes: change % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "backend_changes_guard" ON "backend_changes";
CREATE TRIGGER "backend_changes_guard"
  BEFORE UPDATE OR DELETE ON "backend_changes"
  FOR EACH ROW EXECUTE FUNCTION "backend_changes_guard"();

CREATE OR REPLACE FUNCTION "backend_change_events_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM "backend_changes" WHERE "id" = OLD."changeId") THEN
    RAISE EXCEPTION 'backend_change_events is append-only (event %)', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "backend_change_events_guard" ON "backend_change_events";
CREATE TRIGGER "backend_change_events_guard"
  BEFORE UPDATE OR DELETE ON "backend_change_events"
  FOR EACH ROW EXECUTE FUNCTION "backend_change_events_guard"();
-- END backend change guard
