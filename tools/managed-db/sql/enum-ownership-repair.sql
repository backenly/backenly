-- ============================================================================
-- Converge the ownership of the platform's enum types onto the application role
-- ============================================================================
--
-- For databases that ALREADY completed the app-role cutover. The cutover moved
-- public relations and functions to backenly_app but not types, so every enum
-- stayed with the admin role that created it. Nothing noticed until
-- 20260924120000_project_pause ran `ALTER TYPE "WebhookDeliveryStatus" ADD VALUE`
-- as backenly_app on staging:
--
--   ERROR: must be owner of type "WebhookDeliveryStatus"   (42501)
--
-- app-role-cutover.sql now moves enums as well. This file repairs the databases
-- that were cut over before it did, WITHOUT re-running the cutover. The cutover
-- rotates the application password and stages a new secret. This touches
-- neither.
--
-- ── What it does ────────────────────────────────────────────────────────────
--
-- Exactly one kind of statement: `ALTER TYPE <enum> OWNER TO <app role>`, for
-- each enum in `public` that the connected admin role owns. It discovers them
-- from the catalog rather than naming them, so an enum added later is covered.
-- Extension-owned types are excluded, since they follow their extension.
-- It never touches a role, a password, a secret, a grant, a table or a row.
-- scripts/run-enum-ownership-repair.ts audits this file for that vocabulary
-- before sending it anywhere.
--
-- ── Settings (written by the launcher as a preamble, never by hand) ─────────
--
--   backenly.repair_apply              'false' reports, 'true' repairs
--   backenly.repair_expect_database    the database this may touch
--   backenly.repair_expect_app_role    the application role, which must ALSO
--                                      be what public.backenly_app_role()
--                                      resolves to
--
-- Every one is required. A missing setting refuses rather than defaulting.
--
-- ── Guarantees ─────────────────────────────────────────────────────────────
--
--   Report first:  'false' prints the plan (current owner -> desired owner) and
--                  changes nothing.
--   Idempotent:    a second apply finds nothing owned by the admin role and
--                  moves nothing.
--   Fail closed:   an enum owned by a THIRD role, neither the admin nor the app
--                  role, is not something this understands. It refuses the
--                  whole run instead of skipping that enum.
--   Proved:        after an apply, every enum must be owned by the app role,
--                  checked in the same transaction, or the run fails and rolls
--                  back.

DO $$
DECLARE
  apply_setting text := current_setting('backenly.repair_apply', true);
  expect_db     text := current_setting('backenly.repair_expect_database', true);
  expect_app    text := current_setting('backenly.repair_expect_app_role', true);
  admin         text := current_user;
  app_role      text;
  role_row      record;
  r             record;
  will_move     int  := 0;
  moved         int  := 0;
  wrong_after   int  := 0;
  unexpected    text := '';
BEGIN
  -- ── Where am I, and on whose behalf ───────────────────────────────────────
  IF apply_setting IS NULL OR apply_setting NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'refusing: backenly.repair_apply must be exactly true or false';
  END IF;
  IF coalesce(expect_db, '') = '' THEN
    RAISE EXCEPTION 'refusing: backenly.repair_expect_database is not set';
  END IF;
  IF current_database() <> expect_db THEN
    RAISE EXCEPTION 'refusing: connected to database %, expected %', current_database(), expect_db;
  END IF;
  IF coalesce(expect_app, '') = '' THEN
    RAISE EXCEPTION 'refusing: backenly.repair_expect_app_role is not set';
  END IF;

  -- The configured application role, from the one seam the platform uses for
  -- it. It must agree with what the operator expected: two answers that differ
  -- mean something is misconfigured, and this is not the place to pick one.
  IF to_regprocedure('public.backenly_app_role()') IS NULL THEN
    RAISE EXCEPTION 'refusing: public.backenly_app_role() does not exist, so no application role is configured here';
  END IF;
  app_role := public.backenly_app_role();
  IF app_role IS DISTINCT FROM expect_app THEN
    RAISE EXCEPTION 'refusing: public.backenly_app_role() resolves to %, but % was expected', app_role, expect_app;
  END IF;
  IF app_role = admin THEN
    RAISE EXCEPTION 'refusing: the application role is the connected admin role %, so there is nothing to separate', admin;
  END IF;

  SELECT rolsuper, rolbypassrls INTO role_row FROM pg_roles WHERE rolname = app_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refusing: role % does not exist', app_role;
  END IF;
  -- Never hand anything to a widened role. The application role is NOSUPERUSER
  -- NOBYPASSRLS by design, and if it is not, the problem is bigger than enums.
  IF role_row.rolsuper OR role_row.rolbypassrls THEN
    RAISE EXCEPTION 'refusing: % is SUPERUSER or BYPASSRLS, which the application role must never be', app_role;
  END IF;

  RAISE NOTICE 'enum ownership repair: % on database %, connected as %, application role %',
    CASE apply_setting WHEN 'true' THEN 'APPLY' ELSE 'REPORT' END, current_database(), admin, app_role;

  -- ── Before ───────────────────────────────────────────────────────────────
  FOR r IN
    SELECT format('%I.%I', n.nspname, t.typname) AS ident, pg_get_userbyid(t.typowner) AS owner
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'e'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
     ORDER BY t.typname
  LOOP
    IF r.owner = app_role THEN
      RAISE NOTICE 'before  %  owner % -> % (already correct)', r.ident, r.owner, app_role;
    ELSIF r.owner = admin THEN
      RAISE NOTICE 'before  %  owner % -> % (will move)', r.ident, r.owner, app_role;
      will_move := will_move + 1;
    ELSE
      RAISE NOTICE 'before  %  owner % -> % (UNEXPECTED OWNER)', r.ident, r.owner, app_role;
      unexpected := unexpected || E'\n  ' || r.ident || ' is owned by ' || r.owner;
    END IF;
  END LOOP;

  IF unexpected <> '' THEN
    RAISE EXCEPTION 'refusing: enum types owned by neither % nor %; investigate before repairing anything:%',
      admin, app_role, unexpected;
  END IF;

  -- ── The repair ───────────────────────────────────────────────────────────
  IF apply_setting = 'true' THEN
    FOR r IN
      SELECT format('%I.%I', n.nspname, t.typname) AS ident
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'
         AND t.typowner = admin::regrole
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
       ORDER BY t.typname
    LOOP
      EXECUTE format('ALTER TYPE %s OWNER TO %I', r.ident, app_role);
      moved := moved + 1;
    END LOOP;
  END IF;

  -- ── After ────────────────────────────────────────────────────────────────
  FOR r IN
    SELECT format('%I.%I', n.nspname, t.typname) AS ident, pg_get_userbyid(t.typowner) AS owner
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'e'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
     ORDER BY t.typname
  LOOP
    RAISE NOTICE 'after   %  owner %', r.ident, r.owner;
    IF r.owner <> app_role THEN
      wrong_after := wrong_after + 1;
    END IF;
  END LOOP;

  IF apply_setting = 'true' AND wrong_after > 0 THEN
    RAISE EXCEPTION 'repair incomplete: % enum type(s) are still not owned by %', wrong_after, app_role;
  END IF;

  RAISE NOTICE 'REPAIR_RESULT mode=% would_move=% moved=% not_owned_by_app_role=%',
    CASE apply_setting WHEN 'true' THEN 'apply' ELSE 'report' END, will_move, moved, wrong_after;
END $$;
