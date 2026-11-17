/**
 * Realtime Trigger Installer
 *
 * Installs PostgreSQL NOTIFY triggers on workspace tables so that
 * INSERT / UPDATE / DELETE events are broadcast to the SSE endpoint.
 *
 * The trigger calls pg_notify() on the project's realtime channel, whose name
 * the platform keeps (lib/realtime/channel-sql.ts), with a JSON payload:
 *   {
 *     type: "INSERT" | "UPDATE" | "DELETE",
 *     table: "messages",
 *     data: { ...newRow },      // new row (or deleted row for DELETE)
 *     old:  { ...oldRow } | null // previous row for UPDATE only
 *     timestamp: 1711234567.123
 *   }
 *
 * That is what the trigger sends, not what a subscriber receives. For any
 * stream but a service-role one, the realtime routes deliver an insert or
 * update only if the stream could read the row, with `old` reduced to the
 * primary key, and a delete as the primary key alone (lib/realtime/visibility.ts).
 *
 * pg_notify payload limit is 8000 bytes. For large rows the data field
 * is cut down to stay within limits: an update's old row to its primary key
 * first, then the row itself, so a client can still fetch the row by that key
 * or drop a deleted one (notifyFunctionSql in lib/realtime/channel-sql.ts).
 *
 * Important: this uses executeInWorkspaceSchema (Prisma raw) which goes
 * through the pooled connection. That is fine for one-shot DDL; only
 * the LISTEN (in the SSE route) needs the direct connection.
 */

import { executeInWorkspaceSchema, queryWorkspaceSchema } from './workspaceDatabase'
import { NOTIFY_FUNCTION_NAME, functionCommentSql, notifyFunctionSql } from '@/lib/realtime/channel-sql'
import { bringProjectFunctionsCurrent } from '@/lib/realtime/channels'

/**
 * Recorded on the notify function, so a schema still running an older body is
 * recognised and replaced (ensureRealtimeFunctionCurrent).
 */
export { REALTIME_FUNCTION_VERSION } from '@/lib/realtime/channel-sql'

/**
 * Create (or replace) a schema's notify function and record its version: one
 * per schema, reused by every table's trigger. Its body names no channel; it
 * reads the project's own when it runs.
 */
async function createNotifyFunction(projectId: string): Promise<void> {
  const schemaName = `workspace_${projectId}`
  await executeInWorkspaceSchema(projectId, notifyFunctionSql(schemaName))
  await executeInWorkspaceSchema(projectId, functionCommentSql(schemaName, NOTIFY_FUNCTION_NAME))
}

/**
 * Replace a schema's notify function (and its presence function) if it is not
 * the current one.
 *
 * Every table's trigger calls the one function by name, so replacing it moves
 * all of the project's realtime tables to the current body at once. Asked each
 * time a stream opens and by the listener hub's repair pass, not once per
 * process: an older release running beside this one, or a restore, can put an
 * older body back. A schema without the function has no realtime table.
 */
export async function ensureRealtimeFunctionCurrent(projectId: string): Promise<'current' | 'upgraded' | 'absent'> {
  return (await bringProjectFunctionsCurrent(projectId)).notify
}

/** What installRealtimeTrigger did. */
export interface TriggerInstallResult {
  /** The table carries the realtime trigger when the call returns. */
  installed: boolean
  /**
   * It already did, so nothing was run. Re-creating an identical trigger
   * changed nothing, so History recorded nothing, while enable_realtime listed
   * the table as "Enabled by this call" (production QA, 2026-11-16).
   */
  alreadyStreaming?: boolean
  /** Why a table was not given a trigger, when it was not. */
  reason?: string
}

/**
 * Whether a table already carries the trigger this file installs, enabled and
 * unchanged: AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, on every column,
 * calling the schema's own notify function. One that differs is replaced.
 */
