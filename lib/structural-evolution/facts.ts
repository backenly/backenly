/**
 * TABLE FACTS — one read of everything a restructuring depends on
 * ===============================================================
 *
 * Structural evolution decides whether a group of columns can leave a table,
 * renders the SQL that moves them, and later proves what it left behind. All
 * three read the same facts, and they read them HERE so they cannot disagree:
 * an analysis that thinks a column is unconstrained while the planner sees a
 * CHECK on it would propose a ladder the planner then renders wrongly.
 *
 * ── Dependencies come from pg_depend, not from parsing ──────────────────────
 *
 * "Which policies, views, indexes and constraints mention this column" is the
 * question every separability rule turns on. Parsing `pg_get_expr` output for
 * column names would answer it most of the time and lie the rest: a policy that
 * says `status` matches a column called `status_code`, a view that aliases a
 * column hides it. PostgreSQL records the real answer — it is what refuses
 * `ALTER TABLE ... DROP COLUMN` when something still uses the column — so this
 * reads that record instead of reconstructing it.
 *
 * The one consumer pg_depend cannot see is a function body. plpgsql resolves
 * names at execution time, so a trigger function that writes `refund_amount`
 * has no dependency on it at all. Those are reported separately, by text
 * match, and labelled as a text match.
 *
 * ── The basis fingerprint excludes the ladder's own objects ─────────────────
 *
 * A plan must go stale when somebody else changes the table, and must NOT go
 * stale because the plan itself ran. The maintenance planner hashes the whole
 * catalog and so changes identity under its own feet; this hashes the host's
 * shape with every object named `bkn_evo_*` removed, which is exactly the set
 * a ladder creates. A trigger the owner adds to `orders` invalidates consent; the
 * sync trigger this ladder adds does not.
 *
 * Read-only.
 */

import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'

/** Every object a ladder creates carries this prefix, and nothing else may. */
export const LADDER_OBJECT_PREFIX = 'bkn_evo_'

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

export interface ColumnFact {
  name: string
  attnum: number
  /** `format_type` output — exact, including typmod and array-ness. */
  type: string
  /** Base type name, for classification (`timestamptz`, `numeric`, `_text`). */
  udt: string
  notNull: boolean
  default: string | null
  generated: boolean
  identity: boolean
  /** Column-level privileges exist. Table grants alone then do not describe access. */
  hasColumnAcl: boolean
}

export type ConstraintKind = 'p' | 'u' | 'c' | 'f' | 'x' | 't' | 'n'

export interface ConstraintFact {
  name: string
  kind: ConstraintKind
  /** Every column the constraint references, from conkey. */
  columns: string[]
  definition: string
  validated: boolean
  refTable?: string
  refSchema?: string
  refColumns?: string[]
  /** a = no action, r = restrict, c = cascade, n = set null, d = set default */
  onDelete?: string
  onUpdate?: string
}

export interface InboundForeignKey {
  name: string
  fromSchema: string
  fromTable: string
  /** The HOST columns the foreign key points at. */
  columns: string[]
}

export interface IndexFact {
  name: string
  unique: boolean
  primary: boolean
  expression: boolean
  partial: boolean
  method: string
  constraintBacked: boolean
  definition: string
  /** Every column the index reads, including inside expressions and predicates. */
  references: string[]
}

export interface PolicyFact {
  name: string
  command: string
  permissive: boolean
  roles: string[]
  using: string | null
  withCheck: string | null
  references: string[]
}

export interface TriggerFact {
  name: string
  definition: string
  /** The function's source, for the text-match consumer check. */
  functionSource: string | null
}

export interface GrantFact {
  grantee: string
  privilege: string
}

/** Something PostgreSQL records as depending on a host column. */
export interface ColumnDependent {
  kind: 'view' | 'index' | 'policy' | 'constraint' | 'trigger' | 'generated_column' | 'other'
  object: string
  column: string
}

export interface TableStats {
  liveRows: number
  inserts: number
  updates: number
  hotUpdates: number
  deletes: number
  seqScans: number
  idxScans: number
}

export interface TableFacts {
  schema: string
  table: string
  oid: number
  /** 'r' ordinary, 'p' partitioned. */
  relkind: string
  owner: string
  rowSecurity: boolean
  forceRowSecurity: boolean
  columns: ColumnFact[]
  primaryKey: string[]
  constraints: ConstraintFact[]
  inboundForeignKeys: InboundForeignKey[]
  indexes: IndexFact[]
  policies: PolicyFact[]
  triggers: TriggerFact[]
  grants: GrantFact[]
  dependents: ColumnDependent[]
  /** Null when the statistics collector has nothing for this table. */
  stats: TableStats | null
}

