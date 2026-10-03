-- A human's consent to run ONE maintenance plan, at ONE version.
--
-- Approval was an environment variable. That works for an operator running a
-- single plan by hand and cannot work for a scheduler: a process-wide variable
-- holds no per-project consent and offers no way to withdraw one.
--
-- Bound to planVersion, never to planId. planVersion covers the ladder, the
-- catalog fingerprint and the executor capability table, so consent to version
-- N is not consent to N+1.
CREATE TABLE "maintenance_approvals" (
    "id"          TEXT NOT NULL,
    "projectId"   TEXT NOT NULL,
    "findingId"   TEXT NOT NULL,
    "planId"      TEXT NOT NULL,
    "planVersion" TEXT NOT NULL,
    "maxTier"     INTEGER NOT NULL DEFAULT 2,
    "approvedBy"  TEXT NOT NULL,
    -- What the ladder operates on, as the approver stated it. Bindings travel
    -- with consent because they are part of what is being consented to.
    "bindings"    JSONB NOT NULL,
    "reason"      TEXT,
    "revokedAt"   TIMESTAMP(3),
    "revokedBy"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_approvals_pkey" PRIMARY KEY ("id")
);

-- One consent per plan version. A second approval for the same version is the
-- same consent, not a stronger one.
CREATE UNIQUE INDEX "maintenance_approvals_planId_planVersion_key"
    ON "maintenance_approvals"("planId", "planVersion");

CREATE INDEX "maintenance_approvals_projectId_revokedAt_idx"
    ON "maintenance_approvals"("projectId", "revokedAt");

ALTER TABLE "maintenance_approvals"
    ADD CONSTRAINT "maintenance_approvals_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
