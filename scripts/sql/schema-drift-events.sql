-- ============================================================================
-- SCHEMA DRIFT EVENTS — the table the DDL-capture triggers write, per region
-- ============================================================================
-- Install with:  bash scripts/install-sql.sh scripts/sql/schema-drift-events.sql
--
-- The capture triggers (scripts/setup-direct-access.sql) record every DDL
-- statement a direct-access role runs into public.schema_drift_events IN THE
-- DATABASE THAT RAN IT. In the home region that table is part of the platform
-- schema (Prisma model SchemaDriftEvent). A regional database holds no platform
-- schema, so this file creates the one platform-shaped table it needs, exactly
-- as the model defines it: the application reads it there with the model's own
-- accessor (lib/data-plane/regional.ts projectDriftEvents), and
-- tests/integration/project-region.spec.ts keeps the two definitions identical.
--
-- Idempotent. Run as the installer, after scripts/postgrest-install.sh (which
-- defines public.backenly_app_role()) and before any direct-access credential
-- is handed out. Not for the home database: Prisma owns the table there.
--
-- Ownership stays with the installer, who also owns the SECURITY DEFINER
-- capture functions, so the functions can always insert. The application role
-- reads, adopts and prunes; it never inserts (only the triggers record events).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.schema_drift_events (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "roleName" TEXT NOT NULL,
    "commandTag" TEXT NOT NULL,
    "objectType" TEXT,
    "objectIdentity" TEXT,
    "schemaName" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolvedAt" TIMESTAMP(3),
    "findingId" TEXT,

    CONSTRAINT "schema_drift_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "schema_drift_events_projectId_status_idx"
    ON public.schema_drift_events ("projectId", "status");
CREATE INDEX IF NOT EXISTS "schema_drift_events_capturedAt_idx"
    ON public.schema_drift_events ("capturedAt");

-- Nobody but the installer and the application role.
REVOKE ALL ON public.schema_drift_events FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format(
    'GRANT SELECT, UPDATE, DELETE ON public.schema_drift_events TO %I',
    public.backenly_app_role()
  );
END $$;
