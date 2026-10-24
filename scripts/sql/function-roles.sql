-- ============================================================================
-- Per-project database login for function code
-- ============================================================================
--
-- A route-module function reaches the database through a client that sets the
-- caller's claims first (lib/services/ai-functions/rls-aware-db.ts). It used to
-- issue its SQL on the app's own connection, and the app role owns every
-- platform table and every workspace schema. Row security filters rows by
-- claims; it does not stop a statement that names another schema. So function
-- code could read public.users, public.api_keys, public.projects or another
-- project's workspace schema, and the generator writes that code from the
-- requester's own description of what it should do.
--
-- Each workspace schema now gets its own LOGIN role, and function SQL runs on
-- a connection that logs in AS that role:
--
--   bkn_fn_<first 12 hex of sha256(schema name)>
--
-- It holds DML on that schema's tables and sequences and nothing else, and it
-- is a member of no other role. That last part is the boundary. Switching role
-- on the app's connection (SET LOCAL ROLE) would not be one: function code runs
-- arbitrary SQL, and `RESET ROLE` returns a session to its login role. A
-- session whose login role IS the project role has nowhere to return to, and
-- PostgreSQL grants refuse anything outside the schema.
--
-- Row security is unchanged: workspace policies carry no TO clause, so they
-- apply to this role exactly as they applied to the app role.
--
-- The app role cannot CREATE ROLE, so creation and grants go through the
-- SECURITY DEFINER helper below. It takes the schema and derives the role name
-- itself, so no caller can point one project's login at another's schema. The
-- password is derived by the app from its own secret and never stored. Nor can
-- the app DROP ROLE, so the login is dropped with its project through a second
-- helper, backenly_fn_role_drop.
--
-- Installed by scripts/postgrest-install.sh, after postgrest-ddl-sync.sql,
-- which defines public.backenly_app_role(). Idempotent. Creates no event
-- triggers, so its position in the install cannot brick a database.
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.backenly_app_role()') IS NULL THEN
    RAISE EXCEPTION 'function-roles.sql needs public.backenly_app_role(). Install through scripts/postgrest-install.sh, which applies the files in order.';
  END IF;
END $$;

-- The name only. Kept in SQL so the helper never trusts a name it is handed;
-- lib/services/ai-functions/function-db-role.ts derives the same string.
CREATE OR REPLACE FUNCTION public.backenly_fn_role_name(p_schema text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT 'bkn_fn_' || left(encode(sha256(convert_to(p_schema, 'UTF8')), 'hex'), 12)
$fn$;

CREATE OR REPLACE FUNCTION public.backenly_fn_role_sync(p_schema text, p_password text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  app     text := public.backenly_app_role();
  fn_role text;
BEGIN
  IF p_schema IS NULL OR p_schema !~ '^workspace_[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'not a workspace schema: %', p_schema USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = p_schema) THEN
    RAISE EXCEPTION 'workspace schema % does not exist', p_schema USING ERRCODE = '3F000';
  END IF;
  IF p_password IS NULL OR length(p_password) < 32 THEN
    RAISE EXCEPTION 'function role password must be at least 32 characters' USING ERRCODE = '22023';
  END IF;

  fn_role := public.backenly_fn_role_name(p_schema);

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = fn_role) THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 10',
      fn_role);
  END IF;
  -- Re-asserted every time, so a password derived from a rotated secret takes
  -- effect. SUPERUSER, REPLICATION and BYPASSRLS are left out on purpose:
  -- naming them in ALTER ROLE, even as NO..., needs a true superuser, which a
  -- managed database never grants, and only a superuser could have set them.
  EXECUTE format(
    'ALTER ROLE %I LOGIN NOINHERIT CONNECTION LIMIT 10 PASSWORD %L',
    fn_role, p_password);
  EXECUTE format('ALTER ROLE %I SET search_path = %I, public', fn_role, p_schema);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', fn_role, '15s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', fn_role, '30s');

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', p_schema, fn_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', p_schema, fn_role);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', p_schema, fn_role);

  -- Tables the app role creates later are covered without another sync.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      app, p_schema, fn_role);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
      app, p_schema, fn_role);
  END IF;

  RETURN fn_role;
END;
$fn$;

REVOKE ALL ON FUNCTION public.backenly_fn_role_sync(text, text) FROM PUBLIC;

-- Drop the login when its project is deleted (lib/projects/delete.ts). The app
-- role cannot: it is NOCREATEROLE and holds none of the login's privileges, so
-- the DROP OWNED and DROP ROLE a deletion used to run as the app failed with
-- 42501 on a managed database for every project whose functions had used the
-- database. This definer, which created the login, takes its privileges first
-- (DROP OWNED and terminating its sessions need them) for the reasons given at
-- public.backenly_direct_drop_role in scripts/setup-direct-access.sql, and the
-- grant goes with the role. The schema need not exist any more: a deletion
-- drops it first, so the name is checked against the shape the sync gives it.
--
-- DROP OWNED reaches only the current database. When anything outside it still
-- names the login (another database's grant, or a database-level privilege or
-- object this definer cannot clear), DROP ROLE fails with 2BP01 and the
-- deletion with it, so the login is retired instead, NOLOGIN with no password,
-- and the result is false. public.backenly_direct_drop_role explains why
-- nothing outside is touched and why the caller calls again after its commit.
-- True means the login is gone.
CREATE OR REPLACE FUNCTION public.backenly_fn_role_drop(p_role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  granted boolean := false;
BEGIN
  IF p_role IS NULL OR p_role !~ '^bkn_fn_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'not a function role: %', p_role USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RETURN true; -- already gone
  END IF;

  IF NOT pg_has_role(current_user, p_role, 'USAGE') THEN
    EXECUTE format(CASE WHEN current_setting('server_version_num')::int >= 160000
                        THEN 'GRANT %I TO %I WITH INHERIT TRUE, SET FALSE'
                        ELSE 'GRANT %I TO %I' END, p_role, current_user);
    granted := true;
  END IF;
  PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = p_role;
  EXECUTE format('DROP OWNED BY %I', p_role);

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
END;
$fn$;

REVOKE ALL ON FUNCTION public.backenly_fn_role_drop(text) FROM PUBLIC;

DO $$
DECLARE r text := public.backenly_app_role();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_fn_role_sync(text, text) TO %I', r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_fn_role_drop(text) TO %I', r);
  END IF;
END $$;
