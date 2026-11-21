-- ============================================================================
-- The connection pooler's login lookup, in database backenly_pooler.
-- ============================================================================
-- Customers connect psql, ORMs and any other PostgreSQL client to their
-- project's own database (p_<32 hex>) through the connection pooler,
-- services/pooler (PgBouncer). PgBouncer checks each login's SCRAM-SHA-256
-- proof against a verifier it reads here through auth_query, then signs in to
-- the database with the keys that proof carried. That second step works only
-- because the verifier here is byte for byte the one the role has on the
-- server: Backenly computes it (lib/data-plane/scram.ts), sets it with
-- ALTER ROLE <login> PASSWORD '<verifier>', and writes the same string to
-- backenly_pooler.logins. RDS never shows a stored verifier, so the pooler
-- cannot read pg_authid the way PgBouncer's own example does.
--
--   backenly_pooler.logins        one row per customer login: its verifier,
--                                 the database it belongs to, and whether the
--                                 pooler serves it. backenly_app writes it, and
--                                 sets updated_at = now() when it changes a row.
--   backenly_pooler.databases()   the project databases the pooler lists: every
--                                 existing p_<32 hex> database with an active
--                                 login. The pooler reads it at start and every
--                                 few seconds after, and serves no other
--                                 database name: a client asking for the
--                                 region's shared database, postgres or
--                                 template1 is refused inside the pooler,
--                                 which never signs in to the server as that
--                                 login for it (and this database is refused
--                                 to every client).
--   backenly_pooler.lookup(login, database)
--                                 what each listed database's auth_query
--                                 calls, as backenly_pooler_auth, with that
--                                 database's own name written into the query:
--                                   SELECT usename, passwd FROM backenly_pooler.lookup($1, 'p_...')
--                                 It returns the login and its verifier only
--                                 for an active row of THAT database whose role
--                                 can log in now, so a login is not even
--                                 checked for another project's database (the
--                                 server refuses that too: CONNECT is granted
--                                 by name). Roles that are not customer logins
--                                 (backenly_app, the administrator,
--                                 PostgREST's roles) can never have a row, so
--                                 the pooler never serves them. Both arguments
--                                 are text, not name: a name argument would cut
--                                 a longer value to 63 bytes before comparing.
--
-- Turning a login off: active = false stops new logins through the pooler at
-- once. A client already signed in keeps its keys, and in transaction mode
-- the pooler reuses them to open new server connections, so the role itself
-- must also change on the server (ALTER ROLE ... NOLOGIN, or a new verifier
-- written to both places) and its sessions be ended (pg_terminate_backend).
--
-- ── What the regional procedure does around this file ──────────────────────
-- This file does not do the following; tools/managed-db/regional/bootstrap.sh,
-- sql/roles.sql, sql/verify.sql, launch.ts and image-files.txt are to be
-- extended to do them, in this order:
--
--   1. roles.sql has created backenly_app (it does today).
--
--   2. The role backenly_pooler_auth, the way roles.sql manages its logins: a
--      SCRAM-SHA-256 verifier from a new variable, BACKENLY_POOLER_AUTH_VERIFIER,
--      which launch.ts computes; the password set only when the role is
--      created or named in BOOTSTRAP_ROTATE, and recorded in
--      backenly_meta.bootstrap_credentials:
--        CREATE ROLE backenly_pooler_auth LOGIN NOINHERIT;
--        ALTER ROLE backenly_pooler_auth PASSWORD '<verifier>';
--      Every other attribute stays at its default (NOSUPERUSER NOCREATEDB
--      NOCREATEROLE NOREPLICATION NOBYPASSRLS), and the role is granted no
--      role; this file refuses one that has either. Its password goes to the
--      pooler as POOLER_AUTH_PASSWORD (services/pooler/README.md): printable
--      ASCII without spaces, double quotes or backslashes, at least 16
--      characters. launch.ts's generatePassword() (64 hex characters) fits.
--
--   3. The database, from the shell, connected to the regional database as
--      the administrator. CREATE DATABASE cannot run inside a transaction or a
--      DO block, so it is two statements:
--        SELECT 1 FROM pg_database WHERE datname = 'backenly_pooler';
--        CREATE DATABASE backenly_pooler;      -- only when the first returned nothing
--      Created by the administrator, so the administrator owns it; this file
--      checks that.
--
--   4. This file, connected to backenly_pooler as the administrator:
--        psql -X -v ON_ERROR_STOP=1 -d <the regional URL, database backenly_pooler> \
--             -f tools/managed-db/regional/sql/pooler.sql
--      recorded as a step of its own in backenly_meta.bootstrap_steps (which
--      lives in the regional database) with this file's checksum. It is safe
--      to re-run, it converges privileges to exactly what is declared here,
--      and it ends by checking that state, so a failed check rolls back the
--      whole run.
--
--   5. verify.sql (or a check of its own against backenly_pooler) asserts the
--      same end state; the checks at the end of this file are the list.
--
-- Runs as the RDS master, which is NOT a superuser: nothing here needs one.
-- tests/integration/pooler-auth.spec.ts runs it as such an administrator on a
-- fresh PostgreSQL 16 and exercises every grant.

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  auth pg_roles%ROWTYPE;
BEGIN
  IF current_database() <> 'backenly_pooler' THEN
    RAISE EXCEPTION 'refusing: pooler.sql belongs in database backenly_pooler, not %', current_database();
  END IF;

  -- REVOKE by a role without the owner's rights only warns, and changes nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_database d
                  WHERE d.datname = current_database() AND pg_has_role(current_user, d.datdba, 'MEMBER')) THEN
    RAISE EXCEPTION 'refusing: % does not own database backenly_pooler; create it as the role that runs this file',
      current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_app') THEN
    RAISE EXCEPTION 'refusing: role backenly_app does not exist yet (roles.sql creates it)';
  END IF;

  SELECT * INTO auth FROM pg_roles WHERE rolname = 'backenly_pooler_auth';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refusing: role backenly_pooler_auth does not exist yet; create it with its verifier first';
  END IF;
  IF NOT auth.rolcanlogin THEN
    RAISE EXCEPTION 'refusing: backenly_pooler_auth cannot log in, so the pooler could not look up any login';
  END IF;
  IF auth.rolsuper OR auth.rolcreatedb OR auth.rolcreaterole OR auth.rolreplication OR auth.rolbypassrls THEN
    RAISE EXCEPTION 'refusing: backenly_pooler_auth must be NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = auth.oid) THEN
    RAISE EXCEPTION 'refusing: backenly_pooler_auth is a member of %; it may hold no role',
      (SELECT string_agg(roleid::regrole::text, ', ') FROM pg_auth_members WHERE member = auth.oid);
  END IF;
