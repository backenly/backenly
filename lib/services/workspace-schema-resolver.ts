/**
 * WORKSPACE SCHEMA RESOLVER — single source of truth for the inspector.
 *
 * ── The problem this kills ───────────────────────────────────────────────────
 * The PHASE 4.1 design declared the BackendGraph the canonical state and the
 * database a mere "execution artifact". In production the two DRIFT: the build
 * runtime materialises tables in `workspace_{projectId}` that never get written
 * back into the graph (or the graph is reset while the schema survives).
 *
 * When that happened the old inspector half-worked:
 *   • `/api/database/tables`    — fell back to live introspection → listed tables
 *   • `/api/database/structure` — read ONLY the graph → hard-404'd every table
 *     with "Table 'x' not found in graph"
 * because the empty-graph guard (`!graph.entities`) does not catch an empty
 * object `{}`. Two endpoints, two sources, two divergent fallbacks.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 * ONE reconciliation kernel. Every database-inspector endpoint reads from here.
 *   • The DATABASE is ground truth for *existence* — does the table/column
 *     physically exist in the workspace schema.
 *   • The GRAPH is the enrichment + intent layer — reason, createdBy, and
 *     "planned but not yet materialised" tables.
 *   • The resolved view is the deterministic UNION of both.
 *   • Drift SELF-HEALS: tables/columns present in the live schema but missing
 *     from the graph are backfilled into the graph (idempotent, cooldown-guarded)
 *     so the "source of truth" converges back to honesty instead of rotting.
 */

import { prisma } from '@/lib/db/prisma'
import { PostgresService, type ColumnInfo } from '@/lib/db/hybrid'
import { listTableStats } from '@/lib/services/workspace-table-stats'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'
import {
  getActiveGraph,
  saveNewGraph,
  createInitialGraph,
} from '@/lib/orchestration/graph-pointer'
import {
  createEmptyGraph,
  type BackendStateGraph,
  type EntityState,
  type FieldState,
} from '@/lib/orchestration/backend-state-graph'

/** A column as the inspector consumes it (mirrors `ColumnInfo` in lib/api/database.ts). */
export interface ResolvedColumn {
  name: string
  type: string
  nullable: boolean
  primary: boolean
  foreign: boolean
  unique: boolean
  indexed: boolean
  default?: string
  description?: string
}

/** A table reconciled from live schema + graph intent. */
export interface ResolvedTable {
  name: string
  schema: string
  /** Physically present in `workspace_{projectId}`. */
  exists: boolean
  /** Present as an entity in the active BackendGraph. */
  inGraph: boolean
  /** `live` = materialised in the DB. `planned` = graph intent, not built yet. */
  status: 'live' | 'planned'
  rows: number | null
  size: string | null
  fieldCount: number
  createdAt?: string
  createdBy?: string
  reason?: string
}

export interface ResolvedTableList {
  workspaceSchema: string
  tables: ResolvedTable[]
  /** True when the live schema has tables/columns the graph is missing. */
  driftDetected: boolean
}

/**
 * Internal Backenly tables never shown to the developer.
 *
 * Reads the LIVE workspace schema, so it must exclude every reserved plumbing
 * table by its physical name — not just `_backenly_`. The auth-runtime tables
 * (_token_blacklist, _email_verifications, _magic_links, _password_resets)
 * physically exist in the schema; without the canonical predicate they were
 * counted here ("Managed 18" instead of 16) even after their platform metadata
 * was removed, because this surface reads the database directly.
 */
function isSystemTable(name: string): boolean {
  return isReservedWorkspaceTable(name)
}

/**
 * Batched column counts for a set of tables in one query.
 * Returns a map of tableName → columnCount. Never throws.
 */
