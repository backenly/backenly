-- Can the credential this runner connected with alter everything a migration may alter?
--
-- Run by the entrypoint BEFORE `migrate deploy`, and on its own as `preflight`.
-- It reads the catalog and changes nothing.
--
-- Why it exists: on 2026-09-24 staging's `migrate deploy` of
-- 20260924120000_project_pause failed on its first statement,
--
--   ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'CANCELLED'
--   ERROR: must be owner of type "WebhookDeliveryStatus"   (42501)
--
-- because the app-role cutover had moved the tables to backenly_app but left
-- every enum with the RDS master. Nothing was applied, but Prisma had already
-- written a FAILED row into _prisma_migrations, and a failed row refuses every
-- later deploy until someone resolves it. The failure was discoverable from the
-- catalog before Prisma started, so this asks the catalog first.
--
-- It does not parse migrations. It checks the whole class instead: every
-- object Prisma manages in `public` (tables, sequences, views, and user-defined
-- types) must be alterable by current_user, meaning owned by it or by a role
-- whose privileges it inherits, which is PostgreSQL's own ownership test.
-- Pending migrations can only ALTER objects that already exist, and every
-- existing one is in this set, so a clean pass covers any pending migration
-- without reading it.
--
-- Excluded, each for a stated reason:
--   extension members           they follow their extension; RDS owns
--                               pg_stat_statements' views, and no migration
--                               alters them.
--   identity-internal relations they follow their parent table.
--   backenly_pgrst_schema_registry
--                               provisioning, not migrations. It stays with the
--                               elevated role on purpose (see
--                               tools/managed-db/sql/app-role-cutover.sql).
--   workspace_* schemas         tenant objects with per-project owners; no
--                               platform migration touches them.
--
-- The failure lists every offender by name and owner, so the message tells the
-- operator exactly what to repair.

DO $$
DECLARE
  problems text := '';
  r record;
BEGIN
  IF NOT has_schema_privilege(current_user, 'public', 'CREATE') THEN
    problems := problems || E'\n  schema public: ' || current_user || ' has no CREATE';
  END IF;

  FOR r IN
    SELECT 'type' AS kind, format('%I.%I', n.nspname, t.typname) AS ident, t.typowner AS owner
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       -- enum, domain, range, multirange, and STANDALONE composites. A table's
       -- own row type is a composite too, and it follows the table.
       AND (t.typtype IN ('e', 'd', 'r', 'm')
            OR (t.typtype = 'c'
                AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'relation', format('%I.%I', n.nspname, c.relname), c.relowner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
       AND c.relname <> 'backenly_pgrst_schema_registry'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'i'))
     ORDER BY 1, 2
  LOOP
    IF NOT pg_has_role(current_user, r.owner, 'USAGE') THEN
      problems := problems || E'\n  ' || r.kind || ' ' || r.ident || ' is owned by ' || pg_get_userbyid(r.owner);
    END IF;
  END LOOP;

  IF problems <> '' THEN
    RAISE EXCEPTION 'ownership preflight: % cannot alter every migration-managed object:%', current_user, problems;
  END IF;
END $$;
