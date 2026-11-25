-- ============================================================================
-- Verify: a project's own database is what the steps promise, or the run fails.
-- ============================================================================
-- The project-database counterpart of verify.sql, run in the template every
-- project database is cloned from (backenly_project_template) and in each
-- project database (p_<32 lowercase hex>) by tools/managed-db/regional/
-- bootstrap.sh. What applies to a database that holds one project is checked
-- as verify.sql checks it; what only the region's own database holds (the
-- region's copy of what authorizes its requests, the region's customer data on
-- platform rows, the credentials the procedure recorded) is not, and what makes
-- a database a project's own is checked instead: the mark, the grants on the
-- database, and who owns schema public.
--
-- Read-only. Every problem is collected and reported together.

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
  db constant text := current_database();
  r record;
  rname text;
  priv text;
  installed_in text;
  self_grant text;
  helper_owner text;
  app_exists boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_app');
  authenticator_exists boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_authenticator');
BEGIN
  -- ── Run by the role that built the template ───────────────────────────────
  -- What follows reads the ledger in backenly_meta and the helpers in public
  -- and postgrest, which belong to the administrator that built the template
  -- (on Amazon RDS, the master). A role that cannot use those schemas cannot
  -- verify anything here: said once, by name, rather than as a bare error.
  FOREACH rname IN ARRAY ARRAY['backenly_meta', 'postgrest', 'public'] LOOP
    IF to_regnamespace(rname) IS NOT NULL AND NOT has_schema_privilege(rname, 'USAGE') THEN
      RAISE EXCEPTION 'project database verification failed (%): % cannot use schema %, which belongs to %; run this as the administrator that built the template',
        db, current_user, rname, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = rname);
    END IF;
  END LOOP;

  -- ── A project database, and nothing else ──────────────────────────────────
  IF db <> 'backenly_project_template' AND db !~ '^p_[0-9a-f]{32}$' THEN
    problems := problems || format('%s is neither backenly_project_template nor a project database (p_<32 lowercase hex>)', db);
  END IF;
  IF to_regclass('public.projects') IS NOT NULL OR to_regclass('public._prisma_migrations') IS NOT NULL THEN
    problems := problems || 'this database holds platform tables'::text;
  END IF;

  -- ── Roles: the declared attributes, exactly (instance-wide, as verify.sql) ─
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
        ('backenly_external',      false, NULL,  false),
        ('backenly_no_schema_changes', false, NULL, false)
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

  -- The role that creates project databases, where the region has one: it
  -- creates databases and does nothing else, and nothing the platform runs as
  -- holds it.
  FOR r IN SELECT p.* FROM pg_roles p WHERE p.rolname = 'backenly_dbcreator' LOOP
    IF r.rolsuper OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
       OR NOT r.rolcreatedb OR NOT r.rolcanlogin THEN
      problems := problems || 'role backenly_dbcreator must be LOGIN CREATEDB NOINHERIT, and NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS'::text;
    END IF;
    -- pg_signal_backend is the one role it may hold, as verify.sql says: DROP
    -- DATABASE ... WITH (FORCE) ends only the sessions its owner may signal.
    IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid <> 'pg_signal_backend'::regrole) THEN
      problems := problems || 'role backenly_dbcreator is a member of a role other than pg_signal_backend'::text;
    END IF;
    FOREACH rname IN ARRAY ARRAY['backenly_app', 'backenly_backup', 'backenly_authenticator',
                                 'anon', 'authenticated', 'service_role', 'backenly_external'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname);
      IF pg_has_role(rname, 'backenly_dbcreator', 'MEMBER') THEN
        problems := problems || format('%s is a member of backenly_dbcreator', rname);
      END IF;
    END LOOP;
  END LOOP;

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

  -- ── The database itself: closed to PUBLIC, open to those it names ─────────
  -- One privilege per check: has_database_privilege is true for a list when
  -- ANY of it is held.
  FOREACH priv IN ARRAY ARRAY['CONNECT', 'TEMPORARY', 'CREATE'] LOOP
    IF has_database_privilege('public', db, priv) THEN
      problems := problems || format('PUBLIC holds %s on this database (a clone gets its grants from scripts/sql/project-database-acl.sql)', priv);
    END IF;
    IF app_exists THEN
      IF NOT has_database_privilege('backenly_app', db, priv) THEN
        problems := problems || format('backenly_app needs %s on this database', priv);
      END IF;
    END IF;
  END LOOP;
  FOREACH rname IN ARRAY ARRAY['backenly_backup', 'backenly_authenticator'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname) THEN
      IF NOT has_database_privilege(rname, db, 'CONNECT') THEN
        problems := problems || format('%s needs CONNECT on this database', rname);
      END IF;
    END IF;
  END LOOP;
  IF app_exists THEN
    IF NOT pg_has_role('backenly_app', 'pg_read_all_stats', 'USAGE') THEN
      problems := problems || 'backenly_app needs the privileges of pg_read_all_stats to read the statements PostgREST runs'::text;
    END IF;
  END IF;

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
      ('public.backenly_fn_role_drop(text)',                            true),
      ('public.backenly_fn_role_retire(text)',                          true),
      ('public.backenly_direct_create_role(text,text,text,text)',       true),
      ('public.backenly_direct_set_password(text,text)',                true),
      ('public.backenly_direct_set_connection_limit(text,integer)',     true),
      ('public.backenly_direct_drop_role(text)',                        true),
      ('public.backenly_direct_retire_role(text)',                      true),
      ('public.backenly_direct_sync_schema(text,text,text,text)',       true),
      ('public.backenly_direct_set_schema_changes(text,boolean)',       true),
      ('public.backenly_direct_shared_database()',                      true),
      ('public.backenly_direct_end_stripped_sessions(text)',            true),
      ('public.backenly_direct_login_holds(text,text)',                 false),
      ('public.backenly_direct_schema_change_holds(text)',              false),
      ('public.backenly_direct_shared_holds(text,text)',                false),
      ('public.backenly_direct_strip_schema_changes(text,text,text)',   false),
      ('public.backenly_direct_login_elsewhere(text)',                  false),
      ('public.backenly_pgrst_prune_schemas()',                         false),
      ('public.backenly_pgrst_apply_owner_defaults(text)',              false),
      ('public.backenly_pgrst_apply_soft_delete(text)',                 false),
      ('public.backenly_pgrst_cutover_blockers(text)',                  false),
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

  -- The definers act on what the app owns and become the roles they create for
  -- it (sql/roles.sql), and give each login they create CONNECT on this
  -- database by name, which needs the grant option where they do not own it
  -- (scripts/sql/project-database-acl.sql).
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
      IF NOT has_database_privilege(r.owner, db, 'CONNECT WITH GRANT OPTION') THEN
        problems := problems || format('the definer functions run as %s, which cannot give a login CONNECT on this database', r.owner);
      END IF;
    END LOOP;
    -- Set for the role, not for one database: a clone does not copy settings
    -- made for a role in a database (sql/roles.sql).
    self_grant := coalesce(
      (SELECT substring(c FROM '^createrole_self_grant=(.*)$') FROM pg_db_role_setting s, unnest(s.setconfig) c
        WHERE s.setrole = 'backenly_app'::regrole AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = db)
          AND c LIKE 'createrole\_self\_grant=%'),
      (SELECT substring(c FROM '^createrole_self_grant=(.*)$') FROM pg_db_role_setting s, unnest(s.setconfig) c
        WHERE s.setrole = 'backenly_app'::regrole AND s.setdatabase = 0 AND c LIKE 'createrole\_self\_grant=%'),
      '');
    IF NOT ('set' = ANY (string_to_array(regexp_replace(self_grant, '\s+', '', 'g'), ','))
            AND 'inherit' = ANY (string_to_array(regexp_replace(self_grant, '\s+', '', 'g'), ','))) THEN
      problems := problems || format('sessions of backenly_app have createrole_self_grant "%s", not "set, inherit"', self_grant);
    END IF;
  END IF;

  -- ── Schema public: the administrator's, closed to PUBLIC ──────────────────
  helper_owner := (SELECT pg_get_userbyid(p.proowner)::text FROM pg_proc p
                    WHERE p.oid = to_regprocedure('public.backenly_direct_create_role(text,text,text,text)'));
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'public') = 'pg_database_owner'::regrole THEN
    problems := problems || 'schema public belongs to the database''s owner, which in a clone is the role that created it; it must belong to the administrator (sql/project-db.sql)'::text;
  ELSIF helper_owner IS NOT NULL AND NOT pg_has_role(helper_owner, (SELECT nspowner FROM pg_namespace WHERE nspname = 'public'), 'USAGE') THEN
    problems := problems || format('schema public belongs to %s, not to %s, which owns the helper functions',
                                   (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'), helper_owner);
  END IF;
  IF has_schema_privilege('public', 'public', 'CREATE') THEN
    problems := problems || 'PUBLIC can create in schema public'::text;
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
                               'backenly_pgrst_drop_sync', 'backenly_ddl_watch', 'backenly_drop_watch'] LOOP
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
      FOREACH priv IN ARRAY ARRAY['SELECT', 'UPDATE', 'DELETE'] LOOP
        IF NOT has_table_privilege('backenly_app', 'public.schema_drift_events', priv) THEN
          problems := problems || format('backenly_app cannot %s drift events', lower(priv));
        END IF;
      END LOOP;
      IF has_table_privilege('backenly_app', 'public.schema_drift_events', 'INSERT') THEN
        problems := problems || 'backenly_app can insert drift events; only the capture triggers may'::text;
      END IF;
    END IF;
    IF has_table_privilege('public', 'public.schema_drift_events', 'SELECT') THEN
      problems := problems || 'PUBLIC can read drift events'::text;
    END IF;
  END IF;

  -- ── Workspaces: the backup role can dump every one ────────────────────────
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_backup') THEN
    FOR r IN
      SELECT n.nspname::text AS workspace,
             has_schema_privilege('backenly_backup', n.oid, 'USAGE') AS usable,
             array(SELECT c.relname::text FROM pg_class c
                    WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'S')
                      AND NOT has_table_privilege('backenly_backup', c.oid, 'SELECT')
                    ORDER BY 1) AS unreadable
        FROM pg_namespace n
       WHERE n.nspname ~ '^workspace_[0-9a-fA-F][0-9a-fA-F-]{10,60}$'
       ORDER BY 1
    LOOP
      IF NOT r.usable THEN
        problems := problems || format('backenly_backup cannot use workspace schema %s, so its snapshots fail', r.workspace);
      ELSIF cardinality(r.unreadable) > 0 THEN
        problems := problems || format('backenly_backup cannot read %s in workspace schema %s, so its snapshots fail',
                                       array_to_string(r.unreadable, ', '), r.workspace);
      END IF;
    END LOOP;
  END IF;

  -- ── Direct access: this database holds one project ────────────────────────
  -- Marked as dedicated, with the mark owned by the role that owns the helpers
  -- (public.backenly_direct_shared_database says why), and holding at most one
  -- project's workspace. Its read-write logins may then be allowed schema
  -- changes by their admin; one that is not (a member of
  -- backenly_no_schema_changes) holds nothing that changes the schema.
  IF to_regclass('backenly_meta.tenancy') IS NULL THEN
    problems := problems || 'backenly_meta.tenancy is missing, so this database does not say it holds one project'::text;
  ELSIF to_regprocedure('public.backenly_direct_shared_database()') IS NOT NULL THEN
    IF public.backenly_direct_shared_database() THEN
      problems := problems || 'this database reads as shared by several projects: its mark is missing or not the administrator''s, or it holds more than one project''s workspace'::text;
    END IF;
  END IF;
  IF to_regprocedure('public.backenly_direct_schema_change_holds(text)') IS NOT NULL
     AND to_regprocedure('public.backenly_capture_home_schema(text)') IS NOT NULL THEN
    FOR r IN
      SELECT p.rolname::text AS login,
             public.backenly_direct_schema_change_holds(p.rolname::text) AS holds
        FROM pg_roles p
       WHERE p.rolname ~ '^bkn_rw_[0-9a-f]{12}$'
         AND public.backenly_capture_home_schema(p.rolname::text) IS NOT NULL
         AND EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                      WHERE m.member = p.oid AND g.rolname = 'backenly_no_schema_changes')
       ORDER BY 1
    LOOP
      IF cardinality(r.holds) > 0 THEN
        problems := problems || format('read-write login %s may not change the schema, yet holds: %s', r.login, array_to_string(r.holds, ', '));
      END IF;
    END LOOP;
    FOR r IN
      SELECT a.rolname::text AS login
        FROM pg_shdescription d JOIN pg_roles a ON a.oid = d.objoid
       WHERE d.classoid = 'pg_authid'::regclass AND a.rolname ~ '^bkn_rw_[0-9a-f]{12}$'
         AND d.description LIKE 'backenly: sessions to end after a strip%'
         AND public.backenly_capture_home_schema(a.rolname::text) IS NOT NULL
       ORDER BY 1
    LOOP
      problems := problems || format('read-write login %s was stripped and its sessions were not ended since: SELECT public.backenly_direct_end_stripped_sessions()', r.login);
    END LOOP;
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
  IF to_regclass('backenly_meta.bootstrap_steps') IS NULL THEN
    problems := problems || 'backenly_meta.bootstrap_steps is missing'::text;
  ELSE
    FOREACH rname IN ARRAY ARRAY['project-db', 'postgrest', 'drift-events', 'direct-access', 'extensions'] LOOP
      IF NOT EXISTS (SELECT 1 FROM backenly_meta.bootstrap_steps s WHERE s.step = rname) THEN
        problems := problems || format('step %s is not recorded in backenly_meta.bootstrap_steps', rname);
      END IF;
    END LOOP;
  END IF;

  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'project database verification failed (%): %', db, array_to_string(problems, '; ');
  END IF;
  RAISE NOTICE 'project database % verified', db;
END $$;
