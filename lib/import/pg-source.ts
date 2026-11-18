/**
 * Reading a Postgres source's catalog: what lib/import/pg-plan.ts plans from.
 *
 * Every statement here is a SELECT on pg_catalog (or a count of a table the
 * person asked to move), run inside lib/import/net.ts readSnapshot, so it is
 * read-only by construction and by PostgreSQL's own refusal.
 *
 * Types come from format_type() and pg_type, not information_schema, because
 * information_schema says "ARRAY" and "USER-DEFINED" where the planner needs
 * `character varying(50)[]` and `post_status`.
 */

import type { CatalogColumn, CatalogForeignKey, CatalogPolicy, CatalogTable, SourceCatalog } from './pg-plan'
import type { SourceReader } from './net'

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`

/** Over this many estimated rows a table is not counted exactly in the preview. */
export const EXACT_COUNT_LIMIT = 5_000_000

export async function readCatalog(db: SourceReader, schemas: string[]): Promise<SourceCatalog> {
  const tablesRes = await db.query<{
    oid: number
    schema: string
    name: string
    rls: boolean
    hidden: boolean
    partitioned: boolean
    estimate: string
    bytes: string
  }>(
    `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls,
            -- RLS applies to whoever reads, unless they own the table (and it is not
            -- forced), are a superuser, or bypass it: then a copy would be partial.
            (c.relrowsecurity AND NOT (r.rolsuper OR r.rolbypassrls)
              AND (c.relforcerowsecurity OR NOT pg_has_role(current_user, c.relowner, 'USAGE'))) AS hidden,
            c.relkind = 'p' AS partitioned,
            GREATEST(c.reltuples, 0)::bigint::text AS estimate,
            pg_table_size(c.oid)::bigint::text AS bytes
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_roles r ON r.rolname = current_user
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname = ANY($1::text[])
      ORDER BY n.nspname, c.relname`,
    [schemas],
  )
  const oids = tablesRes.rows.map((r) => r.oid)
  // A partitioned table holds nothing itself (pg_table_size says 0): its rows are its partitions'.
  const partitioned = await partitionBytes(db, tablesRes.rows.filter((r) => r.partitioned).map((r) => r.oid))
  const tables = new Map<number, CatalogTable>()
  for (const r of tablesRes.rows) {
    tables.set(r.oid, {
      schema: r.schema,
      name: r.name,
      columns: [],
      primaryKey: [],
      uniques: [],
      foreignKeys: [],
      rlsEnabled: r.rls,
      rowsHidden: r.hidden,
      partitioned: r.partitioned,
      bytes: r.partitioned ? partitioned.get(r.oid) ?? 0 : Number(r.bytes) || 0,
      rows: Number(r.estimate) || 0,
      rowsExact: false,
    })
  }

  if (oids.length > 0) {
    // A domain is read as its base type, and named, so the planner can say what it lost.
    const cols = await db.query<{
      oid: number
      name: string
      formatted: string
      type_name: string
      type_kind: string
      category: string
      element_formatted: string | null
      element_type_name: string | null
      element_kind: string | null
      domain: string | null
      nullable: boolean
      default_expr: string | null
      identity: boolean
      generated: boolean
    }>(
      `SELECT a.attrelid::int AS oid, a.attname AS name,
              CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) ELSE format_type(a.atttypid, a.atttypmod) END AS formatted,
              COALESCE(bt.typname, t.typname) AS type_name,
              COALESCE(bt.typtype, t.typtype)::text AS type_kind,
              COALESCE(bt.typcategory, t.typcategory)::text AS category,
              CASE WHEN COALESCE(bt.typcategory, t.typcategory) = 'A' THEN format_type(COALESCE(bt.typelem, t.typelem), NULL) END AS element_formatted,
              et.typname AS element_type_name,
              et.typtype::text AS element_kind,
              CASE WHEN t.typtype = 'd' THEN format_type(a.atttypid, NULL) END AS domain,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default_expr,
              a.attidentity <> '' AS identity,
              a.attgenerated <> '' AS generated
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_catalog.pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
         LEFT JOIN pg_catalog.pg_type et ON et.oid = COALESCE(bt.typelem, t.typelem) AND COALESCE(bt.typcategory, t.typcategory) = 'A'
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attrelid, a.attnum`,
      [oids],
    )
    for (const c of cols.rows) {
      const t = tables.get(c.oid)
      if (!t) continue
      const col: CatalogColumn = {
        name: c.name,
        formatted: c.formatted,
        typeName: c.type_name,
        typeKind: c.type_kind,
        category: c.category,
        elementFormatted: c.element_formatted,
        elementTypeName: c.element_type_name,
        elementKind: c.element_kind,
        domain: c.domain,
        nullable: c.nullable,
        defaultExpr: c.default_expr,
        identity: c.identity,
        generated: c.generated,
      }
      t.columns.push(col)
    }

    const cons = await db.query<{
      oid: number
      name: string
      type: string
      columns: string[]
      ref_schema: string | null
      ref_table: string | null
      ref_columns: string[] | null
      on_delete: string | null
      on_update: string | null
    }>(
      `SELECT con.conrelid::int AS oid, con.conname AS name, con.contype::text AS type,
              ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS columns,
              rn.nspname AS ref_schema, rc.relname AS ref_table,
              CASE WHEN con.contype = 'f' THEN ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) END AS ref_columns,
              CASE WHEN con.contype = 'f' THEN con.confdeltype::text END AS on_delete,
              CASE WHEN con.contype = 'f' THEN con.confupdtype::text END AS on_update
         FROM pg_catalog.pg_constraint con
         LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
         LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p', 'u', 'f')
        ORDER BY con.conrelid, con.conname`,
      [oids],
    )
    for (const c of cons.rows) {
      const t = tables.get(c.oid)
      if (!t) continue
      if (c.type === 'p') t.primaryKey = c.columns
      else if (c.type === 'u') t.uniques.push(c.columns)
      else if (c.type === 'f' && c.ref_schema && c.ref_table) {
        const fk: CatalogForeignKey = {
          name: c.name,
          columns: c.columns,
          refSchema: c.ref_schema,
          refTable: c.ref_table,
          refColumns: c.ref_columns ?? [],
          onDelete: c.on_delete ?? 'a',
          onUpdate: c.on_update ?? 'a',
        }
        t.foreignKeys.push(fk)
      }
    }

    // Unique indexes that are not constraints (CREATE UNIQUE INDEX on one plain column).
    const idx = await db.query<{ oid: number; column: string }>(
      `SELECT i.indrelid::int AS oid, a.attname::text AS column
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = ANY($1::oid[]) AND i.indisunique AND NOT i.indisprimary AND i.indnatts = 1
          AND i.indexprs IS NULL AND i.indpred IS NULL
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = i.indexrelid)`,
      [oids],
    )
    for (const r of idx.rows) {
      const t = tables.get(r.oid)
      if (t && !t.uniques.some((u) => u.length === 1 && u[0] === r.column)) t.uniques.push([r.column])
    }
  }

  const policies = await db
    .query<{ schema: string; table: string; name: string; permissive: string; roles: string[]; command: string; using: string | null; check: string | null }>(
      `SELECT schemaname AS schema, tablename AS table, policyname AS name, permissive,
              roles::text[] AS roles, cmd AS command, qual AS using, with_check AS check
         FROM pg_catalog.pg_policies
        WHERE schemaname = ANY($1::text[])
        ORDER BY schemaname, tablename, policyname`,
      [schemas],
    )
    .then((r) => r.rows)
  const catalogPolicies: CatalogPolicy[] = policies.map((p) => ({
    schema: p.schema,
    table: p.table,
    name: p.name,
    command: (p.command ?? 'ALL').toUpperCase(),
    permissive: String(p.permissive).toUpperCase() !== 'RESTRICTIVE',
    roles: p.roles ?? [],
    using: p.using,
    check: p.check,
  }))

  // What does not move, counted. Objects an extension installed are not the app's.
  const extra = await db.query<{ functions: string; triggers: string; views: string; matviews: string }>(
    `SELECT
       (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = ANY($1::text[]) AND p.prokind IN ('f', 'p')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))::text AS functions,
       (SELECT count(*) FROM pg_catalog.pg_trigger tg JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY($1::text[]) AND NOT tg.tgisinternal)::text AS triggers,
       (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'v'
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'))::text AS views,
       (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'm')::text AS matviews`,
    [schemas],
  )
  const extensions = await db
    .query<{ name: string }>(`SELECT extname AS name FROM pg_catalog.pg_extension ORDER BY extname`)
    .then((r) => r.rows.map((x) => x.name))

  return {
    tables: [...tables.values()],
    policies: catalogPolicies,
    functions: Number(extra.rows[0]?.functions ?? 0),
    triggers: Number(extra.rows[0]?.triggers ?? 0),
    views: Number(extra.rows[0]?.views ?? 0),
    materializedViews: Number(extra.rows[0]?.matviews ?? 0),
    extensions,
  }
}

/**
 * The bytes under each partitioned table: pg_table_size of every partition and
 * sub-partition, summed, since the partitioned table itself has no storage and
 * measures 0. Through pg_inherits, which every PostgreSQL with partitioning has
 * (pg_partition_tree is 12 and later only).
 */
export async function partitionBytes(db: SourceReader, oids: number[]): Promise<Map<number, number>> {
  if (oids.length === 0) return new Map()
  const r = await db.query<{ oid: number; bytes: string }>(
    `WITH RECURSIVE tree(root, rel) AS (
       SELECT p, p FROM unnest($1::oid[]) AS p
       UNION
       SELECT t.root, i.inhrelid FROM pg_catalog.pg_inherits i JOIN tree t ON i.inhparent = t.rel
     )
     SELECT root::int AS oid, COALESCE(sum(pg_catalog.pg_table_size(rel)), 0)::bigint::text AS bytes
       FROM tree
      GROUP BY root`,
    [oids],
  )
  return new Map(r.rows.map((x) => [Number(x.oid), Number(x.bytes) || 0]))
}

/**
 * The bytes the tables of `schemas` hold, as the plan's limits measure a source
 * (pg_table_size: rows and TOAST, no indexes), partitions counted under their
 * table wherever they live, and each table once.
 */
export async function schemaBytes(db: SourceReader, schemas: string[]): Promise<number> {
  const r = await db.query<{ bytes: string }>(
    `WITH RECURSIVE tree(rel) AS (
       SELECT c.oid
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname = ANY($1::text[])
       UNION
       SELECT i.inhrelid FROM pg_catalog.pg_inherits i JOIN tree t ON i.inhparent = t.rel
     )
     SELECT COALESCE(sum(pg_catalog.pg_table_size(rel)), 0)::bigint::text AS bytes FROM tree`,
    [schemas],
  )
  return Number(r.rows[0]?.bytes ?? 0) || 0
}

/**
 * Exact row counts, for the preview and for verification. A table estimated
 * over EXACT_COUNT_LIMIT keeps its estimate (said "about" in the preview); one
 * whose count runs out of time does too.
 */
export async function countRows(db: SourceReader, tables: CatalogTable[], opts: { all?: boolean } = {}): Promise<void> {
  for (const t of tables) {
    if (!opts.all && t.rows > EXACT_COUNT_LIMIT) continue
    // A savepoint, so a count that runs out of time leaves the snapshot usable.
    await db.query('SAVEPOINT backenly_count')
    try {
      const r = await db.query<{ n: string }>(`SELECT count(*)::bigint::text AS n FROM ${q(t.schema)}.${q(t.name)}`)
      t.rows = Number(r.rows[0]?.n ?? 0)
      t.rowsExact = true
      await db.query('RELEASE SAVEPOINT backenly_count')
    } catch (err: any) {
      await db.query('ROLLBACK TO SAVEPOINT backenly_count')
      // 57014: statement timeout. The estimate stands, said "about".
      if (err?.code !== '57014') throw err
    }
  }
}

/** The schemas present on the source that the person asked for; missing ones are named. */
export async function existingSchemas(db: SourceReader, schemas: string[]): Promise<string[]> {
  const r = await db.query<{ name: string }>(
    `SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])`,
    [schemas],
  )
  const have = new Set(r.rows.map((x) => x.name))
  return schemas.filter((s) => have.has(s))
}

// ── Supabase Auth ─────────────────────────────────────────────────────────────

export interface AuthShape {
  present: boolean
  hasDeletedAt: boolean
  hasIsAnonymous: boolean
  hasIdentities: boolean
  hasProviderId: boolean
}

export async function authShape(db: SourceReader): Promise<AuthShape> {
  const r = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'auth' AND table_name IN ('users', 'identities')`,
  )
  const cols = new Set(r.rows.map((x) => `${x.table_name}.${x.column_name}`))
  return {
    present: cols.has('users.id') && cols.has('users.email'),
    hasDeletedAt: cols.has('users.deleted_at'),
    hasIsAnonymous: cols.has('users.is_anonymous'),
    hasIdentities: cols.has('identities.user_id') && cols.has('identities.provider'),
    hasProviderId: cols.has('identities.provider_id'),
  }
}

