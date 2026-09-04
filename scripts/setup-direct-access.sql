-- ============================================================================
-- DIRECT DATABASE ACCESS — superuser bootstrap
-- ============================================================================
-- Run ONCE per cluster as the postgres superuser (idempotent — safe to re-run):
--
--   sudo -u postgres psql -d backenly -f scripts/setup-direct-access.sql
--
-- What this installs and WHY it exists:
--
--   Backenly hands developers real PostgreSQL connection strings (read-only or
--   read-write) scoped to their own workspace_<projectId> schema. The app
--   itself must NOT hold CREATEROLE or superuser — so every privileged
--   operation lives in a narrow SECURITY DEFINER function owned by postgres,
--   with hard input validation. The app (backenly_user) can only call these
--   four functions; it cannot create arbitrary roles or touch other schemas.
--
--   1. backenly_external            — NOLOGIN group; pg_hba only admits remote
--                                     connections for members of this group.
--   2. backenly_direct_create_role  — create/reset a bkn_ro_/bkn_rw_ login role
--                                     (hardened: connection limit, timeouts,
--                                     search_path pinned to the one schema).
--   3. backenly_direct_set_password — rotate.
--   4. backenly_direct_drop_role    — terminate sessions, strip policies,
--                                     reassign owned objects, drop.
--   5. backenly_direct_sync_schema  — idempotent grants/ownership/RLS-policy
--                                     sync for a workspace schema. Called after
--                                     every governed DDL mutation and on adopt.
--   6. backenly_capture_ddl/_drop   — event triggers that record every DDL
--                                     statement executed BY a bkn_% role into
--                                     public.schema_drift_events (the evidence
--                                     the autonomy loop adopts or flags).
--                                     Platform DDL (backenly_user) is ignored.
--
-- Network exposure (listen_addresses / pg_hba / firewall) is applied by
-- scripts/setup-direct-access.sh — not here — because pg_hba syntax errors can
-- lock the app out; keep SQL and config changes separable.
--
-- NOTE: public.schema_drift_events is created by `prisma db push` (model
-- SchemaDriftEvent). Run db:push BEFORE this file on a fresh cluster. The
-- capture functions resolve the table at call time, so ordering only matters
-- for the first external DDL statement.
-- ============================================================================

-- ── App role resolution ──────────────────────────────────────────────────────
--
-- The role the Backenly application connects as. It is NOT the installer: these
-- files are installed by a superuser, and the app then calls the SECURITY
-- DEFINER functions below with far less privilege.
--
-- Resolved rather than hardcoded because nineteen sites across these files
-- named `backenly_user` literally, so an install against a database whose app
-- role is `postgres` — the default on a fresh Ubuntu PostgreSQL, and what CI
-- uses — aborted with `role "backenly_user" does not exist` before creating a
-- single function.
--
-- Override per database or per session:
--   ALTER DATABASE mydb SET backenly.app_role = 'myrole';
CREATE OR REPLACE FUNCTION public.backenly_app_role() RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(nullif(current_setting('backenly.app_role', true), ''), 'backenly_user')
$fn$;

-- ── 1. Remote-access group (pg_hba matches +backenly_external) ───────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_external') THEN
    CREATE ROLE backenly_external NOLOGIN;
  END IF;
END $$;

-- ── 2. Create / re-key a per-project login role ──────────────────────────────
-- DROPs first: these functions once returned void; CREATE OR REPLACE cannot
-- change a return type. Grants are re-applied below, so this stays idempotent.
DROP FUNCTION IF EXISTS public.backenly_direct_create_role(text, text, text, text);
DROP FUNCTION IF EXISTS public.backenly_direct_set_password(text, text);
DROP FUNCTION IF EXISTS public.backenly_direct_drop_role(text);
DROP FUNCTION IF EXISTS public.backenly_direct_sync_schema(text, text, text, text);

CREATE OR REPLACE FUNCTION public.backenly_direct_create_role(
  p_role     text,
  p_password text,
  p_schema   text,
  p_mode     text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_role !~ '^bkn_(ro|rw)_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_create_role: invalid role name %', p_role;
  END IF;
  IF p_schema !~ '^workspace_[0-9a-fA-F][0-9a-fA-F-]{10,60}$' THEN
    RAISE EXCEPTION 'backenly_direct_create_role: invalid schema %', p_schema;
  END IF;
  IF p_mode NOT IN ('READ_ONLY', 'READ_WRITE') THEN
    RAISE EXCEPTION 'backenly_direct_create_role: invalid mode %', p_mode;
  END IF;
  IF length(p_password) < 24 THEN
    RAISE EXCEPTION 'backenly_direct_create_role: password too short';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = p_schema) THEN
    RAISE EXCEPTION 'backenly_direct_create_role: schema % does not exist', p_schema;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', p_role, p_password);
  ELSE
    -- Low per-role connection caps are a shared-cluster self-own guard: the app,
    -- every tenant's runtime, AND these direct roles all draw from one Postgres
    -- (max_connections=100). A burst of direct connections must never starve the
    -- app's own pool. ro 3 / rw 2 is ample for psql/BI/migrations at this scale;
    -- raise per-role once the cluster is per-tenant isolated.
    EXECUTE format(
      'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT %s IN ROLE backenly_external',
      p_role, p_password, CASE WHEN p_mode = 'READ_ONLY' THEN 3 ELSE 2 END
    );
  END IF;

  -- Hardening: bounded statements, no camping in open transactions, and the
  -- role only ever sees its own schema by default.
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', p_role, '60s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', p_role, '120s');
  EXECUTE format('ALTER ROLE %I SET search_path = %I', p_role, p_schema);
  IF p_mode = 'READ_ONLY' THEN
    -- Belt and braces: grants are the real enforcement (SELECT only), this
    -- just makes accidental writes fail earlier and clearer.
    EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', p_role);
  END IF;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_create_role(text, text, text, text) FROM PUBLIC;
