/**
 * Realtime channels — reading, creating and replacing them.
 *
 * Each project's realtime stream has its own channel name, kept by the
 * platform (lib/realtime/channel-sql.ts has the objects and the reasons).
 * This module is the only code that handles one:
 *
 *   - the listener hub asks for a project's channel, to LISTEN on it;
 *   - broadcast asks for a payload to be sent on it, and never holds the name;
 *   - closing a project's write access to its database replaces it.
 *
 * The name stays in this process and in the database. It is not put in a
 * response, an SSE frame, a log line or the change history: every statement
 * that carries one runs on this module's own pool, which the change recorder
 * does not see, and what callers and people are shown is the stream's label
 * (workspaceChannelName in lib/security/workspace-schema.ts).
 *
 * The platform objects are installed by the application itself, as the
 * application role, the first time a process needs them in a region. Nothing
 * has to be run by hand for realtime to work, on Cloud or self-hosted.
 */

import { randomBytes } from 'crypto'
import type { Pool } from 'pg'
import { projectRegion, regionPool } from '@/lib/data-plane/regional'
import type { CloudRegionId } from '@/lib/regions'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import {
  CHANNEL_ROTATED_FRAME,
  CREATE_CHANNEL_FOR_EXISTING_SCHEMA_SQL,
  CREATE_CHANNEL_SQL,
  FUNCTION_STATE_SQL,
  NOTIFY_CHANNEL_SQL,
  NOTIFY_FUNCTION_NAME,
  PLATFORM_INSTALL_LOCK_SQL,
  PLATFORM_STATUS_SQL,
  READ_CHANNELS_SQL,
  READ_CHANNEL_SQL,
  ROTATE_CHANNEL_SQL,
  currentFunctionSql,
  isChannelName,
  platformInstallSql,
  type RealtimeFunctionName,
  type RealtimeFunctionRow,
  type RealtimePlatformStatus,
} from './channel-sql'

/**
 * This module's connections to a region, as the application role. Asked for on
 * every use, never kept: lib/data-plane/regional.ts owns the pools and may
 * close them.
 */
export function realtimePool(region: CloudRegionId, projectId?: string): Pool {
  return regionPool(region, 'realtime-channels', { max: 4 }, projectId)
}

// ── Platform objects ─────────────────────────────────────────────────────────

export async function readRealtimePlatformStatus(pool: Pool): Promise<RealtimePlatformStatus> {
  const { rows } = await pool.query<RealtimePlatformStatus>(PLATFORM_STATUS_SQL)
  return rows[0]
}

/**
 * Create whatever is missing of the schema, the table and the view, in one
 * transaction, as the role this pool connects with (which then owns them).
 * A read decides first, so a database that is up to date sees no DDL; the
 * lock makes two processes starting together install once.
 */
