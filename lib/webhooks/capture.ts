/**
 * WHERE ROW EVENTS COME FROM
 * ==========================
 *
 * `triggerWebhooks()` had no caller. Not one. The delivery engine, the retry
 * ladder, the dead-letter handling and the HMAC signing were all real and all
 * unreachable, because nothing in the tree ever announced that a row had
 * changed. The register called webhooks BACKEND_ONLY on the strength of a
 * route and a library existing; what was actually missing was the event.
 *
 * ── Why capture has to be in the database ───────────────────────────────────
 *
 * PostgREST is the only data plane. An end-user app's INSERT arrives at
 * Postgres over :3002 and the Next process never sees it. So an inline
 * `triggerWebhooks()` call in a route handler would fire for the dashboard's
 * own table editor and stay silent for every write the product actually
 * exists to serve — a webhook surface that works in the demo and not in
 * production. The only place that observes every writer is Postgres itself.
 *
 * ── Why an outbox table and not the realtime NOTIFY ─────────────────────────
 *
 * Realtime already captures row changes, and reusing it was the first
 * instinct. Its own header says why that is wrong here:
 *
 *     events during the outage are lost, which matches LISTEN/NOTIFY
 *     semantics — clients needing gapless data must re-fetch via REST
 *
 * That is the correct trade for a live view a human is watching. It is the
 * wrong one for a webhook: a receiver cannot "re-fetch", it can only never be
 * told. A hub reconnect, a web process restart or a deploy would silently
 * drop deliveries, and silence is indistinguishable from "nothing happened".
 * pg_notify also truncates past ~8000 bytes, so large rows would arrive
 * without their data.
 *
 * So the trigger writes a row. It commits with the transaction that caused it
 * — if the INSERT rolls back, so does the event, which NOTIFY cannot promise —
 * and it survives every restart. A drain in `runSystemTasks` turns outbox rows
 * into WebhookLog rows and hands them to the existing delivery ladder.
 *
 * ── At-least-once, and saying so ────────────────────────────────────────────
 *
 * Claim, deliver, delete. A crash between claiming and logging leaves a row
 * claimed, and the reclaim window puts it back. That means a receiver can see
 * the same event twice, so every delivery carries an `id` in its payload and
 * an `X-Webhook-Delivery` header for de-duplication. At-least-once is the
 * honest guarantee; pretending to exactly-once would be a lie with a retry
 * ladder attached.
 *
 * ── What is deliberately NOT captured ───────────────────────────────────────
 *
 * Auth-managed tables. `users` holds the bcrypt hash, and realtime shipped a
 * live credential leak for months by broadcasting row_to_json(NEW) from it.
 * The same predicate excludes it here, from the same source, so "auth-managed"
 * keeps one definition. `auth.user.created` is emitted by the signup route
 * instead, from a payload built field by field.
 */

