/**
 * The import plan for a Postgres source (Supabase or any Postgres): what each
 * source table becomes in the new Backenly project, and how its rows travel.
 *
 * Pure and deterministic: catalog rows in, plan out. No I/O, so the whole
 * migration strategy is unit-tested without a database
 * (__tests__/import/pg-plan.test.ts). lib/import/pg-engine.ts carries it out.
 *
 * The rules, and why:
 *
 *   - Types are kept EXACTLY where Backenly's governed kernel can declare them
 *     (`sqlType`, the spellings lib/ai/minimal-executor.ts accepts: text,
 *     varchar(n), numeric(p,s), timestamptz, uuid, jsonb, arrays of these…).
 *     Anything else (enums, pgvector, inet, tsvector, time with time zone…)
 *     is stored as text or the nearest exact type, and the table says so.
 *   - Every table is created "as written" (`asWritten`): nothing a column's
 *     NAME suggests (a CHECK on `status`, a UNIQUE on `email`, a guessed
 *     foreign key on `user_id`) is added, because those guesses are for
 *     tables Backenly designs; here the source already said what it is.
 *   - Backenly gives every table `id uuid`, "createdAt", "updatedAt" and
 *     "deleted_at". A source uuid primary key fills `id`; created_at /
 *     updated_at / deleted_at fill the platform's own columns.
 *   - A primary key that is not a uuid (a bigint identity, a text code) keeps
 *     its values in `legacy_id` (or its own name, when it is not `id`), and
 *     the row gets a uuid. A foreign key that pointed at it becomes a uuid
 *     pointing at the new id, with the old value kept beside it in
 *     `<column>_legacy`. Both uuids are derived from the old key with a
 *     per-import secret (lib/import/pg-engine.ts `derivedUuid`), so a child
 *     row finds its parent without a second pass, in any order, self
 *     references and cycles included.
 *   - Foreign keys are declared exactly (actions included) when the table is
 *     created, parents first. A key that cannot be satisfied while rows
 *     arrive (a table referencing itself, a cycle, a key into Backenly's
 *     users table, a key on the platform's own id) is added after the rows,
 *     and said if it cannot be.
 *   - `users` is Backenly's sign-in table, so a source table of that name
 *     arrives as `profiles` (the rename the AI's blueprint validator uses).
 */

import type { DeclaredForeignKey, ReferentialAction } from '@/lib/db/declared-foreign-key'

// ── The catalog, as lib/import/pg-source.ts reads it ──────────────────────────

export interface CatalogColumn {
  name: string
  /** format_type() of the column's type, a domain resolved to its base: 'character varying(255)', 'text[]', 'public.post_status'. */
  formatted: string
  /** pg_type.typname of that type: 'int8', '_text', 'post_status', 'vector'. */
  typeName: string
  /** pg_type.typtype: b base, e enum, c composite, r range, m multirange, p pseudo. */
  typeKind: string
  /** pg_type.typcategory: A array, D datetime, E enum, U user-defined… */
  category: string
  /** For an array: its element, as format_type / typname / typtype print it. */
  elementFormatted: string | null
  elementTypeName: string | null
  elementKind: string | null
  /** The domain this column was declared with, when it was one. */
  domain: string | null
  nullable: boolean
  defaultExpr: string | null
  identity: boolean
  generated: boolean
}

export interface CatalogForeignKey {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
  /** pg_constraint.confdeltype / confupdtype: a r c n d */
  onDelete: string
  onUpdate: string
}

export interface CatalogTable {
  schema: string
  name: string
  columns: CatalogColumn[]
  primaryKey: string[]
  /** Single- and multi-column unique constraints and plain unique indexes, primary key excluded. */
  uniques: string[][]
  foreignKeys: CatalogForeignKey[]
  rlsEnabled: boolean
  /**
   * Row-level security filters what the CONNECTING user reads from this
   * table (it is not the owner, a superuser, or BYPASSRLS): a copy would be
   * silently partial, so the import is refused (lib/import/drivers/pg-common.ts).
   */
  rowsHidden?: boolean
  partitioned: boolean
  /** pg_table_size: rows and TOAST, no indexes. */
  bytes: number
  /** Exact when counted, else the planner's estimate. */
  rows: number
  rowsExact: boolean
}

export interface CatalogPolicy {
  schema: string
  table: string
  name: string
  /** ALL | SELECT | INSERT | UPDATE | DELETE */
  command: string
  permissive: boolean
  roles: string[]
  using: string | null
  check: string | null
}

