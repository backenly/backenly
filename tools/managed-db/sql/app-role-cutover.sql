-- ============================================================================
-- Layer 1: move the application off the rotating RDS master credential.
-- ============================================================================
--
-- On AWS, web and runtime connect as `backenly_admin`, the RDS MASTER user, and
-- RDS ROTATES that password on a schedule. Nothing propagates the rotation into
-- the hand-maintained `backenly-<env>/database-url` secret.
--
-- Measured 2026-09-20: staging's master rotated on 09-19, its database-url was
-- last changed on 09-12, and every staging web task since has failed to
-- authenticate and been killed by the ELB health check. Production's next
-- rotation is the same day this was written.
--
-- After this the master is an ADMIN credential only, and the application runs
-- as `backenly_app`: LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB
-- NOCREATEROLE, with a password RDS does not touch.
--
-- ── What this does NOT do, and why each exclusion was measured ──────────────
--
-- No `REASSIGN OWNED BY`. A sweep would take objects that must not move. The
-- staging inventory found four separate classes of them:
--
--   rdsadmin views and event triggers   AWS owns these. `backenly_admin` is
--                                       rolsuper=f and CANNOT alter them, so a
--                                       sweep does not merely overreach, it
--                                       fails partway through.
--
--   backenly_pgrst* functions           SECURITY DEFINER. Owned by the elevated
--   backenly_pgrst_schema_registry      role on purpose: a SECURITY DEFINER
--                                       function owned by the application role
--                                       runs with the application role's
--                                       privileges, silently removing the
--                                       elevation the data plane depends on.
--
--   workspace_* schemas and contents    Owned by PER-PROJECT `bkn_own_<hex>`
--                                       roles, by design (setup-direct-access
--                                       .sql). Moving them to one app-wide role
--                                       would break direct database access.
--
--   extension-owned objects             Follow their extension.
--
-- ── How the application still reaches the workspace schemas ────────────────
--
-- By MEMBERSHIP, not ownership. `queryWorkspaceAsOwner()` does not `SET ROLE`:
-- it takes an ordinary DATABASE_URL pool connection and establishes the
-- service-role RLS context transaction-locally. So the application role needs
-- the workspace privileges INHERITED, which is why `backenly_app` is INHERIT
-- and is granted membership in each `bkn_own_<hex>` role.
--
-- That is not a new mechanism. `backenly_direct_sync_schema()` already runs
-- `GRANT <owner> TO public.backenly_app_role()` (setup-direct-access.sql:239).
-- Once `backenly.app_role` points at `backenly_app`, every FUTURE project grants
-- the right membership on its own, through a SECURITY DEFINER function, without
-- the application ever needing CREATEROLE. This file only has to catch up the
-- projects that already exist.
--
-- ── Modes ──────────────────────────────────────────────────────────────────
--
-- `backenly.cutover_apply` is false for a measurement and true for the cutover.
-- A measurement must be able to report that an environment is still on the
-- master credential without failing: that is the finding, not an error.
--
-- The new password arrives in BACKENLY_APP_PASSWORD, lifted from a PENDING
-- version of the database-url secret inside the container. It is never written
-- into this file, never passed as a psql argument, and never placed in a task
-- definition's plaintext environment, because `describe-task-definition` shows
-- those to anyone who can read ECS.

\set ON_ERROR_STOP on

\if :{?apply}
\else
  \set apply false
\endif

SELECT current_user AS admin_role, current_database() AS database;

-- Carried through a runtime setting rather than a psql variable: psql does NOT
-- interpolate `:vars` inside a dollar-quoted block, so the obvious form is a
-- syntax error at run time and nowhere else.
SELECT set_config('backenly.cutover_apply', :'apply', false);

-- `\getenv` leaves the variable UNSET when the environment variable is absent,
-- which is what a measurement wants: no password is needed to count owners.
\getenv app_pw BACKENLY_APP_PASSWORD
\if :{?app_pw}
  SELECT set_config('backenly.app_password', :'app_pw', false);
\else
  \echo 'BACKENLY_APP_PASSWORD not present (measurement run)'
\endif

-- ── MEASUREMENT (always) ───────────────────────────────────────────────────

