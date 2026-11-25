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
--                                 login, with the pool size its logins'
--                                 connection limit allows. The pooler reads it at start and every
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
-- tools/managed-db/regional/bootstrap.sh runs this file as the step `pooler`
-- of an apply, in a region whose administrator made backenly_pooler_auth, in
-- this order:
--
--   1. sql/roles.sql creates backenly_app, and backenly_pooler_auth only when
--      the run supplies its SCRAM-SHA-256 verifier, BACKENLY_POOLER_AUTH_VERIFIER,
--      which launch.ts computes (secrets.poolerAuth in the region's launch
--      config). The password is set only when the role is created or named in
--      BOOTSTRAP_ROTATE, and recorded in backenly_meta.bootstrap_credentials:
--        CREATE ROLE backenly_pooler_auth LOGIN NOINHERIT CONNECTION LIMIT 60;
--        ALTER ROLE backenly_pooler_auth PASSWORD '<verifier>';
--      Every other attribute stays at its default (NOSUPERUSER NOCREATEDB
--      NOCREATEROLE NOREPLICATION NOBYPASSRLS), and the role is granted no
--      role; this file refuses one that has either. Its password goes to the
--      pooler as POOLER_AUTH_PASSWORD (services/pooler/README.md): printable
--      ASCII without spaces, double quotes or backslashes, at least 16
--      characters. launch.ts keeps generatePassword()'s 64 hex characters, the
--      password itself rather than a connection string, in that secret.
--
--   2. The database, from the shell, connected to the regional database as
--      the administrator. CREATE DATABASE cannot run inside a transaction or a
--      DO block, so it is two statements:
--        SELECT count(*) FROM pg_database WHERE datname = 'backenly_pooler';
--        CREATE DATABASE backenly_pooler TEMPLATE template0;   -- only when it is 0
--      Created by the administrator, so the administrator owns it; this file
--      checks that. From template0, so it holds nothing template1 may.
--
--   3. This file, connected to backenly_pooler as the administrator (the
--      regional URL with its database replaced), recorded as the step
--      `pooler` in backenly_meta.bootstrap_steps of the REGIONAL database,
--      with the checksum of this file and sql/verify-pooler.sql. It is safe
--      to re-run, it converges privileges to exactly what is declared here,
--      and it ends with sql/verify-pooler.sql, so a failed check rolls back
--      the whole run.
--
--   4. sql/verify.sql checks the role and that the step and the database are
--      there; sql/verify-pooler.sql, run on its own against backenly_pooler,
--      checks this file's end state. Both run wherever the procedure verifies
--      the region, an apply and a check alike.
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
-- would answer "does not exist" for after a login. With each, its pool size:
-- the smallest connection limit among its active logins (the plan's limit,
-- set on each login), so the pooler never opens more server connections for a
-- login than the server lets it hold; NULL when every login is unlimited, and
-- the pooler then uses its default.
--
-- An earlier form returned SETOF text; a function's result type cannot be
-- replaced in place, so that form is dropped first.
-- (Looked up with to_regprocedure, which answers NULL for a missing function,
-- never with a ::regprocedure cast, which fails while planning when it is missing.)
DO $drop_old_databases$
DECLARE
  old_form regprocedure := to_regprocedure('backenly_pooler.databases()');
BEGIN
  IF old_form IS NOT NULL AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc AS p
        WHERE p.oid = old_form AND p.proretset AND p.prorettype = 'text'::regtype) THEN
    DROP FUNCTION backenly_pooler.databases();
  END IF;
END
$drop_old_databases$;

CREATE OR REPLACE FUNCTION backenly_pooler.databases()
RETURNS TABLE (database text, pool_size integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $databases$
  SELECT l.database,
         min(NULLIF(GREATEST(r.rolconnlimit, 0), 0))::integer
    FROM backenly_pooler.logins AS l
    JOIN pg_catalog.pg_database AS d ON d.datname = l.database::name
    LEFT JOIN pg_catalog.pg_roles AS r ON r.rolname = l.rolname::name
   WHERE l.active
   GROUP BY l.database
   ORDER BY 1
$databases$;

REVOKE ALL ON FUNCTION backenly_pooler.lookup(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION backenly_pooler.lookup(text, text) FROM backenly_app, backenly_pooler_auth;
GRANT EXECUTE ON FUNCTION backenly_pooler.lookup(text, text) TO backenly_pooler_auth;
REVOKE ALL ON FUNCTION backenly_pooler.databases() FROM PUBLIC;
REVOKE ALL ON FUNCTION backenly_pooler.databases() FROM backenly_app, backenly_pooler_auth;
GRANT EXECUTE ON FUNCTION backenly_pooler.databases() TO backenly_pooler_auth;

-- ── What this file declares, checked ───────────────────────────────────────
-- sql/verify-pooler.sql, read-only, which bootstrap.sh also runs on its own to
-- audit a live region. Inside this transaction, so a run that does not reach
-- the declared state rolls back whole.
\ir verify-pooler.sql

COMMIT;
