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
-- password is derived by the app from its own secret and never stored.
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

DO $$
DECLARE r text := public.backenly_app_role();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_fn_role_sync(text, text) TO %I', r);
  END IF;
END $$;