-- ── 3. Rotate password ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.backenly_direct_set_password(
  p_role     text,
  p_password text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_role !~ '^bkn_(ro|rw)_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_set_password: invalid role name %', p_role;
  END IF;
  IF length(p_password) < 24 THEN
    RAISE EXCEPTION 'backenly_direct_set_password: password too short';
  END IF;
  EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', p_role, p_password);
  -- Kill live sessions so rotation actually revokes access now, not at next reconnect.
  PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = p_role;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_set_password(text, text) FROM PUBLIC;
-- ── 4. Drop a role cleanly ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.backenly_direct_drop_role(
  p_role text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  pol record;
BEGIN
  IF p_role !~ '^bkn_(ro|rw)_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_drop_role: invalid role name %', p_role;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RETURN true; -- already gone — idempotent
  END IF;

  PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = p_role;

  -- Policies that name this role would block DROP ROLE — remove them explicitly.
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE p_role = ANY (roles)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;

  -- Tables a READ_WRITE role created belong to it — hand them to the platform
  -- role so the backend they describe keeps working after revocation.
  EXECUTE format('REASSIGN OWNED BY %I TO %I', p_role, public.backenly_app_role());
  EXECUTE format('DROP OWNED BY %I', p_role); -- strips remaining grants
  EXECUTE format('DROP ROLE %I', p_role);
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_drop_role(text) FROM PUBLIC;
-- ── 5. Idempotent grants / ownership / RLS-policy sync for one schema ────────
--
-- Called: at provision, after every governed DDL mutation, and on drift adopt.
-- Owner-role model (READ_WRITE only): a NOLOGIN role bkn_own_<hex> owns the
-- schema and every table in it; backenly_user AND the rw login role are members,
-- so BOTH the platform and the external developer can ALTER/DROP any table —
-- that is what makes external DDL a first-class citizen instead of a permission
-- error. Membership is inherited, so backenly_user loses nothing.
CREATE OR REPLACE FUNCTION public.backenly_direct_sync_schema(
  p_schema text,
  p_ro     text DEFAULT NULL,
  p_rw     text DEFAULT NULL,
  p_owner  text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  t record;
BEGIN
  IF p_schema !~ '^workspace_[0-9a-fA-F][0-9a-fA-F-]{10,60}$' THEN
    RAISE EXCEPTION 'backenly_direct_sync_schema: invalid schema %', p_schema;
  END IF;
  IF p_ro IS NOT NULL AND p_ro !~ '^bkn_ro_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_sync_schema: invalid ro role %', p_ro;
  END IF;
  IF p_rw IS NOT NULL AND p_rw !~ '^bkn_rw_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_sync_schema: invalid rw role %', p_rw;
  END IF;
  IF p_owner IS NOT NULL AND p_owner !~ '^bkn_own_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_sync_schema: invalid owner role %', p_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = p_schema) THEN
    RETURN true; -- workspace not provisioned yet — nothing to sync
  END IF;
  IF p_ro IS NULL AND p_rw IS NULL THEN
    RETURN true;
  END IF;

  -- Skip roles that disappeared (revoked between the app's read and this call).
  IF p_ro IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_ro) THEN p_ro := NULL; END IF;
  IF p_rw IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_rw) THEN p_rw := NULL; END IF;

  -- ── Ownership model (READ_WRITE only) ──────────────────────────────────────
  IF p_rw IS NOT NULL AND p_owner IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_owner) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', p_owner);
    END IF;
    EXECUTE format('GRANT %I TO %I', p_owner, public.backenly_app_role());
    EXECUTE format('GRANT %I TO %I', p_owner, p_rw);
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', p_schema, p_owner);
    FOR t IN
      SELECT c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
        -- Sequences owned by a serial/identity column follow their table's
        -- owner automatically; ALTERing them directly errors (0A000).
        AND NOT (c.relkind = 'S' AND EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
    LOOP
      IF t.relkind = 'S' THEN
        EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', p_schema, t.relname, p_owner);
      ELSIF t.relkind IN ('v', 'm') THEN
        EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', p_schema, t.relname, p_owner);
      ELSE
        EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', p_schema, t.relname, p_owner);
      END IF;
    END LOOP;
  END IF;

  -- ── Grants (idempotent — GRANT is a no-op when already granted) ────────────
  IF p_ro IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', p_schema, p_ro);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', p_schema, p_ro);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', p_schema, p_ro);
  END IF;
  IF p_rw IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', p_schema, p_rw);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA %I TO %I', p_schema, p_rw);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', p_schema, p_rw);
  END IF;

  -- ── RLS pass-through policies ───────────────────────────────────────────────
  -- Privilege checks run BEFORE policies, so TO backenly_external is safe:
  -- another project's role never reaches policy evaluation here (no USAGE on
  -- this schema). The read policy unlocks rows for direct SELECT on RLS-forced
  -- tables (incl. the end-user `users` table — Supabase-precedent: the project
  -- owner can read their own project's data). Write pass-through targets the
  -- specific rw role only, and only exists once the owner opted into write.
  FOR t IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = p_schema AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  LOOP
    IF p_ro IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = p_schema AND tablename = t.relname AND policyname = 'bkn_direct_read'
    ) THEN
      EXECUTE format(
        'CREATE POLICY bkn_direct_read ON %I.%I FOR SELECT TO backenly_external USING (true)',
        p_schema, t.relname
      );
    END IF;
    IF p_rw IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = p_schema AND tablename = t.relname AND policyname = 'bkn_direct_write'
    ) THEN
      EXECUTE format(
        'CREATE POLICY bkn_direct_write ON %I.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
        p_schema, t.relname, p_rw
      );
    END IF;
  END LOOP;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_sync_schema(text, text, text, text) FROM PUBLIC;