\echo '--- role state (every backenly role, not a fixed list) ---'
-- NOT an allowlist of names. A fixed list hid backenly_user on production, which
-- is the role that actually owns the application tables there, and reading the
-- output as "that role is absent" would have been completely wrong.
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit
  FROM pg_roles
 WHERE rolname LIKE 'backenly%' OR rolname = current_user
 ORDER BY rolname;

\echo '--- WHO IS ACTUALLY CONNECTED (what the running app authenticates as) ---'
-- The question the secret would answer, asked of the database instead, because
-- reading the secret would materialise a live credential.
SELECT usename AS connected_as, count(*) AS connections,
       count(*) FILTER (WHERE state = 'idle') AS idle,
       count(*) FILTER (WHERE state = 'active') AS active
  FROM pg_stat_activity
 WHERE datname = current_database() AND usename IS NOT NULL
 GROUP BY 1 ORDER BY 2 DESC;

\echo '--- backenly.app_role ---'
SELECT COALESCE(current_setting('backenly.app_role', true), '(unset)') AS app_role_in_session;
SELECT d.datname, s.setconfig AS database_level_settings
  FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
 WHERE d.datname = current_database();

\echo '--- THE ALLOWLIST: public relations this cutover would move ---'
SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view'
                      WHEN 'm' THEN 'matview' WHEN 'p' THEN 'partitioned' END AS kind,
       count(*) AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r','S','v','m','p')
   AND c.relowner = current_user::regrole
   AND c.relname <> 'backenly_pgrst_schema_registry'
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.objid = c.oid AND d.deptype IN ('e','i'))
 GROUP BY 1 ORDER BY 1;

\echo '--- ACTUAL owners of public relations (who holds what, by name) ---'
-- Reported by NAME, because "not owned by the current user" is not the same
-- claim as "owned by rdsadmin", and the difference decides whether this cutover
-- has anything to move at all.
SELECT c.relowner::regrole::text AS owner,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view'
                      WHEN 'm' THEN 'matview' WHEN 'p' THEN 'partitioned' END AS kind,
       count(*) AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','S','v','m','p')
 GROUP BY 1, 2 ORDER BY 3 DESC, 1;

\echo '--- ENUM TYPES: current owner -> desired owner ---'
-- Types were missing from the first version of this cutover, which moved
-- relations and functions and left every enum with the admin role. The first
-- migration to ALTER one (20260924120000_project_pause) then failed as
-- backenly_app with 42501. Discovered from the catalog, not named, so an enum
-- added later is covered. Extension-owned types follow their extension.
SELECT format('%I.%I', n.nspname, t.typname) AS enum_type,
       pg_get_userbyid(t.typowner) AS current_owner,
       'backenly_app' AS desired_owner,
       CASE WHEN pg_get_userbyid(t.typowner) = 'backenly_app' THEN 'already correct'
            WHEN t.typowner = current_user::regrole THEN 'will move'
            ELSE 'owned by another role; not moved' END AS action
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public' AND t.typtype = 'e'
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
 ORDER BY 1;

\echo '--- EXCLUDED from the move, and why ---'
SELECT 'owned by another role (not ' || current_user || ')' AS reason, count(*) AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','S','v','m','p')
   AND c.relowner <> current_user::regrole
UNION ALL
SELECT 'pgrst registry table', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'backenly_pgrst_schema_registry'
UNION ALL
SELECT 'extension- or identity-dependent', count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','S','v','m','p')
   AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('e','i'))
UNION ALL
SELECT 'workspace_* relations (per-project owners)', count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname LIKE 'workspace\_%' AND c.relkind IN ('r','S','v','m','p');

\echo '--- workspace owner roles that need membership granted ---'
-- pg_has_role() RAISES on a role that does not exist, and on a measurement run
-- backenly_app is exactly that. Guarded, so the measurement reports rather than
-- fails: "the role is missing" is the finding here, not an error.
SELECT n.nspname AS schema, n.nspowner::regrole::text AS owner_role,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_app')
            THEN pg_has_role('backenly_app', n.nspowner, 'USAGE')::text
            ELSE '(backenly_app does not exist yet)' END AS app_inherits_owner
  FROM pg_namespace n
 WHERE n.nspname LIKE 'workspace\_%'
 ORDER BY 1;

\echo '--- is the SECURITY DEFINER sync function present for FUTURE projects? ---'
SELECT p.proname, p.proowner::regrole::text AS owner, p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'backenly_direct%'
 ORDER BY 1;