/** Social providers: an identity that is not a password or a phone. */
const SOCIAL = `i.provider NOT IN ('email', 'phone')`
export const BCRYPT_HASH = '^\\$2[aby]\\$[0-9]{2}\\$.{53}$'

function liveUsersWhere(shape: AuthShape): string {
  const parts = ['TRUE']
  if (shape.hasDeletedAt) parts.push('u.deleted_at IS NULL')
  if (shape.hasIsAnonymous) parts.push('NOT COALESCE(u.is_anonymous, false)')
  return parts.join(' AND ')
}

export interface AuthCounts {
  total: number
  withPassword: number
  providerOnly: number
  /** Users with an email but no password and no social sign-in (magic link). */
  emailOnly: number
  phoneOnly: number
  anonymous: number
  skipped: number
}

export async function countAuthUsers(db: SourceReader, shape: AuthShape): Promise<AuthCounts> {
  const social = shape.hasIdentities ? `EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND ${SOCIAL})` : 'FALSE'
  const r = await db.query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE ${liveUsersWhere(shape)})::text AS live,
       count(*) FILTER (WHERE ${liveUsersWhere(shape)} AND u.email IS NOT NULL AND u.encrypted_password ~ '${BCRYPT_HASH}')::text AS with_password,
       count(*) FILTER (WHERE ${liveUsersWhere(shape)} AND u.email IS NOT NULL AND NOT COALESCE(u.encrypted_password ~ '${BCRYPT_HASH}', false) AND ${social})::text AS provider_only,
       count(*) FILTER (WHERE ${liveUsersWhere(shape)} AND u.email IS NOT NULL AND NOT COALESCE(u.encrypted_password ~ '${BCRYPT_HASH}', false) AND NOT ${social})::text AS email_only,
       count(*) FILTER (WHERE ${liveUsersWhere(shape)} AND u.email IS NULL AND u.phone IS NOT NULL)::text AS phone_only,
       count(*) FILTER (WHERE ${liveUsersWhere(shape)} AND u.email IS NULL AND u.phone IS NULL)::text AS no_contact,
       ${shape.hasIsAnonymous ? `count(*) FILTER (WHERE COALESCE(u.is_anonymous, false)${shape.hasDeletedAt ? ' AND u.deleted_at IS NULL' : ''})::text` : `'0'`} AS anonymous
     FROM auth.users u`,
  )
  const row = r.rows[0] ?? {}
  const n = (k: string) => Number(row[k] ?? 0)
  const phoneOnly = n('phone_only')
  const anonymous = n('anonymous')
  return {
    total: n('live') + anonymous,
    withPassword: n('with_password'),
    providerOnly: n('provider_only'),
    emailOnly: n('email_only'),
    phoneOnly,
    anonymous,
    skipped: phoneOnly + n('no_contact') + anonymous,
  }
}

export interface AuthUserRow {
  id: string
  email: string
  password: string | null
  verified: boolean
  name: string | null
  avatar_url: string | null
  created_at: string | null
  last_sign_in_at: string | null
  banned: boolean
  provider: string | null
  provider_id: string | null
}

/** The query that reads the users who move, in id order, for a cursor. */
export function authUsersQuery(shape: AuthShape): string {
  const identity = shape.hasIdentities
    ? `LEFT JOIN LATERAL (
         SELECT i.provider, ${shape.hasProviderId ? 'i.provider_id' : `COALESCE(i.identity_data->>'sub', i.id::text)`} AS provider_id
           FROM auth.identities i
          WHERE i.user_id = u.id AND ${SOCIAL}
          ORDER BY i.created_at NULLS LAST
          LIMIT 1
       ) s ON TRUE`
    : `LEFT JOIN LATERAL (SELECT NULL::text AS provider, NULL::text AS provider_id) s ON TRUE`
  return `SELECT u.id::text AS id, lower(u.email) AS email,
                 CASE WHEN u.encrypted_password ~ '${BCRYPT_HASH}' THEN u.encrypted_password END AS password,
                 (u.email_confirmed_at IS NOT NULL) AS verified,
                 NULLIF(COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'), '') AS name,
                 NULLIF(COALESCE(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture'), '') AS avatar_url,
                 u.created_at::text AS created_at,
                 u.last_sign_in_at::text AS last_sign_in_at,
                 COALESCE(u.banned_until > now(), false) AS banned,
                 s.provider, s.provider_id
            FROM auth.users u
            ${identity}
           WHERE ${liveUsersWhere(shape)} AND u.email IS NOT NULL
           ORDER BY u.id`
}