async function getColumnCounts(
  workspaceSchema: string,
  tableNames: string[]
): Promise<Record<string, number>> {
  if (tableNames.length === 0) return {}
  try {
    const placeholders = tableNames.map((_, i) => `$${i + 2}`).join(', ')
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; col_count: string }>>(
      `SELECT table_name, COUNT(*) AS col_count
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name IN (${placeholders})
       GROUP BY table_name`,
      workspaceSchema,
      ...tableNames
    )
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.table_name] = parseInt(row.col_count, 10)
    return counts
  } catch {
    return {}
  }
}

/** Case-insensitive lookup of an entity in a graph's entities map. */
function findEntityCI(
  entities: Record<string, EntityState> | undefined,
  tableName: string
): EntityState | undefined {
  if (!entities) return undefined
  if (entities[tableName]) return entities[tableName]
  const lower = tableName.toLowerCase()
  for (const [key, value] of Object.entries(entities)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

/**
 * Resolve the full table list for a project's workspace.
 *
 * Union of:
 *   1. Every physical table in `workspace_{projectId}` (status: `live`).
 *   2. Every graph entity not yet materialised in the DB (status: `planned`).
 *
 * `driftDetected` is true when a live table is missing from the graph or its
 * graph entity has fewer fields than the live table has columns — the signal
 * the caller uses to trigger `reconcileGraphDrift`.
 */
export async function resolveWorkspaceTables(projectId: string): Promise<ResolvedTableList> {
  const workspaceSchema = `workspace_${projectId}`

  // `PostgresService.listTables` returns `pg_class.reltuples` for row counts,
  // which is a stale planner estimate (and is -1 until ANALYZE runs on a
  // freshly created table). That's the source of the "-1" badges that used to
  // appear next to every new table in the inspector sidebar. We still need it
  // for the table list and table sizes, but row counts come from the unified
  // kernel below — same source the dashboard reads from, so the two surfaces
  // can never disagree on "X rows".
  const [dbTablesRaw, graph, liveStats] = await Promise.all([
    PostgresService.listTables(workspaceSchema).catch((err) => {
      console.error('[SchemaResolver] listTables failed:', err?.message)
      return [] as Awaited<ReturnType<typeof PostgresService.listTables>>
    }),
    getActiveGraph(projectId).catch((err) => {
      console.error('[SchemaResolver] getActiveGraph failed:', err?.message)
      return null
    }),
    listTableStats(projectId).catch((err) => {
      console.error('[SchemaResolver] listTableStats failed:', err?.message)
      return [] as Awaited<ReturnType<typeof listTableStats>>
    }),
  ])

  const dbTables = dbTablesRaw.filter((t) => !isSystemTable(t.name))
  const columnCounts = await getColumnCounts(workspaceSchema, dbTables.map((t) => t.name))
  const statByName = new Map(liveStats.map((s) => [s.name, s]))

  const graphEntities: Record<string, EntityState> = graph?.entities || {}
  const tables: ResolvedTable[] = []
  const seenLower = new Set<string>()
  let driftDetected = false

  // 1. Physical tables — ground truth.
  for (const t of dbTables) {
    seenLower.add(t.name.toLowerCase())
    const entity = findEntityCI(graphEntities, t.name)
    const graphFieldCount = entity ? Object.keys(entity.fields || {}).length : 0
    const dbColCount = columnCounts[t.name] ?? 0

    if (!entity || graphFieldCount === 0 || graphFieldCount < dbColCount) {
      driftDetected = true
    }

    const stat = statByName.get(t.name)
    tables.push({
      name: t.name,
      schema: workspaceSchema,
      exists: true,
      inGraph: !!entity,
      status: 'live',
      // Prefer the kernel's real COUNT(*) over reltuples. Only fall back to
      // `t.rows` (reltuples) when the kernel didn't return a stat for this
      // table — e.g. a table created moments ago that the stats query missed.
      rows: stat ? stat.rows : (t.rows ?? null),
      size: t.size ?? null,
      // Prefer the live column count; the graph count can be stale or empty.
      fieldCount: dbColCount > 0 ? dbColCount : graphFieldCount,
      createdAt: entity?.createdAt,
      createdBy: entity?.createdBy,
      reason: entity?.reason,
    })
  }

  // 2. Graph entities not yet materialised — intent ahead of the database.
  for (const [name, entity] of Object.entries(graphEntities)) {
    if (seenLower.has(name.toLowerCase())) continue
    // A prior reconcileGraphDrift (before isSystemTable used the canonical
    // predicate) may have written reserved tables into the graph. Never surface
    // them as "planned" tables — they are plumbing, not product.
    if (isReservedWorkspaceTable(name)) continue
    tables.push({
      name,
      schema: workspaceSchema,
      exists: false,
      inGraph: true,
      status: 'planned',
      rows: null,
      size: null,
      fieldCount: Object.keys(entity.fields || {}).length,
      createdAt: entity.createdAt,
      createdBy: entity.createdBy,
      reason: entity.reason,
    })
  }

  tables.sort((a, b) => a.name.localeCompare(b.name))
  return { workspaceSchema, tables, driftDetected }
}

/**
 * Resolve the column structure of a single table.
 *
 * Resolution order:
 *   1. Live introspection of `workspace_{projectId}.{table}` — ground truth.
 *      Graph field metadata (descriptions) is layered on top where present.
 *   2. If the table is not materialised, fall back to the graph entity's
 *      declared fields (a `planned` table — show intent).
 *   3. If a graph entity exists but has no fields and no live table, return
 *      `[]` (a known-but-empty table).
 *
 * Returns `null` ONLY when the table exists in neither the database nor the
 * graph — the single legitimate 404 case.
 */
export async function resolveTableStructure(
  projectId: string,
  tableName: string
): Promise<ResolvedColumn[] | null> {
  const workspaceSchema = `workspace_${projectId}`

  let dbColumns: ColumnInfo[] = []
  try {
    dbColumns = await PostgresService.getTableStructure(workspaceSchema, tableName)
  } catch (err: any) {
    console.error(`[SchemaResolver] introspection failed for ${tableName}:`, err?.message)
  }

  const graph = await getActiveGraph(projectId).catch(() => null)
  const entity = findEntityCI(graph?.entities, tableName)

  // 1. Live table — ground truth, enriched with graph descriptions.
  if (dbColumns.length > 0) {
    return dbColumns.map((c) => {
      const graphField = entity?.fields?.[c.name]
      return {
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        primary: !!c.primary,
        foreign: !!c.foreign,
        unique: !!c.unique,
        indexed: !!c.indexed,
        default: c.default,
        description: graphField?.reason || c.description,
      }
    })
  }

  // 2. Not materialised — fall back to graph intent.
  if (entity && Object.keys(entity.fields || {}).length > 0) {
    return Object.entries(entity.fields).map(([name, f]) => ({
      name,
      type: f.type || 'string',
      nullable: f.nullable !== false,
      primary: !!(f as any).isPrimaryKey || !!(f as any).primary,
      foreign: false,
      unique: !!f.unique || !!(f as any).isUnique,
      indexed: false,
      default: f.default,
      description: f.reason,
    }))
  }

  // 3. Known entity with no fields — empty table, not an error.
  if (entity) return []

  // Exists nowhere — genuine 404.
  return null
}

// ── Self-healing reconciliation ──────────────────────────────────────────────

/** Projects currently being reconciled — prevents concurrent double-heals in-process. */
const reconciling = new Set<string>()
/** Last reconcile attempt per project — throttles the background sweep. */
const lastReconcileAt = new Map<string, number>()
const RECONCILE_COOLDOWN_MS = 60_000

/**
 * Backfill the active graph from the live workspace schema.
 *
 * For every physical table missing from the graph — or whose graph entity has
 * fewer fields than the live table has columns — write a reconciled entity (or
 * refreshed field set) into a NEW immutable graph row via the standard pointer
 * machinery. Idempotent: once the graph matches reality this does nothing.
 *
 * Safe to call fire-and-forget from a GET handler — the inspector response is
 * already correct without it; this is graph hygiene only. Guarded by an
 * in-process lock + a 60s cooldown so repeated page loads don't hammer the DB.
 */
export async function reconcileGraphDrift(projectId: string): Promise<void> {
  if (reconciling.has(projectId)) return
  if (Date.now() - (lastReconcileAt.get(projectId) || 0) < RECONCILE_COOLDOWN_MS) return

  reconciling.add(projectId)
  try {
    const workspaceSchema = `workspace_${projectId}`
    const dbTables = (await PostgresService.listTables(workspaceSchema)).filter(
      (t) => !isSystemTable(t.name)
    )
    if (dbTables.length === 0) return

    const existingGraph = await getActiveGraph(projectId)
    const graph: BackendStateGraph = existingGraph || createEmptyGraph(projectId)

    const columnCounts = await getColumnCounts(workspaceSchema, dbTables.map((t) => t.name))
    const entities: Record<string, EntityState> = { ...(graph.entities || {}) }
    const lowerToKey = new Map(Object.keys(entities).map((k) => [k.toLowerCase(), k]))

    const nowIso = new Date().toISOString()
    const added: string[] = []
    const repopulated: string[] = []

    for (const t of dbTables) {
      const existingKey = lowerToKey.get(t.name.toLowerCase())
      const existing = existingKey ? entities[existingKey] : undefined
      const graphFieldCount = existing ? Object.keys(existing.fields || {}).length : 0
      const dbColCount = columnCounts[t.name] ?? 0

      // Already in sync — graph entity holds at least as many fields as the
      // live table has columns. Nothing to heal.
      if (existing && graphFieldCount > 0 && graphFieldCount >= dbColCount) continue
      if (dbColCount === 0) continue

      let cols: ColumnInfo[] = []
      try {
        cols = await PostgresService.getTableStructure(workspaceSchema, t.name)
      } catch (err: any) {
        console.error(`[SchemaResolver] reconcile introspection failed for ${t.name}:`, err?.message)
        continue
      }
      if (cols.length === 0) continue

      const fields: Record<string, FieldState> = {}
      for (const c of cols) {
        fields[c.name] = {
          name: c.name,
          type: c.type,
          reason: 'reconciled_from_database',
          nullable: c.nullable,
          unique: !!c.unique,
          default: c.default,
          createdAt: nowIso,
          createdBy: 'system:schema-reconciler',
          usedBy: [],
        }
      }

      if (existing && existingKey) {
        entities[existingKey] = { ...existing, fields }
        repopulated.push(t.name)
      } else {
        entities[t.name] = {
          name: t.name,
          reason: 'reconciled_from_database',
          fields,
          relationships: [],
          createdAt: nowIso,
          createdBy: 'system:schema-reconciler',
          dependencies: [],
        }
        added.push(t.name)
      }
    }

    if (added.length === 0 && repopulated.length === 0) return

    const mutated: BackendStateGraph = {
      ...graph,
      entities,
      version: (graph.version || 1) + 1,
      lastUpdated: nowIso,
    }

    if (existingGraph) {
      await saveNewGraph(projectId, mutated, undefined, { skipBillingCheck: true })
    } else {
      await createInitialGraph(projectId, mutated)
    }

    console.log(`[SchemaResolver] ✅ Healed graph drift for ${projectId}`, {
      addedEntities: added,
      repopulatedEntities: repopulated,
    })
  } catch (err: any) {
    if (err?.message === 'CONCURRENCY_CONFLICT') {
      console.log('[SchemaResolver] reconcile skipped — concurrent graph mutation won the race')
    } else {
      console.error('[SchemaResolver] reconcile failed:', err?.message)
    }
  } finally {
    // Stamp the cooldown even on failure so a broken project can't hammer the DB.
    lastReconcileAt.set(projectId, Date.now())
    reconciling.delete(projectId)
  }
}
