-- Standing human permission for a Backenly controller to act unattended.
--
-- Default deny: absence of a row is absence of authority. Scoped to one action
-- class, one environment and a resource scope, rather than raising a tier
-- ceiling, because permitting a class is narrow and raising a ceiling is not.
CREATE TABLE "authority_grants" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "granted_by_user_id" TEXT NOT NULL,
    "grantee_kind" TEXT NOT NULL DEFAULT 'backenly',
    "grantee_loop" TEXT NOT NULL,
    "action_class_id" TEXT NOT NULL,
    "resource_scope" TEXT NOT NULL DEFAULT '*',
    "environment" TEXT NOT NULL,
    "max_tier" INTEGER NOT NULL DEFAULT 2,
    "max_blast_radius" TEXT NOT NULL DEFAULT 'table',
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "budget_remaining" INTEGER,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "authority_grants_project_id_action_class_id_environment_idx"
    ON "authority_grants"("project_id", "action_class_id", "environment");
CREATE INDEX "authority_grants_project_id_revoked_at_idx"
    ON "authority_grants"("project_id", "revoked_at");

ALTER TABLE "authority_grants" ADD CONSTRAINT "authority_grants_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
