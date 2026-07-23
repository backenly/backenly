/**
 * SEED RUNNER — deterministic demo-data inserter for blueprint builds
 * ===================================================================
 * Executes the `seed_rows` blueprint step. The architect emits literal demo
 * rows (validated + clamped in validate.ts); this runner makes them real:
 *
 *   • introspects the LIVE table (information_schema + pg_constraint), never
 *     trusts the spec blindly — the physical schema is the ground truth
 *   • resolves FK columns to rows inserted earlier in the same run (in
 *     dependency order, tracked in SeedRunContext)
 *   • resolves user_id / FKs-to-users to a single demo end-user, created
 *     once per run directly in the workspace users table
 *   • coerces values by the column's actual data_type so a sloppy LLM value
 *     ("5" for an int, an object for jsonb) still inserts cleanly
 *   • inserts row-by-row and reports honest per-table counts — a partial
 *     seed is reported as partial, never as success
 *
 * All writes go through lib/services/workspaceDatabase.ts (the sanctioned
 * workspace write path). Platform Prisma is used only for read-only catalog
 * introspection, mirroring lib/ai/behavioral-verifier.ts.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'

const IDENT_RE = /^[a-z_][a-z0-9_]*$/

export interface SeedTableResult {
  tableName: string
  requested: number
  inserted: number
  /** First error encountered (rows after it may still have inserted). */
  error?: string
}

/**
 * Cross-step state for one blueprint run: ids of rows inserted per table
 * (for FK resolution) and the demo end-user id (created lazily).
 */
export interface SeedRunContext {
  projectId: string
  insertedIds: Map<string, string[]>
  demoUserId: string | null
}

export function createSeedContext(projectId: string): SeedRunContext {
  return { projectId, insertedIds: new Map(), demoUserId: null }
}

interface LiveColumn {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

interface FkMapping {
  column: string
  foreign_table: string
  foreign_column: string
}

async function loadLiveColumns(schema: string, table: string): Promise<LiveColumn[]> {
  return prisma.$queryRawUnsafe<LiveColumn[]>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    schema, table,
  )
}

async function loadFkMappings(schema: string, table: string): Promise<FkMapping[]> {
  try {
    return await prisma.$queryRawUnsafe<FkMapping[]>(
      `SELECT
         att.attname     AS column,
         ref.relname     AS foreign_table,
         ref_att.attname AS foreign_column
       FROM pg_constraint c
       JOIN pg_class t          ON t.oid = c.conrelid
       JOIN pg_namespace n      ON n.oid = t.relnamespace
       JOIN pg_class ref        ON ref.oid = c.confrelid
       JOIN LATERAL unnest(c.conkey)  WITH ORDINALITY AS lk(attnum, ord) ON TRUE
       JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS rk(attnum, ord) ON lk.ord = rk.ord
       JOIN pg_attribute att     ON att.attrelid = t.oid       AND att.attnum = lk.attnum
       JOIN pg_attribute ref_att ON ref_att.attrelid = ref.oid AND ref_att.attnum = rk.attnum
       WHERE c.contype = 'f' AND n.nspname = $1 AND t.relname = $2`,
      schema, table,
    )
  } catch {
    return []
  }
}

/** Coerce an architect-provided value to something the column type accepts. */
function coerceValue(value: unknown, dataType: string): unknown {
  const t = dataType.toLowerCase()
  if (t.includes('bool')) return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true'
  if (t.includes('int') || t.includes('serial')) {
    const n = Number(value)
    return Number.isFinite(n) ? Math.trunc(n) : 0
  }
  if (t.includes('numeric') || t.includes('decimal') || t.includes('double') || t.includes('real') || t.includes('float')) {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  if (t.includes('timestamp') || t.includes('date')) {
    const d = new Date(String(value))
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
  }
  if (t.includes('json')) {
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) } catch { return '{}' }
  }
  if (t.includes('uuid')) {
    const s = String(value)
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
      ? s
      : crypto.randomUUID()
  }
  return String(value)
}

/**
 * Find or create the demo end-user every seeded user_id points at. One demo
 * user per project — deterministic email so repeated seeds stay idempotent.
 */
const DEMO_EMAIL = 'demo@backenly.dev'

