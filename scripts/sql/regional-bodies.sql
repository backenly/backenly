-- ============================================================================
-- REGIONAL BODIES — a regional project's customer data, kept in its region
-- ============================================================================
-- Install with:  bash scripts/install-sql.sh scripts/sql/regional-bodies.sql
--
-- Some platform rows record a project's customer data: a webhook or trigger
-- delivery carries the row that fired it and what the receiver answered; a
-- function run records what the function logged and the error it raised. For
-- a project outside the home region that data stays in the region
-- (lib/data-plane/regional-bodies.ts): the platform database keeps the row,
-- without it, for scheduling, listing and alerts, and this table keeps the
-- data, under the row's kind and id, for 30 days after its last change.
--
-- Idempotent. Run as the installer, after scripts/postgrest-install.sh (which
-- defines public.backenly_app_role()). Not for the home database: a home
-- project's data stays on the platform rows, where Prisma owns it.
--
-- Ownership stays with the installer. The application role writes, reads and
-- prunes; nothing else may read the table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.regional_bodies (
    "kind"         TEXT        NOT NULL,
    "id"           TEXT        NOT NULL,
    "projectId"    TEXT        NOT NULL,
    "payload"      JSONB,
    "responseBody" TEXT,
    "error"        TEXT,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "regional_bodies_pkey" PRIMARY KEY ("kind", "id")
);

CREATE INDEX IF NOT EXISTS "regional_bodies_projectId_kind_createdAt_idx"
    ON public.regional_bodies ("projectId", "kind", "createdAt");

CREATE INDEX IF NOT EXISTS "regional_bodies_updatedAt_idx"
    ON public.regional_bodies ("updatedAt");

-- Nobody but the installer and the application role.
REVOKE ALL ON public.regional_bodies FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON public.regional_bodies TO %I',
    public.backenly_app_role()
  );
END $$;
