-- ============================================================================
-- Preflight: refuse anything that is not an empty regional database.
-- ============================================================================
-- Runs first in every mode and writes nothing. A regional database holds the
-- region's workspace schemas only; the platform tables stay in the home region.
-- Run against the home region's database, the steps after this would re-own and
-- re-grant objects the platform depends on, so that is refused outright.

\if :{?allow_missing_extensions}
\else
  \set allow_missing_extensions false
\endif
SELECT set_config('backenly.allow_missing_extensions', :'allow_missing_extensions', false) AS a
\gset _

SELECT current_user AS administrator, current_database() AS database,
       current_setting('server_version') AS server_version,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser;

DO $$
BEGIN
  IF current_setting('server_version_num')::int / 10000 <> 16 THEN
    RAISE EXCEPTION 'refusing: this procedure is written and rehearsed for PostgreSQL 16; the server runs %',
      current_setting('server_version');
  END IF;
  IF to_regclass('public.projects') IS NOT NULL OR to_regclass('public._prisma_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'refusing: % holds platform tables (public.projects or public._prisma_migrations). This procedure initialises a regional data-plane database only, never the home one.',
      current_database();
  END IF;
  -- The rehearsal setting relaxes the extension refusals for a stock server.
  -- RDS is never one: a real regional database gets the full set or fails.
  IF current_setting('backenly.allow_missing_extensions')::boolean
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('rdsadmin', 'rds_superuser')) THEN
    RAISE EXCEPTION 'refusing: BOOTSTRAP_REHEARSAL is for rehearsals on stock PostgreSQL, and this server is Amazon RDS';
  END IF;
END $$;
