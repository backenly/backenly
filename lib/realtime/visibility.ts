/**
 * WHAT A REALTIME SUBSCRIBER MAY RECEIVE OF A CHANGE
 * ==================================================
 * A change event carries the changed row (lib/services/realtimeTriggers.ts).
 * A subscriber receives it only if it could read that row through the data
 * API: the row is selected again, by its primary key, under the subscriber's
 * own identity (lib/services/workspace-rls.ts executeWithUserContext), so the
 * table's row-level security and grants decide, exactly as they do for a read.
 *
 *   service-role subscriber   every event, as sent
 *   insert / update           the event when the subscriber can select the row
 *                             now; an update's old values are reduced to the
 *                             primary key
 *   delete                    the primary key only (the row is gone and cannot
 *                             be checked), so a client can drop it from view
 *   truncated (no row data)   the event as sent: it says a row changed, not which
 *   anything that cannot be   nothing: a table without a primary key, a check
 *   checked                   that fails, a table that is gone
 *
 * Events reach each subscriber in the order they were sent
 * (createVisibleEventQueue): a check that answers late never lets a later change
 * overtake an earlier one.
 */

import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { quoteIdent, workspaceSchemaName } from '@/lib/security/workspace-schema'

export interface RealtimeSubscriber {
  projectId: string
  /** The end user the stream was opened as; null for an anonymous stream. */
  endUserId: string | null
  endUserRole: string | null
  serviceRole: boolean
}

export interface RealtimeChange {
  type: string
  table: string
  data?: Record<string, unknown> | null
  old?: Record<string, unknown> | null
  truncated?: boolean
  timestamp?: number
  [key: string]: unknown
}

export interface PrimaryKeyColumn {
  name: string
  /** format_type() of the column, for casting the compared value. */
  type: string
}

export interface VisibilityDeps {
  primaryKey(projectId: string, table: string): Promise<PrimaryKeyColumn[] | null>
  canSelect(subscriber: RealtimeSubscriber, table: string, key: PrimaryKeyColumn[], values: unknown[]): Promise<boolean>
}

function pick(row: Record<string, unknown> | null | undefined, key: PrimaryKeyColumn[]): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const column of key) out[column.name] = row[column.name]
  return out
}

/** The change as this subscriber may receive it, or null for nothing. */
export async function visibleChange(
  subscriber: RealtimeSubscriber,
  change: RealtimeChange,
  deps: VisibilityDeps = liveDeps,
): Promise<RealtimeChange | null> {
  if (subscriber.serviceRole) return change
  // No row data (a payload too large to send): it says a row changed, not which.
  if (!change.data) return change

  let key: PrimaryKeyColumn[] | null
  try {
    key = await deps.primaryKey(subscriber.projectId, change.table)
  } catch {
    return null
  }
  if (!key || key.length === 0) return null
  const values = key.map((column) => change.data![column.name])
  if (values.some((value) => value === undefined || value === null)) return null

  if (change.type === 'delete') return { ...change, data: pick(change.data, key), old: null }

  let visible = false
  try {
    visible = await deps.canSelect(subscriber, change.table, key, values)
  } catch {
    return null
  }
  if (!visible) return null
  return { ...change, old: change.old ? pick(change.old, key) : (change.old ?? null) }
}

/**
 * One subscriber's queue: changes go in as they arrive and come out, checked,
 * in the same order. `send` sees only what the subscriber may receive.
 */
export function createVisibleEventQueue(
  subscriber: RealtimeSubscriber,
  send: (change: RealtimeChange) => void,
  deps: VisibilityDeps = liveDeps,
): (change: RealtimeChange) => void {
  let tail: Promise<void> = Promise.resolve()
  return (change) => {
    const decided = visibleChange(subscriber, change, deps)
    tail = tail.then(async () => {
      const visible = await decided.catch(() => null)
      if (visible) send(visible)
    })
  }
}

// ── The live checks ─────────────────────────────────────────────────────────

/** A cast the catalog gave, applied to a compared value; anything unusual is compared as text. */
const SAFE_TYPE = /^[a-z][a-z0-9 _]*(\(\d+(,\d+)?\))?(\[\])?$/

const PRIMARY_KEY_TTL_MS = 60_000
const primaryKeys = new Map<string, { at: number; key: PrimaryKeyColumn[] | null }>()

async function livePrimaryKey(projectId: string, table: string): Promise<PrimaryKeyColumn[] | null> {
  const cacheKey = `${projectId}:${table}`
  const cached = primaryKeys.get(cacheKey)
  if (cached && Date.now() - cached.at < PRIMARY_KEY_TTL_MS) return cached.key
  const db = await workspaceRawClient(projectId)
  const qualified = `${quoteIdent(workspaceSchemaName(projectId))}.${quoteIdent(table)}`
  const rows = await db.$queryRaw<Array<{ name: string; type: string }>>`
    SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = to_regclass(${qualified})
       AND i.indisprimary
     ORDER BY array_position(i.indkey, a.attnum)
  `
  const key = rows.length > 0 ? rows : null
  primaryKeys.set(cacheKey, { at: Date.now(), key })
  return key
}

async function liveCanSelect(
  subscriber: RealtimeSubscriber,
  table: string,
  key: PrimaryKeyColumn[],
  values: unknown[],
): Promise<boolean> {
  const where = key
    .map((column, i) =>
      SAFE_TYPE.test(column.type)
        ? `${quoteIdent(column.name)} = $${i + 1}::${column.type}`
        : `${quoteIdent(column.name)}::text = $${i + 1}::text`,
    )
    .join(' AND ')
  const sql = `SELECT 1 FROM ${quoteIdent(workspaceSchemaName(subscriber.projectId))}.${quoteIdent(table)} WHERE ${where} LIMIT 1`
  const rows = await executeWithUserContext(
    subscriber.projectId,
    subscriber.endUserId ?? '',
    false,
    sql,
    values.map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value))),
    subscriber.endUserRole ?? 'user',
  )
  return rows.length > 0
}

export const liveDeps: VisibilityDeps = { primaryKey: livePrimaryKey, canSelect: liveCanSelect }
