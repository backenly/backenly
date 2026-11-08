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
 *   no primary key, or the    nothing
 *   table is gone
 *   a check the database      an error frame naming the table, never the row
 *   could not answer          (createVisibleEventQueue), so the client knows to
 *                             read it again
 *
 * Events reach each subscriber in the order they were sent
 * (createVisibleEventQueue): a check that answers late never lets a later change
 * overtake an earlier one.
 *
 * ── How the checks reach the database ───────────────────────────────────────
 *
 * Each check used to be its own transaction, started the moment the event
 * arrived: subscribers times events. Forty streams on a table while a job
 * inserted 100 rows was 4,000 transactions for the workspace pool's five
 * connections, and a check that could not start within Prisma's two seconds
 * threw, was swallowed, and dropped the event without a word (#622). The
 * checks now go through one checker per process (createVisibilityChecker):
 *
 *   - batched: subscribers with the same identity share each row's check, and
 *     a table's rows waiting under one identity go in a single query;
 *   - bounded: at most VISIBILITY_CHECK_CONCURRENCY run at once, so the pool
 *     keeps connections for the routes it also serves. A batch waiting for a
 *     slot keeps collecting rows, so a burst becomes fewer, larger queries;
 *   - retried, then reported: a failed query is tried again, and one that
 *     still fails rejects with VisibilityCheckFailed, which the queue reports
 *     to the subscriber instead of dropping the event in silence.
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

/** The database reads behind the checks. Live ones below; tests inject their own. */
export interface VisibilityDeps {
  primaryKey(projectId: string, table: string): Promise<PrimaryKeyColumn[] | null>
  /**
   * Which of `rows` (each the primary key's values, in `key`'s column order)
   * the subscriber can select now, as positions in `rows`. One query for all.
   */
  visibleRows(subscriber: RealtimeSubscriber, table: string, key: PrimaryKeyColumn[], rows: unknown[][]): Promise<Set<number>>
}

/** What visibleChange asks; one shared instance batches and bounds the asking. */
export interface VisibilityChecker {
  primaryKey(projectId: string, table: string): Promise<PrimaryKeyColumn[] | null>
  canSelect(subscriber: RealtimeSubscriber, table: string, key: PrimaryKeyColumn[], values: unknown[]): Promise<boolean>
}

/** The database could not answer a check, even after retrying. */
export class VisibilityCheckFailed extends Error {
  readonly table: string
  constructor(table: string, cause: unknown) {
    super(`realtime visibility check on "${table}" failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'VisibilityCheckFailed'
    this.table = table
  }
}

function pick(row: Record<string, unknown> | null | undefined, key: PrimaryKeyColumn[]): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const column of key) out[column.name] = row[column.name]
  return out
}

/**
 * The change as this subscriber may receive it, or null for nothing. Rejects
 * with VisibilityCheckFailed when the database could not answer the check.
 */
export async function visibleChange(
  subscriber: RealtimeSubscriber,
  change: RealtimeChange,
  checker: VisibilityChecker = liveChecker(),
): Promise<RealtimeChange | null> {
  if (subscriber.serviceRole) return change
  // No row data (a payload too large to send): it says a row changed, not which.
  if (!change.data) return change

  const key = await checker.primaryKey(subscriber.projectId, change.table)
  if (!key || key.length === 0) return null
  const values = key.map((column) => change.data![column.name])
  if (values.some((value) => value === undefined || value === null)) return null

  if (change.type === 'delete') return { ...change, data: pick(change.data, key), old: null }

  if (!(await checker.canSelect(subscriber, change.table, key, values))) return null
  return { ...change, old: change.old ? pick(change.old, key) : (change.old ?? null) }
}

/** The SDK passes an error frame to subscribers, and closes the stream only for codes it knows are fatal. */
export const CHANGES_NOT_DELIVERED = 'CHANGES_NOT_DELIVERED'

/**
 * What a subscriber is told in place of changes that could not be checked.
 * Names the table, never a row. The table is in `table` and not the message:
 * the SDK also treats a message matching /reached its limit|api key|unauthor/i
 * as fatal (packages/sdk/src/realtime.ts), and a table may be called anything.
 */
export function changesNotDelivered(table: string): RealtimeChange {
  return {
    type: 'error',
    code: CHANGES_NOT_DELIVERED,
    table,
    message:
      "Changes to the table named in `table` could not be checked against this stream's access, so they were " +
      'not delivered. Read that table again to catch up.',
    timestamp: Date.now(),
  }
}

/**
 * One subscriber's queue: changes go in as they arrive and come out, checked,
 * in the same order. `send` sees only what the subscriber may receive, and,
 * where a check failed, one changesNotDelivered frame per table for the run of
 * failures, rather than nothing.
 */
export function createVisibleEventQueue(
  subscriber: RealtimeSubscriber,
  send: (change: RealtimeChange) => void,
  checker: VisibilityChecker = liveChecker(),
): (change: RealtimeChange) => void {
  let tail: Promise<void> = Promise.resolve()
  /** The table last reported as not delivered, until a check answers again. */
  let reported: string | null = null
  return (change) => {
    const decided = visibleChange(subscriber, change, checker).then(
      (visible) => ({ failed: false as const, visible }),
      () => ({ failed: true as const, visible: null }),
    )
    tail = tail.then(async () => {
      const outcome = await decided
      if (outcome.failed) {
        if (reported !== change.table) send(changesNotDelivered(change.table))
        reported = change.table
        return
      }
      reported = null
      if (outcome.visible) send(outcome.visible)
    })
  }
}

// ── The checker: batched, bounded, retried ──────────────────────────────────

/**
 * Checks running at once in this process. The home workspace pool has five
 * connections unless DATABASE_URL sizes it (lib/data-plane/regional.ts), and
 * the v1 routes Next serves (tickets, presence, storage) use it too, so a
 * burst of changes leaves them three.
 */
export const VISIBILITY_CHECK_CONCURRENCY = 2

/** Rows in one query, so a very large burst is several queries rather than one huge one. */
const MAX_ROWS_PER_QUERY = 200

/** Waits between attempts at a failed query: three attempts in all. */
const RETRY_DELAYS_MS = [250, 1_000]

const PRIMARY_KEY_TTL_MS = 60_000

export interface VisibilityCheckerOptions {
  concurrency?: number
  maxRowsPerQuery?: number
  retryDelaysMs?: number[]
}

/** Runs work with at most `concurrency` pieces in flight; the rest wait their turn. */
function boundedTo(concurrency: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    while (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await work()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A compared value as the query receives it. */
function asText(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

interface PendingRow {
  values: unknown[]
  waiters: Array<{ resolve: (visible: boolean) => void; reject: (err: unknown) => void }>
}

/** The rows waiting to be checked for one table under one identity. */
interface Group {
  id: string
  subscriber: RealtimeSubscriber
  table: string
  key: PrimaryKeyColumn[]
  rows: Map<string, PendingRow>
  scheduled: boolean
}

/** A checker over `deps`. One per process is shared by every stream: see liveChecker. */
export function createVisibilityChecker(deps: VisibilityDeps, options: VisibilityCheckerOptions = {}): VisibilityChecker {
  const run = boundedTo(options.concurrency ?? VISIBILITY_CHECK_CONCURRENCY)
  const maxRows = options.maxRowsPerQuery ?? MAX_ROWS_PER_QUERY
  const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS

  /** `work`, inside the bound, tried again after each delay while it fails; the slot is free while waiting. */
  async function withRetries<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run(work)
      } catch (err) {
        if (attempt >= retryDelays.length) throw err
        await sleep(retryDelays[attempt])
      }
    }
  }

  const keys = new Map<string, { at: number; key: PrimaryKeyColumn[] | null }>()
  const keyLookups = new Map<string, Promise<PrimaryKeyColumn[] | null>>()

  function primaryKey(projectId: string, table: string): Promise<PrimaryKeyColumn[] | null> {
    const id = `${projectId}\0${table}`
    const cached = keys.get(id)
    if (cached && Date.now() - cached.at < PRIMARY_KEY_TTL_MS) return Promise.resolve(cached.key)
    // Every stream on a table asks at once when its cached key expires: one lookup answers them all.
    let lookup = keyLookups.get(id)
    if (!lookup) {
      lookup = withRetries(() => deps.primaryKey(projectId, table))
        .then((key) => {
          keys.set(id, { at: Date.now(), key })
          return key
        })
        .catch((err) => {
          console.error(`[Realtime] primary key lookup for ${projectId}/${table} failed after retries:`, err instanceof Error ? err.message : err)
          throw new VisibilityCheckFailed(table, err)
        })
        .finally(() => keyLookups.delete(id))
      keyLookups.set(id, lookup)
    }
    return lookup
  }

  const groups = new Map<string, Group>()

  function canSelect(subscriber: RealtimeSubscriber, table: string, key: PrimaryKeyColumn[], values: unknown[]): Promise<boolean> {
    // Row-level security reads the end user and their role, so streams opened
    // as the same user and role get the same answer for a row.
    const id = [subscriber.projectId, table, subscriber.endUserId ?? '', subscriber.endUserRole ?? 'user', key.map((c) => c.name).join(',')].join('\0')
    let group = groups.get(id)
    if (!group) {
      group = { id, subscriber, table, key, rows: new Map(), scheduled: false }
      groups.set(id, group)
    }
    const rowId = JSON.stringify(values.map(asText))
    const row = group.rows.get(rowId) ?? { values, waiters: [] }
    group.rows.set(rowId, row)
    const answer = new Promise<boolean>((resolve, reject) => row.waiters.push({ resolve, reject }))
    schedule(group)
    return answer
  }

  /**
   * After the current turn of the event loop, so every stream the hub hands
   * this change to in the same loop (lib/realtime/listener-hub.ts) is in the
   * batch.
   */
  function schedule(group: Group): void {
    if (group.scheduled) return
    group.scheduled = true
    setImmediate(() => void flush(group))
  }

  async function flush(group: Group): Promise<void> {
    const taken: { rows: PendingRow[] | null } = { rows: null }
    // Taken once a slot is free, not before: rows that arrived while waiting join it.
    const take = (): PendingRow[] => {
      if (taken.rows) return taken.rows
      const rows: PendingRow[] = []
      for (const [rowId, row] of group.rows) {
        if (rows.length >= maxRows) break
        rows.push(row)
        group.rows.delete(rowId)
      }
      group.scheduled = false
      if (group.rows.size > 0) schedule(group)
      else if (groups.get(group.id) === group) groups.delete(group.id)
      taken.rows = rows
      return rows
    }
    try {
      const visible = await withRetries(() => {
        const rows = take()
        return deps.visibleRows(group.subscriber, group.table, group.key, rows.map((row) => row.values))
      })
      take().forEach((row, i) => row.waiters.forEach((w) => w.resolve(visible.has(i))))
    } catch (err) {
      const rows = take()
      const waiting = rows.reduce((n, row) => n + row.waiters.length, 0)
      console.error(
        `[Realtime] visibility check on ${group.subscriber.projectId}/${group.table} failed after retries; ` +
          `${waiting} change(s) for ${rows.length} row(s) reported to their streams as not delivered:`,
        err instanceof Error ? err.message : err,
      )
      const failed = new VisibilityCheckFailed(group.table, err)
      rows.forEach((row) => row.waiters.forEach((w) => w.reject(failed)))
    }
  }

  return { primaryKey, canSelect }
}

// ── The live checks ─────────────────────────────────────────────────────────

/** A cast the catalog gave, applied to a compared value; anything unusual is compared as text. */
const SAFE_TYPE = /^[a-z][a-z0-9 _]*(\(\d+(,\d+)?\))?(\[\])?$/

async function livePrimaryKey(projectId: string, table: string): Promise<PrimaryKeyColumn[] | null> {
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
  return rows.length > 0 ? rows : null
}

/**
 * One query for a batch: the rows' key values go in as one text array per key
 * column, and the answer is the positions of the rows that the subscriber's
 * identity can select. The table is read under that identity, so row-level
 * security decides for each row as it would for a read.
 */
async function liveVisibleRows(
  subscriber: RealtimeSubscriber,
  table: string,
  key: PrimaryKeyColumn[],
  rows: unknown[][],
): Promise<Set<number>> {
  const keyed = key.map((_, c) => `k${c}`)
  const match = key
    .map((column, c) =>
      SAFE_TYPE.test(column.type)
        ? `t.${quoteIdent(column.name)} = u.${keyed[c]}::${column.type}`
        : `t.${quoteIdent(column.name)}::text = u.${keyed[c]}`,
    )
    .join(' AND ')
  const sql =
    `SELECT u.i::int AS i FROM unnest(${key.map((_, c) => `$${c + 1}::text[]`).join(', ')}) WITH ORDINALITY AS u(${keyed.join(', ')}, i) ` +
    `WHERE EXISTS (SELECT 1 FROM ${quoteIdent(workspaceSchemaName(subscriber.projectId))}.${quoteIdent(table)} t WHERE ${match})`
  const found = await executeWithUserContext<{ i: number }>(
    subscriber.projectId,
    subscriber.endUserId ?? '',
    false,
    sql,
    key.map((_, c) => rows.map((row) => asText(row[c]))),
    subscriber.endUserRole ?? 'user',
  )
  return new Set(found.map((r) => Number(r.i) - 1))
}

export const liveDeps: VisibilityDeps = { primaryKey: livePrimaryKey, visibleRows: liveVisibleRows }

let shared: VisibilityChecker | null = null

/** The process's one checker over the live database: every stream shares its batches and its bound. */
export function liveChecker(): VisibilityChecker {
  return (shared ??= createVisibilityChecker(liveDeps))
}
