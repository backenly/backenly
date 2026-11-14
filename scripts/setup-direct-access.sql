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
--   with hard input validation. The app (backenly_user) can only call the
--   functions below; it cannot create arbitrary roles or touch other schemas.
--
--   1. backenly_external            — NOLOGIN group; pg_hba only admits remote
--                                     connections for members of this group.
--      backenly_no_schema_changes   — NOLOGIN role with no privileges; a
--                                     read-write login that is a member may not
--                                     change the schema (section 5b).
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
--   5b. backenly_direct_set_schema_changes — whether a read-write login may
--                                     change the schema; a new one may not, and
--                                     on a database shared by several projects
--                                     none may.
--   5c. backenly_direct_shared_database, backenly_direct_login_holds,
--       backenly_direct_schema_change_holds, backenly_direct_shared_holds,
--       backenly_direct_strip_schema_changes,
--       backenly_direct_end_stripped_sessions — whether the database is
--                                     shared; what a read-write login, or every
--                                     login at once, holds that lets it change
--                                     the schema; taking it away; and ending,
--                                     once that has committed, the sessions
--                                     that might still hold it.
--   6. backenly_capture_ddl/_drop   — event triggers that record every DDL
--                                     statement executed BY a bkn_% role into
--                                     public.schema_drift_events (the evidence
--                                     the autonomy loop adopts or flags).
--                                     Platform DDL (backenly_user) is ignored.
--
-- Last, on a shared database every existing read-write login, and what every
-- login holds at once, is stripped of any way to change the schema (section
-- 7), the sessions those strips left are ended once they have committed
-- (section 7b), and every workspace schema that already exists is brought to
-- what the sync declares for the backup role (section 8), so re-running this
-- file is also how an existing database is converged. Run it statement by
-- statement (scripts/install-sql.sh does), not in one transaction: 7b needs
-- section 7 committed.
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
-- And the role that marks a read-write login that may not change the schema
-- (section 5b). The definer grants both, so it holds ADMIN on each: it created
-- them, here or in the regional procedure (tools/managed-db/regional/sql/roles.sql).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_external') THEN
    CREATE ROLE backenly_external NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_no_schema_changes') THEN
    CREATE ROLE backenly_no_schema_changes NOLOGIN;
  END IF;
END $$;

-- ── 2. Create / re-key a per-project login role ──────────────────────────────
-- DROPs first: these functions once returned void; CREATE OR REPLACE cannot
-- change a return type. Grants are re-applied below, so this stays idempotent.
DROP FUNCTION IF EXISTS public.backenly_direct_create_role(text, text, text, text);
DROP FUNCTION IF EXISTS public.backenly_direct_set_password(text, text);
DROP FUNCTION IF EXISTS public.backenly_direct_drop_role(text);
DROP FUNCTION IF EXISTS public.backenly_direct_sync_schema(text, text, text, text);
DROP FUNCTION IF EXISTS public.backenly_direct_set_schema_changes(text, boolean);

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
      'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT %s',
      p_role, p_password, CASE WHEN p_mode = 'READ_ONLY' THEN 3 ELSE 2 END
    );
    -- The remote-access group: pg_hba matches its members, and the read
    -- pass-through policy applies to them (INHERIT). Without SET from
    -- PostgreSQL 16, so a login cannot become the group and give it what it
    -- owns: every login would then act as that object's owner (section 5c).
    EXECUTE format(CASE WHEN current_setting('server_version_num')::int >= 160000
                        THEN 'GRANT backenly_external TO %I WITH INHERIT TRUE, SET FALSE'
                        ELSE 'GRANT backenly_external TO %I' END, p_role);
    -- A new read-write login changes rows, not the schema, until the project's
    -- admin allows it (section 5b). Re-keying an existing login keeps its setting.
    IF p_mode = 'READ_WRITE' THEN
      EXECUTE format(CASE WHEN current_setting('server_version_num')::int >= 160000
                          THEN 'GRANT backenly_no_schema_changes TO %I WITH INHERIT FALSE, SET FALSE'
                          ELSE 'GRANT backenly_no_schema_changes TO %I' END, p_role);
    END IF;
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
-- (section 8). With no ro/rw role it grants the backup role and stops.
-- Owner-role model (READ_WRITE only): a NOLOGIN role bkn_own_<hex> owns the
-- schema and every table in it; backenly_user is a member, and so is the rw
-- login role when it may change the schema (section 5b), so that the external
-- developer can ALTER/DROP any table. Membership is inherited, so backenly_user
-- loses nothing. A login that may not change the schema is no member and has
-- no CREATE on it: it reads and writes rows, and a schema change over it is a
-- permission error. On a database shared by several projects no login may
-- change the schema, and each sync takes from it whatever would let it
-- (section 5c).
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
  v_rw_ddl boolean;
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

  -- Whether the rw login may change the schema (section 5b): never on a
  -- database shared by several projects (section 5c), and elsewhere not while
  -- it is a member of backenly_no_schema_changes. A login made before the
  -- setting existed is not a member, and keeps the schema changes it had only
  -- on a database dedicated to one project.
  IF p_rw IS NOT NULL THEN
    -- Sessions a strip in an earlier transaction left: a session that logged
    -- in before that strip committed may still hold the owner role (5c).
    PERFORM public.backenly_direct_end_stripped_sessions(p_rw);
    v_rw_ddl := NOT public.backenly_direct_shared_database() AND NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
       WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'backenly_no_schema_changes')
         AND m.member = (SELECT oid FROM pg_roles WHERE rolname = p_rw));
    -- Owner-role membership, CREATE on any schema or the database, TRIGGER on
    -- any table, grant options, default privileges and everything the login
    -- owns, and whatever every login holds at once in this project's schemas:
    -- taken, and its sessions ended when anything was (section 5c). First, so
    -- that what the groups owned is the owner role's before it is handed
    -- anything below. A login holding none of it is left alone.
    IF NOT v_rw_ddl THEN
      PERFORM public.backenly_direct_strip_schema_changes(p_rw, p_owner, p_schema);
    END IF;
  ELSE
    v_rw_ddl := false;
  END IF;

  -- ── Ownership model (READ_WRITE only) ──────────────────────────────────────
  -- Membership of the owner role is granted here only to a login that may
  -- change the schema; from any other, the strip below takes it.
  IF p_rw IS NOT NULL AND p_owner IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_owner) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', p_owner);
    END IF;
    EXECUTE format('GRANT %I TO %I', p_owner, public.backenly_app_role());
    IF v_rw_ddl THEN
      EXECUTE format('GRANT %I TO %I', p_owner, p_rw);
    END IF;
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
    IF v_rw_ddl THEN
      EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', p_schema, p_rw);
    ELSE
      -- Stripped above (section 5c).
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', p_schema, p_rw);
    END IF;
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

