/**
 * The restore point: what a workspace schema's tables are, read from the
 * PostgreSQL catalog precisely enough to put them back.
 *
 * ── Why this is not workspace-schema-snapshot.ts ────────────────────────────
 *
 * That snapshot reads `information_schema.columns.data_type`, which is the
 * type's family, not the type: `character varying` without its length,
 * `numeric` without precision, `ARRAY` for every array and `USER-DEFINED` for
 * every enum. It is fine for describing a schema and unusable for restoring
 * one: a column re-created from it is a different column. It also takes about
 * eight queries per table.
 *
 * This reads the catalog itself, in ONE statement, so the whole schema is
 * captured from a single MVCC snapshot. Every definition is produced by
 * PostgreSQL's own deparser (`format_type`, `pg_get_constraintdef`,
 * `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_expr`) with `search_path`
 * pinned to `pg_catalog`, so each one is schema-qualified and replays exactly,
 * whatever search_path the statement that replays it runs under.
 *
 * ── What a table is, here ───────────────────────────────────────────────────
 *
 * Its columns (exact type, nullability, default, identity, generation), its
 * constraints, the indexes that are not owned by a constraint, its row-level
 * security switches and policies, its triggers, and its grants.
 *
 * ── And beside the tables ───────────────────────────────────────────────────
 *
 * Views, materialized views, functions and enum types, each with the statement
 * that re-creates it. They are captured because a change can remove them
 * without naming them: `DROP COLUMN … CASCADE` takes every view that reads the
 * column with it, and a change recorded only in terms of tables would report
 * that as a clean column drop. Objects that belong to an extension are left
 * out; the extension owns them.
 *
 * `oid` and `attnum` are kept because they are how a rename is told apart from
 * a drop and an add: both survive `RENAME`, and neither survives a re-create.
 */

export interface ColumnState {
  name: string
  attnum: number
  /** format_type: `character varying(120)`, `numeric(10,2)`, `text[]`. */
  type: string
  notNull: boolean
  /** Default expression; null for none, and always null for a generated column. */
  default: string | null
  /** '' | 'a' (ALWAYS) | 'd' (BY DEFAULT) */
  identity: string
  /** The generation expression of a STORED generated column, else null. */
  generated: string | null
}

export interface ConstraintState {
  name: string
  /** p primary key · u unique · c check · f foreign key · x exclusion */
  type: string
  /** pg_get_constraintdef: everything after `ADD CONSTRAINT <name>`. */
  definition: string
  columns: string[]
  /** For a foreign key, the table it references. */
  refTable: string | null
  refSchema: string | null
}

export interface IndexState {
  name: string
  /** pg_get_indexdef: a complete CREATE INDEX statement. */
  definition: string
  unique: boolean
}

export interface PolicyState {
  name: string
  /** r SELECT · a INSERT · w UPDATE · d DELETE · * ALL */
  cmd: string
  permissive: boolean
  roles: string[]
  using: string | null
  check: string | null
}

export interface TriggerState {
  name: string
  /** pg_get_triggerdef: a complete CREATE TRIGGER statement. */
  definition: string
  /** O enabled · D disabled · R replica · A always */
  enabled: string
}

export interface GrantState {
  grantee: string
  privilege: string
}

export interface TableState {
  name: string
  oid: number
  columns: ColumnState[]
  constraints: ConstraintState[]
  indexes: IndexState[]
  rls: { enabled: boolean; forced: boolean }
  policies: PolicyState[]
  triggers: TriggerState[]
  /** Privileges held by roles other than the owner. */
  grants: GrantState[]
  comment: string | null
}

export interface ObjectState {
  /** view · materialized_view · function · type (an enum or a domain: see isDomain) */
  kind: 'view' | 'materialized_view' | 'function' | 'type'
  name: string
  /** Unique within the schema: the name, or for a function `name(argument types)`. */
  identity: string
  /**
   * What defines it: a view's query (pg_get_viewdef), a function's complete
   * CREATE OR REPLACE FUNCTION (pg_get_functiondef), an enum's CREATE TYPE, a
   * domain's CREATE DOMAIN.
   */
  definition: string
  /** A view's reloptions, e.g. `security_invoker=true`. */
  options: string[]
}

export interface CatalogSnapshot {
  schema: string
  capturedAt: string
  tables: Record<string, TableState>
  /** Keyed by identity. Absent on snapshots taken before objects were captured. */
  objects?: Record<string, ObjectState>
}

