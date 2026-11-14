/**
 * Bring every project in a region onto the realtime channels the platform keeps.
 *
 * Each project's realtime stream has its own channel name, kept in
 * backenly_realtime.channel_secrets (lib/realtime/channel-sql.ts). The
 * application installs what it needs the first time it streams in a region,
 * and keeps the functions of the projects it streams current. This script does
 * the same for every project in a region at once:
 *
 *   - installs the schema, the table and the view, as the application role;
 *   - gives every project schema that has a notify or presence function a channel;
 *   - replaces every notify and presence function that is not the current one,
 *     in project schemas and in the schemas kept beside them (branches, a
 *     restore's set-aside copy);
 *   - removes channel rows whose schema no longer exists;
 *   - lists any other function in a project schema whose source still names a
 *     stream label (`workspace_<id>_changes`): what it sends there reaches no
 *     stream, and its owner should be told.
 *
 * It prints counts and schema names, never a channel.
 *
 *   npx tsx scripts/upgrade-realtime-channels.ts                     # report, every configured region
 *   npx tsx scripts/upgrade-realtime-channels.ts --apply             # change them
 *   npx tsx scripts/upgrade-realtime-channels.ts --region us-east-1  # one region (with or without --apply)
 *
 * Run it with the application's own database connection (the region's
 * DATABASE_URL), in every region, after a release once no task of the previous
 * release is still running: until then those tasks put their own function
 * bodies back. Safe to run again.
 */

import { randomBytes } from 'crypto'
import type { Pool } from 'pg'
import { CLOUD_REGIONS, type CloudRegionId } from '../lib/regions'
import { disconnectRegionalClients, regionDatabaseUrl } from '../lib/data-plane/regional'
import { prisma } from '../lib/db/prisma'
import {
  bringFunctionsCurrent,
  installRealtimePlatform,
  readRealtimePlatformStatus,
  realtimePool,
} from '../lib/realtime/channels'
import {
  ALL_FUNCTION_STATE_SQL,
  NOTIFY_FUNCTION_NAME,
  PRESENCE_FUNCTION_NAME,
  PROJECT_SCHEMA_SQL_RE,
  REALTIME_SCHEMA,
  currentFunctionSql,
  platformInstallSql,
  type RealtimeFunctionName,
  type RealtimeFunctionRow,
} from '../lib/realtime/channel-sql'

const APPLY = process.argv.includes('--apply')
const regionArg = (() => {
  const at = process.argv.indexOf('--region')
  return at >= 0 ? process.argv[at + 1] : undefined
})()

/** Schemas whose functions are replaced in one transaction: one schema reload each for the REST API. */
const BATCH = 25
/** Names printed per list; the rest are counted. */
const SHOWN = 40

const CANONICAL = new RegExp(PROJECT_SCHEMA_SQL_RE)

function listed(names: string[]): string {
  if (names.length === 0) return ''
  const shown = names.slice(0, SHOWN).join(', ')
  return names.length > SHOWN ? `${shown}, and ${names.length - SHOWN} more` : shown
}

function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string } | null
  return `${e?.code ? `${e.code} ` : ''}${e?.message ?? String(err)}`
}

/** The role the application connects as, when the database says which one it is. */
async function applicationRole(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT pg_catalog.to_regprocedure('public.backenly_app_role()') IS NOT NULL AS present`,
  )
  if (!rows[0]?.present) return null
  const named = await pool.query<{ role: string }>(`SELECT public.backenly_app_role()::text AS role`)
  return named.rows[0]?.role ?? null
}

async function channelRows(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM ${REALTIME_SCHEMA}.channel_secrets`,
  )
  return new Set(rows.map((row) => row.schema_name))
}

async function existingSchemas(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ nspname: string }>(`SELECT nspname::text AS nspname FROM pg_catalog.pg_namespace`)
  return new Set(rows.map((row) => row.nspname))
}