-- ── 5b. Whether a read-write login may change the schema ─────────────────────
--
-- A schema change over a read-write login skips the approvals and the History
-- every other door goes through: it is only observed as drift afterwards. So a
-- new login may not make one (backenly_direct_create_role), and the project's
-- admin can allow it. The setting is kept on the role, so the sync applies it
-- whenever it runs: ownership-role membership and CREATE on the schema with
-- schema changes allowed, row grants alone without. Takes effect at the next
-- sync, which the application runs right after calling this.
--
-- The setting is membership of backenly_no_schema_changes, a role with no
-- privileges, granted without INHERIT or SET from PostgreSQL 16. A setting of
-- Backenly's own on the role (ALTER ROLE ... SET backenly.x) would need a
-- superuser to write, and a managed database such as Amazon RDS has none: its
-- master, which owns these functions, holds ADMIN on the roles it created.
--
-- On a database shared by several projects schema changes are never allowed
-- (section 5c): allowing them is refused here, with SQLSTATE 42501 and a
-- message naming the shared database, which the application shows as the
-- reason. Refusing them stays possible everywhere.
CREATE OR REPLACE FUNCTION public.backenly_direct_set_schema_changes(
  p_role  text,
  p_allow boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_refused boolean;
BEGIN
  IF p_role !~ '^bkn_rw_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_set_schema_changes: invalid role name %', p_role;
  END IF;
  IF p_allow IS NULL THEN
    RAISE EXCEPTION 'backenly_direct_set_schema_changes: say whether schema changes are allowed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RAISE EXCEPTION 'backenly_direct_set_schema_changes: role % does not exist', p_role;
  END IF;
  IF p_allow AND public.backenly_direct_shared_database() THEN
    RAISE EXCEPTION 'backenly_direct_set_schema_changes: schema changes cannot be allowed over a read-write login on a database shared by several projects'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Code a login creates in its schema runs in the sessions that serve every project in the database. Change the schema through Backenly instead.';
  END IF;
  v_refused := EXISTS (
    SELECT 1 FROM pg_auth_members m
     WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'backenly_no_schema_changes')
       AND m.member = (SELECT oid FROM pg_roles WHERE rolname = p_role));
  IF p_allow AND v_refused THEN
    EXECUTE format('REVOKE backenly_no_schema_changes FROM %I', p_role);
  ELSIF NOT p_allow AND NOT v_refused THEN
    EXECUTE format(CASE WHEN current_setting('server_version_num')::int >= 160000
                        THEN 'GRANT backenly_no_schema_changes TO %I WITH INHERIT FALSE, SET FALSE'
                        ELSE 'GRANT backenly_no_schema_changes TO %I' END, p_role);
  END IF;
  -- A REVOKE of a grant another role made only warns, so the result is read
  -- back rather than assumed.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
     WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'backenly_no_schema_changes')
       AND m.member = (SELECT oid FROM pg_roles WHERE rolname = p_role)
  ) = p_allow THEN
    RAISE EXCEPTION 'backenly_direct_set_schema_changes: schema changes over % are still %', p_role,
      CASE WHEN p_allow THEN 'refused' ELSE 'allowed' END;
  END IF;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_set_schema_changes(text, boolean) FROM PUBLIC;

-- ── 5c. A database shared by several projects: read-write logins change rows ─
--
-- Code a login creates in its schema does not stay in its own sessions. A
-- trigger fires in whichever session writes the table; a row-level security
-- policy runs its expression, and the functions it calls, in whichever session
-- reads it; a view, a column default, a check constraint, an index expression,
-- a rule and an operator run their functions there too. A function that is not
-- SECURITY DEFINER runs as that session's role.
--
-- The sessions that read and write every project's tables are shared: the
-- application role, a member of every project's owner role, and PostgREST's
-- authenticated and service_role, which hold DML on every workspace it serves.
-- On a database holding several projects, code one of them plants runs with
-- the access those roles have to all of them, and to the platform's own tables
-- where the database holds them. Switching role does not contain it:
-- PostgreSQL authorizes SET ROLE against the session user, so SET ROLE NONE or
-- set_config('role', 'none', false) inside planted code returns it to the
-- shared role.
--
-- So on a shared database a read-write login reads and writes rows and does
-- nothing else. It holds no CREATE on any schema or on the database, no
-- TRIGGER on any table, no grant option on anything, no default privilege that
-- another role's future objects would give it, no membership in any role but
-- backenly_external and backenly_no_schema_changes, and owns nothing: what it
-- created belongs to the project's owner role, like every table the sync hands
-- over. Nor does any login hold any of that through PUBLIC or through
-- backenly_external, whose privileges every login has, and which owns nothing
-- and can be become by no login. Allowing schema changes is refused (5b), each
-- sync strips the login it names and converges what every login holds in its
-- project's schemas (5), and installing this file strips every login and
-- converges every schema (section 7). Code older logins already planted is
-- found and switched off by scripts/neutralize-planted-objects.ts.
--
-- A session keeps a role it took with SET ROLE after the membership is gone,
-- so a strip ends the login's sessions. A session that logs in while the
-- strip's transaction is still open sees the membership not yet revoked, and
-- can take the role then. The strip therefore marks the login (a comment on
-- the role, which a superuser or the definer holding ADMIN on it may write),
-- and backenly_direct_end_stripped_sessions, called in a later transaction,
-- ends whatever sessions it has and clears the mark: by the application right
-- after each sync, by each sync of that login, and by this file (section 7b).
--
-- A database is dedicated to one project only when a superuser says so for
-- this database and it holds one project's workspace:
--
--   ALTER DATABASE <db> SET backenly.database_tenancy = 'dedicated';
--
-- scripts/sql/dedicated-database.sql does that, and scripts/selfhost.ts runs it:
-- a self-hosted deployment is one project. Only a superuser can set a custom
-- parameter on a database, so a managed database such as Amazon RDS, which has
-- none, is always shared, as every Backenly Cloud database is. The setting is
-- read from the catalog, never from the session, so no session can claim it
-- with SET. A second project's workspace makes the database shared whatever
-- the setting says.
CREATE OR REPLACE FUNCTION public.backenly_direct_shared_database() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $fn$
  SELECT NOT EXISTS (
           SELECT 1
             FROM pg_db_role_setting s
            CROSS JOIN LATERAL unnest(s.setconfig) AS c(setting)
            WHERE s.setrole = 0
              AND s.setdatabase = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
              AND c.setting = 'backenly.database_tenancy=dedicated')
      OR (SELECT count(*) FROM pg_namespace n
           WHERE n.nspname ~ '^workspace_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') > 1
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_shared_database() FROM PUBLIC;