import { prisma } from '@/lib/db/prisma'
import { executeInWorkspaceSchema, queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { ROW_EVENT_TYPES, type RowEventType, type WebhookEventType } from './events'

/** The trigger attached to every captured table. */
const TRIGGER_NAME = 'backenly_webhook_capture'
/** The per-schema function that trigger executes. */
const FUNCTION_NAME = 'backenly_capture_webhook_event'
/** The durable queue the trigger writes into. */
export const OUTBOX_TABLE = '_backenly_webhook_outbox'

/**
 * Rows larger than this are stored without their data and marked truncated.
 *
 * There is no pg_notify limit to respect here — this is about not turning one
 * 40 MB jsonb column into a 40 MB HTTP body aimed at someone's endpoint.
 */
const MAX_ROW_BYTES = 64 * 1024

/** A claimed row older than this is assumed orphaned by a crash and retried. */
const RECLAIM_AFTER_MINUTES = 5

/** Postgres statement keyword for each row event Backenly exposes. */
const PG_OPERATION: Record<RowEventType, 'INSERT' | 'UPDATE' | 'DELETE'> = {
  'row.inserted': 'INSERT',
  'row.updated': 'UPDATE',
  'row.deleted': 'DELETE',
}

/** Backenly event name for each Postgres operation the trigger reports. */
const EVENT_FOR_OPERATION: Record<string, RowEventType> = {
  INSERT: 'row.inserted',
  UPDATE: 'row.updated',
  DELETE: 'row.deleted',
}

// ── Eligibility ──────────────────────────────────────────────────────────────

/**
 * May this table carry a capture trigger?
 *
 * Mirrors `installRealtimeTrigger`'s exclusions and imports the auth predicate
 * from the same module rather than restating it. A second copy is how one
 * surface gets fixed and another does not — which is exactly how `users` stayed
 * on the realtime channel after `/db/users` had been 404'd.
 */
export async function isCapturableTable(tableName: string): Promise<boolean> {
  if (tableName.startsWith('_')) return false
  const { isAuthManagedTable } = await import('@/lib/mcp/schema-introspection')
  if (isAuthManagedTable(tableName)) return false
  return true
}

/** Every user table in the workspace schema that may carry a trigger. */
async function capturableTables(projectId: string): Promise<string[]> {
  const schema = workspaceSchemaName(projectId)
  const rows = (await queryWorkspaceSchema(
    projectId,
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    schema,
  )) as Array<{ table_name: string }>

  const names = (rows ?? []).map(r => r.table_name)
  const eligible: string[] = []
  for (const name of names) {
    if (await isCapturableTable(name)) eligible.push(name)
  }
  return eligible
}

// ── Schema objects ───────────────────────────────────────────────────────────

/**
 * Create the outbox and the trigger function. Idempotent.
 *
 * `claimed_at` is the whole concurrency model: NULL means available, a
 * timestamp means some drain owns it, and an old timestamp means that drain
 * died. The partial index keeps the claim query reading only the rows that are
 * actually waiting, which matters because this table is written on every
 * captured row change and read once a minute.
 */
export async function ensureOutbox(projectId: string): Promise<void> {
  const schema = workspaceSchemaName(projectId)

  await executeInWorkspaceSchema(
    projectId,
    `CREATE TABLE IF NOT EXISTS "${schema}"."${OUTBOX_TABLE}" (
       id          bigserial PRIMARY KEY,
       event_type  text        NOT NULL,
       table_name  text        NOT NULL,
       row_data    jsonb,
       old_data    jsonb,
       truncated   boolean     NOT NULL DEFAULT false,
       occurred_at timestamptz NOT NULL DEFAULT now(),
       claimed_at  timestamptz
     )`,
  )

  await executeInWorkspaceSchema(
    projectId,
    `CREATE INDEX IF NOT EXISTS "${OUTBOX_TABLE}_pending_idx"
       ON "${schema}"."${OUTBOX_TABLE}" (id)
       WHERE claimed_at IS NULL`,
  )

  // `event_type` stores TG_OP verbatim. One trigger covers several operations
  // and TG_ARGV is fixed at CREATE TRIGGER time, so a constant passed there
  // could not say which operation actually fired — and inferring it from which
  // jsonb columns are populated is ambiguous between INSERT and DELETE, both of
  // which have `row_data` and no `old_data`. TG_OP is the only thing that knows.
  await executeInWorkspaceSchema(
    projectId,
    `CREATE OR REPLACE FUNCTION "${schema}".${FUNCTION_NAME}()
     RETURNS trigger LANGUAGE plpgsql
     SECURITY DEFINER
     SET search_path = pg_catalog, pg_temp
     AS $capture$
     DECLARE
       new_row jsonb;
       old_row jsonb;
       too_big boolean := false;
     BEGIN
       new_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
       old_row := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;

       IF octet_length(new_row::text) > ${MAX_ROW_BYTES}
          OR (old_row IS NOT NULL AND octet_length(old_row::text) > ${MAX_ROW_BYTES}) THEN
         too_big := true;
         new_row := NULL;
         old_row := NULL;
       END IF;

       INSERT INTO "${schema}"."${OUTBOX_TABLE}"
         (event_type, table_name, row_data, old_data, truncated)
       VALUES (TG_OP, TG_TABLE_NAME, new_row, old_row, too_big);

       RETURN COALESCE(NEW, OLD);
     END;
     $capture$;`,
  )
}

/**
 * Attach the capture trigger for exactly the given events to one table.
 *
 * SECURITY DEFINER above, and this: the trigger fires under whichever role
 * performed the write — for PostgREST traffic that is `backenly_authenticator`
 * acting as an end-user role, which has no rights on a leading-underscore
 * table and must not be given any. Defining the function as its owner lets the
 * insert succeed without widening what the end-user role can reach directly.
 *
 * Which is exactly why it also carries `SET search_path = pg_catalog, pg_temp`.
 * A SECURITY DEFINER function runs with the definer's privileges but inherits
 * the CALLER's search_path, and the workspace schema is a place the tenant can
 * create objects by design. Without the pin, a tenant could define their own
 * `to_jsonb` in that schema and have it executed as the function's owner. The
 * table is fully qualified for the same reason; the pin covers the built-ins
 * the qualification cannot.
 */
async function installCaptureTrigger(
  projectId: string,
  tableName: string,
  events: readonly RowEventType[],
): Promise<void> {
  const schema = workspaceSchemaName(projectId)

  await executeInWorkspaceSchema(
    projectId,
    `DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "${schema}"."${tableName}"`,
  )

  if (events.length === 0) return

  // Deduplicated and ordered so the emitted SQL is stable for a given
  // subscription set, which keeps the "did this change?" diff readable.
  const ops = [...new Set(events.map(e => PG_OPERATION[e]))].sort().join(' OR ')

  await executeInWorkspaceSchema(
    projectId,
    `CREATE TRIGGER ${TRIGGER_NAME}
       AFTER ${ops}
       ON "${schema}"."${tableName}"
       FOR EACH ROW
       EXECUTE FUNCTION "${schema}".${FUNCTION_NAME}()`,
  )
}

/** Remove the capture trigger from one table. Safe when none is installed. */
async function uninstallCaptureTrigger(projectId: string, tableName: string): Promise<void> {
  const schema = workspaceSchemaName(projectId)
  await executeInWorkspaceSchema(
    projectId,
    `DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "${schema}"."${tableName}"`,
  )
}

/**
 * Throw away every captured event that has not become a delivery yet.
 *
 * Called when a project is paused (lib/projects/pause-lifecycle.ts). Holding
 * these instead would turn them into deliveries weeks later, on resume, and a
 * receiver would get an "insert" for a row that may have changed ten times
 * since. Returns how many were discarded so the pause can record it; 0 when the
 * project never installed row capture and has no outbox at all.
 */
export async function discardOutbox(projectId: string): Promise<number> {
  const schema = workspaceSchemaName(projectId)
  const present = (await queryWorkspaceSchema(
    projectId,
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    `"${schema}"."${OUTBOX_TABLE}"`,
  )) as Array<{ present: boolean }>
  if (!present?.[0]?.present) return 0

  // executeInWorkspaceSchema answers the row count, which is exactly the number
  // wanted here (see the RETURNING note in drainProject for the reverse case).
  const deleted = await executeInWorkspaceSchema(
    projectId,
    `DELETE FROM "${schema}"."${OUTBOX_TABLE}"`,
  )
  return typeof deleted === 'number' ? deleted : 0
}

/** Tables in this project that currently carry the capture trigger. */
export async function listCapturedTables(projectId: string): Promise<string[]> {
  const schema = workspaceSchemaName(projectId)
  try {
    const rows = (await queryWorkspaceSchema(
      projectId,
      `SELECT DISTINCT event_object_table AS table_name
         FROM information_schema.triggers
        WHERE trigger_schema = $1
          AND trigger_name = $2
        ORDER BY event_object_table`,
      schema,
      TRIGGER_NAME,
    )) as Array<{ table_name: string }>
    return (rows ?? []).map(r => r.table_name)
  } catch {
    return []
  }
}

// ── Subscription sync ────────────────────────────────────────────────────────

/**
 * Make the database's triggers match the project's active webhooks.
 *
 * Called after every webhook create, edit, enable/disable and delete, and
 * after a table is added, so "which events are captured" is derived from the
 * webhook rows rather than tracked separately and allowed to drift.
 *
 * With no active row webhook the triggers come off entirely. That is the
 * difference between a feature nobody enabled costing nothing and it costing
 * an extra write on every INSERT in the project forever.
 *
 * The outbox TABLE is deliberately left behind when the last webhook is
 * deleted: it may still hold undelivered events, and dropping it to tidy up
 * would discard them.
 */
export async function syncWebhookCapture(projectId: string): Promise<{
  events: RowEventType[]
  tables: string[]
}> {
  const active = await prisma.webhook.findMany({
    where: { projectId, active: true },
    select: { eventType: true },
  })

  const wanted = [
    ...new Set(
      active
        .map(w => w.eventType)
        .filter((e): e is RowEventType => (ROW_EVENT_TYPES as readonly string[]).includes(e)),
    ),
  ]

  const captured = await listCapturedTables(projectId)

  if (wanted.length === 0) {
    for (const table of captured) {
      await uninstallCaptureTrigger(projectId, table).catch(err =>
        console.warn(`[webhooks] could not drop capture on ${table}:`, err?.message ?? err),
      )
    }
    return { events: [], tables: [] }
  }

  await ensureOutbox(projectId)

  const eligible = await capturableTables(projectId)
  const installed: string[] = []

  for (const table of eligible) {
    try {
      await installCaptureTrigger(projectId, table, wanted)
      installed.push(table)
    } catch (err: any) {
      console.warn(`[webhooks] could not capture ${table}:`, err?.message ?? err)
    }
  }

  // A table that lost eligibility (renamed into an underscore, became
  // auth-managed) keeps its trigger otherwise.
  const eligibleSet = new Set(eligible)
  for (const table of captured) {
    if (!eligibleSet.has(table)) await uninstallCaptureTrigger(projectId, table).catch(() => {})
  }

  return { events: wanted, tables: installed }
}

// ── Drain ────────────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string
  event_type: string
  table_name: string
  row_data: Record<string, unknown> | null
  old_data: Record<string, unknown> | null
  truncated: boolean
  occurred_at: Date
}

