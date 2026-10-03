/**
 * Semantic catalog capture.
 *
 * Reads the structure of a database from the PostgreSQL catalogs, never from
 * information_schema alone and never from Prisma, because the catalogs are the
 * source of truth and several properties this comparison depends on (FORCE
 * RLS, policy roles, trigger enablement, SECURITY DEFINER) have no
 * information_schema representation.
 *
 * Every read runs inside one READ ONLY, REPEATABLE READ transaction, so the
 * snapshot is internally consistent and cannot write. `search_path` is pinned to
 * pg_catalog first: the deparse functions qualify names relative to it, and two
 * captures taken under different search paths would disagree textually about
 * identical objects.
 *
 * What is normalised: OIDs (never captured), ordering (every list is sorted),
 * and routine bodies, which are hashed after line-ending and edge-whitespace
 * normalisation. Bodies are hashed rather than returned because provisioning
 * functions on a live database could embed configuration, and this output goes
 * to a log stream.
 *
 * What is NOT normalised: types, nullability, defaults, identity and generation,
 * constraint and index definitions (including predicates and FK actions),
 * policy command, roles and expressions, trigger definitions and enablement,
 * SECURITY DEFINER, volatility and routine configuration.
 */

import { createHash } from 'node:crypto'
import type { PgClient } from './connect'

export interface Snapshot {
  meta: { database: string; serverVersion: string; schemas: string[] }
  schemas: Array<Record<string, unknown>>
  tables: Array<Record<string, unknown>>
  columns: Array<Record<string, unknown>>
  constraints: Array<Record<string, unknown>>
  indexes: Array<Record<string, unknown>>
  types: Array<Record<string, unknown>>
  sequences: Array<Record<string, unknown>>
  policies: Array<Record<string, unknown>>
  triggers: Array<Record<string, unknown>>
  routines: Array<Record<string, unknown>>
  views: Array<Record<string, unknown>>
  eventTriggers: Array<Record<string, unknown>>
  extensions: Array<Record<string, unknown>>
}

export function normaliseBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

export function bodyDigest(body: string | null): string | null {
  return body === null ? null : createHash('sha256').update(normaliseBody(body), 'utf8').digest('base64')
}

const NOT_EXTENSION_MEMBER = (catalog: string, alias: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`

const QUERIES = {
  // A schema with nothing in it still exists, and `backenly_pgrst_idle` is
  // exactly that: load-bearing and empty. Without this, an extra empty schema
  // would have no footprint in the comparison at all.
  schemas: `
    SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner
      FROM pg_namespace n WHERE n.nspname = ANY($1)`,

  tables: `
    SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
           c.relpersistence::text AS persistence, c.relispartition AS partition,
           c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','f')
       AND ${NOT_EXTENSION_MEMBER('pg_class', 'c')}`,

  columns: `
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           tn.nspname AS type_schema, t.typname AS udt, t.typtype::text AS typtype,
           a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr,
           a.attidentity::text AS identity, a.attgenerated::text AS generated,
           CASE WHEN a.attcollation <> t.typcollation THEN co.collname::text END AS collation
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_namespace tn ON tn.oid = t.typnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_collation co ON co.oid = a.attcollation
     WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','f','v','m')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND ${NOT_EXTENSION_MEMBER('pg_class', 'c')}`,

  constraints: `
    SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype::text AS type,
           pg_get_constraintdef(con.oid, true) AS definition,
           con.condeferrable AS deferrable, con.condeferred AS deferred, con.convalidated AS validated
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND ${NOT_EXTENSION_MEMBER('pg_class', 'c')}`,

  indexes: `
    SELECT n.nspname AS schema, t.relname AS table, i.relname AS name,
           pg_get_indexdef(ix.indexrelid) AS definition,
           ix.indisunique AS unique, ix.indisprimary AS primary, am.amname AS method,
           pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
           EXISTS (SELECT 1 FROM pg_constraint con
                    WHERE con.conindid = ix.indexrelid AND con.conrelid = ix.indrelid
                      AND con.contype IN ('p','u','x')) AS constraint_backed
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
     WHERE n.nspname = ANY($1) AND ${NOT_EXTENSION_MEMBER('pg_class', 't')}`,

  types: `
    SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS kind,
           CASE WHEN t.typtype = 'e' THEN
             (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
           END AS labels,
           CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS domain_base,
           CASE WHEN t.typtype = 'd' THEN t.typnotnull END AS domain_not_null,
           CASE WHEN t.typtype = 'd' THEN
             (SELECT array_agg(pg_get_constraintdef(dc.oid, true) ORDER BY dc.conname) FROM pg_constraint dc WHERE dc.contypid = t.oid)
           END AS domain_checks,
           CASE WHEN t.typtype = 'c' THEN
             (SELECT array_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum)
                FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)
           END AS composite_attributes
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = ANY($1) AND t.typtype IN ('e','d','c','r','m')
       AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
       AND ${NOT_EXTENSION_MEMBER('pg_type', 't')}`,

  sequences: `
    SELECT n.nspname AS schema, c.relname AS name, format_type(s.seqtypid, NULL) AS type,
           s.seqstart::text AS start, s.seqincrement::text AS increment,
           s.seqmin::text AS min, s.seqmax::text AS max, s.seqcycle AS cycle,
           (SELECT tn.nspname || '.' || tc.relname || '.' || a.attname
              FROM pg_depend d
              JOIN pg_class tc ON tc.oid = d.refobjid
              JOIN pg_namespace tn ON tn.oid = tc.relnamespace
              JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i')
             LIMIT 1) AS owned_by
      FROM pg_sequence s
      JOIN pg_class c ON c.oid = s.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND ${NOT_EXTENSION_MEMBER('pg_class', 'c')}`,

  policies: `
    SELECT n.nspname AS schema, c.relname AS table, p.polname AS name,
           p.polcmd::text AS command, p.polpermissive AS permissive,
           cardinality(p.polroles) AS role_count,
           CASE WHEN p.polroles = '{0}'::oid[] THEN ARRAY['public']
                ELSE ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid = ANY (p.polroles) ORDER BY 1)
           END AS roles,
           pg_get_expr(p.polqual, p.polrelid) AS using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1)`,

  triggers: `
    SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name,
           pg_get_triggerdef(t.oid, true) AS definition, t.tgenabled::text AS enabled,
           pn.nspname || '.' || p.proname AS function
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
     WHERE n.nspname = ANY($1) AND NOT t.tgisinternal`,

  routines: `
    SELECT n.nspname AS schema, p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS identity_args,
           pg_get_function_result(p.oid) AS result,
           p.prokind::text AS kind, l.lanname AS language, p.prosecdef AS security_definer,
           p.provolatile::text AS volatility, p.proisstrict AS strict, p.proleakproof AS leakproof,
           p.proconfig AS config,
           CASE WHEN p.prosqlbody IS NOT NULL THEN pg_get_functiondef(p.oid) ELSE p.prosrc END AS body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
     WHERE n.nspname = ANY($1) AND ${NOT_EXTENSION_MEMBER('pg_proc', 'p')}`,

  views: `
    SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
           pg_get_viewdef(c.oid, true) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND c.relkind IN ('v','m')
       AND ${NOT_EXTENSION_MEMBER('pg_class', 'c')}`,

  eventTriggers: `
    SELECT e.evtname AS name, e.evtevent AS event, e.evtenabled::text AS enabled,
           pn.nspname || '.' || p.proname AS function, e.evttags AS tags
      FROM pg_event_trigger e
      JOIN pg_proc p ON p.oid = e.evtfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace`,

  extensions: `
    SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace`,
} as const