-- Everything a read-write login holds in this database that would let it
-- change the schema, one row per thing, with the statement that takes it, the
-- roles whose privileges that statement needs, and the order to take them in:
--
--   1 membership of any role but the two marker groups, an owner role's above all;
--   2 CREATE on the database or on any schema, and TRIGGER on any table;
--   3 a grant option on anything, with which it would grant others what it holds;
--   4 a default privilege another role's future objects would give it;
--   5 ownership of anything, which passes to the project's owner role.
--
-- Grants are found through pg_shdepend, which records every object whose
-- privileges name the login, so no catalog is scanned whole. A temporary
-- object is its own session's, reachable from no other and gone when it ends,
-- so it is not counted. Read by backenly_direct_schema_change_holds and by the
-- strip below, which takes exactly what this lists.
CREATE OR REPLACE FUNCTION public.backenly_direct_login_holds(p_role text, p_owner text DEFAULT NULL)
RETURNS TABLE (item text, fix text, needs text[], step integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $fn$
  WITH login AS (SELECT r.oid FROM pg_roles r WHERE r.rolname = p_role),
       here AS (SELECT d.oid, d.datname::text AS name, d.datacl, pg_get_userbyid(d.datdba)::text AS dba
                  FROM pg_database d WHERE d.datname = current_database()),
       v AS (SELECT current_setting('server_version_num')::int >= 160000 AS pg16,
                    coalesce(p_owner, 'bkn_own_' || right(p_role, 12)) AS owner),
       dep AS (
         SELECT s.classid, s.objid, s.objsubid, s.deptype
           FROM pg_shdepend s, login, here
          WHERE s.refclassid = 'pg_authid'::regclass AND s.refobjid = login.oid AND s.dbid = here.oid),
       -- Every privilege granted to the login on an object in this database,
       -- with what GRANT and REVOKE call the object.
       acl AS (
         SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
                c.oid::regclass::text AS obj, c.oid::regclass::text AS label, NULL::text AS col,
                pg_get_userbyid(c.relowner)::text AS owner, a.privilege_type AS priv, a.is_grantable AS grantable
           FROM dep
           JOIN pg_class c ON dep.classid = 'pg_class'::regclass AND dep.objsubid = 0 AND c.oid = dep.objid
           CROSS JOIN LATERAL aclexplode(c.relacl) a, login
          WHERE dep.deptype = 'a' AND a.grantee = login.oid AND c.relpersistence <> 't'
         UNION ALL
         SELECT 'TABLE', c.oid::regclass::text, c.oid::regclass::text, quote_ident(at.attname),
                pg_get_userbyid(c.relowner)::text, a.privilege_type, a.is_grantable
           FROM dep
           JOIN pg_attribute at ON dep.classid = 'pg_class'::regclass AND dep.objsubid > 0
                                AND at.attrelid = dep.objid AND at.attnum = dep.objsubid
           JOIN pg_class c ON c.oid = at.attrelid
           CROSS JOIN LATERAL aclexplode(at.attacl) a, login
          WHERE dep.deptype = 'a' AND a.grantee = login.oid AND c.relpersistence <> 't'
         UNION ALL
         SELECT 'SCHEMA', quote_ident(n.nspname), n.nspname::text, NULL,
                pg_get_userbyid(n.nspowner)::text, a.privilege_type, a.is_grantable
           FROM dep
           JOIN pg_namespace n ON dep.classid = 'pg_namespace'::regclass AND n.oid = dep.objid
           CROSS JOIN LATERAL aclexplode(n.nspacl) a, login
          WHERE dep.deptype = 'a' AND a.grantee = login.oid
         UNION ALL
         SELECT 'ROUTINE', p.oid::regprocedure::text, p.oid::regprocedure::text, NULL,
                pg_get_userbyid(p.proowner)::text, a.privilege_type, a.is_grantable
           FROM dep
           JOIN pg_proc p ON dep.classid = 'pg_proc'::regclass AND p.oid = dep.objid
           CROSS JOIN LATERAL aclexplode(p.proacl) a, login
          WHERE dep.deptype = 'a' AND a.grantee = login.oid
         UNION ALL
         SELECT CASE WHEN t.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END, t.oid::regtype::text, t.oid::regtype::text, NULL,
                pg_get_userbyid(t.typowner)::text, a.privilege_type, a.is_grantable
           FROM dep
           JOIN pg_type t ON dep.classid = 'pg_type'::regclass AND t.oid = dep.objid
           CROSS JOIN LATERAL aclexplode(t.typacl) a, login
          WHERE dep.deptype = 'a' AND a.grantee = login.oid
         UNION ALL
         SELECT 'LANGUAGE', quote_ident(l.lanname), l.lanname::text, NULL,
                pg_get_userbyid(l.lanowner)::text, a.privilege_type, a.is_grantable
           FROM dep
           JOIN pg_language l ON dep.classid = 'pg_language'::regclass AND l.oid = dep.objid
           CROSS JOIN LATERAL aclexplode(l.lanacl) a, login
          WHERE dep.deptype = 'a' AND a.grantee = login.oid
         UNION ALL
         SELECT 'LARGE OBJECT', m.oid::text, m.oid::text, NULL,
                pg_get_userbyid(m.lomowner)::text, a.privilege_type, a.is_grantable
           FROM dep
           JOIN pg_largeobject_metadata m ON dep.classid = 'pg_largeobject'::regclass AND m.oid = dep.objid
           CROSS JOIN LATERAL aclexplode(m.lomacl) a, login
          WHERE dep.deptype = 'a' AND a.grantee = login.oid
         UNION ALL
         SELECT 'DATABASE', quote_ident(here.name), here.name, NULL, here.dba, a.privilege_type, a.is_grantable
           FROM here CROSS JOIN LATERAL aclexplode(here.datacl) a, login
          WHERE a.grantee = login.oid)
  SELECT 'member of ' || g.rolname,
         CASE WHEN v.pg16 THEN format('REVOKE %I FROM %I GRANTED BY %I CASCADE', g.rolname, p_role, gr.rolname)
              ELSE format('REVOKE %I FROM %I CASCADE', g.rolname, p_role) END,
         CASE WHEN v.pg16 THEN ARRAY[gr.rolname::text] ELSE '{}'::text[] END,
         1
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles gr ON gr.oid = m.grantor, login, v
   WHERE m.member = login.oid AND g.rolname NOT IN ('backenly_external', 'backenly_no_schema_changes')
  UNION ALL
  SELECT CASE acl.kind WHEN 'DATABASE' THEN 'CREATE on database ' ELSE 'CREATE on schema ' END || acl.label,
         format('REVOKE CREATE ON %s %s FROM %I CASCADE', acl.kind, acl.obj, p_role),
         ARRAY[acl.owner], 2
    FROM acl
   WHERE acl.kind IN ('DATABASE', 'SCHEMA') AND acl.priv = 'CREATE'
  UNION ALL
  SELECT 'TRIGGER on ' || acl.label,
         format('REVOKE TRIGGER ON TABLE %s FROM %I CASCADE', acl.obj, p_role),
         ARRAY[acl.owner], 2
    FROM acl
   WHERE acl.kind = 'TABLE' AND acl.col IS NULL AND acl.priv = 'TRIGGER'
  UNION ALL
  SELECT DISTINCT 'grant option on ' || lower(acl.kind) || ' ' || acl.label || coalesce(' (' || acl.col || ')', ''),
         format('REVOKE GRANT OPTION FOR ALL PRIVILEGES%s ON %s %s FROM %I CASCADE',
                coalesce(' (' || acl.col || ')', ''), acl.kind, acl.obj, p_role),
         ARRAY[acl.owner], 3
    FROM acl
   WHERE acl.grantable
  UNION ALL
  SELECT 'default privileges of ' || pg_get_userbyid(da.defaclrole)
           || coalesce(' in schema ' || n.nspname, '') || ' on ' || lower(k.word),
         format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %I CASCADE',
                pg_get_userbyid(da.defaclrole),
                CASE WHEN da.defaclnamespace <> 0 THEN format(' IN SCHEMA %I', n.nspname) ELSE '' END,
                k.word, p_role),
         ARRAY[pg_get_userbyid(da.defaclrole)::text], 4
    FROM dep
    JOIN pg_default_acl da ON dep.classid = 'pg_default_acl'::regclass AND da.oid = dep.objid
    LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
    CROSS JOIN LATERAL (SELECT CASE da.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
                                 WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS'
                                 ELSE 'LARGE OBJECTS' END AS word) k
   WHERE dep.deptype = 'a'
  UNION ALL
  -- Default privileges the sync sets FOR the login (section 5) are recorded as
  -- its own, but create nothing and are not objects: left out.
  SELECT 'owner of ' || count(*) || ' object(s)',
         format('REASSIGN OWNED BY %I TO %I', p_role, min(v.owner)),
         ARRAY[p_role, min(v.owner)], 5
    FROM dep CROSS JOIN LATERAL pg_identify_object(dep.classid, dep.objid, dep.objsubid) o, v
   WHERE dep.deptype = 'o' AND dep.classid <> 'pg_default_acl'::regclass
     AND coalesce(o.schema, '') !~ '^pg_(toast_)?temp_'
  HAVING count(*) > 0
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_login_holds(text, text) FROM PUBLIC;

