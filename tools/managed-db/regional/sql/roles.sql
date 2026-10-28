-- ============================================================================
-- The regional role graph: create or converge, never widen, never drop.
-- ============================================================================
-- Run by tools/managed-db/regional/bootstrap.sh as the database administrator
-- (the RDS master on AWS, which is NOT a true superuser).
--
--   backenly_app            the application. LOGIN INHERIT, and NOSUPERUSER
--                           NOBYPASSRLS NOCREATEDB NOCREATEROLE: RLS applies to
--                           it. CONNECT, TEMPORARY and CREATE on the database,
--                           because it creates the workspace schemas. Workspace
--                           objects belong to per-project bkn_own_* roles
--                           (setup-direct-access.sql) and the app reaches them
--                           by inherited membership.
--   backenly_backup         pg_dump only. LOGIN NOINHERIT BYPASSRLS, and nothing
--                           else; its SELECT grants are made per workspace
--                           schema by backenly_direct_sync_schema.
--   backenly_authenticator  PostgREST's login. NOINHERIT, so it holds no
--                           privilege of its own, only the ability to become
--                           anon / authenticated / service_role (all NOLOGIN).
--   backenly_external       NOLOGIN group every direct-access login joins.
--
-- The administrator running this ends up holding the privileges of
-- backenly_app (INHERIT, not SET), and roles created in the app's sessions are
-- granted back to it: the definer functions it installs next run as it, on what
-- the app owns. On a true superuser both are no-ops; on the RDS master they are
-- what lets the app create a workspace at all (see the backenly_app section).
--
-- Written the way tools/managed-db/sql/app-role-cutover.sql was proven on RDS:
-- CREATE ROLE takes SUPERUSER, BYPASSRLS, CREATEDB and CREATEROLE from their
-- safe defaults instead of naming them (PostgreSQL refuses a non-superuser that
-- so much as mentions SUPERUSER). An existing role is only ever NARROWED: the
-- ALTER ROLE statements below remove attributes and never add them, so a role
-- an operator has deliberately restricted (NOLOGIN during an incident, say) is
-- not quietly re-enabled by a re-run. verify.sql asserts the full declared
-- state, so a role that has drifted either way fails the run instead.
--
-- ── Credentials ──────────────────────────────────────────────────────────────
-- Passwords arrive as SCRAM-SHA-256 VERIFIERS in the environment
-- (tools/managed-db/regional/scram.ts), read with \getenv so they are never psql
-- arguments. A role's password is set in exactly two cases:
--
--   the run that creates the role       its verifier is required
--   BOOTSTRAP_ROTATE names the role     a deliberate replacement
--
-- and each is recorded in backenly_meta.bootstrap_credentials. A verifier
-- supplied for a role that already exists, without BOOTSTRAP_ROTATE, is REFUSED
-- rather than ignored: whoever supplied it is about to store the matching
-- password as the connection secret, and a database that silently kept the old
-- one would leave that secret wrong. Re-running with no verifiers never touches
-- a password, which is what keeps a re-run from rotating a live credential
-- (__tests__/bootstrap/postgrest-roles-idempotency.test.ts has the incident).
--
-- Every decision is made before anything changes, and the block is one
-- transaction, so a refusal leaves the database exactly as it was.

\getenv app_verifier BACKENLY_APP_VERIFIER
\getenv backup_verifier BACKENLY_BACKUP_VERIFIER
\getenv authenticator_verifier BACKENLY_AUTHENTICATOR_VERIFIER
\getenv rotate BOOTSTRAP_ROTATE
-- \getenv leaves a variable unset when the environment has none.
\if :{?app_verifier}
\else
  \set app_verifier ''
\endif
\if :{?backup_verifier}
\else
  \set backup_verifier ''
\endif
\if :{?authenticator_verifier}
\else
  \set authenticator_verifier ''
\endif
\if :{?rotate}
\else
  \set rotate ''
\endif