END $$;

-- ── The database ────────────────────────────────────────────────────────────
-- Nothing for PUBLIC (CONNECT, TEMPORARY and CREATE all go); CONNECT alone for
-- the two roles that use it.
REVOKE ALL ON DATABASE backenly_pooler FROM PUBLIC;
REVOKE ALL ON DATABASE backenly_pooler FROM backenly_app, backenly_pooler_auth;
GRANT CONNECT ON DATABASE backenly_pooler TO backenly_app, backenly_pooler_auth;

-- Nothing lives in the public schema here, and nobody needs it.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ── The schema ──────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS backenly_pooler;
REVOKE ALL ON SCHEMA backenly_pooler FROM PUBLIC;
REVOKE ALL ON SCHEMA backenly_pooler FROM backenly_app, backenly_pooler_auth;
GRANT USAGE ON SCHEMA backenly_pooler TO backenly_app, backenly_pooler_auth;

-- ── The logins ──────────────────────────────────────────────────────────────
-- The verifier is lib/data-plane/scram.ts's output exactly: 4096 iterations, a
-- base64 salt, and two 32-byte keys (tests/unit/data-plane-scram.spec.ts reads
-- this CHECK and holds the generator to it).
CREATE TABLE IF NOT EXISTS backenly_pooler.logins (
  rolname    text        PRIMARY KEY
                         CHECK (rolname ~ '^bkn_[a-z0-9_]+$' AND length(rolname) <= 63),
  verifier   text        NOT NULL CHECK (verifier ~ '^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'),
  database   text        NOT NULL CHECK (database ~ '^p_[0-9a-f]{32}$'),
  active     boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE backenly_pooler.logins FROM PUBLIC;
REVOKE ALL ON TABLE backenly_pooler.logins FROM backenly_app, backenly_pooler_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE backenly_pooler.logins TO backenly_app;

-- ── The lookup and the list ─────────────────────────────────────────────────
-- SECURITY DEFINER so backenly_pooler_auth reads no table itself, and a fixed
-- search_path (pg_catalog first; operators and functions are never looked up
-- in pg_temp) with every table qualified, so nothing in a caller's session can
-- change what they read. lookup is joined to pg_roles so a login whose role is
-- gone, cannot log in, has expired (VALID UNTIL) or is a superuser is not
-- served even while its row says active.
CREATE OR REPLACE FUNCTION backenly_pooler.lookup(login text, database text)
RETURNS TABLE (usename name, passwd text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $lookup$
  SELECT l.rolname::name, l.verifier
    FROM backenly_pooler.logins AS l
    JOIN pg_catalog.pg_roles AS r ON r.rolname = l.rolname::name
   WHERE l.rolname = $1
     AND l.database = $2
     AND l.active
     AND r.rolcanlogin
     AND NOT r.rolsuper
     AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil > now())
$lookup$;

-- Only databases that exist, so the pooler never lists a name the server
-- would answer "does not exist" for after a login.
CREATE OR REPLACE FUNCTION backenly_pooler.databases()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $databases$
  SELECT DISTINCT l.database
    FROM backenly_pooler.logins AS l
    JOIN pg_catalog.pg_database AS d ON d.datname = l.database::name
   WHERE l.active
   ORDER BY 1
$databases$;

REVOKE ALL ON FUNCTION backenly_pooler.lookup(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION backenly_pooler.lookup(text, text) FROM backenly_app, backenly_pooler_auth;
GRANT EXECUTE ON FUNCTION backenly_pooler.lookup(text, text) TO backenly_pooler_auth;
REVOKE ALL ON FUNCTION backenly_pooler.databases() FROM PUBLIC;
REVOKE ALL ON FUNCTION backenly_pooler.databases() FROM backenly_app, backenly_pooler_auth;
GRANT EXECUTE ON FUNCTION backenly_pooler.databases() TO backenly_pooler_auth;

-- ── What this file declares, checked ───────────────────────────────────────
DO $$
DECLARE
  fn oid;
  problems text[] := '{}';
  c record;
BEGIN
  -- Exactly these functions, so a call can never resolve to another signature.
  IF (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'backenly_pooler') IS DISTINCT FROM
     ARRAY['backenly_pooler.databases()', 'backenly_pooler.lookup(text,text)'] THEN
    problems := problems || 'backenly_pooler holds functions other than databases() and lookup(text, text)'::text;
  END IF;
  FOREACH fn IN ARRAY ARRAY['backenly_pooler.lookup(text,text)'::regprocedure, 'backenly_pooler.databases()'::regprocedure]::oid[] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn) THEN
      problems := problems || format('%s is not SECURITY DEFINER', fn::regprocedure);
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = fn) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
      problems := problems || format('%s does not fix its search_path', fn::regprocedure);
    END IF;
    IF (SELECT proowner FROM pg_proc WHERE oid = fn) <> (SELECT relowner FROM pg_class WHERE oid = 'backenly_pooler.logins'::regclass) THEN
      problems := problems || format('%s and logins have different owners, so it may not read logins', fn::regprocedure);
    END IF;
  END LOOP;

  IF (SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' not null' ELSE '' END,
                        ', ' ORDER BY attnum)
        FROM pg_attribute WHERE attrelid = 'backenly_pooler.logins'::regclass AND attnum > 0 AND NOT attisdropped)
     IS DISTINCT FROM
     'rolname text not null, verifier text not null, database text not null, active boolean not null, updated_at timestamp with time zone not null' THEN
    problems := problems || 'backenly_pooler.logins does not have the declared columns'::text;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'backenly_pooler.logins'::regclass AND contype = 'c') <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'backenly_pooler.logins'::regclass AND contype = 'p') THEN
    problems := problems || 'backenly_pooler.logins does not have its primary key and three checks'::text;
  END IF;

  -- Privileges, as each role would actually have them (memberships included).
  FOR c IN
    SELECT * FROM (VALUES
      -- who                   what                                        expected
      ('public',               'CONNECT on the database',                  has_database_privilege('public', 'backenly_pooler', 'CONNECT'), false),
      ('public',               'TEMPORARY on the database',                has_database_privilege('public', 'backenly_pooler', 'TEMPORARY'), false),
      ('public',               'CREATE on the database',                   has_database_privilege('public', 'backenly_pooler', 'CREATE'), false),
      ('public',               'USAGE on schema public',                   has_schema_privilege('public', 'public', 'USAGE'), false),
      ('public',               'CREATE on schema public',                  has_schema_privilege('public', 'public', 'CREATE'), false),
      ('public',               'USAGE on schema backenly_pooler',          has_schema_privilege('public', 'backenly_pooler', 'USAGE'), false),
      ('public',               'any privilege on logins',                  has_table_privilege('public', 'backenly_pooler.logins', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), false),
      ('public',               'EXECUTE on lookup',                        has_function_privilege('public', 'backenly_pooler.lookup(text, text)', 'EXECUTE'), false),
      ('public',               'EXECUTE on databases',                     has_function_privilege('public', 'backenly_pooler.databases()', 'EXECUTE'), false),
      ('backenly_pooler_auth', 'CONNECT on the database',                  has_database_privilege('backenly_pooler_auth', 'backenly_pooler', 'CONNECT'), true),
      ('backenly_pooler_auth', 'TEMPORARY or CREATE on the database',      has_database_privilege('backenly_pooler_auth', 'backenly_pooler', 'TEMPORARY, CREATE'), false),
      ('backenly_pooler_auth', 'USAGE on schema backenly_pooler',          has_schema_privilege('backenly_pooler_auth', 'backenly_pooler', 'USAGE'), true),
      ('backenly_pooler_auth', 'CREATE on any schema here',                has_schema_privilege('backenly_pooler_auth', 'backenly_pooler', 'CREATE') OR has_schema_privilege('backenly_pooler_auth', 'public', 'CREATE'), false),
      ('backenly_pooler_auth', 'any privilege on logins',                  has_table_privilege('backenly_pooler_auth', 'backenly_pooler.logins', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), false),
      ('backenly_pooler_auth', 'EXECUTE on lookup',                        has_function_privilege('backenly_pooler_auth', 'backenly_pooler.lookup(text, text)', 'EXECUTE'), true),
      ('backenly_pooler_auth', 'EXECUTE on databases',                     has_function_privilege('backenly_pooler_auth', 'backenly_pooler.databases()', 'EXECUTE'), true),
      ('backenly_app',         'CONNECT on the database',                  has_database_privilege('backenly_app', 'backenly_pooler', 'CONNECT'), true),
      ('backenly_app',         'TEMPORARY or CREATE on the database',      has_database_privilege('backenly_app', 'backenly_pooler', 'TEMPORARY, CREATE'), false),
      ('backenly_app',         'USAGE on schema backenly_pooler',          has_schema_privilege('backenly_app', 'backenly_pooler', 'USAGE'), true),
      ('backenly_app',         'CREATE on any schema here',                has_schema_privilege('backenly_app', 'backenly_pooler', 'CREATE') OR has_schema_privilege('backenly_app', 'public', 'CREATE'), false),
      ('backenly_app',         'SELECT on logins',                         has_table_privilege('backenly_app', 'backenly_pooler.logins', 'SELECT'), true),
      ('backenly_app',         'INSERT on logins',                         has_table_privilege('backenly_app', 'backenly_pooler.logins', 'INSERT'), true),
      ('backenly_app',         'UPDATE on logins',                         has_table_privilege('backenly_app', 'backenly_pooler.logins', 'UPDATE'), true),
      ('backenly_app',         'DELETE on logins',                         has_table_privilege('backenly_app', 'backenly_pooler.logins', 'DELETE'), true),
      ('backenly_app',         'TRUNCATE, REFERENCES or TRIGGER on logins', has_table_privilege('backenly_app', 'backenly_pooler.logins', 'TRUNCATE, REFERENCES, TRIGGER'), false),
      ('backenly_app',         'EXECUTE on lookup',                        has_function_privilege('backenly_app', 'backenly_pooler.lookup(text, text)', 'EXECUTE'), false),
      ('backenly_app',         'EXECUTE on databases',                     has_function_privilege('backenly_app', 'backenly_pooler.databases()', 'EXECUTE'), false)
    ) AS v(who, what, actual, expected)
  LOOP
    IF c.actual IS DISTINCT FROM c.expected THEN
      problems := problems || format('%s %s %s', c.who, CASE WHEN c.expected THEN 'lacks' ELSE 'has' END, c.what);
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'pooler.sql did not reach its declared state: %', array_to_string(problems, '; ');
  END IF;
  RAISE NOTICE 'backenly_pooler: logins table, lookup, databases and privileges as declared';
END $$;

COMMIT;
