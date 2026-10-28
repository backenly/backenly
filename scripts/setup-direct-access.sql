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
--   4. backenly_direct_drop_role    — take the role's privileges, terminate
--                                     sessions, strip policies, reassign owned
--                                     objects, drop; or, when another database
--                                     on the cluster still names the role,
--                                     retire it (NOLOGIN, no password).
--   5. backenly_direct_sync_schema  — idempotent grants/ownership/RLS-policy
--                                     sync for a workspace schema, including the
--                                     backup role's read, which every workspace
--                                     gets whether or not it has direct access.
--                                     Called when a workspace is created, after
--                                     governed DDL, after a restore and on adopt.
--   6. backenly_capture_ddl/_drop   — event triggers that record every DDL
--                                     statement executed BY a bkn_% role into
--                                     public.schema_drift_events (the evidence
--                                     the autonomy loop adopts or flags).
--                                     Platform DDL (backenly_user) is ignored.
--
-- Last, every workspace schema that already exists is brought to what the
-- sync declares for the backup role, so re-running this file is also how an
-- existing database is converged (section 7).
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
--
-- This body is IDENTICAL to the one in scripts/sql/postgrest-ddl-sync.sql,
-- scripts/sql/postgrest-schema-registry.sql and the managed-DB cutover, and
-- tests/unit/backenly-app-role-definition.spec.ts keeps it that way. This file
-- installs after postgrest-install.sh, so it used to have the last word with an
-- older body whose final fallback was the literal 'backenly_user': on a managed
-- database with no such role, reinstalling direct access silently pointed
-- every grant made through this function at a role nothing could receive.
CREATE OR REPLACE FUNCTION public.backenly_app_role() RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(
    nullif(current_setting('backenly.app_role', true), ''),
    (SELECT rolname::text FROM pg_roles WHERE rolname = 'backenly_app'),
    (SELECT rolname::text FROM pg_roles WHERE rolname = 'backenly_user'),
    current_user::text
  )
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
--
-- The definer needs the PRIVILEGES of the role it drops, not only ADMIN over
-- it: REASSIGN OWNED and DROP OWNED require them, and so does terminating the
-- role's sessions without pg_signal_backend. PostgreSQL 16 gives a CREATEROLE
-- role that is not a superuser ADMIN on a role it creates and nothing more. On
-- Amazon RDS the master is not made a member at all (pg_has_role still reports
-- its ADMIN), and createrole_self_grant has no effect; both measured on
-- staging. So on a managed database, where this definer is the master, every
-- login it created failed here with "permission denied to reassign objects",
-- and so did deleting any project that had one. ADMIN is what lets the definer
-- grant the role to itself first. That is done only when the privileges are
-- missing (a superuser has them all), and the grant goes with the role in the
-- DROP ROLE below.
--
-- A role is cluster-wide, but REASSIGN OWNED and DROP OWNED reach only the
-- current database, and a definer that is not a superuser cannot revoke a
-- database-level privilege another role granted. When anything outside this
-- database still names the role (a grant, a default privilege or an object in
-- another database, or such a database-level privilege), DROP ROLE fails with
-- 2BP01, and so did every deletion of a project whose login it was. A database
-- restored beside this one from a dump that carried the grants is enough. This
-- function touches nothing outside this database, which may hold anyone's
-- data. It retires the login instead: NOLOGIN with no password, so it cannot
-- authenticate by any means, and it returns false. A session that logged in
-- after the termination above outlives it until this transaction commits, so
-- the caller calls again after its commit to end it. The privileges taken
-- above are given back, because the grant no longer goes with the role. The
-- login stays retired, since nothing calls this again on its own: an operator
-- removes what names it elsewhere, then calls this function to drop it.
--
-- Returns true when the role is gone (dropped now, or never existed), false
-- when it was retired.
CREATE OR REPLACE FUNCTION public.backenly_direct_drop_role(
  p_role text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  pol     record;
  granted boolean := false;
BEGIN
  IF p_role !~ '^bkn_(ro|rw)_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_drop_role: invalid role name %', p_role;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RETURN true; -- already gone — idempotent
  END IF;

  -- Before anything that needs them (see above). WITH INHERIT exists from
  -- PostgreSQL 16; before it a membership is inherited by an INHERIT member.
  IF NOT pg_has_role(current_user, p_role, 'USAGE') THEN
    EXECUTE format(CASE WHEN current_setting('server_version_num')::int >= 160000
                        THEN 'GRANT %I TO %I WITH INHERIT TRUE, SET FALSE'
                        ELSE 'GRANT %I TO %I' END, p_role, current_user);
    granted := true;
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

  -- Whatever still names the role is outside this database (see above): retire it.
  IF EXISTS (
    SELECT 1 FROM pg_shdepend s
     WHERE s.refclassid = 'pg_authid'::regclass
       AND s.refobjid = (SELECT oid FROM pg_roles WHERE rolname = p_role)
       AND s.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database())
  ) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD NULL', p_role);
    IF granted THEN
      EXECUTE format('REVOKE %I FROM %I', p_role, current_user);
    END IF;
    RETURN false;
  END IF;

  EXECUTE format('DROP ROLE %I', p_role);
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_drop_role(text) FROM PUBLIC;
-- ── 5. Idempotent grants / ownership / RLS-policy sync for one schema ────────
--
-- Called for EVERY workspace, with or without direct access: when the schema is
-- created (lib/projects/provision.ts), after governed DDL, after a restore, on
-- drift adopt, and for each existing workspace when this file is installed
-- (section 7). With no ro/rw role it grants the backup role and stops.
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
  v_backup text;
  v_creator text;
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

  -- ── The backup role: every workspace, with or without direct access ───────
  -- Snapshots dump each workspace as the read-only backup role: pg_dump
  -- --schema workspace_<id> locks every table, which needs USAGE on the schema
  -- and SELECT on the table, and reads every sequence. One object it cannot
  -- read fails every snapshot of that project, with "permission denied".
  --
  -- Nothing else grants it on a workspace made later: the regional procedure
  -- (tools/managed-db/regional/sql/roles.sql) creates the role with CONNECT
  -- only, and scripts/setup-backup-role.ts, which a self-hosted install runs,
  -- converges the schemas that exist when it runs. So this runs for every
  -- workspace. It used to come after an early return for a call with no ro/rw
  -- role, which left every project without direct access unreadable.
  --
  -- Explicit grants cover what exists now. Default privileges cover a table
  -- created before the next sync, by the roles that create them: the
  -- application (every platform path: typed actions, migrations, imports,
  -- branch merges) and, with READ_WRITE access, the developer's own role, whose
  -- tables are otherwise unreadable until adoption, which may wait for the
  -- owner's approval. PostgreSQL lets a role set defaults only for a role whose
  -- privileges it holds, so a creator this definer cannot act for is left to
  -- the explicit grants of the next sync. The bkn_own_* role creates nothing
  -- unless a developer becomes it, and the adoption sync covers that.
  --
  -- The role is BYPASSRLS, so it needs no policy. Name it with
  --   ALTER DATABASE <db> SET backenly.backup_role = '<role>';
  -- when BACKENLY_BACKUP_ROLE is not the default. No role, no grant.
  v_backup := coalesce(nullif(current_setting('backenly.backup_role', true), ''), 'backenly_backup');
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_backup) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', p_schema, v_backup);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', p_schema, v_backup);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', p_schema, v_backup);
    -- One check per statement: a privilege check on a missing role raises.
    FOREACH v_creator IN ARRAY ARRAY[public.backenly_app_role(), p_rw] LOOP
      CONTINUE WHEN v_creator IS NULL;
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_creator);
      CONTINUE WHEN NOT pg_has_role(current_user, v_creator, 'USAGE');
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO %I',
                     v_creator, p_schema, v_backup);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON SEQUENCES TO %I',
                     v_creator, p_schema, v_backup);
    END LOOP;
  END IF;

  IF p_ro IS NULL AND p_rw IS NULL THEN
    RETURN true; -- no direct-access role, so nothing below applies
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
--
-- A failed capture is not silent, though: it raises a WARNING tagged
-- BACKENLY_DRIFT_CAPTURE_FAILED with the SQLSTATE only (the developer's client
-- sees the tag, not platform internals). The database log carries it; on RDS
-- that log is exported to CloudWatch, where a metric filter alarms on the tag,
-- and lib/autonomy/drift-event-upkeep.ts checks the apparatus hourly.
--
-- capturedAt is written in UTC. The column has no time zone, the application
-- reads it as UTC (Prisma), and now() alone would store the session's local time.
--
-- Every event names its project. A GRANT or REVOKE names no single object, so
-- pg_event_trigger_ddl_commands() reports it with no schema, and a dropped
-- schema has none either; those events used to be stored with no project, so no
-- adoption could ever clear them and they aged the region's drift backlog
-- forever. They are attributed to the project the session's login belongs to.
-- A direct-access login does DDL in its own project's schema only, and a GRANT
-- inside it includes the PostgREST sync granting the API roles on a table the
-- developer just created.