async function streamsAlready(projectId: string, tableName: string): Promise<boolean> {
  const rows = (await queryWorkspaceSchema(
    projectId,
    `SELECT 1 AS one
       FROM pg_trigger t
      WHERE t.tgrelid = to_regclass(format('%I.%I', $1::text, $2::text))
        AND t.tgname = 'backenly_realtime'
        AND NOT t.tgisinternal
        AND t.tgenabled IN ('O', 'A')
        AND t.tgtype = 29
        AND t.tgqual IS NULL
        AND cardinality(t.tgattr::int2[]) = 0
        AND t.tgfoid = to_regprocedure(format('%I.%I()', $1::text, $3::text))`,
    `workspace_${projectId}`,
    tableName,
    NOTIFY_FUNCTION_NAME,
  )) as Array<{ one: number }> | undefined
  return (rows ?? []).length > 0
}

/**
 * Install (or replace) the realtime NOTIFY trigger on a single table.
 * Safe to call multiple times — uses CREATE OR REPLACE / DROP IF EXISTS. A
 * table that already carries it is left as it is.
 *
 * System tables (prefixed `_backenly_`) are skipped — they carry their own
 * specialized NOTIFY functions (e.g. presence uses backenly_notify_presence).
 */
export async function installRealtimeTrigger(
  projectId: string,
  tableName: string
): Promise<TriggerInstallResult> {
  // Skip ALL internal tables (any leading-underscore name: _backenly_presence,
  // _email_verifications, _apis, …). These are platform plumbing — streaming
  // them leaks internal writes onto the public realtime channel and pads the
  // "streaming on N tables" count with tables no end-user app subscribes to.
  // (_backenly_* additionally carry their own specialized NOTIFY triggers.)
  if (tableName.startsWith('_')) {
    return { installed: false, reason: 'internal table — platform plumbing is never streamed' }
  }

  // NEVER stream the auth table.
  //
  // The payload below is row_to_json(NEW) — the WHOLE row. On `users` that
  // includes the bcrypt password hash, so every signup, password reset and
  // login-timestamp update was broadcasting credentials over pg_notify to the
  // project's realtime channel, which is streamed by SSE to any subscribed
  // client. Found 2026-07-21: triggers were live on `users` across many
  // workspace schemas.
  //
  // The underscore rule above did not catch it because `users` has no prefix.
  // `/db/users` is 404'd and Postgres revokes it from client roles for exactly
  // this reason — realtime was the one door left open, and it bypassed both by
  // pushing rather than being read.
  //
  // Uses the same predicate the data plane uses, so "auth-managed" has ONE
  // definition. A second copy here is how one surface gets fixed and another
  // does not.
  const { isAuthManagedTable } = await import('@/lib/mcp/schema-introspection')
  if (isAuthManagedTable(tableName)) {
    return { installed: false, reason: 'auth-managed table — rows include credentials and are never streamed' }
  }

  const schemaName = `workspace_${projectId}`

  // Already streaming: nothing to install, and nothing is replaced. The notify
  // function is kept current on its own (ensureRealtimeFunctionCurrent).
  if (await streamsAlready(projectId, tableName)) return { installed: true, alreadyStreaming: true }

  // 1. Create (or replace) the shared notify function for this schema.
  //    One function per schema, reused across all tables.
  await createNotifyFunction(projectId)

  // 2. Drop the existing trigger on this table (if any) then re-create it.
  //    Split into two statements — Prisma prepared-statement mode rejects
  //    multiple commands in a single $executeRawUnsafe call (42601).
  await executeInWorkspaceSchema(
    projectId,
    `DROP TRIGGER IF EXISTS backenly_realtime ON "${schemaName}"."${tableName}"`
  )

  await executeInWorkspaceSchema(
    projectId,
    `
    CREATE TRIGGER backenly_realtime
      AFTER INSERT OR UPDATE OR DELETE
      ON "${schemaName}"."${tableName}"
      FOR EACH ROW
      EXECUTE FUNCTION "${schemaName}".backenly_notify_realtime()
    `
  )

  return { installed: true }
}

/**
 * Install realtime triggers on multiple tables in a project schema.
 * Failures per-table are logged but do not abort the rest.
 */