-- What a read-write login holds that would let it change the schema, one item
-- per line, sorted; empty when it changes rows only. Read by the strip below,
-- before and after it acts, and by the regional verification
-- (tools/managed-db/regional/sql/verify.sql).
CREATE OR REPLACE FUNCTION public.backenly_direct_schema_change_holds(p_role text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $fn$
  SELECT coalesce(array_agg(DISTINCT h.item ORDER BY h.item), '{}'::text[])
    FROM public.backenly_direct_login_holds(p_role) h
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_schema_change_holds(text) FROM PUBLIC;

-- What every login holds at once, one row per thing: through PUBLIC; through
-- backenly_external, the group each joins, whose privileges each has (the
-- read pass-through policy applies to it by inheritance) and which therefore
-- holds nothing and owns nothing; and through backenly_no_schema_changes,
-- which must hold nothing either. With the statement that takes it (NULL where
-- nothing here can), the roles whose privileges that statement needs, and the
-- order to take them in:
--
--   1 a membership either group holds, and a login able to SET ROLE to the
--     group (from PostgreSQL 16, every login joins it without SET);
--   2 CREATE on a schema or the database, and TRIGGER on a table;
--   3 a grant option either group holds;
--   4 a default privilege naming either group, or giving PUBLIC TRIGGER on
--     tables or CREATE on schemas made later;
--   5 an object either group owns, which passes to the owner role of the
--     project whose schema holds it (p_owner, or the role named from the
--     schema as the sync names it); outside a project's schema, nothing here
--     can say whose it is.
--
-- In p_schema and the schemas named after it (the project's preview branches,
-- change vaults and set-aside copies) when it is given, which is how the sync
-- converges one project's; in the whole database when it is not, which is how
-- installing this file converges every project's (section 7) and how the
-- regional verification checks them.
CREATE OR REPLACE FUNCTION public.backenly_direct_shared_holds(p_schema text DEFAULT NULL, p_owner text DEFAULT NULL)
RETURNS TABLE (holder text, item text, fix text, needs text[], step integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $fn$
  WITH grp AS (
         SELECT 0::oid AS oid, 'PUBLIC'::text AS name, 'PUBLIC'::text AS sql
         UNION ALL
         SELECT r.oid, r.rolname::text, quote_ident(r.rolname)
           FROM pg_roles r WHERE r.rolname IN ('backenly_external', 'backenly_no_schema_changes')),
       here AS (SELECT d.oid, d.datname::text AS name, d.datacl, pg_get_userbyid(d.datdba)::text AS dba
                  FROM pg_database d WHERE d.datname = current_database()),
       v AS (SELECT current_setting('server_version_num')::int >= 160000 AS pg16),
       scope AS (
         SELECT n.oid, n.nspname::text AS name, pg_get_userbyid(n.nspowner)::text AS owner, n.nspacl,
                coalesce(p_owner,
                  CASE WHEN n.nspname ~ '^workspace_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
                       THEN 'bkn_own_' || left(encode(sha256(convert_to(substring(n.nspname FROM 11 FOR 36), 'UTF8')), 'hex'), 12)
                  END) AS project_owner
           FROM pg_namespace n
          WHERE CASE WHEN p_schema IS NULL
                     THEN n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
                     ELSE n.nspname = p_schema OR left(n.nspname, length(p_schema) + 1) = p_schema || '_' END)
  -- 1. Memberships either group holds (the whole database only: roles are the cluster's).
  SELECT mm.rolname::text, 'membership of ' || g.rolname,
         CASE WHEN v.pg16 THEN format('REVOKE %I FROM %I GRANTED BY %I CASCADE', g.rolname, mm.rolname, gr.rolname)
              ELSE format('REVOKE %I FROM %I CASCADE', g.rolname, mm.rolname) END,
         CASE WHEN v.pg16 THEN ARRAY[gr.rolname::text] ELSE '{}'::text[] END, 1
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles mm ON mm.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor, v
   WHERE p_schema IS NULL AND mm.rolname IN ('backenly_external', 'backenly_no_schema_changes')
  UNION ALL
  -- A login that could become the group, and so give it what the login owns.
  -- set_option exists from PostgreSQL 16 only, hence read through to_jsonb.
  SELECT l.rolname::text, 'SET on backenly_external',
         format('REVOKE SET OPTION FOR backenly_external FROM %I GRANTED BY %I', l.rolname, gr.rolname),
         ARRAY[gr.rolname::text], 1
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = 'backenly_external'
    JOIN pg_roles l ON l.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor, v
   WHERE p_schema IS NULL AND v.pg16 AND (to_jsonb(m) ->> 'set_option')::boolean
     AND l.rolname ~ '^bkn_(ro|rw)_[0-9a-f]{12}$'
  UNION ALL
  -- 2. CREATE on a schema or the database, TRIGGER on a table.
  SELECT g.name, 'CREATE on schema ' || s.name,
         format('REVOKE CREATE ON SCHEMA %I FROM %s', s.name, g.sql), ARRAY[s.owner], 2
    FROM scope s CROSS JOIN LATERAL aclexplode(s.nspacl) a JOIN grp g ON g.oid = a.grantee
   WHERE a.privilege_type = 'CREATE'
  UNION ALL
  SELECT g.name, 'CREATE on database ' || here.name,
         format('REVOKE CREATE ON DATABASE %I FROM %s', here.name, g.sql), ARRAY[here.dba], 2
    FROM here CROSS JOIN LATERAL aclexplode(here.datacl) a JOIN grp g ON g.oid = a.grantee
   WHERE p_schema IS NULL AND a.privilege_type = 'CREATE'
  UNION ALL
  SELECT g.name, 'TRIGGER on ' || c.oid::regclass::text,
         format('REVOKE TRIGGER ON TABLE %s FROM %s', c.oid::regclass, g.sql),
         ARRAY[pg_get_userbyid(c.relowner)::text], 2
    FROM scope s
    JOIN pg_class c ON c.relnamespace = s.oid
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN grp g ON g.oid = a.grantee
   WHERE a.privilege_type = 'TRIGGER'
  UNION ALL
  -- 3. Grant options (PUBLIC cannot hold one).
  SELECT DISTINCT g.name, 'grant option on ' || x.what,
         format('REVOKE GRANT OPTION FOR ALL PRIVILEGES%s ON %s FROM %s CASCADE', x.cols, x.target, g.sql),
         ARRAY[x.owner], 3
    FROM (
      SELECT a.grantee, a.is_grantable, 'table ' || c.oid::regclass::text AS what, '' AS cols,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END || c.oid::regclass::text AS target,
             pg_get_userbyid(c.relowner)::text AS owner
        FROM scope s JOIN pg_class c ON c.relnamespace = s.oid CROSS JOIN LATERAL aclexplode(c.relacl) a
      UNION ALL
      SELECT a.grantee, a.is_grantable, 'table ' || c.oid::regclass::text || ' (' || quote_ident(at.attname) || ')',
             ' (' || quote_ident(at.attname) || ')', 'TABLE ' || c.oid::regclass::text, pg_get_userbyid(c.relowner)::text
        FROM scope s
        JOIN pg_class c ON c.relnamespace = s.oid
        JOIN pg_attribute at ON at.attrelid = c.oid AND at.attnum > 0
        CROSS JOIN LATERAL aclexplode(at.attacl) a
      UNION ALL
      SELECT a.grantee, a.is_grantable, 'schema ' || s.name, '', 'SCHEMA ' || quote_ident(s.name), s.owner
        FROM scope s CROSS JOIN LATERAL aclexplode(s.nspacl) a
      UNION ALL
      SELECT a.grantee, a.is_grantable, 'routine ' || p.oid::regprocedure::text, '',
             'ROUTINE ' || p.oid::regprocedure::text, pg_get_userbyid(p.proowner)::text
        FROM scope s JOIN pg_proc p ON p.pronamespace = s.oid CROSS JOIN LATERAL aclexplode(p.proacl) a
      UNION ALL
      SELECT a.grantee, a.is_grantable, 'type ' || t.oid::regtype::text, '',
             CASE WHEN t.typtype = 'd' THEN 'DOMAIN ' ELSE 'TYPE ' END || t.oid::regtype::text, pg_get_userbyid(t.typowner)::text
        FROM scope s JOIN pg_type t ON t.typnamespace = s.oid CROSS JOIN LATERAL aclexplode(t.typacl) a
      UNION ALL
      SELECT a.grantee, a.is_grantable, 'database ' || here.name, '', 'DATABASE ' || quote_ident(here.name), here.dba
        FROM here CROSS JOIN LATERAL aclexplode(here.datacl) a
       WHERE p_schema IS NULL
    ) x
    JOIN grp g ON g.oid = x.grantee
   WHERE x.is_grantable AND g.oid <> 0
  UNION ALL
  -- 4. Default privileges.
  SELECT DISTINCT g.name,
         'default privileges of ' || pg_get_userbyid(da.defaclrole) || coalesce(' in schema ' || n.nspname, '')
           || ' on ' || lower(k.word) || CASE WHEN g.oid = 0 THEN ': ' || a.privilege_type ELSE '' END,
         format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE %s ON %s FROM %s%s',
                pg_get_userbyid(da.defaclrole),
                CASE WHEN da.defaclnamespace <> 0 THEN format(' IN SCHEMA %I', n.nspname) ELSE '' END,
                CASE WHEN g.oid = 0 THEN a.privilege_type ELSE 'ALL' END, k.word, g.sql,
                CASE WHEN g.oid = 0 THEN '' ELSE ' CASCADE' END),
         ARRAY[pg_get_userbyid(da.defaclrole)::text], 4
    FROM pg_default_acl da
    LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
    CROSS JOIN LATERAL aclexplode(da.defaclacl) a
    JOIN grp g ON g.oid = a.grantee
    CROSS JOIN LATERAL (SELECT CASE da.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
                                 WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS'
                                 ELSE 'LARGE OBJECTS' END AS word) k
   WHERE (p_schema IS NULL OR da.defaclnamespace IN (SELECT s.oid FROM scope s)
          OR (da.defaclnamespace = 0 AND pg_get_userbyid(da.defaclrole) = p_owner))
     AND (g.oid <> 0 OR (da.defaclobjtype = 'r' AND a.privilege_type = 'TRIGGER')
                     OR (da.defaclobjtype = 'n' AND a.privilege_type = 'CREATE'))
  UNION ALL
  -- 5. Objects either group owns.
  SELECT g.name, 'ownership of ' || o.type || ' ' || o.identity,
         CASE WHEN s.project_owner IS NOT NULL AND k.word IS NOT NULL
              THEN format('ALTER %s %s OWNER TO %I', k.word, o.identity, s.project_owner) END,
         ARRAY[g.name, s.project_owner], 5
    FROM grp g
    JOIN here ON true
    JOIN pg_shdepend d ON d.refclassid = 'pg_authid'::regclass AND d.refobjid = g.oid AND d.deptype = 'o'
                      AND d.dbid = here.oid AND d.classid <> 'pg_default_acl'::regclass
    CROSS JOIN LATERAL pg_identify_object(d.classid, d.objid, d.objsubid) o
    -- pg_identify_object quotes the schema, and the name, where it must.
    LEFT JOIN scope s ON quote_ident(s.name) = o.schema OR (o.type = 'schema' AND quote_ident(s.name) = o.name)
    CROSS JOIN LATERAL (SELECT CASE o.type
             WHEN 'table' THEN 'TABLE' WHEN 'view' THEN 'VIEW' WHEN 'materialized view' THEN 'MATERIALIZED VIEW'
             WHEN 'sequence' THEN 'SEQUENCE' WHEN 'foreign table' THEN 'FOREIGN TABLE'
             WHEN 'function' THEN 'FUNCTION' WHEN 'procedure' THEN 'PROCEDURE' WHEN 'aggregate' THEN 'AGGREGATE'
             WHEN 'type' THEN 'TYPE' WHEN 'composite type' THEN 'TYPE' WHEN 'domain' THEN 'DOMAIN'
             WHEN 'operator' THEN 'OPERATOR' WHEN 'operator class' THEN 'OPERATOR CLASS'
             WHEN 'operator family' THEN 'OPERATOR FAMILY' WHEN 'collation' THEN 'COLLATION'
             WHEN 'conversion' THEN 'CONVERSION' WHEN 'text search configuration' THEN 'TEXT SEARCH CONFIGURATION'
             WHEN 'text search dictionary' THEN 'TEXT SEARCH DICTIONARY' WHEN 'statistics object' THEN 'STATISTICS'
             WHEN 'schema' THEN 'SCHEMA' END AS word) k
   WHERE g.oid <> 0
     AND coalesce(o.schema, '') !~ '^pg_(toast_)?temp_'
     AND (p_schema IS NULL OR s.oid IS NOT NULL)
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_shared_holds(text, text) FROM PUBLIC;

-- Take from a read-write login everything backenly_direct_login_holds lists,
-- mark it refused (5b) so a database made dedicated later still asks its admin
-- first, take its SET on backenly_external, and, given its project's schema,
-- everything backenly_direct_shared_holds lists there. When the login held
-- anything, end its sessions now and mark it, so that the sessions that log in
-- before this transaction commits are ended by
-- backenly_direct_end_stripped_sessions once it has (see above). Returns
-- whether anything was taken; a login holding none of it, in a project whose
-- schemas hold none of it, is left alone, its sessions included.
--
-- The definer acts with the privileges of the login (to reassign what it owns
-- and end its sessions), of the project's owner role (to revoke what was
-- granted as the owner of its schema and tables, and to hand objects to it:
-- PostgreSQL 16 lets a role that is not a superuser give an object only to a
-- role it can SET ROLE to), of each role that granted the login a membership
-- or holds a default privilege naming it (REVOKE ... GRANTED BY names it), and
-- of backenly_external where it owns something. A definer that is not a
-- superuser holds ADMIN on the roles it created and, on Amazon RDS, nothing
-- more (backenly_direct_drop_role explains), so it grants itself what it lacks
-- and takes it back before it returns. Anything it cannot take is an error
-- naming what is left, never a partial strip reported as done.
--
-- Its signature was (text, text) before it could converge the project's
-- schemas; that one is dropped, or a call naming only the login would match both.
DROP FUNCTION IF EXISTS public.backenly_direct_strip_schema_changes(text, text);

CREATE OR REPLACE FUNCTION public.backenly_direct_strip_schema_changes(
  p_role   text,
  p_owner  text DEFAULT NULL,
  p_schema text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pg16   constant boolean := current_setting('server_version_num')::int >= 160000;
  v_owner  text := coalesce(p_owner, 'bkn_own_' || right(p_role, 12));
  v_role   oid;
  v_marked boolean;
  v_holds  text[];
  v_shared text[] := '{}';
  v_become text[] := '{}';
  v_needs  text[] := '{}';
  v_took   text[] := '{}';
  v_need   text;
  r        record;
BEGIN
  IF p_role IS NULL OR p_role !~ '^bkn_rw_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_strip_schema_changes: invalid role name %', p_role;
  END IF;
  IF v_owner !~ '^bkn_own_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_strip_schema_changes: invalid owner role %', v_owner;
  END IF;
  IF p_schema IS NOT NULL AND p_schema !~ '^workspace_[0-9a-fA-F][0-9a-fA-F-]{10,60}$' THEN
    RAISE EXCEPTION 'backenly_direct_strip_schema_changes: invalid schema %', p_schema;
  END IF;
  SELECT oid INTO v_role FROM pg_roles WHERE rolname = p_role;
  IF v_role IS NULL THEN
    RETURN false; -- gone already
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_no_schema_changes') THEN
    RAISE EXCEPTION 'backenly_direct_strip_schema_changes: role backenly_no_schema_changes is missing';
  END IF;

  v_marked := EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
     WHERE m.member = v_role AND g.rolname = 'backenly_no_schema_changes');
  v_holds := public.backenly_direct_schema_change_holds(p_role);
  IF p_schema IS NOT NULL THEN
    SELECT coalesce(array_agg(h.item), '{}') INTO v_shared FROM public.backenly_direct_shared_holds(p_schema, v_owner) h;
  END IF;
  IF v_pg16 THEN
    SELECT coalesce(array_agg(gr.rolname::text), '{}') INTO v_become
      FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = 'backenly_external'
      JOIN pg_roles gr ON gr.oid = m.grantor
     WHERE m.member = v_role AND (to_jsonb(m) ->> 'set_option')::boolean;
  END IF;
  IF v_marked AND cardinality(v_holds) = 0 AND cardinality(v_shared) = 0 AND cardinality(v_become) = 0 THEN
    RETURN false;
  END IF;

  -- The owner role takes what the login and the groups owned. Made as the sync
  -- makes it, for a login whose project somehow has none.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_owner)
     AND (EXISTS (SELECT 1 FROM public.backenly_direct_login_holds(p_role, v_owner) h WHERE h.step = 5)
          OR (p_schema IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.backenly_direct_shared_holds(p_schema, v_owner) h WHERE h.step = 5))) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', v_owner);
    EXECUTE format('GRANT %I TO %I', v_owner, public.backenly_app_role());
  END IF;

  -- The privileges the steps below need, granted to itself where it lacks
  -- them. Without ADMIN on a role it cannot; the step that needed it then
  -- fails, and so does this function.
  SELECT coalesce(array_agg(DISTINCT x.n), '{}') INTO v_needs
    FROM (SELECT p_role AS n
          UNION ALL
          SELECT unnest(h.needs) FROM public.backenly_direct_login_holds(p_role, v_owner) h
          UNION ALL
          SELECT unnest(v_become)) x
   WHERE x.n IS NOT NULL;
  IF p_schema IS NOT NULL THEN
    SELECT v_needs || coalesce(array_agg(DISTINCT n), '{}') INTO v_needs
      FROM public.backenly_direct_shared_holds(p_schema, v_owner) h CROSS JOIN LATERAL unnest(h.needs) AS n
     WHERE n IS NOT NULL;
  END IF;
  FOR v_need IN
    SELECT DISTINCT n FROM unnest(v_needs) AS n WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n)
  LOOP
    -- Handing objects to the owner role also needs SET on it, from PostgreSQL 16.
    IF pg_has_role(current_user, v_need, 'USAGE')
       AND (NOT v_pg16 OR v_need <> v_owner OR pg_has_role(current_user, v_need, 'SET')) THEN
      CONTINUE;
    END IF;
    CONTINUE WHEN NOT pg_has_role(current_user, v_need, 'MEMBER WITH ADMIN OPTION');
    EXECUTE format(CASE WHEN v_pg16 THEN 'GRANT %I TO %I WITH INHERIT TRUE, SET TRUE'
                        ELSE 'GRANT %I TO %I' END, v_need, current_user);
    v_took := v_took || v_need;
  END LOOP;

  IF NOT v_marked THEN
    EXECUTE format(CASE WHEN v_pg16 THEN 'GRANT backenly_no_schema_changes TO %I WITH INHERIT FALSE, SET FALSE'
                        ELSE 'GRANT backenly_no_schema_changes TO %I' END, p_role);
  END IF;

  -- It can no longer become the group it joined.
  FOREACH v_need IN ARRAY v_become LOOP
    EXECUTE format('REVOKE SET OPTION FOR backenly_external FROM %I GRANTED BY %I', p_role, v_need);
  END LOOP;

  -- What the login holds, in order: memberships first (an owner role's above
  -- all), then CREATE and TRIGGER, grant options, default privileges, and what
  -- it owns, which passes to the project's owner role. No longer a member of
  -- that role, the login can neither change those objects nor grant anyone the
  -- use of them.
  FOR r IN SELECT h.fix FROM public.backenly_direct_login_holds(p_role, v_owner) h ORDER BY h.step, h.item LOOP
    EXECUTE r.fix;
  END LOOP;

  -- What every login holds in this project's schemas.
  IF p_schema IS NOT NULL THEN
    FOR r IN SELECT h.holder, h.item, h.fix FROM public.backenly_direct_shared_holds(p_schema, v_owner) h
              ORDER BY h.step, h.holder, h.item LOOP
      IF r.fix IS NULL THEN
        RAISE EXCEPTION 'backenly_direct_strip_schema_changes: % holds %, which this cannot take', r.holder, r.item;
      END IF;
      EXECUTE r.fix;
    END LOOP;
  END IF;

  IF cardinality(v_holds) > 0 THEN
    PERFORM pg_terminate_backend(a.pid) FROM pg_stat_activity a WHERE a.usename = p_role;
    EXECUTE format('COMMENT ON ROLE %I IS %L', p_role,
                   'backenly: sessions to end after a strip, from transaction ' || pg_current_xact_id()::text);
  END IF;

  FOREACH v_need IN ARRAY v_took LOOP
    EXECUTE format('REVOKE %I FROM %I', v_need, current_user);
  END LOOP;

  v_holds := public.backenly_direct_schema_change_holds(p_role);
  IF cardinality(v_holds) > 0 THEN
    RAISE EXCEPTION 'backenly_direct_strip_schema_changes: % still holds %', p_role, array_to_string(v_holds, '; ');
  END IF;
  IF p_schema IS NOT NULL THEN
    SELECT coalesce(array_agg(h.holder || ' holds ' || h.item), '{}') INTO v_shared
      FROM public.backenly_direct_shared_holds(p_schema, v_owner) h;
    IF cardinality(v_shared) > 0 THEN
      RAISE EXCEPTION 'backenly_direct_strip_schema_changes: in %, %', p_schema, array_to_string(v_shared, '; ');
    END IF;
  END IF;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_strip_schema_changes(text, text, text) FROM PUBLIC;