-- The workspace schema a capturing login belongs to, read from its NAME:
-- bkn_ro_/bkn_rw_ + sha256(projectId) (lib/services/direct-access.ts) and
-- bkn_fn_ + sha256(schema) (scripts/sql/function-roles.sql), 12 hex each. The
-- name, not a setting such as its search_path, because a login may change its
-- own settings and could then point its events at another project. NULL when
-- no workspace matches, or more than one does.
CREATE OR REPLACE FUNCTION public.backenly_capture_home_schema(p_role text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog
AS $fn$
DECLARE
  v_kind    text := substring(p_role FROM '^bkn_(ro|rw|fn)_[0-9a-f]{12}$');
  v_schema  text;
  v_matches int;
BEGIN
  IF v_kind IS NULL THEN RETURN NULL; END IF;
  SELECT min(n.nspname), count(*) INTO v_schema, v_matches
    FROM pg_namespace n
   WHERE n.nspname ~ '^workspace_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND left(encode(sha256(convert_to(
           CASE WHEN v_kind = 'fn' THEN n.nspname ELSE substring(n.nspname FROM 11) END, 'UTF8')), 'hex'), 12)
         = right(p_role, 12);
  RETURN CASE WHEN v_matches = 1 THEN v_schema END;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_capture_home_schema(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.backenly_capture_ddl() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  r        record;
  v_schema text;
  v_home   text;
BEGIN
  IF session_user NOT LIKE 'bkn\_%' THEN RETURN; END IF;
  v_home := public.backenly_capture_home_schema(session_user);
  FOR r IN SELECT command_tag, object_type, object_identity, schema_name
           FROM pg_event_trigger_ddl_commands()
  LOOP
    v_schema := COALESCE(r.schema_name, split_part(r.object_identity, '.', 1), v_home);
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
      now() AT TIME ZONE 'UTC',
      'pending'
    );
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- Never break the developer's DDL because bookkeeping failed, and never
  -- lose the event without a trace either (see the note above).
  RAISE WARNING 'BACKENLY_DRIFT_CAPTURE_FAILED (SQLSTATE %)', SQLSTATE;
