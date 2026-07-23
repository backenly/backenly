-- PHASE 3 — let the application register new workspace schemas with PostgREST
-- without holding any privilege that would let it do anything else.
--
-- PostgREST's `db-schemas` is a STATIC list. A schema created after PostgREST
-- started is invisible to it: requests for that project return 404 with no
-- indication that the cause is configuration rather than a missing table. Every
-- new project would therefore be born broken until someone edited a root-owned
-- file and reloaded.
--
-- PostgREST also reads its configuration FROM THE DATABASE (`db-config`, on by
-- default) via settings stamped on the authenticator role, and re-reads them on
-- `NOTIFY pgrst, 'reload config'`. That turns schema registration into a SQL
-- operation — which the app can perform, and which is transactional.
--
-- The catch: `ALTER ROLE ... SET` requires superuser. Granting the app superuser
-- to solve a list-append is wildly disproportionate — it would hand the runtime
-- the ability to read every tenant's data and disable RLS outright. So the
-- privilege is confined to exactly this operation with SECURITY DEFINER, and the
-- argument is validated rather than trusted, since it is concatenated into a
-- role-level setting.
--
-- ── THE DANGLING-SCHEMA OUTAGE ──────────────────────────────────────────────
-- A registered schema that no longer exists does not degrade one tenant; it
-- takes down ALL of them. PostgREST builds ONE schema cache covering every entry
-- in `db-schemas`, so a single missing schema fails the whole rebuild and every
-- request from every project gets:
--
--   503  {"code":"PGRST002","message":"Could not query the database for the
--         schema cache. Retrying."}
--
-- Verified on this server, not inferred. Deleting one project would otherwise
-- have taken down every other project's backend, with a symptom that points at
-- PostgREST rather than at the deletion that caused it.
--
-- Because the blast radius is cross-tenant, correctness here cannot rest on
-- remembering to call unregister. Two mechanisms make dangling entries
-- structurally impossible:
--
--   1. an EVENT TRIGGER prunes the list automatically whenever ANY schema is
--      dropped, whatever code path did the dropping;
--   2. register/reload prune first, so a list that somehow drifted is repaired
--      by the next ordinary operation rather than staying broken.
--
-- Run as superuser:
--   psql -d backenly -f postgrest-schema-registry.sql

-- ── Internal: read the current list ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.backenly_pgrst_current_schemas()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT COALESCE(
    split_part(
      (SELECT s.setting
         FROM pg_db_role_setting r
         CROSS JOIN LATERAL unnest(r.setconfig) AS s(setting)
        WHERE r.setrole = (SELECT oid FROM pg_roles WHERE rolname = 'backenly_authenticator')
          AND s.setting LIKE 'pgrst.db_schemas=%'
        LIMIT 1),
      '=', 2),
    '')
$fn$;

-- ── Internal: drop entries whose schema no longer exists ────────────────────
-- Returns the pruned list. Never notifies on its own; callers decide when a
-- reload is appropriate so a prune inside a larger operation reloads once.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_prune_schemas()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  current_list text;
  kept         text;
BEGIN
  current_list := public.backenly_pgrst_current_schemas();
  IF current_list IS NULL OR current_list = '' THEN
    RETURN '';
  END IF;

  SELECT string_agg(name, ',' ORDER BY ord)
    INTO kept
    FROM unnest(string_to_array(current_list, ',')) WITH ORDINALITY AS t(name, ord)
   WHERE EXISTS (
     SELECT 1 FROM information_schema.schemata WHERE schema_name = t.name
   );

  kept := COALESCE(kept, '');

  IF kept IS DISTINCT FROM current_list THEN
    EXECUTE format('ALTER ROLE backenly_authenticator SET pgrst.db_schemas = %L', kept);
  END IF;

  RETURN kept;
END;
$fn$;

-- ── Internal: keep platform-internal tables out of PostgREST ────────────────
-- PostgREST exposes EVERY table the role can reach. The legacy executor never
-- had that property: it served only tables with a generated ApiDefinition, so
-- `users` was unreachable because nothing generated an API for it.
--
-- That difference is not cosmetic. Verified against this server, a service-role
-- request for `users` returned rows including the bcrypt `password` column. The
-- gateway could filter those, but a leak this severe should not depend on
-- application code being correct — so the privilege is removed in the database,
-- where no gateway bug, forgotten flag or direct connection can reintroduce it.
--
-- Applied on every registration rather than once at setup, because
-- ALTER DEFAULT PRIVILEGES grants on FUTURE tables: a project that creates its
-- `users` table after setup ran would otherwise be granted access automatically.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_revoke_internal(target_schema text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  t       text;
  revoked integer := 0;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = target_schema
       -- `users` holds end-user credentials; `_`-prefixed tables are platform
       -- internals (_token_blacklist, _backenly_presence, migration bookkeeping).
       AND (table_name = 'users' OR table_name LIKE '\_%')
  LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM anon, authenticated, service_role', target_schema, t);
    revoked := revoked + 1;
  END LOOP;
  RETURN revoked;
END;
$fn$;

-- ── Internal: soft-delete parity ────────────────────────────────────────────
-- The legacy executor appends `deleted_at IS NULL` to every list, get and
-- search. PostgREST has no such concept — it returns what the table holds — so
-- cutting a project over without this makes every soft-deleted row readable
-- again. Deleting a record and having it reappear through the new data plane is
-- about the worst trust failure this migration could produce.
--
-- RESTRICTIVE is load-bearing. Policies are PERMISSIVE by default and OR
-- together, so a permissive `deleted_at IS NULL` added next to an existing
-- owner-rows policy would WIDEN access rather than narrow it — every row an
-- owner could see, plus every non-deleted row belonging to anyone. RESTRICTIVE
-- policies AND with the rest, which is the only correct shape for a filter.
--
-- service_role is deliberately not named: owner tooling, restore and the
-- autonomy loop must still see soft-deleted rows, matching the legacy
-- executor's includeSoftDeleted path.
--
-- Only applied where RLS is ALREADY enabled. Enabling it here as a side effect
-- would silently empty any table that has no permissive policy yet, turning a
-- filter into an outage. Tables carrying deleted_at WITHOUT RLS are reported by
-- backenly_pgrst_cutover_blockers() instead, because that is a cutover blocker
-- and not something to paper over.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_apply_soft_delete(target_schema text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  t       record;
  applied integer := 0;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity                       -- RLS on: policies will apply
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'deleted_at' AND a.attnum > 0 AND NOT a.attisdropped
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = target_schema AND p.tablename = c.relname
          AND p.policyname = 'bkn_pgrst_soft_delete'
      )
  LOOP
    EXECUTE format(
      'CREATE POLICY bkn_pgrst_soft_delete ON %I.%I AS RESTRICTIVE FOR SELECT '
      || 'TO anon, authenticated USING (deleted_at IS NULL)',
      target_schema, t.relname);
    applied := applied + 1;
  END LOOP;
  RETURN applied;
END;
$fn$;

-- ── Internal: owner-column defaults ─────────────────────────────────────────
-- The own-rows policy checks `owner::text = backenly_jwt_claim('sub')`, so a
-- client that simply omits the owner column fails WITH CHECK and gets a 403.
-- That is correct RLS and terrible ergonomics: the caller's identity is already
-- in the request, and making every client restate it is both boilerplate and a
-- footgun (nothing stops them restating it WRONG — the policy catches it, but
-- only after a confusing round trip).
--
-- Supabase solves this with `DEFAULT auth.uid()`. Same idea here: default the
-- owner column to the caller's `sub` claim, so an omitted owner is filled in
-- from the token rather than rejected. Verified against the live plane on
-- 2026-07-20: insert WITHOUT the owner column → 403, WITH it → 201.
--
-- A DEFAULT applies ONLY when the column is omitted, so this never overrides an
-- explicit value and cannot be used to spoof ownership — an explicit wrong
-- owner still hits WITH CHECK. For service_role and anon the claim is NULL, so
-- the default yields NULL and a NOT NULL column still (correctly) refuses an
-- ownerless insert.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_apply_owner_defaults(target_schema text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c       record;
  applied integer := 0;
  expr    text;
BEGIN
  FOR c IN
    SELECT cl.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS coltype
    FROM pg_class cl
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = cl.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = cl.oid AND d.adnum = a.attnum
    WHERE n.nspname = target_schema
      AND cl.relkind IN ('r', 'p')
      AND cl.relrowsecurity                    -- only tables RLS actually guards
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname IN ('user_id', 'userid', 'owner_id', 'author_id', 'created_by')
      AND d.adbin IS NULL                      -- never clobber an existing default
      AND format_type(a.atttypid, a.atttypmod) IN ('uuid', 'text', 'character varying')
  LOOP
    -- The claim reader returns text; a uuid column needs the cast or the
    -- DEFAULT is rejected at ALTER time (42804).
    expr := format('%I.backenly_jwt_claim(%L)', target_schema, 'sub');
    IF c.coltype = 'uuid' THEN
      expr := format('(%s)::uuid', expr);
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s',
                   target_schema, c.tbl, c.col, expr);
    applied := applied + 1;
  END LOOP;
  RETURN applied;
END;
$fn$;

-- ── Cutover readiness ───────────────────────────────────────────────────────
-- Returns one row per reason this schema is not safe to serve over PostgREST.
-- An empty result is the only thing that may precede a flag flip. This exists
-- because the dangerous failures here are all SILENT: nothing errors, the
-- dashboard stays green, and more data is visible than before.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_cutover_blockers(target_schema text)
RETURNS TABLE (table_name text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  -- 1. Soft-delete columns that no policy can filter, because RLS is off.
  RETURN QUERY
    SELECT c.relname::text,
           'has deleted_at but RLS is disabled — soft-deleted rows would be readable'::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'deleted_at' AND a.attnum > 0 AND NOT a.attisdropped
      );

  -- 2. ANY client-reachable table without RLS.
  --
  -- This became load-bearing when ApiDefinition stopped gating exposure. Under
  -- the old model a table was unreachable until an ApiDefinition existed for it,
  -- so RLS being off was survivable — two locks, one of them closed. With the
  -- catalog as the only source of truth, grants decide reachability and RLS is
  -- the ONLY row-level protection left. A table without it is readable in full
  -- by anyone holding an API key.
  --
  -- Supabase has the same property and answers it by shouting "RLS disabled" in
  -- the dashboard. A warning is not enough here: agents create tables without a
  -- human watching the screen, so this is a blocker rather than a notice.
  RETURN QUERY
    SELECT c.relname::text,
           'client-reachable but RLS is disabled — every row is readable by any API key'::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
      AND c.relname <> 'users'
      AND c.relname NOT LIKE '\_%'          -- internals are revoked, not RLS-gated
      AND (
        has_table_privilege('anon', c.oid, 'SELECT')
        OR has_table_privilege('authenticated', c.oid, 'SELECT')
      );

  -- 3. Internal tables still reachable by a client role. Re-checked rather than
  --    trusted: this is the account-takeover case, so it is verified against
  --    live privileges instead of assuming the revoke ran.
  RETURN QUERY
    SELECT c.relname::text,
           'internal table is still client-reachable — run backenly_pgrst_revoke_internal'::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema
      AND c.relkind IN ('r', 'p', 'v', 'm')
      AND (c.relname = 'users' OR c.relname LIKE '\_%')
      AND (
        has_table_privilege('anon', c.oid, 'SELECT')
        OR has_table_privilege('authenticated', c.oid, 'SELECT')
      );
END;
$fn$;

-- ── Register a workspace schema ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.backenly_pgrst_register_schema(target_schema text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  current_list text;
  new_list     text;
BEGIN
  -- The argument lands inside an ALTER ROLE ... SET statement, so it is checked
  -- against a strict pattern instead of being escaped. Only workspace schemas
  -- are registrable: without this, the function could be used to expose
  -- `public` — the platform's own Prisma schema, containing every user, project
  -- and API key — through PostgREST.
  --
  -- The pattern is the CANONICAL `workspace_<uuid>` and nothing else. It used to
  -- be `workspace_[a-zA-Z0-9_-]{1,63}`, which also matched the derived schemas
  -- this platform creates beside the real one — `workspace_<uuid>_staging` from
  -- the migration dry-run path, and branch clones. Those are full copies of a
  -- tenant's tables; registering one would serve a shadow of the entire dataset
  -- over the public API, RLS policies and all, under a name no dashboard shows.
  -- Nothing legitimate registers a non-UUID form: workspaceSchemaName() has
  -- always enforced exactly this shape.
  IF target_schema !~ '^workspace_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'Refusing to register schema %: not a canonical workspace schema', target_schema;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = target_schema
  ) THEN
    RAISE EXCEPTION 'Refusing to register schema %: it does not exist', target_schema;
  END IF;

  -- Repair before extending: adding to a list that already contains a dangling
  -- entry would reload straight into the cross-tenant 503 described above.
  current_list := public.backenly_pgrst_prune_schemas();

  -- Grants. Registration used to omit this, on the assumption that
  -- `backenly_pgrst_on_ddl` had already granted as the tables were created.
  -- It had not: that event trigger skips any schema which is not ALREADY in the
  -- registry, so a schema being registered for the first time has none of its
  -- tables granted. Registering without granting swaps PGRST106 for a blanket
  -- 403 — the same outage wearing a different status code.
  --
  -- prepare_schema is idempotent and ends by re-asserting the credential-table
  -- revocation, so this cannot widen access to `users`.
  PERFORM public.backenly_pgrst_prepare_schema(target_schema);

  -- Close credential exposure BEFORE the schema becomes reachable. Revoking
  -- after registration would leave a window in which `users` is servable.
  -- (prepare_schema already did this; repeated because the ordering guarantee
  -- is what matters and it must not depend on another function's last line.)
  PERFORM public.backenly_pgrst_revoke_internal(target_schema);

  -- Same reasoning for soft-deleted rows: the filter has to exist before the
  -- first request can be served, not shortly after.
  PERFORM public.backenly_pgrst_apply_soft_delete(target_schema);

  -- And owner defaults, so the first insert after cutover does not 403 merely
  -- for omitting a column the token already carries.
  PERFORM public.backenly_pgrst_apply_owner_defaults(target_schema);

  -- Idempotent. Compared against the comma-delimited list rather than by
  -- substring, so `workspace_abc` is not considered already-present merely
  -- because `workspace_abcdef` is.
  IF target_schema = ANY (string_to_array(current_list, ',')) THEN
    NOTIFY pgrst, 'reload config';
    NOTIFY pgrst, 'reload schema';
    RETURN current_list;
  END IF;

  IF current_list = '' OR current_list IS NULL THEN
    new_list := target_schema;
  ELSE
    new_list := current_list || ',' || target_schema;
  END IF;

  EXECUTE format(
    'ALTER ROLE backenly_authenticator SET pgrst.db_schemas = %L', new_list
  );

  -- Config first, then schema cache: reloading the cache before the new schema
  -- is in the config would rebuild it without that schema and report success.
  NOTIFY pgrst, 'reload config';
  NOTIFY pgrst, 'reload schema';

  RETURN new_list;
END;
$fn$;

-- ── Unregister ──────────────────────────────────────────────────────────────
-- Called before dropping a schema. The event trigger below covers the case
-- where it is not called at all.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_unregister_schema(target_schema text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  current_list text;
  new_list     text;
BEGIN
  current_list := public.backenly_pgrst_current_schemas();
  IF current_list IS NULL OR current_list = '' THEN
    RETURN '';
  END IF;

  SELECT COALESCE(string_agg(name, ',' ORDER BY ord), '')
    INTO new_list
    FROM unnest(string_to_array(current_list, ',')) WITH ORDINALITY AS t(name, ord)
   WHERE t.name <> target_schema;

  IF new_list IS DISTINCT FROM current_list THEN
    EXECUTE format('ALTER ROLE backenly_authenticator SET pgrst.db_schemas = %L', new_list);
    NOTIFY pgrst, 'reload config';
    NOTIFY pgrst, 'reload schema';
  END IF;

  RETURN new_list;
END;
$fn$;

-- ── Reload without changing the list ────────────────────────────────────────
-- Prunes first so a stale entry cannot survive a reload that was meant to fix
-- things — a reload that reinstates the 503 is worse than no reload at all.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_reload()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM public.backenly_pgrst_prune_schemas();
  NOTIFY pgrst, 'reload config';
  NOTIFY pgrst, 'reload schema';
END;
$fn$;

-- ── Automatic pruning on schema drop ────────────────────────────────────────
-- The structural guarantee. Any DROP SCHEMA — from the app, a migration, a
-- cleanup script, or a human at psql — prunes the registry in the SAME
-- transaction. If the drop rolls back, so does the prune.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_on_schema_drop()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type = 'schema' AND obj.object_name LIKE 'workspace\_%' THEN
      PERFORM public.backenly_pgrst_unregister_schema(obj.object_name);
    END IF;
  END LOOP;
END;
$fn$;

DROP EVENT TRIGGER IF EXISTS backenly_pgrst_schema_drop;
CREATE EVENT TRIGGER backenly_pgrst_schema_drop
  ON sql_drop
  EXECUTE FUNCTION public.backenly_pgrst_on_schema_drop();

-- ── Automatic registration on schema create ─────────────────────────────────
-- The mirror of the drop trigger, and it is here for the same reason: because
-- the correctness of a cross-cutting invariant must not depend on every future
-- code path remembering to call a function.
--
-- It did depend on that, and the bill came due. `backenly_pgrst_register_schema`
-- shipped with the Phase 3 cutover and was wired into the one-off migration
-- script and nowhere else. Six schema-creation paths existed in the application
-- (projects route ×2, workspaceDatabase, workspaceDatabaseSetup,
-- migration-runner, end-user-auth-table) and NOT ONE of them called it. Every
-- project created after the cutover was born with a data plane that answered
--
--   PGRST106  Invalid schema: workspace_<id>
--
-- on every table, forever, while `/auth/*` and `/fn/*` kept working — so the
-- project looked alive and the failure was attributed to the user's own code.
--
-- The application now calls ensureSchemaRegistered() on each of those paths and
-- the runtime self-heals on PGRST106. This trigger is the layer that does not
-- care whether either of those was done correctly: any CREATE SCHEMA matching
-- the canonical name registers in the SAME transaction, whatever created it. If
-- the create rolls back, so does the registration.
--
-- Safe against recursion: `register_schema` performs ALTER ROLE, and Postgres
-- does not fire event triggers for shared objects (roles, databases,
-- tablespaces), so this cannot re-enter itself.
CREATE OR REPLACE FUNCTION public.backenly_pgrst_on_schema_create()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  obj  record;
  name text;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    CONTINUE WHEN obj.command_tag <> 'CREATE SCHEMA';
    CONTINUE WHEN obj.objid IS NULL;

    -- The name is read from the CATALOG, not from `object_identity`.
    --
    -- `object_identity` returns the identifier AS SQL WOULD WRITE IT, which for
    -- a workspace schema means QUOTED — the name contains hyphens, so Postgres
    -- reports `"workspace_7e65…"`, not `workspace_7e65…`. Matching the pattern
    -- below against that string never succeeds, and because the whole function
    -- then falls through silently, the trigger fired correctly on every CREATE
    -- SCHEMA and registered nothing. Caught by round-tripping a real schema on
    -- production rather than by reading the code.
    --
    -- pg_namespace.nspname is the raw name with no quoting decision applied.
    SELECT n.nspname INTO name FROM pg_namespace n WHERE n.oid = obj.objid;
    CONTINUE WHEN name IS NULL;

    -- Canonical names only. Derived schemas (`..._staging`, branch clones) are
    -- full copies of tenant data and must never become client-reachable.
    CONTINUE WHEN name !~
      '^workspace_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    PERFORM public.backenly_pgrst_register_schema(name);
  END LOOP;
END;
$fn$;

DROP EVENT TRIGGER IF EXISTS backenly_pgrst_schema_create;
CREATE EVENT TRIGGER backenly_pgrst_schema_create
  ON ddl_command_end
  WHEN TAG IN ('CREATE SCHEMA')
  EXECUTE FUNCTION public.backenly_pgrst_on_schema_create();

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The app may register, unregister and reload. It may not read or write the
-- underlying role settings by any other route.
REVOKE ALL ON FUNCTION public.backenly_pgrst_current_schemas() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backenly_pgrst_prune_schemas() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backenly_pgrst_apply_owner_defaults(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backenly_pgrst_revoke_internal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backenly_pgrst_revoke_internal(text) TO backenly_user;
REVOKE ALL ON FUNCTION public.backenly_pgrst_register_schema(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backenly_pgrst_unregister_schema(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backenly_pgrst_reload() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.backenly_pgrst_current_schemas() TO backenly_user;
GRANT EXECUTE ON FUNCTION public.backenly_pgrst_register_schema(text) TO backenly_user;
GRANT EXECUTE ON FUNCTION public.backenly_pgrst_unregister_schema(text) TO backenly_user;
GRANT EXECUTE ON FUNCTION public.backenly_pgrst_reload() TO backenly_user;
