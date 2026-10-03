-- ============================================================================
-- Layer 1 (managed_provisioning): the app role may create workspace schemas.
-- ============================================================================
--
-- Under the current architecture a project's data lives in
-- `workspace_<projectId>`, and `lib/projects/provision.ts` creates that schema
-- as the application role. That needs CREATE on the DATABASE, which is a role
-- privilege and therefore provisioning state — not schema, and never part of
-- the Prisma canonical baseline, which owns Layer 3 only.
--
-- Measured 2026-09-16: production's `backenly_user` did not hold it, so
-- `CREATE SCHEMA` failed with 42501 and creating any new project threw. The
-- staging bootstrap already issued this GRANT but discarded its output
-- (`>/dev/null 2>&1`) and never verified it, so a failure there would have been
-- invisible too. This script exists to make the privilege explicit, idempotent
-- and SELF-VERIFYING.
--
-- It grants exactly one privilege. It does not grant SUPERUSER, CREATEDB,
-- CREATEROLE or BYPASSRLS, it does not transfer ownership, and it refuses if it
-- finds the role has been broadened by something else.

\set ON_ERROR_STOP on

-- `:enforce` is `false` for a measurement and `true` for a grant. A check run
-- must be able to report that an environment LACKS the privilege without
-- failing: that is the finding, not an error.
\if :{?enforce}
\else
  \set enforce true
\endif

SELECT current_user AS admin_role, current_database() AS database;

SELECT current_database() AS dbname \gset
SELECT has_database_privilege('backenly_user', current_database(), 'CREATE')::text AS before_create \gset
\echo 'before: has_database_privilege(backenly_user, CREATE) =' :before_create

-- Idempotent: granting a privilege the role already holds is a no-op.
GRANT CREATE ON DATABASE :"dbname" TO backenly_user;

SELECT has_database_privilege('backenly_user', current_database(), 'CREATE')::text AS after_create \gset
\echo 'after:  has_database_privilege(backenly_user, CREATE) =' :after_create

-- Carried through a runtime setting, not a psql variable: psql does NOT
-- interpolate `:vars` inside a dollar-quoted block, so the obvious form is a
-- syntax error at run time and nowhere else.
SELECT set_config('backenly.enforce_grant', :'enforce', false);

DO $$
DECLARE
  r record;
  enforce boolean := current_setting('backenly.enforce_grant')::boolean;
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
    INTO r FROM pg_roles WHERE rolname = 'backenly_user';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'backenly_user does not exist in this database';
  END IF;

  IF NOT has_database_privilege('backenly_user', current_database(), 'CREATE') THEN
    IF enforce THEN
      RAISE EXCEPTION 'the GRANT reported success but the privilege is still absent';
    END IF;
    RAISE NOTICE 'backenly_user does NOT hold CREATE on % (measurement only)', current_database();
  END IF;

  -- The narrow fix must stay narrow. If any of these is true, something else
  -- widened the role and that is a finding, not a state to grant on top of.
  IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls THEN
    RAISE EXCEPTION
      'backenly_user is broader than intended: super=% createdb=% createrole=% bypassrls=%',
      r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls;
  END IF;

  IF has_database_privilege('backenly_user', current_database(), 'CREATE') THEN
    RAISE NOTICE 'backenly_user holds CREATE on %, and nothing else was widened', current_database();
  END IF;
END $$;