export async function installRealtimeTriggersForAllTables(
  projectId: string,
  tableNames: string[]
): Promise<{
  installed: string[]
  /** Streaming before the call, and left as they were. */
  alreadyStreaming: string[]
  skipped: Array<{ table: string; reason: string }>
  failed: Array<{ table: string; error: string }>
}> {
  const installed: string[] = []
  const alreadyStreaming: string[] = []
  const skipped: Array<{ table: string; reason: string }> = []
  const failed: Array<{ table: string; error: string }> = []
  for (const tableName of tableNames) {
    try {
      const result = await installRealtimeTrigger(projectId, tableName)
      if (result.alreadyStreaming) alreadyStreaming.push(tableName)
      else if (result.installed) installed.push(tableName)
      else skipped.push({ table: tableName, reason: result.reason ?? 'refused' })
    } catch (err: any) {
      console.warn(
        `[realtime] Failed to install trigger on ${tableName}:`,
        err?.message ?? err
      )
      failed.push({ table: tableName, error: err?.message ?? String(err) })
    }
  }
  return { installed, alreadyStreaming, skipped, failed }
}

/**
 * Drop the realtime NOTIFY trigger from a single table.
 * Safe to call when no trigger exists (uses DROP TRIGGER IF EXISTS). The
 * shared notify function `backenly_notify_realtime` is intentionally left in
 * place so re-enabling later is a single CREATE TRIGGER.
 *
 * System tables (prefixed `_backenly_`) are skipped — they never carry the
 * shared trigger.
 */
export async function uninstallRealtimeTrigger(
  projectId: string,
  tableName: string
): Promise<void> {
  if (tableName.startsWith('_backenly_')) return
  const schemaName = `workspace_${projectId}`
  await executeInWorkspaceSchema(
    projectId,
    `DROP TRIGGER IF EXISTS backenly_realtime ON "${schemaName}"."${tableName}"`
  )
}

/**
 * Drop realtime triggers from multiple tables. Failures per-table are logged
 * but do not abort the rest — mirrors the install-all helper's behaviour.
 */
export async function uninstallRealtimeTriggersForAllTables(
  projectId: string,
  tableNames: string[]
): Promise<void> {
  for (const tableName of tableNames) {
    try {
      await uninstallRealtimeTrigger(projectId, tableName)
    } catch (err: any) {
      console.warn(
        `[realtime] Failed to uninstall trigger on ${tableName}:`,
        err?.message ?? err
      )
    }
  }
}

/**
 * List all tables in a project's workspace schema that have the
 * backenly_realtime trigger installed. Used by the Inspector tab.
 */
export async function listTablesWithRealtimeTriggers(
  projectId: string
): Promise<string[]> {
  const schemaName = `workspace_${projectId}`

  try {
    const rows = await queryWorkspaceSchema(
      projectId,
      `
      SELECT DISTINCT event_object_table AS table_name
      FROM   information_schema.triggers
      WHERE  trigger_schema = '${schemaName}'
        AND  trigger_name   = 'backenly_realtime'
      ORDER BY event_object_table
      `
    ) as Array<{ table_name: string }>

    return (rows ?? []).map((r) => r.table_name)
  } catch {
    return []
  }
}

/** A table an app subscribes to: not an internal or a legacy `_apis` table. */
const userFacing = (table: string) => !table.startsWith('_') && !table.endsWith('_apis')

/** Realtime, as a result that made tables reports it. */
export interface NewTablesRealtime {
  /** Every table that streams now. */
  streaming: string[]
  /** The new tables that do not. */
  notStreaming: string[]
  /** One sentence: which tables stream, and the call that adds a new one. */
  note: string
}

/**
 * What to tell the caller that made `created`: null when no table streams, or
 * when every new one does.
 *
 * A new table streams only once realtime is turned on for it by name. It used
 * to join by itself whenever any table streamed, so a merge started streaming
 * a table nobody had named, History said only "Created table", and turning
 * realtime on for it afterwards changed nothing (production QA, 2026-11-16).
 * Supabase works the same way: a table streams once it is added to the
 * realtime publication.
 */
