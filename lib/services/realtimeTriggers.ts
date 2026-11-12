/**
 * Realtime Trigger Installer
 *
 * Installs PostgreSQL NOTIFY triggers on workspace tables so that
 * INSERT / UPDATE / DELETE events are broadcast to the SSE endpoint.
 *
 * The trigger calls pg_notify() on the channel `workspace_{projectId}_changes`
 * with a JSON payload:
 *   {
 *     type: "INSERT" | "UPDATE" | "DELETE",
 *     table: "messages",
 *     data: { ...newRow },      // new row (or deleted row for DELETE)
 *     old:  { ...oldRow } | null // previous row for UPDATE only
 *     timestamp: 1711234567.123
 *   }
 *
 * pg_notify payload limit is 8000 bytes. For large rows the data field
 * is cut down to stay within limits: an update's old row to its primary key
 * first, then the row itself, so a client can still fetch the row by that key
 * or drop a deleted one (notifyFunctionSql).
 *
 * Important: this uses executeInWorkspaceSchema (Prisma raw) which goes
 * through the pooled connection. That is fine for one-shot DDL; only
 * the LISTEN (in the SSE route) needs the direct connection.
 */

import { executeInWorkspaceSchema, queryWorkspaceSchema } from './workspaceDatabase'

const MAX_PAYLOAD_BYTES = 7_500 // Stay safely below pg_notify's 8 000-byte limit

/**
 * Recorded on the notify function, so a schema still running an older body is
 * recognised and replaced (ensureRealtimeFunctionCurrent).
 */
export const REALTIME_FUNCTION_VERSION = 'backenly realtime notify v2'

/**
 * The shared notify function for a schema: one per schema, reused by every
 * table's trigger.
 *
 * A change goes out whole when it fits pg_notify's limit. One that does not
 * used to go out as `{ data: null, truncated: true }`: the client learned that
 * some row changed and not which, could neither fetch it nor apply a delete,
 * and a handler reading `event.data.id` threw (#620). Updates got there at half
 * the row size, because the payload carries the whole old row too. Now, in
 * turn, until it fits:
 *
 *   1. an update's old row is reduced to its primary key (`oldTruncated`),
 *      which is all a stream that is not a service-role one ever receives of
 *      it (lib/realtime/visibility.ts), and the new row stays whole;
 *   2. the row is reduced to its primary key (`truncated`), so a client knows
 *      which row to fetch or drop, and the routes deliver the frame only to a
 *      stream that may read that row, as they do any change with row data;
 *   3. only a table with no primary key, or one too large to send, gets the
 *      old frame with no row data.
 *
 * The primary key is looked up only on that path. pg_notify is never handed
 * more than the limit: raising there would fail the write that fired it.
 */
function notifyFunctionSql(schemaName: string, channel: string): string {
  return `
    CREATE OR REPLACE FUNCTION "${schemaName}".backenly_notify_realtime()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      payload  text;
      row_data json;
      old_data json;
      key_cols text[];
      row_key  json;
      old_key  json;
    BEGIN
      row_data := CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE row_to_json(NEW) END;
      old_data := CASE WHEN TG_OP = 'UPDATE' THEN row_to_json(OLD) ELSE NULL END;

      payload := json_build_object(
        'type',      lower(TG_OP),
        'table',     TG_TABLE_NAME,
        'data',      row_data,
        'old',       old_data,
        'timestamp', extract(epoch from clock_timestamp())
      )::text;
      IF octet_length(payload) <= ${MAX_PAYLOAD_BYTES} THEN
        PERFORM pg_notify('${channel}', payload);
        RETURN COALESCE(NEW, OLD);
      END IF;

      SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum))
        INTO key_cols
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = TG_RELID AND i.indisprimary;

      IF key_cols IS NOT NULL THEN
        SELECT json_object_agg(k, row_data -> k) INTO row_key FROM unnest(key_cols) AS k;

        -- 1. The old row reduced to its key, the new row whole.
        IF TG_OP = 'UPDATE' THEN
          SELECT json_object_agg(k, old_data -> k) INTO old_key FROM unnest(key_cols) AS k;
          payload := json_build_object(
            'type',         lower(TG_OP),
            'table',        TG_TABLE_NAME,
            'data',         row_data,
            'old',          old_key,
            'oldTruncated', true,
            'timestamp',    extract(epoch from clock_timestamp())
          )::text;
          IF octet_length(payload) <= ${MAX_PAYLOAD_BYTES} THEN
            PERFORM pg_notify('${channel}', payload);
            RETURN COALESCE(NEW, OLD);
          END IF;
        END IF;

        -- 2. The row reduced to its key: which row changed.
        payload := json_build_object(
          'type',      lower(TG_OP),
          'table',     TG_TABLE_NAME,
          'data',      row_key,
          'old',       old_key,
          'truncated', true,
          'timestamp', extract(epoch from clock_timestamp())
        )::text;
        IF octet_length(payload) <= ${MAX_PAYLOAD_BYTES} THEN
          PERFORM pg_notify('${channel}', payload);
          RETURN COALESCE(NEW, OLD);
        END IF;
      END IF;

      -- 3. No key to name the row by.
      PERFORM pg_notify('${channel}', json_build_object(
        'type',      lower(TG_OP),
        'table',     TG_TABLE_NAME,
        'data',      null,
        'truncated', true,
        'timestamp', extract(epoch from clock_timestamp())
      )::text);
      RETURN COALESCE(NEW, OLD);
    END;
    $$;
    `
}

