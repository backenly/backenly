-- ============================================================================
-- A project's own database: what it holds that the region's database does not.
-- ============================================================================
-- Run by tools/managed-db/regional/bootstrap.sh as the database administrator
-- (the RDS master on AWS), first in the template every project database is
-- cloned from (backenly_project_template, BOOTSTRAP_MODE=template), and then in
-- each project database (p_<32 lowercase hex>, BOOTSTRAP_MODE=project-dbs)
-- whenever this file changes. Refused anywhere else, the region's own database
-- above all: what follows would close it to every login PUBLIC lets in today.
--
-- The roles are the region's, made once per instance by sql/roles.sql on the
-- region's database, which runs first. This file adds what is per database:
--
--   the database itself    PUBLIC may not connect, make temporary tables or
--                          create schemas; backenly_app may do all three (it
--                          creates the workspace schema), backenly_backup and
--                          backenly_authenticator may connect. A login the
--                          helpers create is then given CONNECT on its own
--                          database by name (setup-direct-access.sql section 2,
--                          function-roles.sql), and reaches no other project's.
--
--                          A clone does NOT inherit these: CREATE DATABASE ...
--                          TEMPLATE copies what a database holds, not the
--                          grants on the database itself. Its owner applies
--                          them right after the clone with
--                          scripts/sql/project-database-acl.sql, which also
--                          gives this administrator what it needs to converge
--                          the clone later. Here they are set only where the
--                          administrator owns the database (the template) and
--                          only where missing; verify-project-db.sql requires
--                          them everywhere.
--
--   schema public          owned by this administrator rather than by the
--                          database's owner (pg_database_owner, PostgreSQL 15
--                          and later), so that in a clone, which the creator
--                          role owns, the procedure can still create and
--                          replace what it keeps in public, and the creator
--                          cannot. PUBLIC may not create in it.
--
--   backenly_meta.tenancy  the mark that says this database holds one project
--                          (public.backenly_direct_shared_database, in
--                          setup-direct-access.sql). Owned by this
--                          administrator in a schema PUBLIC cannot reach, so
--                          no login can write or create it. The region's own
--                          database never carries it; sql/roles.sql refuses
--                          one that does.
--
-- Idempotent: each change is made only where it is missing, so a re-run in a
-- database that has all of it changes nothing. One transaction.

DO $$
DECLARE
  db constant text := current_database();
  owns_db constant boolean := (SELECT datdba FROM pg_database WHERE datname = current_database())
                              = (SELECT oid FROM pg_roles WHERE rolname = current_user);
  rname text;
BEGIN
  IF db <> 'backenly_project_template' AND db !~ '^p_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'refusing: % is neither backenly_project_template nor a project database (p_<32 lowercase hex>). This file is for those only, never for the region''s own database',
      db;
  END IF;
  IF to_regclass('public.projects') IS NOT NULL OR to_regclass('public._prisma_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'refusing: % holds platform tables (public.projects or public._prisma_migrations)', db;
  END IF;
  IF to_regnamespace('backenly_meta') IS NULL THEN
    RAISE EXCEPTION 'refusing: backenly_meta is missing in %; sql/ledger.sql runs first', db;
  END IF;
  FOREACH rname IN ARRAY ARRAY['backenly_app', 'backenly_backup', 'backenly_authenticator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname) THEN
      RAISE EXCEPTION 'refusing: role % does not exist. Apply the regional procedure to the region''s database first (sql/roles.sql makes the roles)',
        rname;
    END IF;
  END LOOP;

  -- ── The database itself ───────────────────────────────────────────────────
  IF owns_db THEN
    IF has_database_privilege('public', db, 'CONNECT') OR has_database_privilege('public', db, 'TEMPORARY')
       OR has_database_privilege('public', db, 'CREATE') THEN
      EXECUTE format('REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', db);
      RAISE NOTICE 'took CONNECT, TEMPORARY and CREATE on % from PUBLIC', db;
    END IF;
    IF NOT (has_database_privilege('backenly_app', db, 'CONNECT') AND has_database_privilege('backenly_app', db, 'TEMPORARY')
            AND has_database_privilege('backenly_app', db, 'CREATE')) THEN
      EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO backenly_app', db);
    END IF;
    FOREACH rname IN ARRAY ARRAY['backenly_backup', 'backenly_authenticator'] LOOP
      IF NOT has_database_privilege(rname, db, 'CONNECT') THEN
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, rname);
      END IF;
    END LOOP;
  END IF;

  -- ── Schema public ─────────────────────────────────────────────────────────
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'public') = 'pg_database_owner'::regrole AND owns_db THEN
    EXECUTE format('ALTER SCHEMA public OWNER TO %I', current_user);
    RAISE NOTICE 'schema public now belongs to %', current_user;
  END IF;
  IF has_schema_privilege('public', 'public', 'CREATE') THEN
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    RAISE NOTICE 'took CREATE on schema public from PUBLIC';
  END IF;

  -- ── The mark: this database holds one project ─────────────────────────────
  CREATE TABLE IF NOT EXISTS backenly_meta.tenancy (
    one        boolean PRIMARY KEY DEFAULT true CHECK (one),
    dedicated  boolean NOT NULL,
    marked_at  timestamptz NOT NULL DEFAULT now(),
    marked_by  text NOT NULL DEFAULT current_user
  );
  REVOKE ALL ON backenly_meta.tenancy FROM PUBLIC;
  IF NOT EXISTS (SELECT 1 FROM backenly_meta.tenancy WHERE dedicated) THEN
    INSERT INTO backenly_meta.tenancy (one, dedicated) VALUES (true, true)
    ON CONFLICT (one) DO UPDATE SET dedicated = true, marked_at = now(), marked_by = current_user;
    RAISE NOTICE 'marked % as holding one project', db;
  END IF;
  -- Whether the mark counts (it must belong to the role that owns the helper
  -- functions, or to a superuser) is verify-project-db.sql's to check: the
  -- helpers are installed after this step.
END $$;
