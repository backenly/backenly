-- OPEN THE REGION'S DATABASE TO PUBLIC AGAIN
-- ==========================================
-- What puts back sql/close-shared.sql: CONNECT and TEMPORARY on the region's
-- database given to PUBLIC, as PostgreSQL gives them to every new database.
-- The grants by name close-shared made stay (they are harmless, and the
-- platform's roles hold them anyway), and a project role's privileges taken
-- then are not given back by name: PUBLIC's cover CONNECT again.
--
-- As the database's owner (the RDS master on AWS). Run by bootstrap.sh
-- (BOOTSTRAP_MODE=open-shared) with psql -tA, so the only output is the
-- report line below. Idempotent.

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $open$
DECLARE
  db text := current_database();
  owner_name text;
BEGIN
  SELECT pg_get_userbyid(d.datdba) INTO owner_name FROM pg_database d WHERE d.datname = db;
  IF current_user <> owner_name AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'refusing: connected as %, and only %, the owner of %, gives PUBLIC its CONNECT back', current_user, owner_name, db;
  END IF;
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO PUBLIC', db);
  IF NOT has_database_privilege('public', db, 'CONNECT') THEN
    RAISE EXCEPTION 'PUBLIC does not hold CONNECT on % after the grant', db;
  END IF;
END
$open$;

COMMIT;

SELECT 'shared database ' || current_database() || ': open to PUBLIC';
