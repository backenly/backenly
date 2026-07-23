/**
 * Relational includes for the runtime query surface.
 *
 * Lets API callers fetch related rows in one request instead of N+1 client
 * round-trips:
 *
 *   POST /database/query { table: "posts", include: { comments: true, author: true } }
 *   GET  /db/posts?include=comments,author
 *
 * Relations are discovered from REAL foreign keys in the workspace schema
 * (CREATE_TABLE emits REFERENCES and fk-repair backfills missing ones), never
 * guessed from user input:
 *   - belongs-to: this table has an FK column → related table. Matched by the
 *     FK column stem ("author_id"/"authorId" → include key "author") or by the
 *     referenced table name. Attached as a single object (or null).
 *   - has-many: related table has an FK → this table. Matched by the related
 *     table's name. Attached as an array.
 *
 * All related loads run through executeWithUserContext so own_rows / RLS
 * policies apply to included rows exactly as they would to a direct query —
 * a user who can't read a row directly can't read it via include either.
 */

import { prisma } from '@/lib/db'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

export interface RlsIdentity {
  userId: string
  isServiceRole: boolean
  role: string
}

export interface FkEdge {
  table: string
  column: string
  refTable: string
  refColumn: string
}

export type IncludeSpec = Record<string, boolean | { include?: IncludeSpec }>

const MAX_INCLUDE_DEPTH = 2
// Ceiling on related rows loaded per relation per request — prevents a
// has-many include on a huge child table from becoming an accidental export.
const MAX_RELATED_ROWS = 1000
// IN-list chunk size (Postgres handles large lists fine; this bounds memory).
const IN_CHUNK = 500

// ── Metadata caches (60s TTL — schema changes are rare relative to reads) ────

interface SchemaMeta {
  fks: FkEdge[]
  /** table → Set of column names (used for deleted_at detection) */
  columns: Map<string, Set<string>>
  loadedAt: number
}

const metaCache = new Map<string, SchemaMeta>()
const META_TTL_MS = 60_000

export function invalidateRelationMeta(projectId: string): void {
  metaCache.delete(projectId)
}

