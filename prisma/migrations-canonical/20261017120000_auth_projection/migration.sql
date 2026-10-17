-- The authorization projection's capture: every change to what authorizes a
-- request to a project kept outside the home region, recorded in the same
-- transaction as the change, for delivery to that region
-- (lib/auth-projection/deliver.ts).
--
-- What authorizes such a request lives here, in the platform database: the
-- project's lock, pause and end-user signing secret, its keys, and the branches
-- its keys are bound to. Option C (founders, 2026-10-16) gives each region a
-- copy of those rows for its own projects. The triggers below record which rows
-- changed; the delivery reads their state when it delivers, so this table never
-- holds a key hash or a secret.
--
-- Additive: two new tables, their indexes, and triggers on projects, api_keys
-- and workspace_branches. No existing row is read or changed. A project in the
-- home region (region NULL or 'ap-south-1') records nothing, so on a deployment
-- with one region, which is every self-hosted one, the triggers write nothing.
-- The counters a request updates on every call (api_keys.requestCount, resetAt,
-- lastUsed; projects.lastActivityAt) are not watched at all.

-- CreateTable
CREATE TABLE "auth_projection_changes" (
    "id" BIGSERIAL NOT NULL,
    "region" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "auth_projection_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_projection_regions" (
    "region" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "round" BIGINT NOT NULL DEFAULT 0,
    "watermarkAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "resyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),

    CONSTRAINT "auth_projection_regions_pkey" PRIMARY KEY ("region")
);

-- CreateIndex
CREATE INDEX "auth_projection_changes_region_deliveredAt_id_idx" ON "auth_projection_changes"("region", "deliveredAt", "id");

-- CreateIndex
CREATE INDEX "auth_projection_changes_deliveredAt_idx" ON "auth_projection_changes"("deliveredAt");

-- Capture.
--
-- Everything from here to the end of the file can be run again: a database
-- built from the schema rather than from these migrations, as the test
-- databases are, installs exactly this (tests/integration/auth-projection.spec.ts).

-- A project's own row: its old region on an update or delete, its new one on
-- an insert or a change of region, so each side hears of it.
CREATE OR REPLACE FUNCTION "auth_projection_capture_project"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD."region" IS NOT NULL AND OLD."region" <> 'ap-south-1' THEN
      INSERT INTO "auth_projection_changes" ("region", "projectId", "entity", "entityId")
      VALUES (OLD."region", OLD."id", 'project', OLD."id");
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW."region" IS NOT NULL AND NEW."region" <> 'ap-south-1' THEN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO "auth_projection_changes" ("region", "projectId", "entity", "entityId")
        VALUES (NEW."region", NEW."id", 'project', NEW."id");
      ELSIF NEW."region" IS DISTINCT FROM OLD."region" THEN
        INSERT INTO "auth_projection_changes" ("region", "projectId", "entity", "entityId")
        VALUES (NEW."region", NEW."id", 'project', NEW."id");
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

-- A key or a branch: recorded for the region of the project it belongs to.
-- When the project itself is being deleted its row is already gone, so nothing
-- is recorded here: the project's own change carries the deletion, and the
-- region removes the project's keys and branches with it.
CREATE OR REPLACE FUNCTION "auth_projection_capture_member"() RETURNS trigger AS $$
DECLARE
  old_project TEXT;
  new_project TEXT;
  member TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_project := OLD."projectId";
    member := OLD."id";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_project := NEW."projectId";
    member := NEW."id";
  END IF;
  INSERT INTO "auth_projection_changes" ("region", "projectId", "entity", "entityId")
  SELECT p."region", p."id", TG_ARGV[0], member
    FROM "projects" p
   WHERE p."id" IN (old_project, new_project)
     AND p."region" IS NOT NULL
     AND p."region" <> 'ap-south-1';
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

-- TRUNCATE removes rows without a row trigger, so it forgets every delivery
-- instead: each region's copy then no longer matches, and is delivered afresh.
CREATE OR REPLACE FUNCTION "auth_projection_forget_deliveries"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "auth_projection_regions";
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "projects_auth_projection_insert"
  AFTER INSERT ON "projects"
  FOR EACH ROW WHEN (NEW."region" IS NOT NULL AND NEW."region" <> 'ap-south-1')
  EXECUTE FUNCTION "auth_projection_capture_project"();