-- Carried as session settings: psql does not interpolate :vars inside a
-- dollar-quoted block (the cutover file's note). \gset swallows the echo.
SELECT set_config('backenly.app_verifier', :'app_verifier', false) AS a,
       set_config('backenly.backup_verifier', :'backup_verifier', false) AS b,
       set_config('backenly.authenticator_verifier', :'authenticator_verifier', false) AS c,
       set_config('backenly.rotate', :'rotate', false) AS d
\gset _

DO $$
DECLARE
  verifier_shape constant text := '^SCRAM-SHA-256\$([0-9]+):[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$';
  managed constant text[] := ARRAY['backenly_app', 'backenly_backup', 'backenly_authenticator'];
  rotate text[] := array_remove(string_to_array(regexp_replace(current_setting('backenly.rotate'), '\s+', '', 'g'), ','), '');
  to_set text[] := '{}';
  rname text;
  r record;
BEGIN
  FOREACH rname IN ARRAY rotate LOOP
    IF NOT rname = ANY (managed) THEN
      RAISE EXCEPTION 'refusing: BOOTSTRAP_ROTATE names "%", which is not a role this procedure manages (%)',
        rname, array_to_string(managed, ', ');
    END IF;
  END LOOP;

  -- ── Decide ────────────────────────────────────────────────────────────────
  FOR r IN
    SELECT v.role_name, v.verifier, c.set_at,
           EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v.role_name) AS present
      FROM (VALUES
        ('backenly_app',           current_setting('backenly.app_verifier')),
        ('backenly_backup',        current_setting('backenly.backup_verifier')),
        ('backenly_authenticator', current_setting('backenly.authenticator_verifier'))
      ) AS v(role_name, verifier)
      LEFT JOIN backenly_meta.bootstrap_credentials c ON c.role_name = v.role_name
  LOOP
    -- A plaintext password in one of these variables is refused, not stored.
    IF r.verifier <> '' AND r.verifier !~ verifier_shape THEN
      RAISE EXCEPTION 'refusing: the value supplied for % is not a SCRAM-SHA-256 verifier', r.role_name;
    END IF;
    IF r.verifier <> '' AND (regexp_match(r.verifier, verifier_shape))[1]::int < 4096 THEN
      RAISE EXCEPTION 'refusing: the verifier for % uses fewer than 4096 iterations', r.role_name;
    END IF;

    IF r.role_name = ANY (rotate) THEN
      IF r.verifier = '' THEN
        RAISE EXCEPTION 'refusing: BOOTSTRAP_ROTATE names % but no verifier was supplied for it', r.role_name;
      END IF;
      to_set := to_set || r.role_name;
    ELSIF NOT r.present THEN
      IF r.verifier = '' THEN
        RAISE EXCEPTION 'refusing: % does not exist yet, and the run that creates it must supply its verifier', r.role_name;
      END IF;
      to_set := to_set || r.role_name;
    ELSIF r.verifier <> '' AND r.set_at IS NOT NULL THEN
      RAISE EXCEPTION 'refusing: % already has the password this procedure set at %. Supplying another would replace a live credential: leave its verifier out, or name it in BOOTSTRAP_ROTATE to replace it deliberately',
        r.role_name, r.set_at;
    ELSIF r.verifier <> '' THEN
      RAISE EXCEPTION 'refusing: % exists, and this procedure has no record of setting its password. If nothing authenticates as it yet, name it in BOOTSTRAP_ROTATE',
        r.role_name;
    END IF;
  END LOOP;

  -- ── backenly_app ──────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_app') THEN
    CREATE ROLE backenly_app LOGIN INHERIT;
    RAISE NOTICE 'created role backenly_app';
  END IF;
  ALTER ROLE backenly_app WITH NOCREATEDB NOCREATEROLE;
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO backenly_app', current_database());

  -- The installer must hold the application role's PRIVILEGES, not only ADMIN
  -- over it. The definer functions the next steps install (registry, DDL sync,
  -- direct access) run as their owner, the installer, on schemas the app owns:
  -- they find those schemas through information_schema, grant on them and set
  -- default privileges FOR the app. PostgreSQL 16 gives a CREATEROLE role that
  -- is not a superuser only ADMIN on a role it creates, with neither INHERIT nor
  -- SET; that counts as membership and confers none of it. Measured on a stock
  -- PostgreSQL 16 with the functions owned by such an administrator: CREATE
  -- SCHEMA workspace_<uuid> as the app failed with "Refusing to register schema
  -- ...: it does not exist". INHERIT and not SET: the installer acts on what the
  -- app owns and never needs to become it.
  IF NOT pg_has_role(current_user, 'backenly_app', 'USAGE') THEN
    EXECUTE format('GRANT backenly_app TO %I WITH INHERIT TRUE, SET FALSE', current_user);
    RAISE NOTICE 'granted the privileges of backenly_app to %', current_user;
  END IF;

  -- The roles those functions create on the app's behalf must come back to
  -- their creator with SET and INHERIT. backenly_direct_sync_schema hands a
  -- schema to a bkn_own_* role it has just created, and PostgreSQL 16 lets a
  -- non-superuser change an owner only to a role it can SET ROLE to (measured:
  -- "must be able to SET ROLE bkn_own_..."). createrole_self_grant does exactly
  -- that for roles created in the app's sessions, which is where those definer
  -- functions run. The app itself is NOCREATEROLE, so nothing else changes.
  EXECUTE format('ALTER ROLE backenly_app IN DATABASE %I SET createrole_self_grant = %L',
                 current_database(), 'set, inherit');

  -- Point public.backenly_app_role() at it: at database level where the server
  -- allows a custom parameter there, else at role level, else by resolution
  -- (backenly_app_role() finds backenly_app by name). RDS refuses both settings
  -- from the master, measured during the cutover; resolution is what serves there.
  BEGIN
    EXECUTE format('ALTER DATABASE %I SET backenly.app_role = %L', current_database(), 'backenly_app');
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      ALTER ROLE backenly_app SET backenly.app_role = 'backenly_app';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'backenly.app_role could not be set; backenly_app_role() resolves backenly_app by name';
    END;
  END;

  -- ── backenly_backup ───────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_backup') THEN
    CREATE ROLE backenly_backup LOGIN NOINHERIT BYPASSRLS;
    RAISE NOTICE 'created role backenly_backup';
  END IF;
  ALTER ROLE backenly_backup WITH NOINHERIT NOCREATEDB NOCREATEROLE;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO backenly_backup', current_database());

  -- ── PostgREST, and the direct-access group ────────────────────────────────
  -- postgrest-schema-registry.sql and setup-direct-access.sql create the same
  -- roles the same way. Created here first, by the administrator, so it holds
  -- ADMIN on each (backenly_direct_create_role puts every login it makes IN ROLE
  -- backenly_external) and the authenticator's password is set in the run that
  -- creates it.
  FOREACH rname IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'backenly_external'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', rname);
      RAISE NOTICE 'created role %', rname;
    END IF;
    EXECUTE format('ALTER ROLE %I WITH NOLOGIN NOCREATEDB NOCREATEROLE', rname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_authenticator') THEN
    CREATE ROLE backenly_authenticator LOGIN NOINHERIT;
    RAISE NOTICE 'created role backenly_authenticator';
  END IF;
  -- NOINHERIT is what keeps the authenticator powerless; asserted every run.
  ALTER ROLE backenly_authenticator WITH NOINHERIT NOCREATEDB NOCREATEROLE;
  FOREACH rname IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m
                    WHERE m.roleid = rname::regrole AND m.member = 'backenly_authenticator'::regrole) THEN
      EXECUTE format('GRANT %I TO backenly_authenticator', rname);
    END IF;
  END LOOP;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO backenly_authenticator', current_database());

  -- ── Passwords, only where decided above ───────────────────────────────────
  FOREACH rname IN ARRAY to_set LOOP
    EXECUTE format('ALTER ROLE %I PASSWORD %L', rname, current_setting(CASE rname
      WHEN 'backenly_app' THEN 'backenly.app_verifier'
      WHEN 'backenly_backup' THEN 'backenly.backup_verifier'
      ELSE 'backenly.authenticator_verifier' END));
    INSERT INTO backenly_meta.bootstrap_credentials AS c (role_name, set_at, set_by)
    VALUES (rname, now(), current_user)
    ON CONFLICT (role_name) DO UPDATE
      SET set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by, rotations = c.rotations + 1;
    RAISE NOTICE 'credential set for %', rname;
  END LOOP;
END $$;

-- The verifiers are not needed any further in this session.
SELECT set_config('backenly.app_verifier', '', false) AS a,
       set_config('backenly.backup_verifier', '', false) AS b,
       set_config('backenly.authenticator_verifier', '', false) AS c,
       set_config('backenly.rotate', '', false) AS d
\gset _
