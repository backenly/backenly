-- ============================================================================
-- Extensions the data plane uses, in the regional database.
-- ============================================================================
-- The same list as tools/managed-db/extension-spec.ts REQUIRED_EXTENSIONS, with
-- the same rules as its Layer 2 provisioning (tools/managed-db/
-- provision-extensions.ts), and tests/unit/regional-bootstrap.spec.ts keeps the
-- two equal. Only an extension that is available and not installed is created,
-- in schema public. Everything else is a different problem with a different
-- owner, and is refused:
--
--   not available on this server         an engine or image problem
--   needs shared_preload_libraries       the instance's parameter group (Layer 1)
--   installed in another schema          diagnosed, never moved: an extension
--                                        can own objects and data
--
-- `allow_missing_extensions` exists for rehearsals on a stock PostgreSQL 16
-- that lacks pgvector or the preload, and turns the first two refusals into
-- notices. bootstrap.sh sets it from BOOTSTRAP_REHEARSAL, and preflight.sql
-- refuses it on RDS.

\if :{?allow_missing_extensions}
\else
  \set allow_missing_extensions false
\endif
SELECT set_config('backenly.allow_missing_extensions', :'allow_missing_extensions', false) AS a
\gset _

DO $$
DECLARE
  allow_missing boolean := current_setting('backenly.allow_missing_extensions')::boolean;
  -- pg_settings rather than current_setting(): it is how the capability probe
  -- reads it (tools/migration-lineage/probe/capabilities.ts), and a role that may
  -- not see the setting gets no row, which reads as "not preloaded" there too.
  preloaded text[] := coalesce(
    (SELECT string_to_array(regexp_replace(setting, '\s+', '', 'g'), ',')
       FROM pg_settings WHERE name = 'shared_preload_libraries'),
    '{}');
  e record;
  installed_in text;
  problem text;
BEGIN
  FOR e IN
    SELECT * FROM (VALUES
      ('pg_stat_statements', true),
      ('pgstattuple',        false),
      ('vector',             false)
    ) AS x(name, requires_preload)
  LOOP
    SELECT n.nspname INTO installed_in
      FROM pg_extension x JOIN pg_namespace n ON n.oid = x.extnamespace
     WHERE x.extname = e.name;
    IF FOUND THEN
      IF installed_in <> 'public' THEN
        RAISE EXCEPTION 'refusing: extension % is installed in schema %, not public. This procedure never moves an extension; diagnose it',
          e.name, installed_in;
      END IF;
      CONTINUE;
    END IF;

    problem := NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = e.name) THEN
      problem := format('extension %s is not available on this server, which is an engine or image problem', e.name);
    ELSIF e.requires_preload AND NOT e.name = ANY (preloaded) THEN
      problem := format('extension %s needs shared_preload_libraries, which the instance''s parameter group sets', e.name);
    END IF;

    IF problem IS NULL THEN
      EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I SCHEMA public', e.name);
      RAISE NOTICE 'installed extension %', e.name;
    ELSIF allow_missing THEN
      RAISE NOTICE 'rehearsal: %', problem;
    ELSE
      RAISE EXCEPTION 'refusing: %', problem;
    END IF;
  END LOOP;
END $$;