const SORT_KEYS: Record<keyof typeof QUERIES, string[]> = {
  schemas: ['name'],
  tables: ['schema', 'name'],
  columns: ['schema', 'table', 'name'],
  constraints: ['schema', 'table', 'name'],
  indexes: ['schema', 'table', 'name'],
  types: ['schema', 'name'],
  sequences: ['schema', 'name'],
  policies: ['schema', 'table', 'name'],
  triggers: ['schema', 'table', 'name'],
  routines: ['schema', 'name', 'identity_args'],
  views: ['schema', 'name'],
  eventTriggers: ['name'],
  extensions: ['name'],
}

function sortRows(rows: Array<Record<string, unknown>>, keys: string[]): Array<Record<string, unknown>> {
  const k = (r: Record<string, unknown>) => keys.map(key => String(r[key] ?? '')).join(' ')
  return [...rows].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0))
}

export async function captureSnapshot(client: PgClient, schemas: string[]): Promise<Snapshot> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query('SET LOCAL search_path TO pg_catalog')
    const readOnly = await client.query('SHOW transaction_read_only')
    if (readOnly.rows[0]?.transaction_read_only !== 'on') {
      throw new Error('capture transaction is not read-only; refusing to continue')
    }

    const meta = await client.query(
      "SELECT current_database() AS database, current_setting('server_version') AS version",
    )
    const out: Partial<Snapshot> = {
      meta: { database: meta.rows[0].database, serverVersion: meta.rows[0].version, schemas: [...schemas].sort() },
    }

    for (const key of Object.keys(QUERIES) as Array<keyof typeof QUERIES>) {
      const sql = QUERIES[key]
      const { rows } = sql.includes('$1') ? await client.query(sql, [schemas]) : await client.query(sql)
      let shaped = rows as Array<Record<string, unknown>>
      if (key === 'routines') {
        shaped = shaped.map(({ body, ...rest }) => ({
          ...rest,
          body_sha256: bodyDigest(typeof body === 'string' ? body : null),
          body_length: typeof body === 'string' ? normaliseBody(body).length : null,
        }))
      }
      ;(out as Record<string, unknown>)[key] = sortRows(shaped, SORT_KEYS[key])
    }

    await client.query('COMMIT')
    return out as Snapshot
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