-- End the sessions of a read-write login a strip marked (or of every one, with
-- no argument), and clear the mark; returns how many logins. A mark this
-- transaction made waits: the sessions it is for are the ones that log in
-- before this transaction commits. Each session is ended whatever it is doing;
-- one that logged in after the strip committed cannot have taken what was
-- taken, and loses one connection. Called by the application right after each
-- sync, by each sync of the login, and by this file (section 7b).
CREATE OR REPLACE FUNCTION public.backenly_direct_end_stripped_sessions(p_role text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pg16    constant boolean := current_setting('server_version_num')::int >= 160000;
  v_mine    text := 'backenly: sessions to end after a strip, from transaction '
                    || coalesce(pg_current_xact_id_if_assigned()::text, '');
  v_granted boolean;
  v_ended   integer := 0;
  r         record;
BEGIN
  IF p_role IS NOT NULL AND p_role !~ '^bkn_rw_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'backenly_direct_end_stripped_sessions: invalid role name %', p_role;
  END IF;
  FOR r IN
    SELECT a.rolname::text AS login, d.description
      FROM pg_shdescription d JOIN pg_roles a ON a.oid = d.objoid
     WHERE d.classoid = 'pg_authid'::regclass
       AND a.rolname ~ '^bkn_rw_[0-9a-f]{12}$' AND (p_role IS NULL OR a.rolname = p_role)
       AND d.description LIKE 'backenly: sessions to end after a strip%'
     ORDER BY 1
  LOOP
    CONTINUE WHEN r.description = v_mine;
    -- Ending a role's sessions needs its privileges (backenly_direct_drop_role explains).
    v_granted := false;
    IF NOT pg_has_role(current_user, r.login, 'USAGE') THEN
      EXECUTE format(CASE WHEN v_pg16 THEN 'GRANT %I TO %I WITH INHERIT TRUE, SET FALSE'
                          ELSE 'GRANT %I TO %I' END, r.login, current_user);
      v_granted := true;
    END IF;
    PERFORM pg_terminate_backend(s.pid) FROM pg_stat_activity s WHERE s.usename = r.login;
    EXECUTE format('COMMENT ON ROLE %I IS NULL', r.login);
    IF v_granted THEN
      EXECUTE format('REVOKE %I FROM %I', r.login, current_user);
    END IF;
    v_ended := v_ended + 1;
  END LOOP;
  RETURN v_ended;
END
$fn$;

REVOKE ALL ON FUNCTION public.backenly_direct_end_stripped_sessions(text) FROM PUBLIC;
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
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_direct_set_schema_changes(text, boolean) TO %I', r);
    -- Read by the application to say why schema changes cannot be allowed.
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_direct_shared_database() TO %I', r);
    -- Called by the application right after each sync (section 5c).
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_direct_end_stripped_sessions(text) TO %I', r);
  END IF;
END $grant$;

-- ── 7. A shared database: no login keeps a way to change the schema ──────────
--
-- The sync strips the login it names each time it runs, and converges what
-- every login holds in that project's schemas (section 5c). This strips every
-- read-write login there is and converges every schema, so installing this
-- file is how a release reaches them all: the home database's install, and in
-- a region the regional procedure's direct-access step (tools/managed-db/
-- regional/bootstrap.sh), whose verify.sql then fails the run for anything
-- still held.
--
-- What every login holds at once is backenly_direct_shared_holds: CREATE on a
-- schema or on the database and TRIGGER on a table granted to PUBLIC, to
-- backenly_external (the group every direct-access login joins, with its
-- privileges) or to backenly_no_schema_changes (which must hold nothing); a
-- grant option, default privilege, membership or object either group holds;
-- and a login able to become backenly_external. CREATE on the public schema
-- matters most: every session's search path includes it, so a function or
-- operator created there can stand in for a built-in one.
--
-- A database dedicated to one project (section 5c) is left as it is. One
-- transaction: every failure is collected and reported together, and any
-- failure leaves every grant, membership and owner as it was (a session the
-- strip already ended stays ended). Run as the installer, which on Amazon RDS
-- is no superuser: it grants itself, as the strip does, the privileges of the
-- roles whose objects it changes, and takes them back.
DO $strip$
DECLARE
  r        record;
  stripped int := 0;
  failed   text[] := '{}';
  took     text[] := '{}';
  v_pg16   constant boolean := current_setting('server_version_num')::int >= 160000;