/** Create (or replace) a schema's notify function and record its version. */
async function createNotifyFunction(projectId: string): Promise<void> {
  const schemaName = `workspace_${projectId}`
  await executeInWorkspaceSchema(projectId, notifyFunctionSql(schemaName, `workspace_${projectId}_changes`))
  await executeInWorkspaceSchema(
    projectId,
    `COMMENT ON FUNCTION "${schemaName}".backenly_notify_realtime() IS '${REALTIME_FUNCTION_VERSION}'`,
  )
}

/** Projects whose notify function this process has already found current, or absent. */
const currentFunctionChecked = new Set<string>()
/** A check under way, shared by every stream that opens for the project meanwhile. */
const functionChecks = new Map<string, Promise<'current' | 'upgraded' | 'absent'>>()

/**
 * Replace a schema's notify function if it predates REALTIME_FUNCTION_VERSION.
 *
 * Every table's trigger calls the one function by name, so replacing it moves
 * all of the project's realtime tables to the current body at once. Schemas
 * whose realtime was enabled before kept the old body, which sent large changes
 * with no row key, until a table's realtime was enabled again. Checked once per
 * project per process; a schema without the function has no realtime table.
 */
export function ensureRealtimeFunctionCurrent(projectId: string): Promise<'current' | 'upgraded' | 'absent'> {
  if (currentFunctionChecked.has(projectId)) return Promise.resolve('current')
  let check = functionChecks.get(projectId)
  if (!check) {
    check = checkRealtimeFunction(projectId).finally(() => functionChecks.delete(projectId))
    functionChecks.set(projectId, check)
  }
  return check
}

async function checkRealtimeFunction(projectId: string): Promise<'current' | 'upgraded' | 'absent'> {
  const schemaName = `workspace_${projectId}`
  const rows = (await queryWorkspaceSchema(
    projectId,
    `SELECT obj_description(p.oid, 'pg_proc') AS version
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = 'backenly_notify_realtime'`,
    schemaName,
  )) as Array<{ version: string | null }>
  let outcome: 'current' | 'upgraded' | 'absent' = 'current'
  if (!rows?.length) outcome = 'absent'
  else if (rows[0].version !== REALTIME_FUNCTION_VERSION) {
    await createNotifyFunction(projectId)
    outcome = 'upgraded'
  }
  currentFunctionChecked.add(projectId)
  return outcome
}

/**
 * Install (or replace) the realtime NOTIFY trigger on a single table.
 * Safe to call multiple times — uses CREATE OR REPLACE / DROP IF EXISTS.
 *
 * System tables (prefixed `_backenly_`) are skipped — they carry their own
 * specialized NOTIFY functions (e.g. presence uses backenly_notify_presence).
 */
/** Why a table was not given a trigger, when it was not. */
export interface TriggerInstallResult {
  installed: boolean
  reason?: string
}

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

  // 1. Create (or replace) the shared notify function for this schema.
  //    One function per schema, reused across all tables.
  await createNotifyFunction(projectId)
  currentFunctionChecked.add(projectId)

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
): Promise<{ installed: string[]; skipped: Array<{ table: string; reason: string }>; failed: Array<{ table: string; error: string }> }> {
  const installed: string[] = []
  const skipped: Array<{ table: string; reason: string }> = []
  const failed: Array<{ table: string; error: string }> = []
  for (const tableName of tableNames) {
    try {
      const result = await installRealtimeTrigger(projectId, tableName)
      if (result.installed) installed.push(tableName)
      else skipped.push({ table: tableName, reason: result.reason ?? 'refused' })
    } catch (err: any) {
      console.warn(
        `[realtime] Failed to install trigger on ${tableName}:`,
        err?.message ?? err
      )
      failed.push({ table: tableName, error: err?.message ?? String(err) })
    }
  }
  return { installed, skipped, failed }
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
 *   • channel         — the Postgres NOTIFY channel name
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
    .filter((n) => !n.startsWith('_') && !n.endsWith('_apis'))

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
      .filter((n) => !n.startsWith('_') && !n.endsWith('_apis'))
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
