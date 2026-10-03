-- Ownership intent: a durable assertion that a table's rows belong to the
-- authenticated subject through a named column.
--
-- Append-only by design. A change writes a new version and supersedes the old
-- one, because an approval binds to an exact version and an in-place update
-- would silently move what was consented to.
CREATE TABLE "ownership_intents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "owner_column" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT 'authenticated_user',
    "provenance" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "superseded_by_id" TEXT,
    "superseded_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "declared_by" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ownership_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ownership_intents_project_id_table_name_version_key"
    ON "ownership_intents"("project_id", "table_name", "version");
CREATE INDEX "ownership_intents_project_id_table_name_idx"
    ON "ownership_intents"("project_id", "table_name");
CREATE INDEX "ownership_intents_project_id_revoked_at_idx"
    ON "ownership_intents"("project_id", "revoked_at");

ALTER TABLE "ownership_intents" ADD CONSTRAINT "ownership_intents_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
