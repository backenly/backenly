-- CLOSE THE REGION'S DATABASE TO EVERY LOGIN THAT IS NOT THE PLATFORM'S
-- ======================================================================
-- Once every project of the region has a database of its own, the region's
-- database (the one this procedure initialises, which held the projects'
-- shared schemas) need not be open to every login on the instance.
-- PostgreSQL gives CONNECT on every database to PUBLIC by default, and a
-- project's logins live on the same instance as its database; once nothing of
-- any project is left in the region's database, only the platform's roles
-- connect to it.
--
-- In one transaction, as the database's owner (the RDS master on AWS):
--
--   1. refused while the database holds a workspace schema no move left
--      behind: a project still keeps its data here;
--   2. CONNECT given by name to the platform's roles that use the database
--      (sql/roles.sql already gives it to the application, backup and
--      authenticator roles; the database creator and the pooler's login get
--      it here) and to any other login connected to it now that is not a
--      project's, so nothing that works now stops;
--   3. CONNECT and TEMPORARY taken from PUBLIC;
--   4. every privilege on the database taken from each project role
--      (bkn_ro_, bkn_rw_, bkn_fn_, bkn_own_ and 12 hex) that holds one by
--      name: direct access and functions make a project's logins with CONNECT
--      on the database they are made in, which was this one while the
--      project's data was here; their sessions here are ended;
--   5. verified: PUBLIC holds no CONNECT, no project role does, and every role
--      step 2 named does.
--
-- Idempotent: a second run changes nothing and reports the same. After an
-- apply that makes a new platform role (the database creator or the pooler's
-- login), run it again. sql/open-shared.sql gives CONNECT back to PUBLIC.
--
-- Run by bootstrap.sh (BOOTSTRAP_MODE=close-shared) with psql -tA, so the only
-- output is the report lines below.

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $close$
DECLARE
  db text := current_database();
  owner_name text;
  unmoved_count integer;
  unmoved_example text;
  r record;
  named text[] := ARRAY[]::text[];
BEGIN
  SELECT pg_get_userbyid(d.datdba) INTO owner_name FROM pg_database d WHERE d.datname = db;
  IF current_user <> owner_name AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'refusing: connected as %, and only %, the owner of %, may take CONNECT from PUBLIC on it', current_user, owner_name, db;
  END IF;

  -- 1. No project's data is left here.
  SELECT count(*), min(n.nspname) INTO unmoved_count, unmoved_example
    FROM pg_namespace n
   WHERE starts_with(n.nspname, 'workspace_')
     AND n.nspname !~* '^workspace_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_moved[0-9]+(_[0-9]+)?$';
  IF unmoved_count > 0 THEN
    RAISE EXCEPTION 'refusing: % still holds % workspace schema(s) no move left behind, such as %: a project keeps its data here. Move every project of the region first.', db, unmoved_count, unmoved_example;
  END IF;

  -- 2. The platform's roles, by name, and whatever else is connected now that is not a project's.
  FOR r IN
    SELECT g.rolname::text AS name
      FROM pg_roles g
     WHERE g.rolname IN ('backenly_app', 'backenly_backup', 'backenly_authenticator', 'backenly_dbcreator', 'backenly_pooler_auth')
    UNION
    SELECT DISTINCT a.usename::text
      FROM pg_stat_activity a
      JOIN pg_roles g ON g.rolname = a.usename
     WHERE a.datname = db
       AND g.rolcanlogin
       AND NOT g.rolsuper
       AND a.usename <> current_user
       AND a.usename !~ '^bkn_(fn|ro|rw|own)_[0-9a-f]{12}$'
     ORDER BY 1
  LOOP
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, r.name);
    named := named || r.name;
  END LOOP;

  -- 3. PUBLIC.
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', db);

  -- 4. Project roles holding a privilege on the database by name, and their sessions here.
  FOR r IN
    SELECT DISTINCT g.rolname::text AS name
      FROM pg_database d
      CROSS JOIN LATERAL aclexplode(d.datacl) x
      JOIN pg_roles g ON g.oid = x.grantee
     WHERE d.datname = db
       AND g.rolname ~ '^bkn_(fn|ro|rw|own)_[0-9a-f]{12}$'
  LOOP
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', db, r.name);
  END LOOP;
  -- Best effort, each on its own: a session that cannot be ended here is
  -- reported below, and closes the database to that login when it ends.
  FOR r IN
    SELECT a.pid FROM pg_stat_activity a
     WHERE a.datname = db AND a.usename ~ '^bkn_(fn|ro|rw|own)_[0-9a-f]{12}$'
  LOOP
    BEGIN
      PERFORM pg_terminate_backend(r.pid, 5000);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  -- 5. Verified.
  IF has_database_privilege('public', db, 'CONNECT') THEN
    RAISE EXCEPTION 'PUBLIC still holds CONNECT on %: a grant made by another role was not taken back', db;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles g
              WHERE g.rolname ~ '^bkn_(fn|ro|rw|own)_[0-9a-f]{12}$'
                AND has_database_privilege(g.oid, db, 'CONNECT')) THEN
    RAISE EXCEPTION 'a project role can still connect to %: %', db,
      (SELECT string_agg(g.rolname::text, ', ' ORDER BY g.rolname::text) FROM pg_roles g
        WHERE g.rolname ~ '^bkn_(fn|ro|rw|own)_[0-9a-f]{12}$' AND has_database_privilege(g.oid, db, 'CONNECT'));
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(named) AS n(name) JOIN pg_roles g ON g.rolname = n.name
              WHERE NOT has_database_privilege(g.oid, db, 'CONNECT')) THEN
    RAISE EXCEPTION 'a platform role cannot connect to % after the grant', db;
  END IF;
END
$close$;

COMMIT;

-- The report, from the database's own privileges after the change, each in a
-- transaction of its own (pg_stat_activity is read once per transaction).
SELECT 'shared database ' || current_database() || ': closed (CONNECT by name: '
       || coalesce((SELECT string_agg(DISTINCT g.rolname::text, ', ' ORDER BY g.rolname::text)
                      FROM pg_database d
                      CROSS JOIN LATERAL aclexplode(d.datacl) x
                      JOIN pg_roles g ON g.oid = x.grantee
                     WHERE d.datname = current_database()
                       AND x.privilege_type = 'CONNECT'
                       AND g.oid <> d.datdba), 'none')
       || ')';
SELECT 'project sessions still connected: ' || count(*)
  FROM pg_stat_activity a
 WHERE a.datname = current_database()
   AND a.usename ~ '^bkn_(fn|ro|rw|own)_[0-9a-f]{12}$';