/** Batch size per project per tick. Bounds one slow endpoint's blast radius. */
const DRAIN_BATCH = 200

/**
 * Convert one project's captured rows into webhook deliveries.
 *
 * FOR UPDATE SKIP LOCKED plus the claim stamp means two web processes draining
 * the same project take disjoint work rather than delivering everything twice.
 */
async function drainProject(projectId: string): Promise<number> {
  const schema = workspaceSchemaName(projectId)

  // queryWorkspaceSchema, NOT executeInWorkspaceSchema: the latter returns
  // `result.rowCount`, so a RETURNING clause sent through it yields a number
  // and every claimed row is discarded. That version of this function drained
  // nothing, for ever, while reporting success — the exact shape of bug this
  // program keeps finding, so it is named here rather than quietly fixed.
  const claimed = (await queryWorkspaceSchema(
    projectId,
    `WITH due AS (
       SELECT id
         FROM "${schema}"."${OUTBOX_TABLE}"
        WHERE claimed_at IS NULL
           OR claimed_at < now() - interval '${RECLAIM_AFTER_MINUTES} minutes'
        ORDER BY id
        LIMIT ${DRAIN_BATCH}
        FOR UPDATE SKIP LOCKED
     )
     UPDATE "${schema}"."${OUTBOX_TABLE}" o
        SET claimed_at = now()
       FROM due
      WHERE o.id = due.id
      RETURNING o.id, o.event_type, o.table_name, o.row_data, o.old_data,
                o.truncated, o.occurred_at`,
  )) as OutboxRow[]

  if (!Array.isArray(claimed) || claimed.length === 0) return 0

  const { triggerWebhooks } = await import('./index')
  const deliveredIds: string[] = []

  for (const row of claimed) {
    const eventType = resolveEventType(row)
    if (!eventType) {
      deliveredIds.push(row.id)
      continue
    }

    try {
      await triggerWebhooks(projectId, eventType, {
        table: row.table_name,
        record: row.row_data,
        old: row.old_data,
        truncated: row.truncated,
        occurredAt: new Date(row.occurred_at).toISOString(),
        outboxId: String(row.id),
      })
      deliveredIds.push(row.id)
    } catch (err: any) {
      // Leave it claimed. The reclaim window brings it back rather than
      // dropping an event because one tick failed.
      console.warn(`[webhooks] enqueue failed for outbox ${row.id}:`, err?.message ?? err)
    }
  }

  if (deliveredIds.length > 0) {
    await executeInWorkspaceSchema(
      projectId,
      `DELETE FROM "${schema}"."${OUTBOX_TABLE}" WHERE id = ANY($1::bigint[])`,
      deliveredIds,
    )
  }

  return deliveredIds.length
}

