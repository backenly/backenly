-- ============================================================================
-- Verify: database backenly_pooler holds the connection pooler's login lookup
-- exactly as sql/pooler.sql declares it, or the run fails.
-- ============================================================================
-- Read-only. pooler.sql includes this file as its last statement, inside its
-- own transaction, so a run that does not reach this state rolls back whole.
-- bootstrap.sh also runs it on its own, connected to backenly_pooler, wherever
-- it verifies the region's database (an apply, and a check whose steps are all
-- recorded), so a live region's lookup is audited the same way.
--
-- Every problem is collected and reported together, so one run shows all of
-- them. Privileges are checked as each role would actually have them,
-- memberships included, and from both sides: the role that needs one has it,
-- and PUBLIC does not.
--
-- The catalog is read from pg_catalog only, whatever the session's own
-- search_path holds.
SET search_path = pg_catalog, pg_temp;

DO $$
DECLARE
  fn oid;
  problems text[] := '{}';
  c record;
BEGIN
  IF current_database() <> 'backenly_pooler' THEN
    RAISE EXCEPTION 'refusing: verify-pooler.sql checks database backenly_pooler, not %', current_database();
  END IF;
  -- Without these the checks below cannot even be asked.
  IF to_regnamespace('backenly_pooler') IS NULL OR to_regclass('backenly_pooler.logins') IS NULL
     OR to_regprocedure('backenly_pooler.lookup(text,text)') IS NULL OR to_regprocedure('backenly_pooler.databases()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'backenly_pooler_auth')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'backenly_app') THEN
    RAISE EXCEPTION 'backenly_pooler did not reach its declared state: the schema backenly_pooler, its table logins, lookup(text, text), databases(), or the roles backenly_app and backenly_pooler_auth are missing (sql/pooler.sql makes them)';
  END IF;

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
    RAISE EXCEPTION 'backenly_pooler did not reach its declared state: %', array_to_string(problems, '; ');
  END IF;
  RAISE NOTICE 'backenly_pooler: logins table, lookup, databases and privileges as declared';
END $$;