\echo '--- PRESERVE-LIST (must be unchanged after the cutover) ---'
SELECT 'registry table' AS kind, c.relowner::regrole::text AS owner, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'backenly_pgrst_schema_registry'
UNION ALL
SELECT 'security definer fn', p.proowner::regrole::text, p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'backenly_pgrst%'
UNION ALL
SELECT 'event trigger', evtowner::regrole::text, evtname FROM pg_event_trigger
 ORDER BY 1, 3;

-- ── CUTOVER (only when backenly.cutover_apply is true) ──────────────────────

DO $$
DECLARE
  do_apply boolean := current_setting('backenly.cutover_apply')::boolean;
  app_pw   text    := current_setting('backenly.app_password', true);
  app_role text    := 'backenly_app';
  admin    text    := current_user;
  r        record;
  moved    int     := 0;
  granted  int     := 0;
BEGIN
  IF NOT do_apply THEN
    RAISE NOTICE 'measurement only: nothing was created, moved or granted';
    RETURN;
  END IF;

  IF app_pw IS NULL OR length(app_pw) < 24 THEN
    RAISE EXCEPTION 'backenly.app_password is absent or too short; refusing to set a weak credential';
  END IF;

  -- ── 1. The role ──────────────────────────────────────────────────────────
  -- INHERIT is load-bearing: queryWorkspaceAsOwner() does not SET ROLE, so the
  -- workspace privileges have to arrive through inherited membership.
  --
  -- The attributes are NOT spelled out here, and that is an RDS constraint
  -- rather than a preference. PostgreSQL requires the SUPERUSER attribute to
  -- change the SUPERUSER attribute IN EITHER DIRECTION, and the RDS master is
  -- rolsuper=f (it is an rds_superuser member, which is not the same thing). So
  -- naming NOSUPERUSER fails with 42501 even though it asks for the default:
  --
  --   ERROR: permission denied to alter role
  --   DETAIL: Only roles with the SUPERUSER attribute may change the SUPERUSER
  --           attribute.
  --
  -- A freshly created role is already NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and
  -- NOCREATEROLE. So the safe properties are taken from the creation defaults
  -- and ASSERTED at the end, rather than requested and refused.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN INHERIT', app_role);
    RAISE NOTICE 'created role % (defaults: NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE)', app_role;
  ELSE
    RAISE NOTICE 'role % exists; converging password and the attributes this role may set', app_role;
  END IF;

  -- Only what a CREATEROLE holder is permitted to set. backenly_admin has
  -- CREATEDB and CREATEROLE itself, so it may withhold both from another role.
  EXECUTE format('ALTER ROLE %I WITH LOGIN INHERIT NOCREATEDB NOCREATEROLE PASSWORD %L',
                 app_role, app_pw);

  -- ── 2. The GUC is the seam ───────────────────────────────────────────────
  --
  -- public.backenly_app_role() is
  --   coalesce(nullif(current_setting('backenly.app_role', true), ''), 'backenly_user')
  -- and backenly_direct_sync_schema() grants future owner roles to whatever it
  -- returns. Measured on AWS: the setting has NEVER been established, so the
  -- function has been returning 'backenly_user' — a role that does not exist in
  -- this cluster at all. Pointing it at the real role is the whole seam.
  --
  -- Database-level is preferred because EVERY connection inherits it, including
  -- the event triggers that fire in other roles' sessions. But a custom
  -- parameter is a placeholder until an extension defines it, and RDS refuses
  -- `ALTER DATABASE ... SET` of one from a non-superuser:
  --
  --   ERROR: permission denied to set parameter "backenly.app_role"
  --
  -- Role-level is the fallback. It is narrower — it applies to sessions that log
  -- in AS the app role, which is the application itself and therefore every
  -- caller of backenly_direct_sync_schema() — and it is strictly better than the
  -- status quo, where the setting is absent and the fallback names a
  -- non-existent role.
  -- Measured on RDS: BOTH are refused from the master credential. Neither is
  -- fatal, because the function below no longer depends on either succeeding.
  BEGIN
    EXECUTE format('ALTER DATABASE %I SET backenly.app_role = %L', current_database(), app_role);
    RAISE NOTICE 'backenly.app_role set at DATABASE level';
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      EXECUTE format('ALTER ROLE %I SET backenly.app_role = %L', app_role, app_role);
      RAISE NOTICE 'backenly.app_role set at ROLE level on %', app_role;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE
        'RDS refuses to set the custom parameter at either level; relying on resolution instead';
    END;
  END;

  -- ── 2b. Make the resolver correct WITHOUT the setting ────────────────────
  --
  -- The canonical definition is
  --   coalesce(nullif(current_setting('backenly.app_role', true), ''), 'backenly_user')
  -- and on AWS that constant names a role which does not exist, because the
  -- four-role split was never applied here — the app has always been the RDS
  -- master. So the fallback is replaced by one that RESOLVES to a role that
  -- actually exists, in the order the design intends:
  --
  --   the explicit setting, when an operator established one;
  --   else backenly_app, the application role, once it exists;
  --   else backenly_user, the installer, which is the historical answer;
  --   else current_user, so a fresh cluster mid-install still returns something
  --   real rather than a name nothing can be granted to.
  --
  -- CREATE OR REPLACE keeps the existing owner, so this stays an elevated
  -- object. The same change is made in the canonical SQL, so a reinstall agrees
  -- rather than silently reverting this.
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.backenly_app_role() RETURNS text
    LANGUAGE sql STABLE AS $body$
      SELECT coalesce(
        nullif(current_setting('backenly.app_role', true), ''),
        (SELECT rolname::text FROM pg_roles WHERE rolname = 'backenly_app'),
        (SELECT rolname::text FROM pg_roles WHERE rolname = 'backenly_user'),
        current_user::text
      )
    $body$;
  $fn$;
  RAISE NOTICE 'backenly_app_role() now resolves to %', (SELECT public.backenly_app_role());

  -- ── 3. Database and schema privileges ────────────────────────────────────
  -- CREATE on the database is what lets lib/projects/provision.ts create
  -- workspace_<projectId>.
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO %I', current_database(), app_role);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA public TO %I', app_role);

  -- ── 4. The allowlisted public relations, and nothing else ────────────────
  -- Restricted to relations THIS role owns, so rdsadmin's objects are never
  -- touched; the registry is named out; extension- and identity-dependent
  -- objects follow their parent.
  FOR r IN
    SELECT c.oid::regclass::text AS ident, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','S','v','m','p')
       AND c.relowner = admin::regrole
       AND c.relname <> 'backenly_pgrst_schema_registry'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.objid = c.oid AND d.deptype IN ('e','i'))
  LOOP
    IF    r.relkind = 'S' THEN EXECUTE format('ALTER SEQUENCE %s OWNER TO %I', r.ident, app_role);
    ELSIF r.relkind = 'v' THEN EXECUTE format('ALTER VIEW %s OWNER TO %I', r.ident, app_role);
    ELSIF r.relkind = 'm' THEN EXECUTE format('ALTER MATERIALIZED VIEW %s OWNER TO %I', r.ident, app_role);
    ELSE  EXECUTE format('ALTER TABLE %s OWNER TO %I', r.ident, app_role);
    END IF;
    moved := moved + 1;
  END LOOP;
  RAISE NOTICE 'public: moved % allowlisted relation(s) to %', moved, app_role;

  -- Application functions in public, excluding the privileged support prefix
  -- and anything belonging to an extension.
  moved := 0;
  FOR r IN
    SELECT p.oid::regprocedure::text AS ident
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proowner = admin::regrole
       AND p.proname NOT LIKE 'backenly_pgrst%'
       AND p.proname NOT LIKE 'backenly_direct%'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.ident, app_role);
    moved := moved + 1;
  END LOOP;
  RAISE NOTICE 'public: moved % application function(s) to %', moved, app_role;

  -- ── 4a. The enum types the migrations alter ──────────────────────────────
  -- Migrations ALTER enums (`ADD VALUE`), and PostgreSQL ties that to
  -- ownership exactly as it does for tables. The first version of this file
  -- left them behind, which is why tools/managed-db/sql/enum-ownership-repair.sql
  -- exists for the databases it already ran on. Idempotent: only enums still
  -- owned by the admin role are moved.
  moved := 0;
  FOR r IN
    SELECT format('%I.%I', n.nspname, t.typname) AS ident
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'e'
       AND t.typowner = admin::regrole
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO %I', r.ident, app_role);
    moved := moved + 1;
  END LOOP;
  RAISE NOTICE 'public: moved % enum type(s) to %', moved, app_role;

  -- ── 4b. EXECUTE on the privileged helpers ────────────────────────────────
  -- These stay owned by the elevated role — that is what makes them SECURITY
  -- DEFINER — but the application is the thing that CALLS them. Today it can
  -- because it *is* backenly_admin. After the cutover it is not, so the right
  -- to call has to be granted explicitly or direct-access provisioning and the
  -- PostgREST schema registry both start failing with 42501.
  moved := 0;
  FOR r IN
    SELECT p.oid::regprocedure::text AS ident
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'backenly_pgrst%' OR p.proname LIKE 'backenly_direct%')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', r.ident, app_role);
    moved := moved + 1;
  END LOOP;
  RAISE NOTICE 'granted EXECUTE on % privileged helper(s) to %', moved, app_role;

  -- ── 5. Catch up the projects that already exist ──────────────────────────
  -- The membership half of what backenly_direct_sync_schema() does for new
  -- ones. Ownership of the schema and its tables is deliberately left with the
  -- per-project role.
  FOR r IN
    SELECT DISTINCT n.nspowner::regrole::text AS owner_role
      FROM pg_namespace n
     WHERE n.nspname LIKE 'workspace\_%'
       AND n.nspowner::regrole::text LIKE 'bkn\_own\_%'
  LOOP
    EXECUTE format('GRANT %I TO %I', r.owner_role, app_role);
    granted := granted + 1;
  END LOOP;
  RAISE NOTICE 'granted % existing workspace owner role(s) to %', granted, app_role;

  -- ── 6. Default privileges ────────────────────────────────────────────────
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    app_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    app_role);

  -- ── 7. Prove it, in the transaction that did it ──────────────────────────
  SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit
    INTO r FROM pg_roles WHERE rolname = app_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% does not exist after the cutover', app_role;
  END IF;
  -- Asserted, not set. This connection cannot change SUPERUSER or BYPASSRLS in
  -- either direction, so if either is true the role was widened by something
  -- with more privilege than this has, and the whole cutover is refused rather
  -- than completed against a role that bypasses RLS.
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole THEN
    RAISE EXCEPTION
      '% is broader than intended: super=% bypassrls=% createdb=% createrole=%. '
      'SUPERUSER and BYPASSRLS cannot be corrected from this connection (the RDS '
      'master is rolsuper=f), so this needs a superuser before the cutover can proceed.',
      app_role, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole;
  END IF;
  IF NOT r.rolcanlogin THEN
    RAISE EXCEPTION '% cannot log in, so the application could not use it', app_role;
  END IF;
  IF NOT r.rolinherit THEN
    RAISE EXCEPTION '% is NOINHERIT, so workspace membership would not apply without SET ROLE', app_role;
  END IF;

  -- The support objects must NOT have moved.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'backenly_pgrst%'
       AND p.proowner = app_role::regrole
  ) THEN
    RAISE EXCEPTION 'a backenly_pgrst%% function is now owned by %, which removes its elevation', app_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'backenly_pgrst_schema_registry'
       AND c.relowner = app_role::regrole
  ) THEN
    RAISE EXCEPTION 'the PostgREST registry is now owned by %, which it must not be', app_role;
  END IF;

  -- No enum the migrations may alter is left with the admin role.
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'e'
       AND t.typowner = admin::regrole
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  ) THEN
    RAISE EXCEPTION 'an enum type in public is still owned by %, so a migration that alters it would fail', admin;
  END IF;

  -- Every existing workspace owner role must now be inherited by the app role.
  FOR r IN
    SELECT n.nspname, n.nspowner::regrole::text AS owner_role
      FROM pg_namespace n
     WHERE n.nspname LIKE 'workspace\_%'
       AND n.nspowner::regrole::text LIKE 'bkn\_own\_%'
  LOOP
    IF NOT pg_has_role(app_role, r.owner_role, 'USAGE') THEN
      RAISE EXCEPTION '% does not inherit %, so workspace % would be unreachable',
        app_role, r.owner_role, r.nspname;
    END IF;
  END LOOP;

  RAISE NOTICE 'cutover complete: % is LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE', app_role;
END $$;
