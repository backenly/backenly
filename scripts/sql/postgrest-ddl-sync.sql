-- PHASE 3 — keep PostgREST in step with a schema that changes constantly.
--
-- Backenly's whole premise is that an agent creates tables at runtime. PostgREST
-- caches the schema at startup and does NOT re-read it on its own, so a table
-- created a second ago does not exist as far as PostgREST is concerned:
--
--   404  {"code":"PGRST205","message":"Could not find the table
--         '<schema>.<table>' in the schema cache"}
--
-- That is the exact symptom this whole program started from — "not even a single
-- api generated". Under the legacy executor a new table worked immediately
-- because every request read the live catalog. Moving to PostgREST reintroduces
-- the failure unless the cache is refreshed on every DDL change.
--
-- A new table also has NO grants, so even after a reload PostgREST answers 403.
-- ALTER DEFAULT PRIVILEGES is not sufficient on its own: it applies per
-- CREATING ROLE, so a table created by a role nobody configured defaults to
-- unreachable. Grants are therefore issued explicitly, per table, as it appears.
--
-- Doing this from application code would mean finding every path that emits DDL
-- — the AI executor, MCP, migrations, branch clones, the table-lifecycle kernel,
-- and whatever is added next. One of them would be missed, and the failure is a
-- table that silently 404s. An event trigger fires for all of them, including
-- paths that do not exist yet.
--
-- Run as superuser:
--   psql -d backenly -f postgrest-ddl-sync.sql

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

-- ── Prepare a schema for PostgREST ──────────────────────────────────────────
-- Grants + default privileges + internal-table revocation, idempotent. Called at
-- cutover; safe to re-run at any time.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_prepare_schema(target_schema text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF target_schema !~ '^workspace_[a-zA-Z0-9_-]{1,63}$' THEN
    RAISE EXCEPTION 'Refusing to prepare %: not a workspace schema', target_schema;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role', target_schema);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO authenticated, service_role',
    target_schema);
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO anon', target_schema);
  EXECUTE format(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated, service_role',
    target_schema);

  -- Default privileges for the roles that actually emit DDL here. Recorded for
  -- both because tables arrive from the app connection and from migrations run
  -- as the owner, and a default set for only one of them leaves the other's
  -- tables unreachable.
  EXECUTE (
    format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role',
      public.backenly_app_role(), target_schema));
  EXECUTE (
    format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
       GRANT SELECT ON TABLES TO anon', public.backenly_app_role(), target_schema));

  -- Runs LAST: the blanket grants above would otherwise have just handed out
  -- SELECT on the credential tables they are meant to exclude.
  PERFORM public.backenly_pgrst_revoke_internal(target_schema);
END;
$fn$;

-- ── React to DDL ────────────────────────────────────────────────────────────
-- Fires after any successful DDL. Only acts on schemas PostgREST is actually
-- serving, so projects still on the legacy executor cost nothing.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_on_ddl()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  obj        record;
  registered text[];
  touched    boolean := false;
  sch        text;
BEGIN
  registered := string_to_array(public.backenly_pgrst_current_schemas(), ',');
  IF registered IS NULL OR array_length(registered, 1) IS NULL THEN
    RETURN;
  END IF;

  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    CONTINUE WHEN obj.schema_name IS NULL;
    CONTINUE WHEN NOT (obj.schema_name = ANY (registered));

    sch := obj.schema_name;
    touched := true;

    -- A newly created table has no grants; without this it is visible in the
    -- cache but answers 403, which reads like a permissions bug rather than a
    -- provisioning gap.
    IF obj.command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO authenticated, service_role',
        sch);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO anon', sch);
      EXECUTE format(
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated, service_role', sch);
      -- Re-assert the exclusion: the blanket grant above covers `users` too if
      -- the project just created it.
      PERFORM public.backenly_pgrst_revoke_internal(sch);
    END IF;

    -- Soft-delete parity has to be re-applied on ALTER as well as CREATE: a
    -- table that gains `deleted_at` later would otherwise serve deleted rows
    -- until someone re-registered the schema by hand. Cheap and idempotent —
    -- the function only touches tables that lack the policy.
    IF obj.command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE') THEN
      PERFORM public.backenly_pgrst_apply_soft_delete(sch);
      -- A table that gains an owner column later must get its default too, or
      -- inserts against it start 403ing for no visible reason.
      PERFORM public.backenly_pgrst_apply_owner_defaults(sch);
    END IF;
  END LOOP;

  -- One notification per DDL statement, not per object: a migration creating
  -- twenty tables should trigger one cache rebuild, not twenty.
  IF touched THEN
    NOTIFY pgrst, 'reload schema';
  END IF;
END;
$fn$;

DROP EVENT TRIGGER IF EXISTS backenly_pgrst_ddl_sync;
CREATE EVENT TRIGGER backenly_pgrst_ddl_sync
  ON ddl_command_end
  EXECUTE FUNCTION public.backenly_pgrst_on_ddl();

REVOKE ALL ON FUNCTION public.backenly_pgrst_prepare_schema(text) FROM PUBLIC;

DO $grant$
DECLARE r text := public.backenly_app_role();
BEGIN
  -- Skipped rather than failed when the role is absent: the functions are still
  -- installed and a later run grants them, which is what makes this re-runnable.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.backenly_pgrst_prepare_schema(text) TO %I', r);
  END IF;
END $grant$;
