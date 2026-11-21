-- ============================================================================
-- A project's own database, right after it is cloned: the grants on it
-- ============================================================================
-- CREATE DATABASE p_<hex> TEMPLATE backenly_project_template copies everything
-- the template holds, and none of the grants on the template database itself:
-- a clone starts with PostgreSQL's defaults, under which its creator owns it
-- and PUBLIC, every login on the instance, may connect to it and make
-- temporary tables there. This gives the clone the grants
-- tools/managed-db/regional/sql/project-db.sql gives the template, and must run
-- before the clone is used for anything.
--
-- ── Inputs ───────────────────────────────────────────────────────────────────
--   backenly.project_database   session setting: the new database's name,
--                               p_<32 lowercase hex>. Set it in the same
--                               session first, as a parameter, never spliced:
--                                 SELECT set_config('backenly.project_database', $1, false)
--   the session's role          the new database's owner, which is the role
--                               that ran CREATE DATABASE (on Backenly Cloud the
--                               region's backenly_dbcreator). Anyone else is
--                               refused: only the owner can take what PUBLIC
--                               holds on a database.
--   backenly_project_template   must exist. Its owner is the administrator that
--                               made it and converges every project database
--                               (tools/managed-db/regional/bootstrap.sh); that
--                               role is read from the catalog, never passed in.
--
-- Run it on any database of the instance, preferably the connection that ran
-- CREATE DATABASE, so the clone is closed before anything else can reach it.
-- Plain SQL with no psql commands, so a driver can send it as it is. Idempotent.
--
-- ── What it grants ───────────────────────────────────────────────────────────
--   PUBLIC                   nothing: no CONNECT, TEMPORARY or CREATE
--   backenly_app             CONNECT, TEMPORARY, CREATE (it creates the
--                            project's workspace schema)
--   backenly_backup          CONNECT
--   backenly_authenticator   CONNECT
--   the administrator        CONNECT, TEMPORARY, CREATE WITH GRANT OPTION: it
--                            converges the clone as the template's helpers
--                            change, and the helpers it owns give each login
--                            they create CONNECT on this database by name
--                            (scripts/setup-direct-access.sql section 2,
--                            scripts/sql/function-roles.sql), which a GRANT
--                            needs the grant option for when the grantor does
--                            not own the database.

DO $$
DECLARE
  db    text := current_setting('backenly.project_database', true);
  admin text := (SELECT pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = 'backenly_project_template');
  owner text;
  rname text;
BEGIN
  IF db IS NULL OR db !~ '^p_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'project-database-acl: set backenly.project_database to the new database''s name (p_<32 lowercase hex>) first, not %',
      coalesce(quote_literal(db), 'nothing');
  END IF;
  owner := (SELECT pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = db);
  IF owner IS NULL THEN
    RAISE EXCEPTION 'project-database-acl: database % does not exist', db;
  END IF;
  IF owner <> current_user THEN
    RAISE EXCEPTION 'project-database-acl: run this as %, the owner of %, not as %', owner, db, current_user;
  END IF;
  IF admin IS NULL THEN
    RAISE EXCEPTION 'project-database-acl: backenly_project_template does not exist, so % was not cloned from it', db;
  END IF;
  FOREACH rname IN ARRAY ARRAY['backenly_app', 'backenly_backup', 'backenly_authenticator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname) THEN
      RAISE EXCEPTION 'project-database-acl: role % does not exist', rname;
    END IF;
  END LOOP;

  EXECUTE format('REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', db);
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO backenly_app', db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO backenly_backup, backenly_authenticator', db);
  IF admin <> owner THEN
    EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO %I WITH GRANT OPTION', db, admin);
  END IF;
END $$;
