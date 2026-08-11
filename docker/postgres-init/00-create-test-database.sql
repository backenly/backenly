-- Create the database the test suite runs against.
--
-- `npm test` pushes the schema with --accept-data-loss, so tests need a
-- database of their own: pointing TEST_DATABASE_URL at the development
-- database would drop the data you are working on. jest.setup.js refuses to
-- start without TEST_DATABASE_URL for the same reason, which means that until
-- this database exists the documented first run (`cp .env.example .env`,
-- `docker compose -f docker-compose.dev.yml up -d`, `npm test`) cannot succeed.
--
-- Named to sort before 10-pg-stat-statements.sql: that file creates the
-- measurement extensions in POSTGRES_DB, and the \connect below scopes the
-- same two to this database, so both halves of the stack can measure rather
-- than infer. Extensions are per-database, not per-cluster.
--
-- Runs once, on first initialisation of an empty data directory. On a volume
-- that already exists, create it by hand with exactly these statements.
CREATE DATABASE backenly_test;

\connect backenly_test

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgstattuple;
