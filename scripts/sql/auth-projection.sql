-- ============================================================================
-- AUTHORIZATION PROJECTION — the region's copy of what authorizes its requests
-- ============================================================================
-- Install with:  bash scripts/install-sql.sh scripts/sql/auth-projection.sql
--
-- A request to a project kept outside the home region is authorized from rows
-- in the home platform database: the project's lock, pause and end-user
-- signing secret, its publishable keys, and the branches they are bound to.
-- These tables are the region's copy of those rows for its own projects,
-- delivered from the home region (lib/auth-projection/deliver.ts) together
-- with a watermark: every change committed at home before "watermarkAt" is in
-- the copy. A reader trusts the copy only while the watermark is younger than
-- the staleness bound, and asks the home database otherwise (Option C,
-- founders, 2026-10-16).
--
-- Only publishable keys are copied. A service-role key, an MCP key or a
-- dashboard key is never here, so it is always authorized at home. A row that
-- is not here is not evidence of anything: the reader asks home.
--
-- "epoch" and "round" are the delivery the copy last applied, also recorded at
-- home. When they differ, this database or the home one was restored, or a
-- delivery committed here but not there, and the copy is delivered afresh.
-- "version" on each row is the home change it was delivered at; an older
-- delivery never overwrites a newer one.
--
-- Idempotent. Run as the installer, after scripts/postgrest-install.sh (which
-- defines public.backenly_app_role()). Not for the home database.
--
-- Ownership stays with the installer. The application role reads the copy and
-- the home region writes it, over its connection as that same role; nothing
-- else may read these tables, which hold key hashes and encrypted signing
-- secrets.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.auth_projection_state (
    "region"      TEXT        NOT NULL,
    "epoch"       TEXT        NOT NULL,
    "round"       BIGINT      NOT NULL,
    "watermarkAt" TIMESTAMPTZ,
    "deliveredAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "resyncedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "auth_projection_state_pkey" PRIMARY KEY ("region")
);

CREATE TABLE IF NOT EXISTS public.auth_projection_projects (
    "id"               TEXT         NOT NULL,
    "lockedDownAt"     TIMESTAMP(3),
    "lockedDownReason" TEXT,
    "pausedAt"         TIMESTAMP(3),
    "pauseReason"      TEXT,
    "jwtSecret"        TEXT,
    "userId"           TEXT,
    "organizationId"   TEXT,
    "version"          BIGINT       NOT NULL,
    "projectedAt"      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "auth_projection_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public.auth_projection_keys (
    "id"              TEXT         NOT NULL,
    "projectId"       TEXT         NOT NULL,
    "keyHash"         TEXT         NOT NULL,
    "name"            TEXT         NOT NULL,
    "keyPrefix"       TEXT         NOT NULL,
    "userId"          TEXT         NOT NULL,
    "role"            TEXT         NOT NULL,
    "permissions"     TEXT[]       NOT NULL,
    "capabilities"    TEXT[]       NOT NULL,
    "expiresAt"       TIMESTAMP(3),
    "rateLimit"       INTEGER      NOT NULL,
    "rateLimitWindow" INTEGER      NOT NULL,
    "scope"           TEXT         NOT NULL,
    "keyType"         TEXT         NOT NULL,
    "serviceRole"     BOOLEAN      NOT NULL,
    "branchId"        TEXT,
    "version"         BIGINT       NOT NULL,
    "projectedAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "auth_projection_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "auth_projection_keys_keyHash_key"
    ON public.auth_projection_keys ("keyHash");

CREATE INDEX IF NOT EXISTS "auth_projection_keys_projectId_idx"
    ON public.auth_projection_keys ("projectId");

CREATE TABLE IF NOT EXISTS public.auth_projection_branches (
    "id"          TEXT        NOT NULL,
    "projectId"   TEXT        NOT NULL,
    "name"        TEXT        NOT NULL,
    "status"      TEXT        NOT NULL,
    "schemaName"  TEXT        NOT NULL,
    "version"     BIGINT      NOT NULL,
    "projectedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "auth_projection_branches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "auth_projection_branches_projectId_idx"
    ON public.auth_projection_branches ("projectId");

-- Each key's rate-limit window, counted here rather than at home once the copy
-- is enforced (lib/auth-projection/rate.ts). A key's requests are all served
-- in its project's region, so this is the one counter for it. The window
-- starts again when the key's window length changes or the key is rotated
-- ("keyMark" is the start of its hash), as home's counter does. The count is
-- written home periodically, for the console ("mirroredAt").
CREATE TABLE IF NOT EXISTS public.auth_rate_windows (
    "keyId"         TEXT        NOT NULL,
    "windowSeconds" INTEGER     NOT NULL,
    "keyMark"       TEXT        NOT NULL,
    "resetAt"       TIMESTAMPTZ NOT NULL,
    "count"         INTEGER     NOT NULL,
    "lastUsedAt"    TIMESTAMPTZ NOT NULL,
    "mirroredAt"    TIMESTAMPTZ,

    CONSTRAINT "auth_rate_windows_pkey" PRIMARY KEY ("keyId")
);

CREATE INDEX IF NOT EXISTS "auth_rate_windows_lastUsedAt_idx"
    ON public.auth_rate_windows ("lastUsedAt");

-- Nobody but the installer and the application role.
REVOKE ALL ON public.auth_projection_state, public.auth_projection_projects,
              public.auth_projection_keys, public.auth_projection_branches,
              public.auth_rate_windows FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_projection_state, public.auth_projection_projects, '
    'public.auth_projection_keys, public.auth_projection_branches, public.auth_rate_windows TO %I',
    public.backenly_app_role()
  );
END $$;
