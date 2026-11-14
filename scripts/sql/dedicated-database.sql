-- ============================================================================
-- Mark this database as holding one project's data only
-- ============================================================================
-- Run as a superuser, once, on a database that holds a single project, which is
-- what a self-hosted deployment is (scripts/selfhost.ts runs it):
--
--   bash scripts/install-sql.sh scripts/sql/dedicated-database.sql
--
-- On a database shared by several projects, a read-write direct-access login
-- changes rows only: code it could create in its schema (a trigger, a policy's
-- function, a view) would run in the sessions that serve every project there.
-- On a database dedicated to one project those sessions serve only that
-- project, so its admin may allow schema changes over the login
-- (scripts/setup-direct-access.sql, sections 5b and 5c).
--
-- Only a superuser can set a parameter of its own on a database, which is why
-- the mark is one: a managed database such as Amazon RDS has no superuser and
-- is always treated as shared. A second project's workspace in the database
-- makes it shared whatever this says. Undo with
--
--   ALTER DATABASE <db> RESET backenly.database_tenancy;
--
-- and then reinstall scripts/setup-direct-access.sql, which takes from every
-- read-write login whatever would let it change the schema.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET backenly.database_tenancy = %L', current_database(), 'dedicated');
END $$;