export async function realtimeForNewTables(projectId: string, created: string[]): Promise<NewTablesRealtime | null> {
  const streaming = (await listTablesWithRealtimeTriggers(projectId)).filter(userFacing)
  if (streaming.length === 0) return null
  const live = new Set(streaming)
  const notStreaming = [...new Set(created)].filter((t) => userFacing(t) && !live.has(t))
  if (notStreaming.length === 0) return null
  const call = `realtime { "action": "enable", "tableName": "${notStreaming[0]}" }`
  const note =
    `Realtime streams ${listed(streaming)}; ${listed(notStreaming)} ${notStreaming.length === 1 ? 'does' : 'do'} not. ` +
    (notStreaming.length === 1 ? `To stream it: ${call}.` : `To stream one: ${call}, once for each table.`)
  return { streaming, notStreaming, note }
}

/** "a", "a and b", "a, b and c", "a, b, c and 4 more": short enough for a clipped tool result. */
function listed(names: string[], shown = 3): string {
  if (names.length === 1) return names[0]
  if (names.length <= shown) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`
}

/**
 * Full realtime status for a project — the OBSERVE half of the realtime
 * agentic loop. Used by the AI chat brain's `get_realtime_status` read tool,
 * the executor's `GET_REALTIME_STATUS` action, and the proof system.
 *
 * Reports ground truth, never a proxy:
 *   • streamingTables — tables with a live backenly_realtime NOTIFY trigger
 *   • idleTables      — user tables WITHOUT a trigger (realtime not enabled)
 *   • allTables       — every user table in the workspace schema
 *   • onlineUsers     — end-users active in the last 90s (presence)
 *   • channel         — the stream's label (`workspace_<id>_changes`), as the
 *                       SSE `connected` frame shows it; the channel itself is
 *                       kept by the platform and never reported
 */
export interface RealtimeStatus {
  streamingTables: string[]
  idleTables: string[]
  allTables: string[]
  onlineUsers: number
  channel: string
}

export async function getRealtimeStatus(projectId: string): Promise<RealtimeStatus> {
  const schemaName = `workspace_${projectId}`
  const channel = `workspace_${projectId}_changes`

  // Tables with a live NOTIFY trigger — exclude every internal (leading-
  // underscore) table so a stray trigger left on _email_verifications / _apis
  // from before this fix never shows up as a user-facing streaming table.
  const streamingTables = (await listTablesWithRealtimeTriggers(projectId).catch(() => [] as string[]))
    .filter(userFacing)

  // Every user table in the workspace schema — system + phantom tables excluded.
  let allTables: string[] = []
  try {
    const rows = await queryWorkspaceSchema(
      projectId,
      `
      SELECT table_name
      FROM   information_schema.tables
      WHERE  table_schema = '${schemaName}'
        AND  table_type   = 'BASE TABLE'
      ORDER BY table_name
      `
    ) as Array<{ table_name: string }>
    allTables = (rows ?? [])
      .map((r) => r.table_name)
      .filter(userFacing)
  } catch {
    // Schema not provisioned yet — fall back to whatever is streaming.
    allTables = [...streamingTables]
  }

  const streamingSet = new Set(streamingTables)
  const idleTables = allTables.filter((t) => !streamingSet.has(t))

  // Online end-users — presence rows within the 60 s TTL (same window the
  // presence API prunes and lists with, so both surfaces agree). Best-effort:
  // the presence table may not be bootstrapped on a brand-new project.
  let onlineUsers = 0
  try {
    const rows = await queryWorkspaceSchema(
      projectId,
      `SELECT COUNT(*) AS cnt
       FROM "_backenly_presence"
       WHERE "lastSeen" > NOW() - INTERVAL '60 seconds'`
    ) as Array<{ cnt: string }>
    onlineUsers = parseInt(rows?.[0]?.cnt ?? '0', 10) || 0
  } catch {
    // Presence table not provisioned yet — leave at 0.
  }

  return { streamingTables, idleTables, allTables, onlineUsers, channel }
}