async function loadSchemaMeta(projectId: string): Promise<SchemaMeta> {
  const cached = metaCache.get(projectId)
  if (cached && Date.now() - cached.loadedAt < META_TTL_MS) return cached

  const schemaName = `workspace_${projectId}`

  const fkRows = await prisma.$queryRawUnsafe<Array<{
    table_name: string
    column_name: string
    foreign_table: string
    foreign_column: string
  }>>(
    `SELECT
       tc.table_name       AS table_name,
       kcu.column_name     AS column_name,
       ccu.table_name      AS foreign_table,
       ccu.column_name     AS foreign_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema   = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema   = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1`,
    schemaName,
  )

  const colRows = await prisma.$queryRawUnsafe<Array<{
    table_name: string
    column_name: string
  }>>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = $1`,
    schemaName,
  )

  const columns = new Map<string, Set<string>>()
  for (const row of colRows) {
    let set = columns.get(row.table_name)
    if (!set) { set = new Set(); columns.set(row.table_name, set) }
    set.add(row.column_name)
  }

  const meta: SchemaMeta = {
    fks: fkRows.map(r => ({
      table: r.table_name,
      column: r.column_name,
      refTable: r.foreign_table,
      refColumn: r.foreign_column,
    })),
    columns,
    loadedAt: Date.now(),
  }
  metaCache.set(projectId, meta)
  return meta
}

// ── Relation resolution ────────────────────────────────────────────────────────

/** "author_id" / "authorId" → "author"; anything else → null. */
function fkColumnStem(column: string): string | null {
  const snake = column.match(/^(.+)_id$/i)
  if (snake) return snake[1].toLowerCase()
  const camel = column.match(/^(.+)Id$/)
  if (camel) return camel[1].toLowerCase()
  return null
}

interface ResolvedRelation {
  kind: 'belongs-to' | 'has-many'
  edge: FkEdge
}

/**
 * Resolve an include key against the FK graph for a table.
 * Priority: belongs-to by column stem → belongs-to by referenced table name →
 * has-many by child table name. Returns null when nothing matches (the caller
 * reports it — a typo'd include must fail loudly, not silently return nothing).
 */
function resolveRelation(meta: SchemaMeta, tableName: string, includeKey: string): ResolvedRelation | null {
  const key = includeKey.toLowerCase()

  const belongsTo = meta.fks.filter(e => e.table === tableName)
  for (const edge of belongsTo) {
    if (fkColumnStem(edge.column) === key) return { kind: 'belongs-to', edge }
  }
  for (const edge of belongsTo) {
    if (edge.refTable.toLowerCase() === key) return { kind: 'belongs-to', edge }
  }

  const hasMany = meta.fks.filter(e => e.refTable === tableName)
  for (const edge of hasMany) {
    if (edge.table.toLowerCase() === key) return { kind: 'has-many', edge }
  }

  return null
}

/** Relations available on a table — used for error messages and discovery. */
export async function listAvailableRelations(projectId: string, tableName: string): Promise<string[]> {
  const meta = await loadSchemaMeta(projectId)
  const names = new Set<string>()
  for (const edge of meta.fks) {
    if (edge.table === tableName) {
      const stem = fkColumnStem(edge.column)
      names.add(stem ?? edge.refTable)
    }
    if (edge.refTable === tableName) names.add(edge.table)
  }
  return [...names].sort()
}

// ── Include execution ──────────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export class UnknownRelationError extends Error {
  constructor(
    public readonly relation: string,
    public readonly table: string,
    public readonly available: string[],
  ) {
    super(
      `Unknown relation "${relation}" on table "${table}". ` +
      (available.length > 0
        ? `Available relations: ${available.join(', ')}.`
        : `Table "${table}" has no foreign-key relationships yet.`),
    )
  }
}

/**
 * Parse the REST form: ?include=comments,author → { comments: true, author: true }.
 * Nested form uses dots: ?include=comments.author
 */
export function parseIncludeParam(raw: string | undefined): IncludeSpec | undefined {
  if (!raw) return undefined
  const spec: IncludeSpec = {}
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const path = entry.split('.').map(s => s.trim()).filter(Boolean).slice(0, MAX_INCLUDE_DEPTH)
    let cursor: IncludeSpec = spec
    for (let i = 0; i < path.length; i++) {
      const key = path[i]
      if (i === path.length - 1) {
        if (cursor[key] === undefined) cursor[key] = true
      } else {
        const existing = cursor[key]
        const node = typeof existing === 'object' && existing !== null
          ? existing
          : { include: {} as IncludeSpec }
        node.include = node.include ?? {}
        cursor[key] = node
        cursor = node.include
      }
    }
  }
  return Object.keys(spec).length > 0 ? spec : undefined
}

/**
 * Attach related rows to `rows` in place. Batched (one query per relation per
 * chunk), RLS-scoped, depth-capped.
 */
export async function applyIncludes(opts: {
  projectId: string
  tableName: string
  rows: any[]
  include: IncludeSpec | undefined
  rls: RlsIdentity
  depth?: number
}): Promise<void> {
  const { projectId, tableName, rows, include, rls } = opts
  const depth = opts.depth ?? 1
  if (!include || rows.length === 0 || depth > MAX_INCLUDE_DEPTH) return

  const meta = await loadSchemaMeta(projectId)
  const schemaName = `workspace_${projectId}`

  for (const [key, value] of Object.entries(include)) {
    if (value === false || value === undefined || value === null) continue

    const relation = resolveRelation(meta, tableName, key)
    if (!relation) {
      throw new UnknownRelationError(key, tableName, await listAvailableRelations(projectId, tableName))
    }

    const { edge, kind } = relation
    const targetTable = kind === 'belongs-to' ? edge.refTable : edge.table
    const localKey    = kind === 'belongs-to' ? edge.column   : edge.refColumn
    const foreignKey  = kind === 'belongs-to' ? edge.refColumn : edge.column

    const parentValues = [...new Set(
      rows.map(r => r[localKey]).filter(v => v !== null && v !== undefined),
    )]
    if (parentValues.length === 0) {
      for (const row of rows) row[key] = kind === 'has-many' ? [] : null
      continue
    }

    const softDelete = meta.columns.get(targetTable)?.has('deleted_at')
      ? `AND "deleted_at" IS NULL` : ''

    const related: any[] = []
    for (const group of chunk(parentValues, IN_CHUNK)) {
      if (related.length >= MAX_RELATED_ROWS) break
      const placeholders = group.map((_, i) => `$${i + 1}`).join(', ')
      const sql =
        `SELECT * FROM "${schemaName}"."${targetTable}" ` +
        `WHERE "${foreignKey}" IN (${placeholders}) ${softDelete} ` +
        `LIMIT ${MAX_RELATED_ROWS - related.length}`
      const batch = await executeWithUserContext<any>(
        rls.userId, rls.isServiceRole, sql, group, rls.role,
      )
      related.push(...batch)
    }

    // Recurse into nested includes BEFORE attaching, so nesting depth is bounded.
    const nested = typeof value === 'object' ? value.include : undefined
    if (nested && depth < MAX_INCLUDE_DEPTH) {
      await applyIncludes({
        projectId, tableName: targetTable, rows: related,
        include: nested, rls, depth: depth + 1,
      })
    }

    if (kind === 'belongs-to') {
      const byId = new Map(related.map(r => [r[foreignKey], r]))
      for (const row of rows) {
        row[key] = row[localKey] !== null && row[localKey] !== undefined
          ? (byId.get(row[localKey]) ?? null)
          : null
      }
    } else {
      const byParent = new Map<any, any[]>()
      for (const rel of related) {
        const parent = rel[foreignKey]
        const list = byParent.get(parent)
        if (list) list.push(rel)
        else byParent.set(parent, [rel])
      }
      for (const row of rows) {
        row[key] = byParent.get(row[localKey]) ?? []
      }
    }
  }
}