async function ensureDemoUser(ctx: SeedRunContext, schema: string): Promise<string | null> {
  if (ctx.demoUserId) return ctx.demoUserId
  try {
    const existing = (await queryWorkspaceSchema(
      ctx.projectId,
      `SELECT id FROM {schema}.users WHERE email = $1 LIMIT 1`,
      DEMO_EMAIL,
    )) as Array<{ id: string }>
    if (existing?.[0]?.id) {
      ctx.demoUserId = String(existing[0].id)
      return ctx.demoUserId
    }

    // Introspect the users table so the insert satisfies every NOT NULL
    // column with no default — auth implementations differ on column names.
    const cols = await loadLiveColumns(schema, 'users')
    if (cols.length === 0) return null
    const names: string[] = []
    const values: unknown[] = []
    const id = crypto.randomUUID()
    for (const c of cols) {
      const n = c.column_name
      if (n === 'id') { names.push(n); values.push(id); continue }
      if (n === 'email') { names.push(n); values.push(DEMO_EMAIL); continue }
      if (n === 'name' || n === 'full_name' || n === 'username') { names.push(n); values.push('Demo User'); continue }
      if (c.is_nullable === 'NO' && c.column_default === null) {
        names.push(n)
        values.push(coerceValue(n.includes('password') ? crypto.randomBytes(24).toString('hex') : 'demo', c.data_type))
      }
    }
    const placeholders = names.map((_, i) => `$${i + 1}`).join(', ')
    const inserted = (await queryWorkspaceSchema(
      ctx.projectId,
      `INSERT INTO {schema}.users (${names.map(n => `"${n}"`).join(', ')})
       VALUES (${placeholders})
       ON CONFLICT DO NOTHING
       RETURNING id`,
      ...values,
    )) as Array<{ id: string }>
    ctx.demoUserId = inserted?.[0]?.id ? String(inserted[0].id) : id
    return ctx.demoUserId
  } catch (err) {
    console.error('[SeedRunner] demo user creation failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Insert one table's demo rows. Never throws — every failure lands in the
 * returned result so the build summary stays truthful.
 */
export async function runSeedStep(
  ctx: SeedRunContext,
  tableName: string,
  rows: Array<Record<string, unknown>>,
): Promise<SeedTableResult> {
  const requested = rows.length
  const result: SeedTableResult = { tableName, requested, inserted: 0 }

  if (!IDENT_RE.test(tableName)) {
    result.error = `invalid table name`
    return result
  }

  let schema: string
  try {
    schema = workspaceSchemaName(ctx.projectId)
  } catch {
    result.error = 'invalid project id'
    return result
  }

  let liveCols: LiveColumn[]
  let fks: FkMapping[]
  try {
    ;[liveCols, fks] = await Promise.all([
      loadLiveColumns(schema, tableName),
      loadFkMappings(schema, tableName),
    ])
  } catch (err) {
    result.error = `introspection failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`
    return result
  }
  if (liveCols.length === 0) {
    result.error = 'table does not exist in the workspace schema'
    return result
  }

  const colByName = new Map(liveCols.map(c => [c.column_name, c]))
  const fkByColumn = new Map(fks.map(f => [f.column, f]))
  const needsUser =
    colByName.has('user_id') ||
    fks.some(f => f.foreign_table === 'users')
  const demoUserId = needsUser ? await ensureDemoUser(ctx, schema) : null

  let fkPickCounter = 0
  for (const row of rows) {
    const names: string[] = []
    const values: unknown[] = []
    let rowBlocked: string | null = null

    // 1. Architect-provided values (only columns that physically exist and
    //    are not FK-managed — those are resolved below).
    for (const [k, v] of Object.entries(row)) {
      const col = colByName.get(k)
      if (!col) continue
      if (k === 'id' || k === 'created_at' || k === 'updated_at') continue
      if (fkByColumn.has(k) || k === 'user_id') continue
      names.push(k)
      values.push(coerceValue(v, col.data_type))
    }

    // 2. FK + identity columns.
    for (const col of liveCols) {
      const n = col.column_name
      if (n === 'id' || n === 'created_at' || n === 'updated_at') continue
      const fk = fkByColumn.get(n)
      const isUserCol = n === 'user_id' || fk?.foreign_table === 'users'
      if (isUserCol) {
        if (demoUserId) { names.push(n); values.push(demoUserId) }
        else if (col.is_nullable === 'NO' && col.column_default === null) {
          rowBlocked = `no demo user available for required column ${n}`
        }
        continue
      }
      if (fk && fk.foreign_column === 'id') {
        const parents = ctx.insertedIds.get(fk.foreign_table) ?? []
        if (parents.length > 0) {
          names.push(n)
          values.push(parents[fkPickCounter++ % parents.length])
        } else if (col.is_nullable === 'NO' && col.column_default === null) {
          rowBlocked = `no seeded parent rows in ${fk.foreign_table} for required FK ${n}`
        }
        // nullable FK with no parent → leave NULL
      }
    }

    if (rowBlocked) {
      if (!result.error) result.error = rowBlocked
      continue
    }
    if (names.length === 0) {
      if (!result.error) result.error = 'no usable columns after clamping to the live schema'
      continue
    }

    try {
      const placeholders = names.map((_, i) => `$${i + 1}`).join(', ')
      const insertedRows = (await queryWorkspaceSchema(
        ctx.projectId,
        `INSERT INTO {schema}."${tableName}" (${names.map(n => `"${n}"`).join(', ')})
         VALUES (${placeholders})
         RETURNING id`,
        ...values,
      )) as Array<{ id: unknown }>
      result.inserted += 1
      const id = insertedRows?.[0]?.id
      if (id !== undefined && id !== null) {
        const list = ctx.insertedIds.get(tableName) ?? []
        list.push(String(id))
        ctx.insertedIds.set(tableName, list)
      }
    } catch (err) {
      if (!result.error) {
        result.error = err instanceof Error ? err.message.slice(0, 160) : 'insert failed'
      }
    }
  }

  return result
}