END
$fn$;

CREATE OR REPLACE FUNCTION public.backenly_capture_drop() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  r        record;
  v_schema text;
  v_home   text;
BEGIN
  IF session_user NOT LIKE 'bkn\_%' THEN RETURN; END IF;
  v_home := public.backenly_capture_home_schema(session_user);
  FOR r IN SELECT object_type, object_identity, schema_name
           FROM pg_event_trigger_dropped_objects()
           WHERE original AND NOT is_temporary
  LOOP
    -- sql_drop runs after the catalog rows are gone, so a dropped schema is
    -- named by its identity rather than looked up.
    v_schema := COALESCE(r.schema_name,
                         CASE WHEN r.object_type = 'schema' THEN trim(both '"' FROM r.object_identity) END,
                         v_home);
    INSERT INTO public.schema_drift_events
      ("id", "projectId", "roleName", "commandTag", "objectType", "objectIdentity", "schemaName", "capturedAt", "status")
    VALUES (
      gen_random_uuid()::text,
      CASE WHEN v_schema LIKE 'workspace\_%' THEN substring(v_schema FROM 11) ELSE NULL END,
      session_user::text,
      'DROP ' || upper(COALESCE(r.object_type, 'OBJECT')),
      r.object_type,
      r.object_identity,
      v_schema,
      now() AT TIME ZONE 'UTC',
      'pending'
    );
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'BACKENLY_DRIFT_CAPTURE_FAILED (SQLSTATE %)', SQLSTATE;
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

-- ── 7. Converge every existing workspace ─────────────────────────────────────
--
-- The application calls the sync for each workspace it creates, changes or
-- restores. A workspace made before the sync covered every one (it granted the
-- backup role only where direct access existed) is still unreadable, and so is
-- every snapshot of it. Re-running this file is how an existing database is
-- brought to what the sync declares: the regional procedure re-applies it
-- (tools/managed-db/regional/bootstrap.sh, step direct-access), and its
-- verify.sql then fails the run for any workspace the backup role still cannot
-- read. Anywhere else it is re-run with scripts/install-sql.sh.
--
-- Backup grants only: no ro/rw role is named, so ownership, direct-access
-- grants and policies are left as they are. The schemas are the ones the sync
-- accepts, so a preview branch (workspace_<id>_br_<name>) is not one of them.
-- Last in the file, so a failure here leaves every function installed and
-- granted. One transaction: every failure is collected and reported together,
-- and any failure leaves the grants exactly as they were.
DO $converge$
DECLARE
  s text;
  failed text[] := '{}';
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname ~ '^workspace_[0-9a-fA-F][0-9a-fA-F-]{10,60}$'
     ORDER BY nspname
  LOOP
    BEGIN
      PERFORM public.backenly_direct_sync_schema(s);
    EXCEPTION WHEN OTHERS THEN
      failed := failed || format('%s: %s', s, SQLERRM);
    END;
  END LOOP;
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'the backup role could not be given read access to % workspace schema(s): %',
      array_length(failed, 1), array_to_string(failed, '; ');
  END IF;
END $converge$;