export async function installRealtimePlatform(pool: Pool): Promise<'current' | 'installed'> {
  if (platformInstallSql(await readRealtimePlatformStatus(pool)).length === 0) return 'current'

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    await client.query(PLATFORM_INSTALL_LOCK_SQL)
    const { rows } = await client.query<RealtimePlatformStatus>(PLATFORM_STATUS_SQL)
    const steps = platformInstallSql(rows[0])
    for (const sql of steps) await client.query(sql)
    await client.query('COMMIT')
    return steps.length > 0 ? 'installed' : 'current'
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const installs = new Map<CloudRegionId, Promise<void>>()

/** Once per region per process; a failure is forgotten, so the next caller tries again. */
export function ensureRealtimePlatform(region: CloudRegionId, projectId?: string): Promise<void> {
  const known = installs.get(region)
  if (known) return known
  const install = Promise.resolve()
    .then(() => installRealtimePlatform(realtimePool(region, projectId)))
    .then(() => undefined)
  installs.set(region, install)
  install.catch(() => {
    if (installs.get(region) === install) installs.delete(region)
  })
  return install
}

/** SQLSTATE of "that table / that schema is not there". */
function isMissingPlatform(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === '42P01' || code === '3F000'
}

/**
 * Run against the platform objects. If they turn out to be gone under a
 * process that installed them (a database restored from a bundle that does not
 * carry them), install again and run once more.
 */
async function onPlatform<T>(
  region: CloudRegionId,
  projectId: string | undefined,
  run: (pool: Pool) => Promise<T>,
): Promise<T> {
  await ensureRealtimePlatform(region, projectId)
  try {
    return await run(realtimePool(region, projectId))
  } catch (err) {
    if (!isMissingPlatform(err)) throw err
    installs.delete(region)
    await ensureRealtimePlatform(region, projectId)
    return run(realtimePool(region, projectId))
  }
}

// ── Channels ─────────────────────────────────────────────────────────────────

/** Random, made here: the database may have no pgcrypto. */
function newChannelName(): string {
  return `bkn_rt_${randomBytes(24).toString('hex')}`
}

async function resolveChannel(projectId: string, createSql: string): Promise<string | null> {
  const schema = workspaceSchemaName(projectId)
  const region = await projectRegion(projectId)
  return onPlatform(region, projectId, async (pool) => {
    // Two statements: an insert that lost to another process's sees that
    // process's row only in a statement of its own.
    await pool.query(createSql, [schema, newChannelName()])
    const { rows } = await pool.query<{ channel: unknown }>(READ_CHANNEL_SQL, [schema])
    if (rows.length === 0) return null
    const { channel } = rows[0]
    if (!isChannelName(channel)) throw new Error('The realtime channel stored for this project is not a channel name')
    return channel
  })
}

/** The project's channel, created the first time it is asked for. */
export async function projectChannel(projectId: string): Promise<string> {
  const channel = await resolveChannel(projectId, CREATE_CHANNEL_SQL)
  if (channel === null) throw new Error('The realtime channel of this project is not available')
  return channel
}

/**
 * The project's channel as it is now. One that is missing is created only
 * while the project's schema exists, so a project that has just been deleted
 * gets no new row; null then.
 */
export function currentProjectChannel(projectId: string): Promise<string | null> {
  return resolveChannel(projectId, CREATE_CHANNEL_FOR_EXISTING_SCHEMA_SQL)
}

/** The channels of these schemas, for the ones that have one. One query. */
export async function channelsOfSchemas(region: CloudRegionId, schemas: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (schemas.length === 0) return found
  const rows = await onPlatform(region, undefined, async (pool) => {
    const result = await pool.query<{ schema_name: string; channel: unknown }>(READ_CHANNELS_SQL, [schemas])
    return result.rows
  })
  for (const row of rows) {
    if (isChannelName(row.channel)) found.set(row.schema_name, row.channel)
  }
  return found
}

/**
 * Send `payload` to the project's stream. The database reads the channel and
 * sends in one statement, so the caller never holds the name and a channel
 * replaced a moment ago is never used. False when the project has no channel:
 * no stream has been opened for it yet, so nobody is there to hear it.
 */
export async function notifyProjectChannel(projectId: string, payload: string): Promise<boolean> {
  const schema = workspaceSchemaName(projectId)
  const region = await projectRegion(projectId)
  try {
    const { rowCount } = await realtimePool(region, projectId).query(NOTIFY_CHANNEL_SQL, [schema, payload])
    return (rowCount ?? 0) > 0
  } catch (err) {
    if (isMissingPlatform(err)) return false
    throw err
  }
}

/**
 * Give the project a new channel, and tell whoever listens on the old one to
 * read it. Run when a login that could read the channel is closed, re-keyed
 * or removed (lib/services/direct-access.ts): what that login knew stops
 * being the project's channel. Streams move over in milliseconds; a change
 * announced in that gap is not delivered, as with any reconnect.
 *
 * Never creates a channel ('absent': nothing was there to replace) and throws
 * when the database could not be asked, so the caller does not report a
 * replacement that did not happen.
 */
export async function rotateProjectChannel(projectId: string): Promise<'rotated' | 'absent'> {
  const schema = workspaceSchemaName(projectId)
  const region = await projectRegion(projectId)
  try {
    const { rowCount } = await realtimePool(region, projectId).query(ROTATE_CHANNEL_SQL, [
      schema,
      newChannelName(),
      CHANNEL_ROTATED_FRAME,
    ])
    return (rowCount ?? 0) > 0 ? 'rotated' : 'absent'
  } catch (err) {
    if (isMissingPlatform(err)) return 'absent'
    throw err
  }
}

// ── The functions in workspace schemas ───────────────────────────────────────

/** `upgraded`: it was there with another body and now has the current one. */
export type FunctionState = 'current' | 'upgraded' | 'absent'

export interface SchemaFunctions {
  notify: FunctionState
  presence: FunctionState
}

export interface FunctionsOutcome {
  states: Map<string, SchemaFunctions>
  /** Schemas whose functions could not be replaced this time, and why. */
  failures: Array<{ schema: string; error: unknown }>
}

async function functionRows(pool: Pool, schemas: string[]): Promise<RealtimeFunctionRow[]> {
  const { rows } = await pool.query<RealtimeFunctionRow>(FUNCTION_STATE_SQL, [schemas])
  return rows
}

/**
 * Replace the notify and presence functions of these schemas where they are
 * not the current ones. A function that is absent stays absent.
 *
 * One query finds them. Each schema is then replaced in a transaction of its
 * own (body and version comment together), outside the change history: the
 * body is Backenly's, not part of what a project's history records.
 *
 * Another process may be replacing the same function at the same moment, and
 * PostgreSQL then refuses one of the two. So a refusal is followed by a look:
 * if the function is current after all, that is success.
 */
export async function bringFunctionsCurrent(pool: Pool, schemas: string[]): Promise<FunctionsOutcome> {
  const states = new Map<string, SchemaFunctions>()
  const failures: FunctionsOutcome['failures'] = []
  for (const schema of schemas) states.set(schema, { notify: 'absent', presence: 'absent' })
  if (schemas.length === 0) return { states, failures }

  const stale = new Map<string, RealtimeFunctionName[]>()
  for (const row of await functionRows(pool, schemas)) {
    const entry = states.get(row.schema_name)
    if (!entry) continue
    entry[row.function_name === NOTIFY_FUNCTION_NAME ? 'notify' : 'presence'] = row.current ? 'current' : 'upgraded'
    if (!row.current) stale.set(row.schema_name, [...(stale.get(row.schema_name) ?? []), row.function_name])
  }

  for (const [schema, names] of stale) {
    try {
      await pool.query([`SET LOCAL lock_timeout = '3s';`, ...names.map((name) => currentFunctionSql(schema, name))].join('\n'))
    } catch (error) {
      const after = await functionRows(pool, [schema]).catch(() => null)
      if (after === null || after.some((row) => !row.current)) failures.push({ schema, error })
    }
  }
  return { states, failures }
}

const projectChecks = new Map<string, Promise<SchemaFunctions>>()

/**
 * Bring one project's notify and presence functions current. Asked every time
 * a stream opens and again by the hub's repair pass, not once per process: an
 * older release still running beside this one, or a restore, can put an older
 * body back at any time. Calls that overlap share one check.
 */
export function bringProjectFunctionsCurrent(projectId: string): Promise<SchemaFunctions> {
  const running = projectChecks.get(projectId)
  if (running) return running
  const check = (async () => {
    const schema = workspaceSchemaName(projectId)
    const region = await projectRegion(projectId)
    const { states, failures } = await bringFunctionsCurrent(realtimePool(region, projectId), [schema])
    if (failures.length > 0) throw failures[0].error
    return states.get(schema) ?? { notify: 'absent', presence: 'absent' }
  })().finally(() => {
    projectChecks.delete(projectId)
  })
  projectChecks.set(projectId, check)
  return check
}