export interface SourceCatalog {
  tables: CatalogTable[]
  policies: CatalogPolicy[]
  /** Things that do not move, counted. */
  functions: number
  triggers: number
  views: number
  materializedViews: number
  extensions: string[]
}

// ── The plan ──────────────────────────────────────────────────────────────────

/** One declared column, as CREATE_TABLE receives it (lib/ai/minimal-executor.ts executeCreateTable). */
export interface PlannedColumn {
  name: string
  /** Executor vocabulary: TEXT, UUID, BYTEA, INTERVAL, TIMETZ… Used when there is no sqlType. */
  type: string
  /** Exact SQL type, from the spellings the executor accepts as declared. */
  sqlType?: string
  notNull?: boolean
  unique?: boolean
  default?: string
  references?: DeclaredForeignKey
}

/** How one destination column gets its value from a source row. */
export interface CopyTarget {
  column: string
  /** Index into `select`, the source expressions. */
  from: number
  /** Derive a uuid from the value: the id the row of `table` with that key received. */
  derive?: { table: string }
}

/** A key added after the rows have arrived (see the header). */
export interface DeferredForeignKey {
  column: string
  references: DeclaredForeignKey
  why: 'self' | 'cycle' | 'users' | 'platform_id'
}

export type PrimaryKeyKind = 'uuid' | 'carried' | 'composite' | 'none'

export interface PlannedTable {
  sourceSchema: string
  sourceName: string
  /** schema.name, the key every map below uses. */
  sourceKey: string
  /** The Backenly table name. */
  name: string
  columns: PlannedColumn[]
  /** Source expressions, each cast to text: what one row reads. */
  select: string[]
  copy: CopyTarget[]
  pk: { kind: PrimaryKeyKind; columns: string[]; carrier: string | null }
  deferredForeignKeys: DeferredForeignKey[]
  rows: number
  rowsExact: boolean
  bytes: number
  notes: string[]
  /** Source column → Backenly column, for the access rules translation. */
  columnMap: Record<string, string>
}

export interface ImportPlan {
  /** In creation and copy order: a table comes after every table it declares a key to. */
  tables: PlannedTable[]
  /** schema.name → Backenly table name. */
  names: Record<string, string>
  warnings: string[]
}

export interface PlanOptions {
  /** 'supabase' also understands keys into auth.users. */
  source: 'supabase' | 'postgres'
  /** The source's users are moving too, so a key into auth.users can become a key into users. */
  usersMoving: boolean
  /** Schemas being moved, first one first (its tables keep their names on a clash). */
  schemas: string[]
}

// ── Names ─────────────────────────────────────────────────────────────────────

/** Names the new project already has, or that Backenly owns. */
const RESERVED_TABLES = new Set(['users'])

/** Supabase-internal tables in public that are not the app's data. */
const INTERNAL_TABLES = new Set(['schema_migrations', 'supabase_functions', 'secrets', 'supabase_migrations'])

const PLATFORM_COLUMNS = new Set(['id', 'createdat', 'updatedat', 'deletedat'])

type PlatformSlot = 'id' | 'createdAt' | 'updatedAt' | 'deleted_at'

/** Which of Backenly's own columns a source column name would land on, as the executor compares them. */
export function platformSlot(column: string): PlatformSlot | null {
  const k = column.toLowerCase().replace(/_/g, '')
  if (k === 'id') return 'id'
  if (k === 'createdat') return 'createdAt'
  if (k === 'updatedat') return 'updatedAt'
  if (k === 'deletedat') return 'deleted_at'
  return null
}

/** A table name Backenly can create and address: lower-case letters, digits, underscores. */
export function safeTableName(raw: string): string {
  let n = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!n) n = 'table'
  if (/^[0-9]/.test(n)) n = `t_${n}`
  return n.slice(0, 55)
}