BEGIN
  IF NOT public.backenly_direct_shared_database() THEN
    RAISE NOTICE 'direct access: this database is dedicated to one project; its read-write logins keep the schema changes their admin allowed';
    RETURN;
  END IF;

  FOR r IN SELECT rolname::text AS login FROM pg_roles WHERE rolname ~ '^bkn_rw_[0-9a-f]{12}$' ORDER BY 1 LOOP
    BEGIN
      IF public.backenly_direct_strip_schema_changes(r.login) THEN
        stripped := stripped + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      failed := failed || format('%s: %s', r.login, SQLERRM);
    END;
  END LOOP;

  -- The roles the statements below act as, the owner roles objects pass to
  -- made as the sync makes them.
  FOR r IN
    SELECT DISTINCT n AS role
      FROM public.backenly_direct_shared_holds() h CROSS JOIN LATERAL unnest(h.needs) AS n
     WHERE n IS NOT NULL
  LOOP
    IF r.role ~ '^bkn_own_[0-9a-f]{12}$' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r.role);
      EXECUTE format('GRANT %I TO %I', r.role, public.backenly_app_role());
    END IF;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role);
    IF pg_has_role(current_user, r.role, 'USAGE') AND (NOT v_pg16 OR pg_has_role(current_user, r.role, 'SET')) THEN
      CONTINUE;
    END IF;
    CONTINUE WHEN NOT pg_has_role(current_user, r.role, 'MEMBER WITH ADMIN OPTION');
    EXECUTE format(CASE WHEN v_pg16 THEN 'GRANT %I TO %I WITH INHERIT TRUE, SET TRUE'
                        ELSE 'GRANT %I TO %I' END, r.role, current_user);
    took := took || r.role;
  END LOOP;

  FOR r IN SELECT h.holder, h.item, h.fix FROM public.backenly_direct_shared_holds() h ORDER BY h.step, h.holder, h.item LOOP
    IF r.fix IS NULL THEN
      failed := failed || format('%s holds %s, which this cannot take: give it to the role that should own it', r.holder, r.item);
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE r.fix;
    EXCEPTION WHEN OTHERS THEN
      failed := failed || format('%s: %s', r.fix, SQLERRM);
    END;
  END LOOP;

  FOR r IN SELECT unnest(took) AS role LOOP
    EXECUTE format('REVOKE %I FROM %I', r.role, current_user);
  END LOOP;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'direct access: % thing(s) that let a login change the schema of this shared database could not be taken: %',
      array_length(failed, 1), array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'direct access: this database is shared; % read-write login(s) had a way to change the schema taken', stripped;
END $strip$;

-- ── 7b. The sessions those strips left ───────────────────────────────────────
--
-- Each strip above ended its login's sessions as it ran, and marked the login:
-- a session that logged in before that transaction committed saw the
-- membership still there, may have taken the owner role, and keeps it. This
-- statement is the next transaction, so it ends them. Under one transaction
-- (psql --single-transaction) it waits instead, and the application's next
-- sync of each login ends them.
DO $end$
DECLARE
  n integer := public.backenly_direct_end_stripped_sessions();
BEGIN
  IF n > 0 THEN
    RAISE NOTICE 'direct access: ended the sessions of % read-write login(s) stripped above', n;
  END IF;
END $end$;

-- ── 8. Converge every existing workspace ─────────────────────────────────────
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