/** Functions in project schemas, other than the two above, whose source names a stream label. */
async function otherSenders(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT n.nspname || '.' || p.proname AS name
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname ~ '^workspace_'
        AND p.proname NOT IN ('${NOTIFY_FUNCTION_NAME}', '${PRESENCE_FUNCTION_NAME}')
        AND p.prosrc ~ 'workspace_[0-9a-fA-F-]{36}_changes'
      ORDER BY 1`,
  )
  return rows.map((row) => row.name)
}

/** Replace in batches; a batch that fails is retried one schema at a time. */
async function replaceFunctions(pool: Pool, stale: RealtimeFunctionRow[]): Promise<{ replaced: number; failed: string[] }> {
  const bySchema = new Map<string, RealtimeFunctionName[]>()
  for (const row of stale) bySchema.set(row.schema_name, [...(bySchema.get(row.schema_name) ?? []), row.function_name])
  const schemas = [...bySchema.keys()]
  let replaced = 0
  const failed: string[] = []
  for (let i = 0; i < schemas.length; i += BATCH) {
    const batch = schemas.slice(i, i + BATCH)
    const sql = [
      `SET LOCAL lock_timeout = '5s';`,
      ...batch.flatMap((schema) => bySchema.get(schema)!.map((name) => currentFunctionSql(schema, name))),
    ].join('\n')
    try {
      await pool.query(sql)
      replaced += batch.length
    } catch {
      const { failures } = await bringFunctionsCurrent(pool, batch)
      replaced += batch.length - failures.length
      for (const { schema, error } of failures) failed.push(`${schema} (${errorText(error)})`)
    }
  }
  return { replaced, failed }
}

async function createChannels(pool: Pool, schemas: string[]): Promise<number> {
  let created = 0
  for (let i = 0; i < schemas.length; i += 500) {
    const batch = schemas.slice(i, i + 500)
    const channels = batch.map(() => `bkn_rt_${randomBytes(24).toString('hex')}`)
    const { rowCount } = await pool.query(
      `INSERT INTO ${REALTIME_SCHEMA}.channel_secrets (schema_name, channel)
       SELECT t.schema_name, t.channel
         FROM unnest($1::text[], $2::text[]) AS t(schema_name, channel)
        WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = t.schema_name::name)
       ON CONFLICT (schema_name) DO NOTHING`,
      [batch, channels],
    )
    created += rowCount ?? 0
  }
  return created
}

async function upgradeRegion(region: CloudRegionId): Promise<boolean> {
  const say = (line: string) => console.log(`[${region}] ${line}`)
  const pool = realtimePool(region)
  let ok = true

  // ── Platform objects ──
  const status = await readRealtimePlatformStatus(pool)
  const missing = platformInstallSql(status).length > 0
  say(
    `connected as ${status.connected_as}; platform objects: ` +
      (!status.has_table && !status.has_view ? 'not installed' : missing ? 'installed, not current' : 'current') +
      (status.table_owner ? `; owned by ${status.table_owner}` : ''),
  )
  if (status.table_owner && status.table_owner !== status.connected_as) {
    say(`the table of channels belongs to ${status.table_owner}, not ${status.connected_as}: connect as the role that owns it`)
    return false
  }
  if (missing && APPLY) {
    const appRole = await applicationRole(pool)
    if (appRole && appRole !== status.connected_as) {
      say(`refused: the application connects as ${appRole}, and objects made by ${status.connected_as} could not be used by it`)
      return false
    }
    await installRealtimePlatform(pool)
    say('platform objects installed')
  }
  const tablePresent = status.has_table || (missing && APPLY)

  // ── Functions ──
  const { rows: functions } = await pool.query<RealtimeFunctionRow>(ALL_FUNCTION_STATE_SQL)
  const count = (name: string, current: boolean) =>
    functions.filter((row) => row.function_name === name && row.current === current).length
  const stale = functions.filter((row) => !row.current)
  say(
    `notify functions: ${count(NOTIFY_FUNCTION_NAME, true)} current, ${count(NOTIFY_FUNCTION_NAME, false)} not; ` +
      `presence functions: ${count(PRESENCE_FUNCTION_NAME, true)} current, ${count(PRESENCE_FUNCTION_NAME, false)} not`,
  )
  if (stale.length > 0) say(`not current in: ${listed([...new Set(stale.map((row) => row.schema_name))])}`)

  // ── Channels ──
  const streaming = [...new Set(functions.map((row) => row.schema_name).filter((schema) => CANONICAL.test(schema)))]
  const withChannel = tablePresent ? await channelRows(pool) : new Set<string>()
  const schemasNow = await existingSchemas(pool)
  const without = streaming.filter((schema) => !withChannel.has(schema))
  const orphans = [...withChannel].filter((schema) => !schemasNow.has(schema))
  say(`channels: ${withChannel.size} kept, ${without.length} project schema(s) with realtime and no channel, ${orphans.length} for schemas that are gone`)

  const senders = await otherSenders(pool)
  if (senders.length > 0) {
    say(`other functions naming a stream label (their events reach no stream): ${listed(senders)}`)
  }

  if (!APPLY) return ok

  const created = await createChannels(pool, without)
  say(`channels created: ${created}`)

  const { replaced, failed } = await replaceFunctions(pool, stale)
  say(`schemas whose functions were replaced: ${replaced}`)
  if (failed.length > 0) {
    ok = false
    say(`could not replace: ${listed(failed)}`)
  }

  if (orphans.length > 0) {
    const { rowCount } = await pool.query(
      `DELETE FROM ${REALTIME_SCHEMA}.channel_secrets s
        WHERE s.schema_name = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = s.schema_name::name)`,
      [orphans],
    )
    say(`channels removed for schemas that are gone: ${rowCount ?? 0}`)
  }
  return ok
}

async function main(): Promise<void> {
  const configured = CLOUD_REGIONS.map((region) => region.id).filter((id) => regionDatabaseUrl(id, 'app') !== undefined)
  const regions = regionArg ? configured.filter((id) => id === regionArg) : configured
  if (regions.length === 0) {
    console.error(regionArg ? `No database connection is configured for region ${regionArg}.` : 'No region has a database connection configured.')
    process.exitCode = 1
    return
  }

  let failures = 0
  for (const region of regions) {
    try {
      if (!(await upgradeRegion(region))) failures += 1
    } catch (err) {
      failures += 1
      console.error(`[${region}] failed: ${errorText(err)}`)
    }
  }

  console.log(
    APPLY
      ? `Done in ${regions.length} region(s)${failures ? `, ${failures} with failures` : ''}.`
      : `Report only, ${regions.length} region(s). Run with --apply to install, create channels and replace functions.`,
  )
  if (failures > 0) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(errorText(err))
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectRegionalClients().catch(() => {})
    await prisma.$disconnect().catch(() => {})
  })