/** Anything that can run one parameterised query and hand back its rows. */
export interface QueryRunner {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

/**
 * Backenly's own plumbing in a workspace schema, which no change makes and no
 * restore puts back: row-event capture for webhooks and functions, derived
 * from their rows by lib/webhooks/capture.ts, and presence, set up by
 * server/routes/presence.ts. Each is kept by its own sync, outside the lock.
 * Read as part of a table, every capture sync would make the table look
 * changed since and block its restores, and a restore could take the trigger
 * away and silently stop delivery. Left out the way other roles' grants are;
 * a restore asks the sync to look again (lib/changes/freshness.ts).
 * Realtime's trigger is not here: it is turned on and off by a person, and
 * lives only in the trigger, so it belongs to the history.
 */
export const CAPTURE_TRIGGER = 'backenly_webhook_capture'
export const PLATFORM_OBJECTS = {
  tables: ['_backenly_webhook_outbox', '_backenly_presence'],
  triggers: [CAPTURE_TRIGGER, 'backenly_presence_notify'],
  functions: ['backenly_capture_webhook_event', 'backenly_notify_presence'],
} as const

const sqlNames = (names: readonly string[]) => `ARRAY[${names.map((n) => `'${n}'`).join(', ')}]::name[]`

/**
 * The whole schema in one statement. Kept as one statement on purpose: a
 * catalog read split across several queries can observe a DDL commit between
 * them and describe a schema that never existed.
 */
const CATALOG_SQL = `
SELECT
(SELECT coalesce(json_agg(t ORDER BY t.name), '[]'::json)
FROM (
  SELECT
    c.oid::bigint AS oid,
    c.relname AS name,
    c.relrowsecurity AS rls_enabled,
    c.relforcerowsecurity AS rls_forced,
    obj_description(c.oid, 'pg_class') AS comment,
    (
      SELECT coalesce(json_agg(json_build_object(
        'name', a.attname,
        'attnum', a.attnum,
        'type', format_type(a.atttypid, a.atttypmod),
        'notNull', a.attnotnull,
        'default', CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
        'identity', a.attidentity::text,
        'generated', CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END
      ) ORDER BY a.attnum), '[]'::json)
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    ) AS columns,
    (
      SELECT coalesce(json_agg(json_build_object(
        'name', con.conname,
        'type', con.contype::text,
        'definition', pg_get_constraintdef(con.oid),
        'columns', (
          SELECT coalesce(json_agg(att.attname ORDER BY k.ord), '[]'::json)
          FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
        ),
        'refTable', fc.relname,
        'refSchema', fn.nspname
      ) ORDER BY con.conname), '[]'::json)
      FROM pg_constraint con
      LEFT JOIN pg_class fc ON fc.oid = con.confrelid
      LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE con.conrelid = c.oid AND con.contype IN ('p', 'u', 'c', 'f', 'x')
    ) AS constraints,
    (
      SELECT coalesce(json_agg(json_build_object(
        'name', ic.relname,
        'definition', pg_get_indexdef(i.indexrelid),
        'unique', i.indisunique
      ) ORDER BY ic.relname), '[]'::json)
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = c.oid
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint x
          WHERE x.conindid = i.indexrelid AND x.conrelid = c.oid AND x.contype IN ('p', 'u', 'x')
        )
    ) AS indexes,
    (
      SELECT coalesce(json_agg(json_build_object(
        'name', pol.polname,
        'cmd', pol.polcmd::text,
        'permissive', pol.polpermissive,
        'roles', (
          SELECT coalesce(json_agg(coalesce(r.rolname::text, 'public') ORDER BY coalesce(r.rolname::text, 'public')), '[]'::json)
          FROM unnest(pol.polroles) AS pr(roid)
          LEFT JOIN pg_roles r ON r.oid = pr.roid
        ),
        'using', pg_get_expr(pol.polqual, pol.polrelid),
        'check', pg_get_expr(pol.polwithcheck, pol.polrelid)
      ) ORDER BY pol.polname), '[]'::json)
      FROM pg_policy pol
      WHERE pol.polrelid = c.oid
    ) AS policies,
    (
      SELECT coalesce(json_agg(json_build_object(
        'name', tg.tgname,
        'definition', pg_get_triggerdef(tg.oid),
        'enabled', tg.tgenabled::text
      ) ORDER BY tg.tgname), '[]'::json)
      FROM pg_trigger tg
      WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal AND tg.tgname <> ALL (${sqlNames(PLATFORM_OBJECTS.triggers)})
    ) AS triggers,
    (
      SELECT coalesce(json_agg(json_build_object(
        'grantee', CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid = g.grantee) END,
        'privilege', g.privilege_type
      ) ORDER BY g.grantee, g.privilege_type), '[]'::json)
      FROM aclexplode(c.relacl) AS g
      WHERE g.grantee <> c.relowner
    ) AS grants
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND c.relname <> ALL (${sqlNames(PLATFORM_OBJECTS.tables)})
) t) AS tables,
(SELECT coalesce(json_agg(o ORDER BY o.identity), '[]'::json)
FROM (
  SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'materialized_view' END AS kind,
         c.relname AS name,
         c.relname AS identity,
         pg_get_viewdef(c.oid, true) AS definition,
         coalesce(to_json(c.reloptions), '[]'::json) AS options
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'function',
         p.proname,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         pg_get_functiondef(p.oid),
         '[]'::json
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
     AND p.proname <> ALL (${sqlNames(PLATFORM_OBJECTS.functions)})
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'type',
         t.typname,
         t.typname,
         'CREATE TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname) || ' AS ENUM (' ||
           coalesce((SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '') || ')',
         '[]'::json
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = $1 AND t.typtype = 'e'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'type',
         t.typname,
         t.typname,
         'CREATE DOMAIN ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname) || ' AS ' || format_type(t.typbasetype, t.typtypmod) ||
           CASE WHEN t.typdefaultbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(t.typdefaultbin, 0) ELSE '' END ||
           CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END ||
           coalesce((SELECT string_agg(' CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid), '' ORDER BY c.conname)
                       FROM pg_constraint c WHERE c.contypid = t.oid), ''),
         '[]'::json
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = $1 AND t.typtype = 'd'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
) o) AS objects
`

interface RawTable {
  oid: number | string
  name: string
  rls_enabled: boolean
  rls_forced: boolean
  comment: string | null
  columns: ColumnState[]
  constraints: ConstraintState[]
  indexes: IndexState[]
  policies: PolicyState[]
  triggers: TriggerState[]
  grants: GrantState[]
}

/**
 * Read every table in `schema`.
 *
 * The runner must already have `search_path` pinned to `pg_catalog` for the
 * definitions to come back schema-qualified; `readCatalogOn` and the runners in
 * lib/changes/lock.ts do that. A runner that has not would still read the right
 * tables, but its definitions would name objects relative to whatever path the
 * connection happened to have.
 */
export async function readCatalog(runner: QueryRunner, schema: string): Promise<CatalogSnapshot> {
  const rows = await runner.query<{ tables: RawTable[] | string; objects: ObjectState[] | string }>(CATALOG_SQL, [schema])
  const raw = rows[0]?.tables ?? []
  const list: RawTable[] = typeof raw === 'string' ? JSON.parse(raw) : raw
  const rawObjects = rows[0]?.objects ?? []
  const objectList: ObjectState[] = typeof rawObjects === 'string' ? JSON.parse(rawObjects) : rawObjects
  const objects: Record<string, ObjectState> = {}
  for (const o of objectList) {
    objects[o.identity] = { kind: o.kind, name: o.name, identity: o.identity, definition: o.definition, options: o.options ?? [] }
  }
  const tables: Record<string, TableState> = {}
  for (const t of list) {
    tables[t.name] = {
      name: t.name,
      oid: Number(t.oid),
      columns: t.columns ?? [],
      constraints: t.constraints ?? [],
      indexes: t.indexes ?? [],
      rls: { enabled: t.rls_enabled === true, forced: t.rls_forced === true },
      policies: t.policies ?? [],
      triggers: t.triggers ?? [],
      grants: t.grants ?? [],
      comment: t.comment ?? null,
    }
  }
  return { schema, capturedAt: new Date().toISOString(), tables, objects }
}

/**
 * Only the named tables and objects, for storing the part of a snapshot a
 * change touched.
 */
export function pickTables(
  snapshot: CatalogSnapshot,
  names: Iterable<string>,
  objectIdentities: Iterable<string> = [],
): CatalogSnapshot {
  const tables: Record<string, TableState> = {}
  for (const name of names) {
    const t = snapshot.tables[name]
    if (t) tables[name] = t
  }
  const objects: Record<string, ObjectState> = {}
  for (const id of objectIdentities) {
    const o = snapshot.objects?.[id]
    if (o) objects[id] = o
  }
  return { schema: snapshot.schema, capturedAt: snapshot.capturedAt, tables, objects }
}

/** A type captured as a domain rather than an enum: it is dropped with DROP DOMAIN. */
export function isDomain(o: Pick<ObjectState, 'kind' | 'definition'>): boolean {
  return o.kind === 'type' && o.definition.startsWith('CREATE DOMAIN ')
}

/** An enum's labels in order, read from the CREATE TYPE the catalog built; null for anything else. */
export function enumLabels(o: Pick<ObjectState, 'kind' | 'definition'> | undefined): string[] | null {
  if (!o || o.kind !== 'type') return null
  const at = o.definition.indexOf(' AS ENUM (')
  if (!o.definition.startsWith('CREATE TYPE ') || at < 0) return null
  return [...o.definition.slice(at).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
}

/** Objects compare equal when they would behave the same: kind, definition, options. */
export function sameObject(a: ObjectState, b: ObjectState): boolean {
  return a.kind === b.kind && a.definition === b.definition && JSON.stringify([...a.options].sort()) === JSON.stringify([...b.options].sort())
}

// ── Comparison ───────────────────────────────────────────────────────────────

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** The data plane's soft-delete policy (backenly_pgrst_apply_soft_delete). */
export const DATA_PLANE_POLICY = 'bkn_pgrst_soft_delete'

/** The owner default backenly_pgrst_apply_owner_defaults sets, as pg_get_expr renders it. */
const DATA_PLANE_OWNER_DEFAULT = /^\(?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\.backenly_jwt_claim\('sub'::text\)\)?(?:::uuid)?$/

const comparableDefault = (d: string | null | undefined) =>
  d != null && DATA_PLANE_OWNER_DEFAULT.test(d) ? null : d

/**
 * The parts of a table a rollback promises to restore, in a form that compares
 * equal exactly when two tables are the same table to a client.
 *
 * Deliberately left out:
 *   - oid and attnum: a table restored by re-creating it, or a column re-added,
 *     is the same table to every query even though both numbers change;
 *   - column order: a re-added column lands at the end, and nothing addresses
 *     columns by position;
 *   - grants: the data-plane installer re-grants every table in a schema each
 *     time any table is created there, and direct-access roles are granted on
 *     every table when they are issued, so grants move for reasons that have
 *     nothing to do with this table. They are restored, but not compared.
 *   - comments, which describe and do not decide.
 *   - what the same installer adds to a table it serves, by its own sync
 *     (scripts/sql/postgrest-schema-registry.sql): the soft-delete policy and
 *     the owner column's default to the caller's `sub` claim. Registering a
 *     schema again (the PGRST106 self-heal, the schema_not_registered repair)
 *     adds both to every table outside any change, and compared, they made
 *     every earlier change "changed since" and refused its restore.
 */
export function tableSignature(t: TableState): string {
  return JSON.stringify({
    columns: [...t.columns].sort(byName).map((c) => [c.name, c.type, c.notNull, comparableDefault(c.default), c.identity, c.generated]),
    constraints: [...t.constraints].sort(byName).map((c) => [c.name, c.type, c.definition]),
    indexes: [...t.indexes].sort(byName).map((i) => [i.name, i.definition]),
    rls: [t.rls.enabled, t.rls.forced],
    policies: [...t.policies].filter((p) => p.name !== DATA_PLANE_POLICY).sort(byName)
      .map((p) => [p.name, p.cmd, p.permissive, [...p.roles].sort(), p.using, p.check]),
    triggers: [...t.triggers].sort(byName).map((g) => [g.name, g.definition, g.enabled]),
  })
}

export function sameTable(a: TableState, b: TableState): boolean {
  return tableSignature(a) === tableSignature(b)
}

/**
 * The roles the REST API serves requests as. Their privileges on a table are
 * the API's access to it, so a change that takes one away has changed the
 * table, and its restore gives it back. Every other role's grants (direct
 * access, backups) are kept by their own sync (lib/services/direct-access.ts)
 * and stay out of both: the reason grants are left out of tableSignature.
 */
export const API_GRANTEES: ReadonlySet<string> = new Set(['anon', 'authenticated', 'service_role'])

/** The API roles' privileges `then` held that `now` does not. */
export function apiGrantsRemoved(then: TableState, now: TableState): GrantState[] {
  const held = new Set(now.grants.map((g) => `${g.grantee}\u0000${g.privilege}`))
  return then.grants.filter((g) => API_GRANTEES.has(g.grantee) && !held.has(`${g.grantee}\u0000${g.privilege}`))
}