/** A column name the executor can quote: no double quote, at most 63 bytes. */
export function safeColumnName(raw: string): string {
  let n = raw.replace(/"/g, '_')
  if (!n.trim()) n = 'column'
  return Buffer.from(n).length > 63 ? n.slice(0, 55) : n
}

/**
 * The executor treats column names that differ only in case or underscores as
 * the same column (`user_id` and `userId`), and its own four (id, createdAt,
 * updatedAt, deleted_at) as taken. Claim a name it will not merge with another.
 */
const columnKey = (n: string) => n.toLowerCase().replace(/_/g, '')

function claimColumn(base: string, taken: Set<string>): string {
  if (!taken.has(columnKey(base))) {
    taken.add(columnKey(base))
    return base
  }
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 58)}_${i}`
    if (!taken.has(columnKey(candidate))) {
      taken.add(columnKey(candidate))
      return candidate
    }
  }
}

function uniqueName(base: string, taken: Set<string>, max = 63): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `_${i}`
    const candidate = `${base.slice(0, max - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MappedType {
  type: string
  sqlType?: string
  /** The source expression, cast to text for transport. `%s` is the quoted column. */
  expr: string
  note?: string
}

/** Base types the executor declares exactly (its DECLARED_SQL_TYPE), keyed by format_type's spelling. */
const EXACT: Record<string, string> = {
  text: 'text',
  smallint: 'smallint',
  integer: 'integer',
  bigint: 'bigint',
  boolean: 'boolean',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'jsonb',
  date: 'date',
  real: 'real',
  'double precision': 'double precision',
  numeric: 'numeric',
  'character varying': 'varchar',
  character: 'char',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  'time without time zone': 'time',
  money: 'money',
}

/** The executor's own vocabulary for exact types it has no `sqlType` spelling for. */
const VOCABULARY: Record<string, string> = {
  bytea: 'BYTEA',
  interval: 'INTERVAL',
  'time with time zone': 'TIMETZ',
}

/** format_type spelling → the executor's exact spelling, or null. */
export function exactSqlType(formatted: string): string | null {
  const f = formatted.trim().toLowerCase()
  if (EXACT[f]) return EXACT[f]
  let m: RegExpExecArray | null
  if ((m = /^character varying\((\d{1,5})\)$/.exec(f))) return `varchar(${m[1]})`
  if ((m = /^character\((\d{1,4})\)$/.exec(f))) return `char(${m[1]})`
  if ((m = /^numeric\((\d{1,4}),(\d{1,4})\)$/.exec(f))) return `numeric(${m[1]},${m[2]})`
  if ((m = /^numeric\((\d{1,4})\)$/.exec(f))) return `numeric(${m[1]})`
  if ((m = /^timestamp\(([0-6])\) without time zone$/.exec(f))) return `timestamp(${m[1]})`
  if ((m = /^timestamp\(([0-6])\) with time zone$/.exec(f))) return `timestamptz(${m[1]})`
  if ((m = /^time\(([0-6])\) without time zone$/.exec(f))) return `time(${m[1]})`
  if (f === 'name' || f === 'citext') return 'text'
  if (f === 'oid') return 'bigint'
  return null
}

const TEXT = '%s::text'

/**
 * What a source column's type becomes. `expr` is how its value travels: always
 * as text, which every type prints and parses losslessly with the session
 * settings lib/import/net.ts readSnapshot fixes (UTC, ISO dates, full float
 * digits, hex bytea).
 */
export function mapColumnType(col: CatalogColumn): MappedType {
  const f = col.formatted.trim().toLowerCase()
  const name = col.name

  if (col.category === 'A' || f.endsWith('[]')) {
    const element = (col.elementFormatted ?? f.replace(/\[\]$/, '')).trim().toLowerCase()
    const exact = exactSqlType(element)
    if (exact && exact !== 'money') return { type: 'TEXT', sqlType: `${exact}[]`, expr: TEXT }
    return {
      type: 'TEXT',
      sqlType: 'text[]',
      expr: TEXT,
      note: `${name}: ${col.formatted} stored as text[]`,
    }
  }

  if (f === 'money') return { type: 'TEXT', sqlType: 'numeric(19,2)', expr: '%s::numeric::text', note: `${name}: money stored as numeric(19,2)` }

  const exact = exactSqlType(f)
  if (exact) {
    const note =
      f === 'citext' ? `${name}: citext stored as text (comparisons are no longer case-insensitive)`
      : col.domain ? `${name}: domain ${col.domain} stored as ${exact}`
      : undefined
    return { type: 'TEXT', sqlType: exact, expr: TEXT, ...(note ? { note } : {}) }
  }
  if (VOCABULARY[f]) return { type: VOCABULARY[f], expr: TEXT }
  const withPrecision = /^(interval|time with time zone)\b/.exec(f)
  if (withPrecision) return { type: VOCABULARY[withPrecision[1]], expr: TEXT }

  if (col.typeKind === 'e') {
    return { type: 'TEXT', sqlType: 'text', expr: TEXT, note: `${name}: enum ${col.typeName} stored as text` }
  }
  if (col.typeName === 'vector' || /(^|\.)vector(\(\d+\))?$/.test(f)) {
    return {
      type: 'TEXT',
      sqlType: 'text',
      expr: TEXT,
      note: `${name}: pgvector embedding stored as text; ask your agent to add vector search to it`,
    }
  }
  return { type: 'TEXT', sqlType: 'text', expr: TEXT, note: `${name}: ${col.formatted} stored as text` }
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_KEYWORDS = new Set(['now()', 'current_timestamp', 'current_date', 'current_time', 'gen_random_uuid()', 'uuid_generate_v4()', 'true', 'false', 'null'])

/**
 * A source default Backenly can declare, or why not. Casts to the source's own
 * types are taken off ('draft'::post_status is 'draft' on a text column).
 * Sequences (identity, serial) are not carried: Backenly's rows get uuids.
 */
export function carriedDefault(expr: string | null): { value?: string; dropped?: string } {
  if (!expr) return {}
  let v = expr.trim()
  if (/^nextval\(/i.test(v)) return {}
  const jsonLiteral = /^'(\{\}|\[\])'::jsonb?$/i.exec(v)
  if (jsonLiteral) return { value: v.toLowerCase() }
  const castLiteral = /^('(?:[^']|'')*'|-?\d+(?:\.\d+)?|null|true|false)::[a-z_][a-z0-9_ ."]*(\(\d+(?:,\d+)?\))?(\[\])?$/i.exec(v)
  if (castLiteral) v = castLiteral[1]
  const paren = /^\((.*)\)$/.exec(v)
  if (paren && !paren[1].includes('(')) v = paren[1].trim()
  if (/^'(?:[^']|'')*'$/.test(v)) return { value: v }
  if (/^-?\d+(\.\d+)?$/.test(v)) return { value: v }
  if (DEFAULT_KEYWORDS.has(v.toLowerCase())) return { value: v }
  return { dropped: expr.trim() }
}

// ── Foreign keys ──────────────────────────────────────────────────────────────

const ACTIONS: Record<string, ReferentialAction> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
}

export function referentialAction(code: string): ReferentialAction {
  return ACTIONS[code] ?? 'NO ACTION'
}

/**
 * Tarjan's strongly connected components over "table → table it references".
 * Two tables in one component reference each other through a cycle.
 */
function componentsOf(keys: string[], edges: Map<string, Set<string>>): Map<string, number> {
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const comp = new Map<string, number>()
  let compId = 0
  const visit = (v: string) => {
    idx.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!))
      }
    }
    if (low.get(v) === idx.get(v)) {
      for (;;) {
        const w = stack.pop()!
        onStack.delete(w)
        comp.set(w, compId)
        if (w === v) break
      }
      compId++
    }
  }
  for (const k of [...keys].sort()) if (!idx.has(k)) visit(k)
  return comp
}