// ── RLS visibility ───────────────────────────────────────────────────────────

export interface RlsVisibility {
  database: string
  catalogReadable: { pg_policy: boolean; pg_class: boolean; pg_policies: boolean }
  bySchema: Array<{
    schema: string
    tables: number
    rlsEnabled: number
    rlsForced: number
    rlsEnabledWithoutPolicy: number
    policiesFromCatalog: number
    policiesFromView: number
    classification: 'rls_with_policies' | 'rls_without_policies' | 'rls_not_enabled' | 'no_tables'
  }>
  policiesTotalUnjoined: number
  policiesTotalJoined: number
  policiesTotalView: number
  consistent: boolean
  inconsistencies: string[]
}

// Tenant schemas are summarised as one bucket: their names are project ids and
// the question here is visibility, not which project owns what.
const SCHEMA_BUCKET = (column: string) =>
  `CASE WHEN ${column} LIKE 'workspace\\_%' THEN 'workspace_*' ELSE ${column}::text END`

/**
 * Settles whether "zero policies" is a fact or a bad observation.
 *
 * Reads pg_policy joined to pg_class and pg_namespace directly, independently
 * reads relrowsecurity / relforcerowsecurity, and compares both with the
 * pg_policies view and with an unjoined count of pg_policy. Only the database
 * this session is connected to is visible: policies are per-database.
 */
export async function rlsVisibility(client: PgClient): Promise<RlsVisibility> {
  const q = async (sql: string) => (await client.query(sql)).rows

  const [db] = await q('SELECT current_database() AS database')
  const [privs] = await q(`
    SELECT has_table_privilege('pg_catalog.pg_policy', 'SELECT') AS pg_policy,
           has_table_privilege('pg_catalog.pg_class', 'SELECT') AS pg_class,
           has_table_privilege('pg_catalog.pg_policies', 'SELECT') AS pg_policies`)

  const tables = await q(`
    SELECT ${SCHEMA_BUCKET('n.nspname')} AS schema,
           count(*)::int AS tables,
           count(*) FILTER (WHERE c.relrowsecurity)::int AS rls_enabled,
           count(*) FILTER (WHERE c.relforcerowsecurity)::int AS rls_forced,
           count(*) FILTER (WHERE c.relrowsecurity
                              AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))::int AS rls_without_policy
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     GROUP BY 1`)
  const fromCatalog = await q(`
    SELECT ${SCHEMA_BUCKET('n.nspname')} AS schema, count(*)::int AS policies
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     GROUP BY 1`)
  const fromView = await q(`
    SELECT ${SCHEMA_BUCKET('schemaname')} AS schema, count(*)::int AS policies
      FROM pg_policies GROUP BY 1`)
  const [unjoined] = await q('SELECT count(*)::int AS n FROM pg_policy')

  const schemas = new Set<string>([...tables, ...fromCatalog, ...fromView].map(r => r.schema))
  const find = (rows: any[], s: string) => rows.find(r => r.schema === s)
  const inconsistencies: string[] = []

  const bySchema = [...schemas].sort().map(schema => {
    const t = find(tables, schema)
    const catalog = find(fromCatalog, schema)?.policies ?? 0
    const view = find(fromView, schema)?.policies ?? 0
    if (catalog !== view) inconsistencies.push(`${schema}: pg_policy join sees ${catalog}, pg_policies sees ${view}`)
    const rlsEnabled = t?.rls_enabled ?? 0
    return {
      schema,
      tables: t?.tables ?? 0,
      rlsEnabled,
      rlsForced: t?.rls_forced ?? 0,
      rlsEnabledWithoutPolicy: t?.rls_without_policy ?? 0,
      policiesFromCatalog: catalog,
      policiesFromView: view,
      classification: (!t
        ? 'no_tables'
        : rlsEnabled === 0
          ? 'rls_not_enabled'
          : catalog > 0
            ? 'rls_with_policies'
            : 'rls_without_policies') as RlsVisibility['bySchema'][number]['classification'],
    }
  })

  const joined = bySchema.reduce((n, s) => n + s.policiesFromCatalog, 0)
  const viewTotal = bySchema.reduce((n, s) => n + s.policiesFromView, 0)
  if (unjoined.n !== joined) inconsistencies.push(`pg_policy has ${unjoined.n} rows but the join accounts for ${joined}`)
  for (const [name, ok] of Object.entries(privs)) {
    if (ok !== true) inconsistencies.push(`${name} is not readable by this role`)
  }

  return {
    database: db.database,
    catalogReadable: privs,
    bySchema,
    policiesTotalUnjoined: unjoined.n,
    policiesTotalJoined: joined,
    policiesTotalView: viewTotal,
    consistent: inconsistencies.length === 0,
    inconsistencies,
  }
}

// The RLS positive control lives in ./rls-control.ts. It is the only DDL in this
// neighbourhood, and this module is shared with the production capture path,
// whose bundle is audited for exactly that kind of text before it may ship.