/**
 * Which Backenly event an outbox row represents.
 *
 * `event_type` holds TG_OP. An unrecognised value means a row written by a
 * trigger this build does not know about; it is dropped rather than guessed
 * at, and the caller deletes it so it cannot wedge the queue.
 */
function resolveEventType(row: OutboxRow): RowEventType | null {
  return EVENT_FOR_OPERATION[row.event_type] ?? null
}

/**
 * Drain every project that has an active row webhook.
 *
 * Driven from `runSystemTasks`, beside the retry ladder it feeds. Projects are
 * processed independently so one unreachable schema cannot stall the rest.
 */
export async function drainWebhookOutbox(): Promise<number> {
  const projects = await prisma.webhook.findMany({
    // A paused project's outbox was emptied when it paused and nothing can
    // write to it since, so there is nothing to drain.
    where: { active: true, eventType: { in: [...ROW_EVENT_TYPES] }, project: { pausedAt: null } },
    select: { projectId: true },
    distinct: ['projectId'],
  })

  let total = 0
  for (const { projectId } of projects) {
    try {
      total += await drainProject(projectId)
    } catch (err: any) {
      console.warn(`[webhooks] drain failed for ${projectId}:`, err?.message ?? err)
    }
  }

  if (total > 0) console.log(`[webhooks] drained ${total} captured event(s)`)
  return total
}

export type { RowEventType, WebhookEventType }