/** Parents before children; ties by name. Edges inside a cycle are ignored (their keys are deferred). */
function creationOrder(keys: string[], edges: Map<string, Set<string>>, comp: Map<string, number>): string[] {
  const deps = new Map<string, Set<string>>()
  for (const k of keys) {
    const d = new Set<string>()
    for (const p of edges.get(k) ?? []) if (p !== k && comp.get(p) !== comp.get(k)) d.add(p)
    deps.set(k, d)
  }
  const order: string[] = []
  const remaining = new Set(keys)
  while (remaining.size > 0) {
    const ready = [...remaining].filter((k) => [...deps.get(k)!].every((p) => !remaining.has(p))).sort()
    if (ready.length === 0) {
      // Unreachable: every cycle's edges were dropped above. Stay total anyway.
      order.push(...[...remaining].sort())
      break
    }
    for (const k of ready) {
      order.push(k)
      remaining.delete(k)
    }
  }
  return order
}

// ── The plan builder ──────────────────────────────────────────────────────────

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`

/** A uuid-typed column, the way the planner reads it (a domain over uuid counts). */
function isUuid(col: CatalogColumn | undefined): boolean {
  return !!col && col.formatted.trim().toLowerCase() === 'uuid'
}

function isDatetime(col: CatalogColumn): boolean {
  return col.category === 'D' && !col.formatted.toLowerCase().startsWith('time ') && !col.formatted.toLowerCase().startsWith('time(') && col.formatted.toLowerCase() !== 'interval'
}

export function buildPlan(catalog: SourceCatalog, opts: PlanOptions): ImportPlan {
  const warnings: string[] = []
  const keyOf = (schema: string, name: string) => `${schema}.${name}`

  // ── Which tables move ───────────────────────────────────────────────────────
  const tables = catalog.tables.filter((t) => {
    if (opts.source === 'supabase' && t.schema === 'public' && INTERNAL_TABLES.has(t.name.toLowerCase())) {
      warnings.push(`Skipped "${t.name}": a Supabase internal table, not your data.`)
      return false
    }
    if (t.columns.length === 0) {
      warnings.push(`Skipped "${t.schema}.${t.name}": it has no columns.`)
      return false
    }
    return true
  })
  const byKey = new Map(tables.map((t) => [keyOf(t.schema, t.name), t]))

  // ── Names: schema order decides who keeps a name on a clash ────────────────
  const schemaRank = (s: string) => {
    const i = opts.schemas.indexOf(s)
    return i === -1 ? opts.schemas.length : i
  }
  const naming = [...tables].sort((a, b) => schemaRank(a.schema) - schemaRank(b.schema) || a.name.localeCompare(b.name))
  const names: Record<string, string> = {}
  const takenTables = new Set<string>(RESERVED_TABLES)
  for (const t of naming) {
    const key = keyOf(t.schema, t.name)
    let base = safeTableName(t.name)
    if (base === 'users') base = 'profiles'
    if (takenTables.has(base) && t.schema !== opts.schemas[0]) base = safeTableName(`${t.schema}_${t.name}`)
    const name = uniqueName(base, takenTables, 55)
    takenTables.add(name)
    names[key] = name
  }

  // ── Primary keys ───────────────────────────────────────────────────────────
  const pkKind = new Map<string, PrimaryKeyKind>()
  const carrierOf = new Map<string, string | null>()
  for (const t of tables) {
    const key = keyOf(t.schema, t.name)
    if (t.primaryKey.length === 0) {
      pkKind.set(key, 'none')
      carrierOf.set(key, null)
    } else if (t.primaryKey.length > 1) {
      pkKind.set(key, 'composite')
      carrierOf.set(key, null)
    } else {
      const col = t.columns.find((c) => c.name === t.primaryKey[0])
      if (isUuid(col)) {
        pkKind.set(key, 'uuid')
        carrierOf.set(key, null)
      } else {
        pkKind.set(key, 'carried')
        carrierOf.set(key, platformSlot(t.primaryKey[0]) === 'id' ? 'legacy_id' : safeColumnName(t.primaryKey[0]))
      }
    }
  }

  // ── Which keys can be declared with the table ──────────────────────────────
  const edges = new Map<string, Set<string>>()
  for (const t of tables) {
    const key = keyOf(t.schema, t.name)
    const set = new Set<string>()
    for (const fk of t.foreignKeys) {
      const parent = keyOf(fk.refSchema, fk.refTable)
      if (fk.columns.length === 1 && byKey.has(parent)) set.add(parent)
    }
    edges.set(key, set)
  }
  const comp = componentsOf([...byKey.keys()], edges)
  const order = creationOrder([...byKey.keys()], edges, comp)
  const cyclic = [...byKey.keys()].filter((k) => [...byKey.keys()].some((o) => o !== k && comp.get(o) === comp.get(k)))
  if (cyclic.length > 0) {
    warnings.push(
      `${cyclic.map((k) => names[k]).sort().join(', ')} reference each other in a cycle: their foreign keys are added after the rows arrive.`,
    )
  }

  // ── Each table ─────────────────────────────────────────────────────────────
  const planned: PlannedTable[] = []
  /**
   * Keys to a parent's unique (non-primary) column: the parent's column may
   * arrive under another name, so the key is pointed at it once every table
   * is planned.
   */
  const pendingRefs: Array<{ parentKey: string; sourceColumn: string; childNotes: string[]; label: string; resolve: (column: string | null) => void }> = []
  for (const key of order) {
    const t = byKey.get(key)!
    const name = names[key]
    const kind = pkKind.get(key)!
    const notes: string[] = []
    const columns: PlannedColumn[] = []
    const select: string[] = []
    const copy: CopyTarget[] = []
    const deferred: DeferredForeignKey[] = []
    const columnMap: Record<string, string> = {}
    const takenCols = new Set<string>(['id', 'createdat', 'updatedat', 'deletedat'])
    const filledSlots = new Set<PlatformSlot>()
    let carrierName: string | null = null

    if (name !== t.name) {
      notes.push(t.name.toLowerCase() === 'users' ? `Arrives as ${name}: Backenly's sign-in owns the users table` : `Arrives as ${name}`)
    }
    if (t.partitioned) notes.push('Partitioned in the source; arrives as one table')

    const selectIndex = (expr: string) => {
      select.push(expr)
      return select.length - 1
    }

    // Single-column foreign keys by local column.
    const fkByColumn = new Map<string, CatalogForeignKey>()
    for (const fk of t.foreignKeys) {
      if (fk.columns.length === 1) fkByColumn.set(fk.columns[0], fk)
      else notes.push(`Two-column foreign key ${fk.name} (${fk.columns.join(', ')}) not carried`)
    }
    const singleUniques = new Set(t.uniques.filter((u) => u.length === 1).map((u) => u[0]))
    for (const u of t.uniques) if (u.length > 1) notes.push(`Unique rule on (${u.join(', ')}) not carried`)

    // The primary key.
    const pkCol = kind === 'uuid' || kind === 'carried' ? t.columns.find((c) => c.name === t.primaryKey[0])! : null
    if (kind === 'uuid' && pkCol) {
      const at = selectIndex(`${q(pkCol.name)}::text`)
      copy.push({ column: 'id', from: at })
      filledSlots.add('id')
      columnMap[pkCol.name] = 'id'
      if (platformSlot(pkCol.name) !== 'id') {
        // Keep the source's own name too, so code that reads it keeps working.
        const keep = claimColumn(safeColumnName(pkCol.name), takenCols)
        columns.push({ name: keep, type: 'UUID', sqlType: 'uuid', notNull: true, unique: true })
        copy.push({ column: keep, from: at })
        columnMap[pkCol.name] = keep
        notes.push(`Primary key ${pkCol.name} is also the row's id`)
      }
    } else if (kind === 'carried' && pkCol) {
      const carrier = claimColumn(carrierOf.get(key)!, takenCols)
      carrierName = carrier
      const mapped = mapColumnType(pkCol)
      const at = selectIndex(mapped.expr.replace('%s', q(pkCol.name)))
      columns.push({ name: carrier, type: mapped.type, ...(mapped.sqlType ? { sqlType: mapped.sqlType } : {}), notNull: true, unique: true })
      copy.push({ column: carrier, from: at })
      copy.push({ column: 'id', from: at, derive: { table: name } })
      filledSlots.add('id')
      columnMap[pkCol.name] = carrier
      notes.push(
        carrier === 'legacy_id'
          ? `id was ${pkCol.formatted}: kept in legacy_id; rows get uuid ids`
          : `Primary key ${pkCol.name} (${pkCol.formatted}) kept; rows also get uuid ids`,
      )
    } else if (kind === 'composite') {
      notes.push(`Primary key (${t.primaryKey.join(', ')}) kept as columns; rows also get uuid ids`)
    }

    for (const col of t.columns) {
      if (pkCol && col.name === pkCol.name) continue
      const fk = fkByColumn.get(col.name)
      const parentKey = fk ? keyOf(fk.refSchema, fk.refTable) : null
      const parent = parentKey ? byKey.get(parentKey) : undefined
      const parentKind = parentKey ? pkKind.get(parentKey) : undefined
      const refsParentPk = !!(fk && parent && parent.primaryKey.length === 1 && fk.refColumns[0] === parent.primaryKey[0])
      const slot = platformSlot(col.name)

      // A key into a legacy-keyed parent: a uuid to its new id, the old value beside it.
      if (fk && parent && refsParentPk && parentKind === 'carried') {
        const parentName = names[parentKey!]
        const legacyName = claimColumn(safeColumnName(`${col.name}_legacy`), takenCols)
        const mapped = mapColumnType(col)
        const at = selectIndex(mapped.expr.replace('%s', q(col.name)))
        columns.push({ name: legacyName, type: mapped.type, ...(mapped.sqlType ? { sqlType: mapped.sqlType } : {}) })
        copy.push({ column: legacyName, from: at })

        const target = claimColumn(safeColumnName(slot ? `${col.name}_ref` : col.name), takenCols)
        const references: DeclaredForeignKey = {
          table: parentName,
          column: 'id',
          onDelete: referentialAction(fk.onDelete),
          onUpdate: referentialAction(fk.onUpdate),
        }
        const self = parentKey === key
        const inCycle = !self && comp.get(parentKey!) === comp.get(key)
        if (self || inCycle) {
          columns.push({ name: target, type: 'UUID', sqlType: 'uuid' })
          deferred.push({ column: target, references, why: self ? 'self' : 'cycle' })
        } else {
          columns.push({ name: target, type: 'UUID', sqlType: 'uuid', references })
        }
        copy.push({ column: target, from: at, derive: { table: parentName } })
        columnMap[col.name] = target
        notes.push(`${target} now holds the ${parentName} row's id (the old value is in ${legacyName})`)
        continue
      }

      // Backenly's own columns.
      if (slot) {
        if (slot === 'id') {
          const renamed = claimColumn(safeColumnName(`source_${col.name}`), takenCols)
          const mapped = mapColumnType(col)
          columns.push({ name: renamed, type: mapped.type, ...(mapped.sqlType ? { sqlType: mapped.sqlType } : {}) })
          copy.push({ column: renamed, from: selectIndex(mapped.expr.replace('%s', q(col.name))) })
          columnMap[col.name] = renamed
          notes.push(`${col.name} arrives as ${renamed}: id is the row's uuid`)
          continue
        }
        if (!filledSlots.has(slot) && isDatetime(col)) {
          filledSlots.add(slot)
          copy.push({ column: slot, from: selectIndex(`${q(col.name)}::text`) })
          columnMap[col.name] = slot
          if (slot !== col.name) notes.push(`${col.name} fills Backenly's ${slot}`)
          if (slot === 'deleted_at') notes.push(`Rows with ${col.name} set stay hidden from the API, which reads deleted_at as deleted`)
          continue
        }
        const renamed = claimColumn(safeColumnName(`source_${col.name}`), takenCols)
        const mapped = mapColumnType(col)
        columns.push({ name: renamed, type: mapped.type, ...(mapped.sqlType ? { sqlType: mapped.sqlType } : {}) })
        copy.push({ column: renamed, from: selectIndex(mapped.expr.replace('%s', q(col.name))) })
        columnMap[col.name] = renamed
        notes.push(`${col.name} arrives as ${renamed}`)
        continue
      }

      const target = claimColumn(safeColumnName(col.name), takenCols)
      const mapped = mapColumnType(col)
      if (mapped.note) notes.push(mapped.note)
      const pc: PlannedColumn = { name: target, type: mapped.type, ...(mapped.sqlType ? { sqlType: mapped.sqlType } : {}) }
      // A number a sequence handed out: the values move, the sequence does not,
      // so the column cannot insist on a value new rows will not get.
      const numbered = col.identity || /^nextval\(/i.test(col.defaultExpr ?? '')
      if (!col.nullable && !col.generated && !numbered) pc.notNull = true
      if (singleUniques.has(col.name)) pc.unique = true
      if (col.generated) notes.push(`${col.name}: generated column, kept as values`)
      else if (numbered) notes.push(`${col.name}: numbered by a sequence in the source; the numbers are kept, new rows get none`)
      else {
        const d = carriedDefault(col.defaultExpr)
        if (d.value !== undefined) pc.default = d.value
        if (d.dropped) notes.push(`${col.name}: default ${d.dropped.slice(0, 60)} not carried`)
      }

      // A key Backenly can declare as written.
      if (fk && parent && parentKey) {
        const parentName = names[parentKey]
        const toUnique = !refsParentPk && parent.uniques.some((u) => u.length === 1 && u[0] === fk.refColumns[0])
        const refCol = refsParentPk ? (parentKind === 'uuid' ? 'id' : null) : toUnique ? fk.refColumns[0] : null
        if (refCol) {
          const references: DeclaredForeignKey = {
            table: parentName,
            column: refCol,
            onDelete: referentialAction(fk.onDelete),
            onUpdate: referentialAction(fk.onUpdate),
          }
          const self = parentKey === key
          const inCycle = !self && comp.get(parentKey) === comp.get(key)
          const entry: DeferredForeignKey = { column: target, references, why: self ? 'self' : 'cycle' }
          if (self || inCycle) deferred.push(entry)
          else pc.references = references
          if (toUnique) {
            pendingRefs.push({
              parentKey,
              sourceColumn: fk.refColumns[0],
              childNotes: notes,
              label: `${col.name} → ${parentName}.${fk.refColumns[0]}`,
              resolve: (column) => {
                if (column) {
                  references.column = column
                  return
                }
                if (pc.references === references) delete pc.references
                const at = deferred.indexOf(entry)
                if (at !== -1) deferred.splice(at, 1)
              },
            })
          }
        } else {
          notes.push(`${col.name} → ${parentName}: foreign key not carried (it does not point at a unique column Backenly keeps)`)
        }
      } else if (fk && !parent) {
        const authUsers = opts.source === 'supabase' && fk.refSchema === 'auth' && fk.refTable === 'users'
        if (authUsers && opts.usersMoving && fk.refColumns[0] === 'id' && isUuid(col)) {
          deferred.push({
            column: target,
            references: { table: 'users', column: 'id', onDelete: referentialAction(fk.onDelete), onUpdate: referentialAction(fk.onUpdate) },
            why: 'users',
          })
        } else if (authUsers) {
          notes.push(`${col.name} refers to Supabase's auth users; the values are kept`)
        } else {
          notes.push(`${col.name} → ${fk.refSchema}.${fk.refTable}: that table is not moving, so the values are kept without a foreign key`)
        }
      }

      columns.push(pc)
      copy.push({ column: target, from: selectIndex(mapped.expr.replace('%s', q(col.name))) })
      columnMap[col.name] = target
    }

    // A key on the primary key itself (profiles.id → auth.users.id, a 1:1 table).
    if (pkCol) {
      const fk = fkByColumn.get(pkCol.name)
      if (fk) {
        const parentKey = keyOf(fk.refSchema, fk.refTable)
        const parent = byKey.get(parentKey)
        const authUsers = opts.source === 'supabase' && fk.refSchema === 'auth' && fk.refTable === 'users'
        if (kind === 'uuid' && authUsers && opts.usersMoving) {
          deferred.push({
            column: 'id',
            references: { table: 'users', column: 'id', onDelete: referentialAction(fk.onDelete), onUpdate: referentialAction(fk.onUpdate) },
            why: 'users',
          })
          notes.push(`id is the user's id, as in Supabase`)
        } else if (kind === 'uuid' && parent && pkKind.get(parentKey) === 'uuid' && fk.refColumns[0] === parent.primaryKey[0]) {
          deferred.push({
            column: 'id',
            references: { table: names[parentKey], column: 'id', onDelete: referentialAction(fk.onDelete), onUpdate: referentialAction(fk.onUpdate) },
            why: 'platform_id',
          })
        } else if (authUsers) {
          notes.push(`${pkCol.name} refers to Supabase's auth users; the values are kept`)
        }
      }
    }

    planned.push({
      sourceSchema: t.schema,
      sourceName: t.name,
      sourceKey: key,
      name,
      columns,
      select,
      copy,
      pk: { kind, columns: t.primaryKey, carrier: carrierName },
      deferredForeignKeys: deferred,
      rows: t.rows,
      rowsExact: t.rowsExact,
      bytes: t.bytes,
      notes,
      columnMap,
    })
  }

  const plannedByKey = new Map(planned.map((p) => [p.sourceKey, p]))
  for (const r of pendingRefs) {
    const parent = plannedByKey.get(r.parentKey)
    const column = parent?.columnMap[r.sourceColumn]
    const ok = !!column && !!parent?.columns.some((c) => c.name === column && c.unique)
    r.resolve(ok ? column! : null)
    if (!ok) r.childNotes.push(`${r.label}: foreign key not carried (that column is not kept unique)`)
  }

  // ── What does not move ─────────────────────────────────────────────────────
  if (catalog.views > 0) warnings.push(`${catalog.views} view${catalog.views === 1 ? '' : 's'} not moved: ask your agent to recreate what your app reads from ${catalog.views === 1 ? 'it' : 'them'}.`)
  if (catalog.materializedViews > 0) warnings.push(`${catalog.materializedViews} materialized view${catalog.materializedViews === 1 ? '' : 's'} not moved.`)
  if (catalog.functions > 0) warnings.push(`${catalog.functions} database function${catalog.functions === 1 ? '' : 's'} not moved: Backenly runs logic as functions your agent writes.`)
  if (catalog.triggers > 0) warnings.push(`${catalog.triggers} trigger${catalog.triggers === 1 ? '' : 's'} not moved.`)
  if (tables.some((t) => t.partitioned)) warnings.push('Partitioned tables arrive as one table each.')

  return { tables: planned, names, warnings }
}