-- ── 6. DDL drift capture — the observed-drift half of the open loop ──────────
--
-- Fires on EVERY DDL statement in the cluster, but returns immediately unless
-- session_user is a bkn_% role — platform DDL (backenly_user), migrations, and
-- psql-as-postgres are never recorded. The insert is wrapped so a capture
-- failure can NEVER break the developer's DDL statement. No recursion risk:
-- the function only INSERTs (never DDL), and INSERT does not fire event triggers.
CREATE OR REPLACE FUNCTION public.backenly_capture_ddl() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  r        record;
  v_schema text;
BEGIN
  IF session_user NOT LIKE 'bkn\_%' THEN RETURN; END IF;
  FOR r IN SELECT command_tag, object_type, object_identity, schema_name
           FROM pg_event_trigger_ddl_commands()
  LOOP
    v_schema := COALESCE(r.schema_name, split_part(r.object_identity, '.', 1));
    INSERT INTO public.schema_drift_events
      ("id", "projectId", "roleName", "commandTag", "objectType", "objectIdentity", "schemaName", "capturedAt", "status")
    VALUES (
      gen_random_uuid()::text,
      CASE WHEN v_schema LIKE 'workspace\_%' THEN substring(v_schema FROM 11) ELSE NULL END,
      session_user::text,
      r.command_tag,
      r.object_type,
      r.object_identity,
      v_schema,
      now(),
      'pending'
    );
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  NULL; -- never break user DDL because bookkeeping failed
END
$fn$;

CREATE OR REPLACE FUNCTION public.backenly_capture_drop() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  r record;
BEGIN
  IF session_user NOT LIKE 'bkn\_%' THEN RETURN; END IF;
  FOR r IN SELECT object_type, object_identity, schema_name
           FROM pg_event_trigger_dropped_objects()
           WHERE original AND NOT is_temporary
  LOOP
    INSERT INTO public.schema_drift_events
      ("id", "projectId", "roleName", "commandTag", "objectType", "objectIdentity", "schemaName", "capturedAt", "status")
    VALUES (
      gen_random_uuid()::text,
      CASE WHEN r.schema_name LIKE 'workspace\_%' THEN substring(r.schema_name FROM 11) ELSE NULL END,
      session_user::text,
      'DROP ' || upper(COALESCE(r.object_type, 'OBJECT')),
      r.object_type,
      r.object_identity,
      r.schema_name,
      now(),
      'pending'
    );
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_capture_ddl() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backenly_capture_drop() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS backenly_ddl_watch;
CREATE EVENT TRIGGER backenly_ddl_watch ON ddl_command_end
  EXECUTE FUNCTION public.backenly_capture_ddl();

DROP EVENT TRIGGER IF EXISTS backenly_drop_watch;
CREATE EVENT TRIGGER backenly_drop_watch ON sql_drop
  EXECUTE FUNCTION public.backenly_capture_drop();

-- Done. Verify with:
--   \df public.backenly_direct_*
--   SELECT evtname, evtevent FROM pg_event_trigger WHERE evtname LIKE 'backenly%';

DO $grant$
DECLARE r text := public.backenly_app_role();
BEGIN
  -- Skipped rather than failed when the role is absent: the functions are still
  -- installed and a later run grants them, which is what makes this re-runnable.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_direct_create_role(text, text, text, text) TO %I', r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_direct_set_password(text, text) TO %I', r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_direct_drop_role(text) TO %I', r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_direct_sync_schema(text, text, text, text) TO %I', r);
  END IF;
END $grant$;