CREATE OR REPLACE TRIGGER "projects_auth_projection_update"
  AFTER UPDATE OF "region", "lockedDownAt", "lockedDownReason", "pausedAt", "pauseReason", "jwtSecret", "userId", "organizationId" ON "projects"
  FOR EACH ROW WHEN (
    ((OLD."region" IS NOT NULL AND OLD."region" <> 'ap-south-1') OR (NEW."region" IS NOT NULL AND NEW."region" <> 'ap-south-1'))
    AND (OLD."region" IS DISTINCT FROM NEW."region"
      OR OLD."lockedDownAt" IS DISTINCT FROM NEW."lockedDownAt"
      OR OLD."lockedDownReason" IS DISTINCT FROM NEW."lockedDownReason"
      OR OLD."pausedAt" IS DISTINCT FROM NEW."pausedAt"
      OR OLD."pauseReason" IS DISTINCT FROM NEW."pauseReason"
      OR OLD."jwtSecret" IS DISTINCT FROM NEW."jwtSecret"
      OR OLD."userId" IS DISTINCT FROM NEW."userId"
      OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId"))
  EXECUTE FUNCTION "auth_projection_capture_project"();

CREATE OR REPLACE TRIGGER "projects_auth_projection_delete"
  AFTER DELETE ON "projects"
  FOR EACH ROW WHEN (OLD."region" IS NOT NULL AND OLD."region" <> 'ap-south-1')
  EXECUTE FUNCTION "auth_projection_capture_project"();

CREATE OR REPLACE TRIGGER "projects_auth_projection_truncate"
  AFTER TRUNCATE ON "projects"
  FOR EACH STATEMENT EXECUTE FUNCTION "auth_projection_forget_deliveries"();

CREATE OR REPLACE TRIGGER "api_keys_auth_projection_insert"
  AFTER INSERT ON "api_keys"
  FOR EACH ROW WHEN (NEW."projectId" IS NOT NULL)
  EXECUTE FUNCTION "auth_projection_capture_member"('api_key');

CREATE OR REPLACE TRIGGER "api_keys_auth_projection_update"
  AFTER UPDATE OF "projectId", "keyHash", "name", "keyPrefix", "userId", "role", "permissions", "capabilities", "expiresAt", "rateLimit", "rateLimitWindow", "scope", "keyType", "serviceRole", "branchId" ON "api_keys"
  FOR EACH ROW WHEN (
    (OLD."projectId" IS NOT NULL OR NEW."projectId" IS NOT NULL)
    AND (OLD."projectId" IS DISTINCT FROM NEW."projectId"
      OR OLD."keyHash" IS DISTINCT FROM NEW."keyHash"
      OR OLD."name" IS DISTINCT FROM NEW."name"
      OR OLD."keyPrefix" IS DISTINCT FROM NEW."keyPrefix"
      OR OLD."userId" IS DISTINCT FROM NEW."userId"
      OR OLD."role" IS DISTINCT FROM NEW."role"
      OR OLD."permissions" IS DISTINCT FROM NEW."permissions"
      OR OLD."capabilities" IS DISTINCT FROM NEW."capabilities"
      OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
      OR OLD."rateLimit" IS DISTINCT FROM NEW."rateLimit"
      OR OLD."rateLimitWindow" IS DISTINCT FROM NEW."rateLimitWindow"
      OR OLD."scope" IS DISTINCT FROM NEW."scope"
      OR OLD."keyType" IS DISTINCT FROM NEW."keyType"
      OR OLD."serviceRole" IS DISTINCT FROM NEW."serviceRole"
      OR OLD."branchId" IS DISTINCT FROM NEW."branchId"))
  EXECUTE FUNCTION "auth_projection_capture_member"('api_key');

CREATE OR REPLACE TRIGGER "api_keys_auth_projection_delete"
  AFTER DELETE ON "api_keys"
  FOR EACH ROW WHEN (OLD."projectId" IS NOT NULL)
  EXECUTE FUNCTION "auth_projection_capture_member"('api_key');

CREATE OR REPLACE TRIGGER "api_keys_auth_projection_truncate"
  AFTER TRUNCATE ON "api_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION "auth_projection_forget_deliveries"();

CREATE OR REPLACE TRIGGER "workspace_branches_auth_projection_insert"
  AFTER INSERT ON "workspace_branches"
  FOR EACH ROW EXECUTE FUNCTION "auth_projection_capture_member"('branch');

CREATE OR REPLACE TRIGGER "workspace_branches_auth_projection_update"
  AFTER UPDATE OF "projectId", "name", "status", "schemaName" ON "workspace_branches"
  FOR EACH ROW WHEN (
    OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."status" IS DISTINCT FROM NEW."status"
    OR OLD."schemaName" IS DISTINCT FROM NEW."schemaName")
  EXECUTE FUNCTION "auth_projection_capture_member"('branch');

CREATE OR REPLACE TRIGGER "workspace_branches_auth_projection_delete"
  AFTER DELETE ON "workspace_branches"
  FOR EACH ROW EXECUTE FUNCTION "auth_projection_capture_member"('branch');

CREATE OR REPLACE TRIGGER "workspace_branches_auth_projection_truncate"
  AFTER TRUNCATE ON "workspace_branches"
  FOR EACH STATEMENT EXECUTE FUNCTION "auth_projection_forget_deliveries"();