const REL = `to_regclass(format('%I.%I', $1::text, $2::text))`

type Row = Record<string, unknown>

async function q<T extends Row = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...params)
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/** The base tables in a schema, excluding Backenly's own bookkeeping tables. */
export async function listBaseTables(schema: string): Promise<string[]> {
  const rows = await q<{ name: string }>(
    `SELECT c.relname::text AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND c.relname NOT LIKE '\\_backenly\\_%' AND c.relname NOT LIKE '\\_bkn\\_%'
      ORDER BY 1`,
    schema,
  )
  return rows.map(r => r.name)
}

/** Does any relation (table, view, sequence…) already use this name? */
export async function relationExists(schema: string, name: string): Promise<boolean> {
  const rows = await q<{ found: boolean }>(`SELECT ${REL} IS NOT NULL AS found`, schema, name)
  return rows[0]?.found === true
}

/**
 * Read one table's facts, or null when it does not exist.
 *
 * Every query is keyed on the same `to_regclass` so a table renamed between two
 * of them reads as absent rather than as a mixture of two tables.
 */
export async function readTableFacts(schema: string, table: string): Promise<TableFacts | null> {
  if (!IDENT.test(table)) return null

  const rel = await q<{
    oid: unknown; relkind: string; owner: string; rls: boolean; force: boolean
  }>(
    `SELECT c.oid::int8 AS oid, c.relkind::text AS relkind, pg_get_userbyid(c.relowner)::text AS owner,
            c.relrowsecurity AS rls, c.relforcerowsecurity AS force
       FROM pg_class c WHERE c.oid = ${REL}`,
    schema,
    table,
  )
  const r = rel[0]
  if (!r || !['r', 'p'].includes(r.relkind)) return null

  const [columns, constraints, inbound, indexes, policies, triggers, grants, dependents, stats] =
    await Promise.all([
      q<Row>(
        `SELECT a.attname::text AS name, a.attnum::int AS attnum,
                format_type(a.atttypid, a.atttypmod) AS type, t.typname::text AS udt,
                a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr,
                (a.attgenerated <> '') AS generated, (a.attidentity <> '') AS identity,
                (a.attacl IS NOT NULL) AS has_acl
           FROM pg_attribute a
           JOIN pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = ${REL} AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        schema,
        table,
      ),
      q<Row>(
        `SELECT con.conname::text AS name, con.contype::text AS kind,
                pg_get_constraintdef(con.oid) AS definition, con.convalidated AS validated,
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n
                       ORDER BY k.i) AS columns,
                rc.relname::text AS ref_table, rn.nspname::text AS ref_schema,
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n
                       ORDER BY k.i) AS ref_columns,
                con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update
           FROM pg_constraint con
           LEFT JOIN pg_class rc ON rc.oid = con.confrelid
           LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
          WHERE con.conrelid = ${REL}
          ORDER BY con.conname`,
        schema,
        table,
      ),
      q<Row>(
        `SELECT con.conname::text AS name, n.nspname::text AS from_schema, c.relname::text AS from_table,
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n
                       ORDER BY k.i) AS columns
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE con.confrelid = ${REL} AND con.contype = 'f' AND con.conrelid <> con.confrelid
          ORDER BY con.conname`,
        schema,
        table,
      ),
      q<Row>(
        `SELECT ic.relname::text AS name, i.indisunique AS "unique", i.indisprimary AS "primary",
                (i.indexprs IS NOT NULL) AS expression, (i.indpred IS NOT NULL) AS partial,
                am.amname::text AS method,
                EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) AS constraint_backed,
                pg_get_indexdef(i.indexrelid) AS definition,
                ARRAY(SELECT DISTINCT a.attname::text
                        FROM pg_depend d
                        JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                       WHERE d.classid = 'pg_class'::regclass AND d.objid = i.indexrelid
                         AND d.refclassid = 'pg_class'::regclass AND d.refobjid = i.indrelid
                         AND d.refobjsubid > 0) AS refs
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_am am ON am.oid = ic.relam
          WHERE i.indrelid = ${REL}
          ORDER BY ic.relname`,
        schema,
        table,
      ),
      q<Row>(
        `SELECT p.polname::text AS name, p.polcmd::text AS command, p.polpermissive AS permissive,
                ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END
                        FROM unnest(p.polroles) r) AS roles,
                pg_get_expr(p.polqual, p.polrelid) AS using_expr,
                pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr,
                ARRAY(SELECT DISTINCT a.attname::text
                        FROM pg_depend d
                        JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                       WHERE d.classid = 'pg_policy'::regclass AND d.objid = p.oid
                         AND d.refobjid = p.polrelid AND d.refobjsubid > 0) AS refs
           FROM pg_policy p
          WHERE p.polrelid = ${REL}
          ORDER BY p.polname`,
        schema,
        table,
      ),
      q<Row>(
        `SELECT tg.tgname::text AS name, pg_get_triggerdef(tg.oid) AS definition, pr.prosrc AS source
           FROM pg_trigger tg
           LEFT JOIN pg_proc pr ON pr.oid = tg.tgfoid
          WHERE tg.tgrelid = ${REL} AND NOT tg.tgisinternal
          ORDER BY tg.tgname`,
        schema,
        table,
      ),
      q<Row>(
        `SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END AS grantee,
                x.privilege_type::text AS privilege
           FROM pg_class c, aclexplode(c.relacl) x
          WHERE c.oid = ${REL}
          ORDER BY 1, 2`,
        schema,
        table,
      ),
      q<Row>(
        `SELECT d.classid::regclass::text AS catalog,
                CASE d.classid
                  WHEN 'pg_class'::regclass THEN (SELECT relname::text FROM pg_class WHERE oid = d.objid)
                  WHEN 'pg_rewrite'::regclass THEN (SELECT ev_class::regclass::text FROM pg_rewrite WHERE oid = d.objid)
                  WHEN 'pg_policy'::regclass THEN (SELECT polname::text FROM pg_policy WHERE oid = d.objid)
                  WHEN 'pg_constraint'::regclass THEN (SELECT conname::text FROM pg_constraint WHERE oid = d.objid)
                  WHEN 'pg_trigger'::regclass THEN (SELECT tgname::text FROM pg_trigger WHERE oid = d.objid)
                  WHEN 'pg_attrdef'::regclass THEN (
                    SELECT a2.attname::text FROM pg_attrdef ad
                      JOIN pg_attribute a2 ON a2.attrelid = ad.adrelid AND a2.attnum = ad.adnum
                     WHERE ad.oid = d.objid)
                END AS object,
                a.attname::text AS "column",
                d.deptype::text AS deptype
           FROM pg_depend d
           JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
          WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = ${REL} AND d.refobjsubid > 0`,
        schema,
        table,
      ),
      q<Row>(
        `SELECT n_live_tup AS live, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_hot_upd AS hot,
                n_tup_del AS del, seq_scan AS seq, idx_scan AS idx
           FROM pg_stat_user_tables WHERE relid = ${REL}`,
        schema,
        table,
      ).catch(() => [] as Row[]),
    ])

  const columnFacts: ColumnFact[] = columns.map(c => ({
    name: String(c.name),
    attnum: num(c.attnum),
    type: String(c.type),
    udt: String(c.udt),
    notNull: c.not_null === true,
    default: (c.default_expr as string | null) ?? null,
    generated: c.generated === true,
    identity: c.identity === true,
    hasColumnAcl: c.has_acl === true,
  }))

  const constraintFacts: ConstraintFact[] = constraints.map(c => ({
    name: String(c.name),
    kind: String(c.kind) as ConstraintKind,
    columns: strs(c.columns),
    definition: String(c.definition),
    validated: c.validated !== false,
    ...(c.kind === 'f'
      ? {
          refTable: String(c.ref_table),
          refSchema: String(c.ref_schema),
          refColumns: strs(c.ref_columns),
          onDelete: String(c.on_delete),
          onUpdate: String(c.on_update),
        }
      : {}),
  }))

  const pk = constraintFacts.find(c => c.kind === 'p')

  const dependentFacts: ColumnDependent[] = []
  for (const d of dependents) {
    const object = d.object === null || d.object === undefined ? null : String(d.object)
    if (!object) continue
    const column = String(d.column)
    const catalog = String(d.catalog)
    const kind: ColumnDependent['kind'] =
      catalog === 'pg_rewrite'
        ? 'view'
        : catalog === 'pg_policy'
          ? 'policy'
          : catalog === 'pg_constraint'
            ? 'constraint'
            : catalog === 'pg_trigger'
              ? 'trigger'
              : catalog === 'pg_attrdef'
                ? 'generated_column'
                : catalog === 'pg_class'
                  ? 'index'
                  : 'other'
    // A sequence OWNED BY a column is recorded as a pg_class dependent too.
    // It is part of the column, not a consumer of it.
    if (kind === 'index' && d.deptype === 'a') continue
    // A view's _RETURN rule depends on its own table; a rule ON the host
    // depending on the host is not a consumer elsewhere.
    if (kind === 'view' && (object === table || object.endsWith(`.${table}`))) continue
    // A generated column's expression depends on the columns it reads, and on
    // itself — the self-edge carries no information.
    if (kind === 'generated_column' && object === column) continue
    dependentFacts.push({ kind, object, column })
  }

  const s = stats[0]

  return {
    schema,
    table,
    oid: num(r.oid),
    relkind: r.relkind,
    owner: r.owner,
    rowSecurity: r.rls === true,
    forceRowSecurity: r.force === true,
    columns: columnFacts,
    primaryKey: pk ? pk.columns : [],
    constraints: constraintFacts,
    inboundForeignKeys: inbound.map(i => ({
      name: String(i.name),
      fromSchema: String(i.from_schema),
      fromTable: String(i.from_table),
      columns: strs(i.columns),
    })),
    indexes: indexes.map(i => ({
      name: String(i.name),
      unique: i.unique === true,
      primary: i.primary === true,
      expression: i.expression === true,
      partial: i.partial === true,
      method: String(i.method),
      constraintBacked: i.constraint_backed === true,
      definition: String(i.definition),
      references: strs(i.refs),
    })),
    policies: policies.map(p => ({
      name: String(p.name),
      command: String(p.command),
      permissive: p.permissive !== false,
      roles: strs(p.roles),
      using: (p.using_expr as string | null) ?? null,
      withCheck: (p.check_expr as string | null) ?? null,
      references: strs(p.refs),
    })),
    triggers: triggers.map(t => ({
      name: String(t.name),
      definition: String(t.definition),
      functionSource: (t.source as string | null) ?? null,
    })),
    grants: grants.map(g => ({ grantee: String(g.grantee), privilege: String(g.privilege) })),
    dependents: dependentFacts,
    stats: s
      ? {
          liveRows: num(s.live),
          inserts: num(s.ins),
          updates: num(s.upd),
          hotUpdates: num(s.hot),
          deletes: num(s.del),
          seqScans: num(s.seq),
          idxScans: num(s.idx),
        }
      : null,
  }
}

const isLadderObject = (name: string) => name.startsWith(LADDER_OBJECT_PREFIX)

/**
 * The host's shape, minus everything a ladder put there.
 *
 * Stable under the ladder's own execution and sensitive to everybody else's
 * DDL — see the module header. Statistics are excluded: they move on every
 * write and say nothing about whether a plan's SQL is still correct.
 */
export function basisFingerprint(f: TableFacts): string {
  const shape = {
    t: `${f.schema}.${f.table}:${f.relkind}`,
    rls: [f.rowSecurity, f.forceRowSecurity],
    c: f.columns.map(c => [c.name, c.type, c.notNull, c.default, c.generated, c.identity, c.hasColumnAcl]),
    k: f.constraints.filter(c => !isLadderObject(c.name)).map(c => [c.name, c.kind, c.definition]),
    i: f.indexes.map(i => i.definition),
    p: f.policies.filter(p => !isLadderObject(p.name)).map(p => [p.name, p.command, p.roles, p.using, p.withCheck]),
    tg: f.triggers.filter(t => !isLadderObject(t.name)).map(t => t.definition),
    in: f.inboundForeignKeys.filter(i => !isLadderObject(i.name)).map(i => [i.fromSchema, i.fromTable, i.name, i.columns]),
    g: f.grants.map(g => `${g.grantee}:${g.privilege}`).sort(),
  }
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16)
}

/** Roles holding a privilege on the table, excluding its owner and PUBLIC-as-owner noise. */
export function granteesWith(f: TableFacts, privilege: string): string[] {
  return [...new Set(f.grants.filter(g => g.privilege === privilege && g.grantee !== f.owner).map(g => g.grantee))].sort()
}
