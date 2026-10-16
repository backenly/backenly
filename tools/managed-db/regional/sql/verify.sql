-- ============================================================================
-- Verify: the regional database is what the steps promise, or the run fails.
-- ============================================================================
-- Asserted from the catalog rather than trusted from the steps' exit codes: an
-- install that exits 0 having installed nothing is a failure this repository
-- has met before. Every problem is collected and reported together, so one run
-- shows all of them. Read-only, so BOOTSTRAP_MODE=check runs it too, against a
-- database whose steps are all recorded, as an audit of a live region.
--
-- Grants are checked from both sides: the role that needs one has it, and
-- PUBLIC does not. A definer function anyone could call is the failure that
-- matters most here, and it looks identical to a working install.

\if :{?allow_missing_extensions}
\else
  \set allow_missing_extensions false
\endif
SELECT set_config('backenly.allow_missing_extensions', :'allow_missing_extensions', false) AS a
\gset _

DO $$
DECLARE
  problems text[] := '{}';
  allow_missing boolean := current_setting('backenly.allow_missing_extensions')::boolean;
  r record;
  rname text;
  installed_in text;
  self_grant text;
  app_exists boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_app');
  authenticator_exists boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_authenticator');
BEGIN
  -- ── Still a regional database ─────────────────────────────────────────────
  IF to_regclass('public.projects') IS NOT NULL OR to_regclass('public._prisma_migrations') IS NOT NULL THEN
    problems := problems || 'this database holds platform tables; it is not a regional database'::text;
  END IF;

  -- ── Roles: the declared attributes, exactly ───────────────────────────────
  -- inherit is NULL where it does not matter (the NOLOGIN API roles).
  FOR r IN
    SELECT v.role_name, v.login, v.inherit, v.bypassrls, p.rolname IS NOT NULL AS present,
           p.rolsuper, p.rolcreatedb, p.rolcreaterole, p.rolreplication,
           p.rolcanlogin, p.rolinherit, p.rolbypassrls
      FROM (VALUES
        ('backenly_app',           true,  true,  false),
        ('backenly_backup',        true,  false, true),
        ('backenly_authenticator', true,  false, false),
        ('anon',                   false, NULL,  false),
        ('authenticated',          false, NULL,  false),
        ('service_role',           false, NULL,  false),
        ('backenly_external',      false, NULL,  false)
      ) AS v(role_name, login, inherit, bypassrls)
      LEFT JOIN pg_roles p ON p.rolname = v.role_name
  LOOP
    IF NOT r.present THEN
      problems := problems || format('role %s is missing', r.role_name);
      CONTINUE;
    END IF;
    IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication THEN
      problems := problems || format('role %s must be NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', r.role_name);
    END IF;
    IF r.rolcanlogin IS DISTINCT FROM r.login THEN
      problems := problems || format('role %s must be %s', r.role_name, CASE WHEN r.login THEN 'LOGIN' ELSE 'NOLOGIN' END);
    END IF;
    IF r.inherit IS NOT NULL AND r.rolinherit IS DISTINCT FROM r.inherit THEN
      problems := problems || format('role %s must be %s', r.role_name, CASE WHEN r.inherit THEN 'INHERIT' ELSE 'NOINHERIT' END);
    END IF;
    IF r.rolbypassrls IS DISTINCT FROM r.bypassrls THEN
      problems := problems || format('role %s must be %s', r.role_name, CASE WHEN r.bypassrls THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END);
    END IF;
  END LOOP;

  -- The authenticator can become each API role and holds none of their
  -- privileges itself, and cannot become the application or the backup role.
  IF authenticator_exists THEN
    FOREACH rname IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname);
      IF NOT pg_has_role('backenly_authenticator', rname, 'SET') THEN
        problems := problems || format('backenly_authenticator cannot SET ROLE %s', rname);
      END IF;
      IF pg_has_role('backenly_authenticator', rname, 'USAGE') THEN
        problems := problems || format('backenly_authenticator holds the privileges of %s without SET ROLE', rname);
      END IF;
    END LOOP;
    FOREACH rname IN ARRAY ARRAY['backenly_app', 'backenly_backup'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname);
      IF pg_has_role('backenly_authenticator', rname, 'MEMBER') THEN
        problems := problems || format('backenly_authenticator is a member of %s', rname);
      END IF;
    END LOOP;
  END IF;

  -- Each login role has the credential this procedure set (roles.sql).
  FOREACH rname IN ARRAY ARRAY['backenly_app', 'backenly_backup', 'backenly_authenticator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM backenly_meta.bootstrap_credentials c WHERE c.role_name = rname) THEN
      problems := problems || format('no credential recorded for %s', rname);
    END IF;
  END LOOP;

  -- ── Database privileges ───────────────────────────────────────────────────
  -- Nested rather than joined with AND throughout: SQL does not promise to
  -- short-circuit, and a privilege check on a missing role raises instead of
  -- adding to the list.
  IF app_exists THEN
    IF NOT has_database_privilege('backenly_app', current_database(), 'CONNECT, CREATE, TEMPORARY') THEN
      problems := problems || 'backenly_app needs CONNECT, CREATE and TEMPORARY on the database'::text;
    END IF;
  END IF;
  FOREACH rname IN ARRAY ARRAY['backenly_backup', 'backenly_authenticator'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname) THEN
      IF NOT has_database_privilege(rname, current_database(), 'CONNECT') THEN
        problems := problems || format('%s needs CONNECT on the database', rname);
      END IF;
    END IF;
  END LOOP;

  -- ── The application role every installed grant goes to ────────────────────
  IF to_regprocedure('public.backenly_app_role()') IS NULL THEN
    problems := problems || 'public.backenly_app_role() is missing'::text;
  ELSIF public.backenly_app_role() <> 'backenly_app' THEN
    problems := problems || format('public.backenly_app_role() resolves to %s, not backenly_app', public.backenly_app_role());
  END IF;

  -- ── The definer functions: present, the app's to call, nobody else's ──────
  FOR r IN
    SELECT * FROM (VALUES
      ('public.backenly_pgrst_current_schemas()',                       true),
      ('public.backenly_pgrst_register_schema(text)',                   true),
      ('public.backenly_pgrst_unregister_schema(text)',                 true),
      ('public.backenly_pgrst_reload()',                                true),
      ('public.backenly_pgrst_revoke_internal(text)',                   true),
      ('public.backenly_pgrst_prepare_schema(text)',                    true),
      ('public.backenly_fn_role_sync(text,text)',                       true),
      ('public.backenly_direct_create_role(text,text,text,text)',       true),
      ('public.backenly_direct_set_password(text,text)',                true),
      ('public.backenly_direct_drop_role(text)',                        true),
      ('public.backenly_direct_sync_schema(text,text,text,text)',       true),
      ('public.backenly_pgrst_prune_schemas()',                         false),
      ('public.backenly_pgrst_apply_owner_defaults(text)',              false),
      ('public.backenly_capture_ddl()',                                 false),
      ('public.backenly_capture_drop()',                                false),
      ('public.backenly_capture_home_schema(text)',                     false)
    ) AS f(signature, app_calls)
  LOOP
    IF to_regprocedure(r.signature) IS NULL THEN
      problems := problems || format('function %s is missing', r.signature);
      CONTINUE;
    END IF;
    IF has_function_privilege('public', r.signature, 'EXECUTE') THEN
      problems := problems || format('PUBLIC can execute %s', r.signature);
    END IF;
    IF r.app_calls AND app_exists THEN
      IF NOT has_function_privilege('backenly_app', r.signature, 'EXECUTE') THEN
        problems := problems || format('backenly_app cannot execute %s', r.signature);
      END IF;
    END IF;
  END LOOP;

  -- The definers can act on what the app owns, and become the roles they create
  -- for it (sql/roles.sql explains both; without them no workspace can be made).
  IF app_exists THEN
    FOR r IN
      SELECT DISTINCT pg_get_userbyid(p.proowner)::text AS owner
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND (p.proname LIKE 'backenly\_pgrst\_%' OR p.proname LIKE 'backenly\_direct\_%'
              OR p.proname LIKE 'backenly\_capture\_%' OR p.proname LIKE 'backenly\_fn\_role\_%')
    LOOP
      IF NOT pg_has_role(r.owner, 'backenly_app', 'USAGE') THEN
        problems := problems || format('the definer functions run as %s, which lacks the privileges of backenly_app', r.owner);
      END IF;
    END LOOP;
    self_grant := coalesce(
      (SELECT substring(c FROM '^createrole_self_grant=(.*)$') FROM pg_db_role_setting s, unnest(s.setconfig) c
        WHERE s.setrole = 'backenly_app'::regrole AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND c LIKE 'createrole\_self\_grant=%'),
      (SELECT substring(c FROM '^createrole_self_grant=(.*)$') FROM pg_db_role_setting s, unnest(s.setconfig) c
        WHERE s.setrole = 'backenly_app'::regrole AND s.setdatabase = 0 AND c LIKE 'createrole\_self\_grant=%'),
      (SELECT substring(c FROM '^createrole_self_grant=(.*)$') FROM pg_db_role_setting s, unnest(s.setconfig) c
        WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND c LIKE 'createrole\_self\_grant=%'),
      '');
    IF NOT ('set' = ANY (string_to_array(regexp_replace(self_grant, '\s+', '', 'g'), ','))
            AND 'inherit' = ANY (string_to_array(regexp_replace(self_grant, '\s+', '', 'g'), ','))) THEN
      problems := problems || format('sessions of backenly_app have createrole_self_grant "%s", not "set, inherit"', self_grant);
    END IF;
  END IF;

  -- PostgREST reads its served schemas through postgrest.pre_config().
  IF to_regprocedure('postgrest.pre_config()') IS NULL THEN
    problems := problems || 'postgrest.pre_config() is missing'::text;
  ELSE
    IF has_function_privilege('public', 'postgrest.pre_config()', 'EXECUTE') THEN
      problems := problems || 'PUBLIC can execute postgrest.pre_config()'::text;
    END IF;
    IF authenticator_exists THEN
      IF NOT has_schema_privilege('backenly_authenticator', 'postgrest', 'USAGE')
         OR NOT has_function_privilege('backenly_authenticator', 'postgrest.pre_config()', 'EXECUTE') THEN
        problems := problems || 'backenly_authenticator cannot call postgrest.pre_config()'::text;
      END IF;
    END IF;
  END IF;

  -- ── Event triggers: PostgREST registration and sync, and DDL capture ──────
  FOREACH rname IN ARRAY ARRAY['backenly_pgrst_schema_create', 'backenly_pgrst_schema_drop', 'backenly_pgrst_ddl_sync',
                               'backenly_ddl_watch', 'backenly_drop_watch'] LOOP
    SELECT evtenabled::text AS enabled INTO r FROM pg_event_trigger WHERE evtname = rname;
    IF NOT FOUND THEN
      problems := problems || format('event trigger %s is missing', rname);
    ELSIF r.enabled = 'D' THEN
      problems := problems || format('event trigger %s is disabled', rname);
    END IF;
  END LOOP;

  -- ── Drift events: the capture writes, the app reads, adopts and prunes ────
  IF to_regclass('public.schema_drift_events') IS NULL THEN
    problems := problems || 'public.schema_drift_events is missing'::text;
  ELSE
    -- The capture functions are SECURITY DEFINER and insert as their owner.
    FOR r IN
      SELECT p.proname::text AS fn, pg_get_userbyid(p.proowner)::text AS owner
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('backenly_capture_ddl', 'backenly_capture_drop')
    LOOP
      IF NOT has_table_privilege(r.owner, 'public.schema_drift_events', 'INSERT') THEN
        problems := problems || format('%s runs as %s, which cannot insert drift events', r.fn, r.owner);
      END IF;
    END LOOP;
    IF app_exists THEN
      IF NOT has_table_privilege('backenly_app', 'public.schema_drift_events', 'SELECT, UPDATE, DELETE') THEN
        problems := problems || 'backenly_app cannot read, adopt and prune drift events'::text;
      END IF;
      IF has_table_privilege('backenly_app', 'public.schema_drift_events', 'INSERT') THEN
        problems := problems || 'backenly_app can insert drift events; only the capture triggers may'::text;
      END IF;
    END IF;
    IF has_table_privilege('public', 'public.schema_drift_events', 'SELECT') THEN
      problems := problems || 'PUBLIC can read drift events'::text;
    END IF;
  END IF;

  -- ── Extensions: installed in public, and working ──────────────────────────
  -- The probes are tools/managed-db/extension-spec.ts operationalProbe, verbatim.
  FOR r IN
    SELECT * FROM (VALUES
      ('pg_stat_statements', 'SELECT 1 FROM pg_stat_statements LIMIT 1'),
      ('pgstattuple',        'SELECT 1 FROM pgstattuple(''pg_class'') LIMIT 1'),
      ('vector',             'SELECT ''[1,2,3]''::vector IS NOT NULL AS ok')
    ) AS x(name, probe)
  LOOP
    SELECT n.nspname INTO installed_in
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = r.name;
    IF NOT FOUND THEN
      IF NOT allow_missing THEN
        problems := problems || format('extension %s is not installed', r.name);
      END IF;
      CONTINUE;
    END IF;
    IF installed_in <> 'public' THEN
      problems := problems || format('extension %s is in schema %s, not public', r.name, installed_in);
    END IF;
    BEGIN
      EXECUTE r.probe;
    EXCEPTION WHEN OTHERS THEN
      problems := problems || format('extension %s is installed but does not work: %s', r.name, SQLERRM);
    END;
  END LOOP;

  -- ── Every step recorded ───────────────────────────────────────────────────
  FOREACH rname IN ARRAY ARRAY['roles', 'postgrest', 'drift-events', 'direct-access', 'extensions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM backenly_meta.bootstrap_steps s WHERE s.step = rname) THEN
      problems := problems || format('step %s is not recorded in backenly_meta.bootstrap_steps', rname);
    END IF;
  END LOOP;

  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'regional database verification failed: %', array_to_string(problems, '; ');
  END IF;
  RAISE NOTICE 'regional database verified';
END $$;
