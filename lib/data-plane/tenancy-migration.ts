/**
 * MOVING A PROJECT INTO A DATABASE OF ITS OWN
 * ===========================================
 * A project created before its region gave projects databases of their own
 * keeps its schemas in the region's shared database (Project.databaseTenancy
 * 'shared', lib/data-plane/regional.ts). This module moves one such project,
 * unchanged, into a database of its own on the region's data instance, the
 * kind a new project gets (lib/data-plane/project-databases.ts), so that every
 * project ends up in its own database and the shared one holds none.
 *
 * It runs once per project, in the project's region, as the regional job
 * `tenancy_migration` an operator starts (scripts/migrate-project-databases.ts,
 * lib/queue/worker.ts), where pg_dump and psql reach both databases. Its job
 * row is the record of the run: how far it got while it runs, and the report
 * (tenancy-migration-rules.ts MigrationReport) after. Each step logs one line,
 * `[TenancyMigration] project=<id> step=<step> ...`.
 *
 * THE STEPS
 *
 *   0  preconditions  refused, with the reason and nothing changed, unless:
 *                     the project is in this process's region, serving (not
 *                     paused, deleted or locked) and shared; the region's data
 *                     instance answers and has its template; no import or other
 *                     move is running; no schema drift waits to be adopted; a
 *                     snapshot of it completed recently; its schemas are all
 *                     ones Backenly names, and every extension they use is one
 *                     the application may install.
 *   1  create         its database, cloned from the template by the region's
 *                     database creator, recorded first (createProjectDatabase);
 *                     then, as the application, every extension its schemas
 *                     use (read from pg_depend) and the realtime platform
 *                     objects. The project still serves.
 *   2  freeze         paused with reason `migrating` (applyMigrationFreeze):
 *                     every door answers PROJECT_PAUSED, its direct logins
 *                     stop, functions and schedules stop, and nothing is
 *                     discarded: the webhook outbox and the deliveries waiting
 *                     to go out are kept. Then the waits out every cached
 *                     answer and request (MigrationWaits.freezeMs), and no
 *                     session of the project's logins may remain.
 *   3  lock           its change lock on both databases (withChangeLockOn),
 *                     held until the old schemas are fenced.
 *   4  snapshot       a snapshot (backupWorkspace), the usual safety copy.
 *   5  dump           the backup role is given read on the branch and vault
 *                     schemas (it already reads the canonical one), then
 *                     pg_dump of exactly the schemas resolveProjectSchemas
 *                     lists, by name, never a pattern.
 *   6  replay         psql into the new database as the application, in one
 *                     transaction, stopping at the first error; then the
 *                     branches PostgREST served are registered there (the
 *                     canonical schema registers itself), the backup role's
 *                     read, the function logins, the realtime functions and
 *                     channel rows (the same channel names), and direct
 *                     access's grants.
 *   7  verify         both sides still frozen: catalogs equal schema by schema,
 *                     every table's rows counted and checksummed as the
 *                     workspace's owner, sequences equal, row security as it
 *                     was, owners as a restore leaves them, the registry, the
 *                     extensions, the channels, the backup role's read, and the
 *                     project's own PostgREST answering. Any failure stops the
 *                     move: the new database is dropped, the project serves
 *                     from the shared one again, nothing is lost.
 *   8  flip           one platform transaction: the row names its database and
 *                     its epoch moves, with a History entry (kind
 *                     `tenancy_migration`) and an audit row.
 *   9  fence          the old schemas stop being served, are renamed
 *                     `workspace_<id>_moved<epoch>[_<n>]` (movedSchemaName),
 *                     handed to the application role and closed to PUBLIC, the
 *                     API roles and the project's logins, after a wait long
 *                     enough that PostgREST no longer reads them and no
 *                     process still resolves the project to them
 *                     (MigrationWaits.flipMs). A process that somehow still
 *                     did would fail loudly, never write to the old copy.
 *  10  resume         the project's own PostgREST restarted on the region's
 *                     host, the pause ended, logins back with CONNECT on the
 *                     new database; then a smoke of its paths, recorded.
 *  11  schedule_drop  the fenced schemas are dropped seven days later by the
 *                     region's retired-schema pass (scheduleSchemaDrop).
 *
 * A dry run runs 0 to 7 and then stops as a failed verification would: its
 * database dropped, the project serving from the shared one, with the
 * verification in its report. It pauses the project for as long as a move.
 *
 * A RUN THAT DIED. Only one run per project at a time, held by an advisory lock
 * on the platform database for the run's whole life. A later run that finds a
 * project paused for a move and no run holding it finishes what it can: before
 * the flip, it ends the pause (the project serves from the shared database
 * again, as it was) and drops the database the dead run made, and refuses
 * (`interrupted`); after the flip, it fences, resumes and smokes, and reports
 * the move.
 */

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { Client, type PoolClient } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import {
  PRIMARY_DATA_INSTANCE,
  SHARED_PLACEMENT_MAX_AGE_MS,
  dataInstanceRawClient,
  databaseClient,
  forgetProjectDatabase,
  isProjectDatabaseName,
  noteTenancyEpoch,
  ownDatabasePostgrest,
  projectDriftEvents,
  regionDataInstanceUrl,
  regionDatabaseUrl,
  regionOfRecord,
  regionRawClient,
  requireRegionDatabaseUrl,
  workspaceRawClient,
  type RegionPostgrest,
  type WorkspaceRawClient,
} from './regional'
import {
  PROJECT_DATABASE_TEMPLATE,
  createProjectDatabase,
  dropProjectDatabase,
  grantBackupReadOn,
  regionDbcreatorUrl,
} from './project-databases'
import { asWorkspaceOwner } from './as-owner'
import { serviceRegion } from './serving'
import { readCatalogOn, withChangeLockOn } from '@/lib/changes/lock'
import { checkpointHash } from '@/lib/changes/integrity'
import { FRESH_MS, MIGRATING_PAUSE_REASON, STALE_SERVING_GRACE_MS } from '@/lib/projects/serving-state'
import {
  afterMigrationFreezeCommitted,
  afterMigrationThawCommitted,
  applyMigrationFreeze,
  applyMigrationThaw,
  withProjectLifecycleLock,
  type LifecycleActor,
} from '@/lib/projects/pause-lifecycle'
import { UnknownProjectSchemaError, resolveProjectSchemas } from '@/lib/projects/delete'
import { projectLoginNames } from '@/lib/projects/logins'
import { DROP_AFTER_MS, scheduleSchemaDrop } from '@/lib/postgrest/retire-schema'
import { registerSchemaOn, servedAmong, unregisterSchemaOn } from '@/lib/postgrest/registration'
import { regionPostgrestHostUrl } from '@/lib/postgrest/host'
import { internalClaimsFor, mintInternalToken } from '@/lib/postgrest/gateway'
import { CHANNEL_TABLE_EXISTS_SQL, DELETE_CHANNELS_SQL, READ_CHANNELS_SQL, isChannelName } from '@/lib/realtime/channel-sql'
import { bringFunctionsCurrent, installRealtimePlatform, realtimeDatabasePool } from '@/lib/realtime/channels'
import { isAllowedExtension } from '@/lib/services/extension-allowlist'
import { forgetFunctionDbClient, functionRoleName, functionRolePassword } from '@/lib/services/ai-functions/function-db-role'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import { backupWorkspace, buildConnection, sanitizeError } from '@/lib/services/workspace-backup'
import { REGIONAL_STATUS, TENANCY_MIGRATION_JOB_TYPE, enqueueRegionalJob } from '@/lib/queue'
import {
  assertValidProjectId,
  isChangeVaultSchema,
  isMovedSchema,
  movedSchemaName,
  quoteIdent,
  workspaceSchemaName,
} from '@/lib/security/workspace-schema'
import {
  catalogDifferences,
  defaultWaits,
  type MigrationCheck,
  type MigrationReport,
  type MigrationStep,
  type MigrationWaits,
  type RefusalCode,
  type TableComparison,
  type VerificationReport,
} from './tenancy-migration-rules'

export { TENANCY_MIGRATION_JOB_TYPE }

const execFileAsync = promisify(execFile)

/** How long what a move leaves in the database it moved out of is kept before it is dropped. */
export const MOVED_SCHEMA_DROP_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** A snapshot at least this recent must have completed before a move starts: the daily one and some slack. */
export const RECENT_SNAPSHOT_MS = 26 * 60 * 60 * 1000

/** The audit row the flip writes, on the project. */
export const DATABASE_MOVED_ACTION = 'PROJECT_DATABASE_MOVED'

/** One run per project, across every process: a session lock on the platform database. 'tmig'. */
const MIGRATION_LOCK_SPACE = 0x746d6967

const DUMP_TIMEOUT_MS = 30 * 60_000
const REPLAY_TIMEOUT_MS = 30 * 60_000
const TOOL_OUTPUT_MAX = 16 * 1024 * 1024
const CHANGE_LOCK_WAIT_MS = 60_000

const ACTOR: LifecycleActor = { kind: 'system', label: 'tenancy migration' }

/** The roles a fenced schema is closed to, beside the project's own logins and owner role. */
const FENCED_FROM = ['anon', 'authenticated', 'service_role', 'backenly_external'] as const

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/** The waits a move uses unless told otherwise, from the bounds they cover (defaultWaits). */
export function productionWaits(): MigrationWaits {
  return defaultWaits({
    freshMs: FRESH_MS,
    staleServingGraceMs: STALE_SERVING_GRACE_MS,
    dropAfterMs: DROP_AFTER_MS,
    placementMaxAgeMs: SHARED_PLACEMENT_MAX_AGE_MS,
  })
}

export interface MigrationOptions {
  /** Run steps 0 to 7, then stop as a failed verification would, with nothing changed. */
  dryRun?: boolean
  /** The job running this move: its row is told how far the move got. */
  jobId?: string | null
  /** Shorter waits, for tests. Production uses productionWaits(). */
  waits?: Partial<MigrationWaits>
  /** How recent the project's last snapshot must be. */
  recentSnapshotMs?: number
  /** Test seam: the verification fails with this detail, after every real check has run. */
  failVerification?: string
}

// ── Internals: what a run knows and how it reports ──────────────────────────

class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message)
    this.name = 'Refusal'
  }
}

class StepFailure extends Error {
  constructor(
    readonly step: MigrationStep,
    message: string,
  ) {
    super(message)
    this.name = 'StepFailure'
  }
}

interface Extension {
  name: string
  version: string
  schema: string
}

/** What step 0 read about the project, used by every later step. */
interface MoveContext {
  region: CloudRegionId
  canonical: string
  /** Every schema of the project in the shared database, canonical first. */
  schemas: string[]
  /** Those the shared database's PostgREST serves. */
  served: string[]
  backupRole: string
  credentials: Array<{ roleName: string; mode: string }>
  /** The project's logins that exist, on the shared database's instance. */
  logins: string[]
  /** The schemas whose function login exists. */
  fnSchemas: string[]
  extensions: Extension[]
  /** The project's tenancy epoch before the move. */
  epoch: number
}

interface Run {
  projectId: string
  report: MigrationReport
  options: MigrationOptions
  waits: MigrationWaits
  step: MigrationStep
  database: string | null
  frozen: boolean
  fnRetired: boolean
}

function message(err: unknown): string {
  return sanitizeError(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 600)
}

function log(run: Run, step: MigrationStep | 'abort', detail: string): void {
  if (step !== 'abort') run.step = step
  console.log(`[TenancyMigration] project=${run.projectId} step=${step}${run.options.dryRun ? ' (dry run)' : ''} ${detail}`)
  run.report.steps.push({ step, at: new Date().toISOString(), detail })
}

/** Tell the job's row how far the move got: the step, and the database once it exists (the orphan sweep reads it). */
async function progress(run: Run): Promise<void> {
  const jobId = run.options.jobId
  if (!jobId) return
  await prisma.backgroundJob
    .update({
      where: { id: jobId },
      data: { result: { step: run.step, database: run.database, at: new Date().toISOString() } },
    })
    .catch(() => {})
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

function q(name: string): string {
  return quoteIdent(name)
}

// ── One run per project ──────────────────────────────────────────────────────

const BUSY = Symbol('busy')

/** The platform database, directly: a session advisory lock needs a session of its own. */
function platformUrl(): string {
  const url = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim()
  if (!url) throw new Error('DATABASE_URL is not set')
  return url
}

async function withMigrationLock<T>(projectId: string, fn: () => Promise<T>): Promise<T | typeof BUSY> {
  const client = new Client({ connectionString: platformUrl(), connectionTimeoutMillis: 10_000 })
  client.on('error', () => {})
  await client.connect()
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS ok', [
      MIGRATION_LOCK_SPACE,
      projectId,
    ])
    if (!rows[0]?.ok) return BUSY
    try {
      return await fn()
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::int, hashtext($2))', [MIGRATION_LOCK_SPACE, projectId]).catch(() => {})
    }
  } finally {
    await client.end().catch(() => {})
  }
}

// ── Step 0: preconditions ────────────────────────────────────────────────────

/** Whether a region's data instance is the instance its shared database is on. */
function sameInstance(region: CloudRegionId): boolean {
  const data = regionDataInstanceUrl(region, 'app')
  const shared = regionDatabaseUrl(region, 'app')
  if (!data || !shared) return false
  try {
    const a = new URL(data)
    const b = new URL(shared)
    return a.hostname === b.hostname && (a.port || '5432') === (b.port || '5432')
  } catch {
    return false
  }
}

function roleOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const name = decodeURIComponent(new URL(url).username)
    return ROLE_NAME.test(name) ? name : null
  } catch {
    return null
  }
}

/**
 * The extensions objects in these schemas depend on: through pg_depend, from
 * every relation, type, function, constraint, default, rule, trigger and
 * policy in them to a member of an extension (or its array type). plpgsql is
 * every database's.
 */
const EXTENSIONS_SQL = `
WITH proj AS (
  SELECT oid FROM pg_namespace WHERE nspname = ANY($1::text[])
), objs AS (
  SELECT 'pg_class'::regclass::oid AS classid, c.oid AS objid FROM pg_class c WHERE c.relnamespace IN (SELECT oid FROM proj)
  UNION ALL SELECT 'pg_type'::regclass::oid, t.oid FROM pg_type t WHERE t.typnamespace IN (SELECT oid FROM proj)
  UNION ALL SELECT 'pg_proc'::regclass::oid, p.oid FROM pg_proc p WHERE p.pronamespace IN (SELECT oid FROM proj)
  UNION ALL SELECT 'pg_constraint'::regclass::oid, k.oid FROM pg_constraint k WHERE k.connamespace IN (SELECT oid FROM proj)
  UNION ALL SELECT 'pg_attrdef'::regclass::oid, d.oid FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
             WHERE c.relnamespace IN (SELECT oid FROM proj)
  UNION ALL SELECT 'pg_rewrite'::regclass::oid, r.oid FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
             WHERE c.relnamespace IN (SELECT oid FROM proj)
  UNION ALL SELECT 'pg_trigger'::regclass::oid, g.oid FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
             WHERE c.relnamespace IN (SELECT oid FROM proj)
  UNION ALL SELECT 'pg_policy'::regclass::oid, y.oid FROM pg_policy y JOIN pg_class c ON c.oid = y.polrelid
             WHERE c.relnamespace IN (SELECT oid FROM proj)
), members AS (
  SELECT d.classid, d.objid, e.oid AS ext
    FROM pg_depend d JOIN pg_extension e ON d.refclassid = 'pg_extension'::regclass::oid AND d.refobjid = e.oid
   WHERE d.deptype = 'e'
), reachable AS (
  SELECT classid, objid, ext FROM members
  UNION ALL
  SELECT 'pg_type'::regclass::oid, t.oid, m.ext
    FROM pg_type t JOIN members m ON m.classid = 'pg_type'::regclass::oid AND m.objid = t.typelem
  UNION ALL
  SELECT 'pg_extension'::regclass::oid, e.oid, e.oid FROM pg_extension e
)
SELECT DISTINCT e.extname::text AS name, e.extversion::text AS version, n.nspname::text AS schema
  FROM pg_depend d
  JOIN objs o ON o.classid = d.classid AND o.objid = d.objid
  JOIN reachable r ON r.classid = d.refclassid AND r.objid = d.refobjid
  JOIN pg_extension e ON e.oid = r.ext
  JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname <> 'plpgsql'
 ORDER BY 1`

async function requiredExtensions(db: WorkspaceRawClient, schemas: string[]): Promise<Extension[]> {
  return db.$queryRawUnsafe<Extension[]>(EXTENSIONS_SQL, schemas)
}

/**
 * A run that died before its flip left the project paused for a move it will
 * never finish. Its pause is ended (the project serves from the shared
 * database, where its data still is, untouched by the flip that never came),
 * its function logins re-keyed there in case the dead run had stopped them,
 * and the databases it made and no project names are dropped. Called only
 * while this run holds the project's migration lock, so no live run is
 * undone.
 */
async function recoverBeforeFlip(run: Run, region: CloudRegionId): Promise<void> {
  const { projectId } = run
  const shared = regionRawClient(region, projectId)
  try {
    const schemas = await resolveProjectSchemas(shared, projectId)
    for (const schema of schemas) {
      const role = functionRoleName(schema)
      const [exists] = await shared.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`
      if (exists?.n) await shared.$queryRaw`SELECT public.backenly_fn_role_sync(${schema}, ${functionRolePassword(schema)}) AS role`
    }
  } catch (err) {
    log(run, 'preconditions', `function logins not re-keyed after an earlier move stopped: ${message(err)}`)
  }
  await withProjectLifecycleLock(projectId, (tx) => applyMigrationThaw(tx, projectId))
  await afterMigrationThawCommitted(projectId, ACTOR)

  const earlier = await prisma.backgroundJob.findMany({
    where: { projectId, type: TENANCY_MIGRATION_JOB_TYPE, ...(run.options.jobId ? { id: { not: run.options.jobId } } : {}) },
    select: { result: true },
  })
  for (const job of earlier) {
    const database = (job.result as { database?: unknown } | null)?.database
    if (!isProjectDatabaseName(database)) continue
    if (await prisma.project.findFirst({ where: { databaseName: database }, select: { id: true } })) continue
    await dropProjectDatabase({ region, database, projectId }).catch((err: unknown) => {
      log(run, 'preconditions', `${database} from an earlier move was not dropped (${message(err)}); the daily orphan sweep drops it`)
    })
  }
}

type Prepared = { kind: 'move'; context: MoveContext } | { kind: 'finish'; region: CloudRegionId; database: string; epoch: number }

async function preconditions(run: Run): Promise<Prepared> {
  const { projectId } = run
  log(run, 'preconditions', 'checking')
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      region: true,
      deletedAt: true,
      lockedDownAt: true,
      pausedAt: true,
      pauseReason: true,
      databaseTenancy: true,
      databaseName: true,
      tenancyEpoch: true,
    },
  })
  if (!row) throw new Refusal('not_found', 'no project has this id')

  let region: CloudRegionId
  try {
    region = regionOfRecord(projectId, row.region)
  } catch (err) {
    throw new Refusal('not_configured', message(err))
  }
  run.report.region = region
  let here: CloudRegionId
  try {
    here = serviceRegion()
  } catch (err) {
    throw new Refusal('not_configured', message(err))
  }
  if (region !== here) {
    throw new Refusal('wrong_region', `the project is in ${region}, and a move runs in the project's own region`)
  }

  // A run that died while the project was paused for its move.
  if (row.pausedAt && row.pauseReason === MIGRATING_PAUSE_REASON) {
    if (row.databaseTenancy === 'dedicated' && isProjectDatabaseName(row.databaseName)) {
      return { kind: 'finish', region, database: row.databaseName, epoch: row.tenancyEpoch }
    }
    await recoverBeforeFlip(run, region)
    throw new Refusal(
      'interrupted',
      'an earlier move stopped before its flip; the project serves from its shared database again, as it was. Start the move again.',
    )
  }

  if (row.databaseTenancy !== 'shared') throw new Refusal('already_dedicated', 'the project already has a database of its own')
  if (row.deletedAt) throw new Refusal('deleted', 'the project was deleted')
  if (row.lockedDownAt) throw new Refusal('locked', 'the project is locked down')
  if (row.pausedAt) {
    throw new Refusal('paused', `the project is paused (${row.pauseReason ?? 'no reason recorded'}); move it once it serves again`)
  }

  if (!regionDatabaseUrl(region, 'app')) throw new Refusal('not_configured', "the region's shared database has no connection here")
  if (!regionDbcreatorUrl(region)) throw new Refusal('not_configured', 'the region has no database creator connection, so no database can be made there')
  if (!regionDataInstanceUrl(region, 'app')) throw new Refusal('not_configured', 'the region has no data instance connection')
  const backupRole = roleOf(regionDatabaseUrl(region, 'backup'))
  if (!backupRole) throw new Refusal('not_configured', "the region has no backup connection, which the copy is read with")

  try {
    await execFileAsync('pg_dump', ['--version'], { timeout: 10_000 })
    await execFileAsync('psql', ['--version'], { timeout: 10_000 })
  } catch {
    throw new Refusal('tools_missing', 'pg_dump and psql are not both available to this process')
  }

  const shared = regionRawClient(region, projectId)
  try {
    await shared.$queryRawUnsafe(`SELECT 1`)
  } catch (err) {
    throw new Refusal('unreachable', `the region's shared database did not answer: ${message(err)}`)
  }
  let template: Array<{ template: boolean }>
  try {
    template = await dataInstanceRawClient(region).$queryRawUnsafe<Array<{ template: boolean }>>(
      `SELECT datistemplate AS template FROM pg_database WHERE datname = $1`,
      PROJECT_DATABASE_TEMPLATE,
    )
  } catch (err) {
    throw new Refusal('unreachable', `the region's data instance did not answer: ${message(err)}`)
  }
  if (!template[0]?.template) throw new Refusal('no_template', `${PROJECT_DATABASE_TEMPLATE} is not on the data instance as a template`)

  const importing = await prisma.backgroundJob.findFirst({ where: { projectId, status: 'import_running' }, select: { id: true } })
  if (importing) throw new Refusal('import_running', 'an import into the project is running')

  const pending = await (await projectDriftEvents(projectId)).countPending(projectId)
  if (pending > 0) throw new Refusal('drift_pending', `${pending} schema change(s) made outside Backenly wait to be adopted; adopt them first`)

  const recentMs = run.options.recentSnapshotMs ?? RECENT_SNAPSHOT_MS
  const snapshot = await prisma.workspaceBackup.findFirst({
    where: { projectId, status: 'completed', createdAt: { gte: new Date(Date.now() - recentMs) } },
    select: { id: true },
  })
  if (!snapshot) throw new Refusal('no_recent_snapshot', `no snapshot of the project completed in the last ${Math.round(recentMs / 3_600_000)} hours`)

  let found: string[]
  try {
    found = await resolveProjectSchemas(shared, projectId)
  } catch (err) {
    if (err instanceof UnknownProjectSchemaError) throw new Refusal('unknown_schema', err.message)
    throw err
  }
  const canonical = workspaceSchemaName(projectId)
  if (!found.includes(canonical)) throw new Refusal('no_schema', `${canonical} is not in the region's shared database`)
  const moved = found.filter(isMovedSchema)
  if (moved.length > 0) throw new Refusal('moved_schemas_present', `the shared database already holds ${moved.join(', ')} from an earlier move`)
  const schemas = [canonical, ...found.filter((schema) => schema !== canonical)]

  const credentials = await prisma.databaseCredential.findMany({ where: { projectId }, select: { roleName: true, mode: true } })
  if (credentials.length > 0 && !sameInstance(region)) {
    throw new Refusal(
      'direct_logins_elsewhere',
      "the project has direct Postgres logins, and the region's data instance is not the instance its shared database is on, where they are",
    )
  }
  const names = projectLoginNames(projectId, credentials.map((c) => c.roleName), schemas)
  const logins = (
    await shared.$queryRaw<Array<{ rolname: string }>>`SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY(${names}::text[]) ORDER BY 1`
  ).map((r) => r.rolname)
  const fnSchemas = schemas.filter((schema) => logins.includes(functionRoleName(schema)))

  const extensions = await requiredExtensions(shared, schemas)
  for (const extension of extensions) {
    if (extension.schema !== 'public') {
      throw new Refusal('extension', `extension ${extension.name} is in schema ${extension.schema}, and a project's database keeps extensions in public`)
    }
    if (!isAllowedExtension(extension.name)) {
      throw new Refusal('extension', `extension ${extension.name} is not one the application may install in a project's database`)
    }
  }

  const served = await servedAmong(shared, schemas)
  log(
    run,
    'preconditions',
    `ok: ${schemas.length} schema(s), ${served.length} served, ${extensions.length} extension(s), ${logins.length} login(s), epoch ${row.tenancyEpoch}`,
  )
  return {
    kind: 'move',
    context: { region, canonical, schemas, served, backupRole, credentials, logins, fnSchemas, extensions, epoch: row.tenancyEpoch },
  }
}

// ── Step 1: create ───────────────────────────────────────────────────────────

async function create(run: Run, ctx: MoveContext): Promise<void> {
  const { projectId } = run
  log(run, 'create', 'creating its database')
  const created = await createProjectDatabase({ region: ctx.region, projectId })
  run.database = created.database
  run.report.database = created.database
  await progress(run)

  const px = databaseClient(ctx.region, created.database, projectId)
  for (const extension of ctx.extensions) {
    const [present] = await px.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_extension WHERE extname = ${extension.name}`
    if (!present?.n) await px.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS ${q(extension.name)} WITH SCHEMA ${q(extension.schema)}`)
  }
  const installed = await px.$queryRaw<Array<{ name: string; schema: string; version: string }>>`
    SELECT e.extname::text AS name, n.nspname::text AS schema, e.extversion::text AS version
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace`
  for (const extension of ctx.extensions) {
    const there = installed.find((e) => e.name === extension.name)
    if (!there || there.schema !== extension.schema) {
      throw new StepFailure('create', `extension ${extension.name} could not be installed in its database`)
    }
    if (there.version !== extension.version) {
      log(run, 'create', `extension ${extension.name} is at ${there.version} there, ${extension.version} in the shared database`)
    }
  }
  run.report.extensions = ctx.extensions.map((e) => e.name)

  await installRealtimePlatform(await realtimeDatabasePool({ region: ctx.region, database: created.database }, projectId))
  log(run, 'create', `created, with ${ctx.extensions.length} extension(s) and the realtime platform objects`)
}

// ── Step 2: freeze ───────────────────────────────────────────────────────────

async function freeze(run: Run, ctx: MoveContext): Promise<void> {
  const { projectId } = run
  log(run, 'freeze', 'pausing it for the move')
  const { frozen } = await withProjectLifecycleLock(projectId, (tx) => applyMigrationFreeze(tx, projectId))
  if (!frozen) throw new StepFailure('freeze', 'the project was paused, deleted or locked meanwhile')
  run.frozen = true
  await progress(run)
  const { stoppedLogins } = await afterMigrationFreezeCommitted(projectId, ACTOR)
  log(run, 'freeze', `paused, ${stoppedLogins.length} direct login(s) stopped; waiting ${Math.round(run.waits.freezeMs / 1000)} s for every door`)
  await sleep(run.waits.freezeMs)

  const shared = regionRawClient(ctx.region, projectId)
  const sessions = async () =>
    shared.$queryRaw<Array<{ login: string; n: number }>>`
      SELECT usename::text AS login, count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND usename = ANY(${ctx.logins}::text[]) GROUP BY 1 ORDER BY 1`
  let left = await sessions()
  if (left.length > 0) {
    for (const { login } of left) {
      if (/^bkn_fn_[0-9a-f]{12}$/.test(login)) {
        await shared.$queryRaw`SELECT public.backenly_fn_role_retire(${login}) AS retired`
        run.fnRetired = true
      } else if (/^bkn_(ro|rw)_[0-9a-f]{12}$/.test(login)) {
        await shared.$queryRaw`SELECT public.backenly_direct_retire_role(${login}) AS retired`
      }
    }
    const deadline = Date.now() + run.waits.sessionsMs
    while ((left = await sessions()).length > 0 && Date.now() < deadline) await sleep(200)
    if (left.length > 0) {
      throw new StepFailure('freeze', `${left.reduce((n, s) => n + s.n, 0)} session(s) of the project's logins did not end`)
    }
  }
  log(run, 'freeze', 'frozen: no session of its logins remains')
}

// ── Steps 4 to 6: snapshot, dump, replay ─────────────────────────────────────

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('hex')
}

async function snapshot(run: Run): Promise<void> {
  log(run, 'snapshot', 'taking a snapshot')
  const result = await backupWorkspace(run.projectId)
  if (!result.success) throw new StepFailure('snapshot', `the snapshot failed: ${result.error ?? 'no reason given'}`)
  log(run, 'snapshot', `taken (${result.filename})`)
}

/** The backup role may read every schema and every table and sequence in it, in the database `db` reaches. */
async function unreadableByBackup(db: WorkspaceRawClient, role: string, schemas: string[]): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ name: string }>>`
    SELECT n.nspname::text AS name FROM pg_namespace n
     WHERE n.nspname = ANY(${schemas}::text[]) AND NOT has_schema_privilege(${role}, n.oid, 'USAGE')
    UNION ALL
    SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY(${schemas}::text[]) AND c.relkind IN ('r', 'p', 'S')
       AND NOT has_table_privilege(${role}, c.oid, 'SELECT')
     ORDER BY 1`
  return rows.map((r) => r.name)
}

/** As the application, which owns them (or is a member of the role that does): the backup role's read on a schema. */
async function grantBackupRead(db: WorkspaceRawClient, role: string, schema: string): Promise<void> {
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`)
  await db.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA ${q(schema)} TO ${q(role)}`)
  await db.$executeRawUnsafe(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${q(schema)} TO ${q(role)}`)
}

async function dump(run: Run, ctx: MoveContext): Promise<string> {
  const { projectId } = run
  const shared = regionRawClient(ctx.region, projectId)
  log(run, 'dump', `giving the backup role read on ${ctx.schemas.length - 1} branch and vault schema(s)`)
  // The canonical schema it reads already, through the sync every workspace gets.
  for (const schema of ctx.schemas.filter((s) => s !== ctx.canonical)) await grantBackupRead(shared, ctx.backupRole, schema)
  const unreadable = await unreadableByBackup(shared, ctx.backupRole, ctx.schemas)
  if (unreadable.length > 0) {
    throw new StepFailure('dump', `the backup role cannot read ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ' and more' : ''}`)
  }

  const dir = path.join(os.tmpdir(), 'backenly-tenancy-migration', projectId)
  await fs.promises.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}.sql`)
  const read = buildConnection('read', ctx.region)
  // Each schema by its exact name: quoted, so it is no pattern, and --strict-names fails on one that matches nothing.
  const schemaArgs = ctx.schemas.flatMap((schema) => ['--schema', `"${schema}"`])
  log(run, 'dump', `dumping ${ctx.schemas.length} schema(s) as the backup role`)
  await execFileAsync('pg_dump', [...read.args, '--no-owner', '--no-privileges', '--strict-names', ...schemaArgs, '--file', file], {
    timeout: DUMP_TIMEOUT_MS,
    env: read.env,
    maxBuffer: TOOL_OUTPUT_MAX,
  })
  const size = (await fs.promises.stat(file)).size
  if (size === 0) throw new StepFailure('dump', 'pg_dump wrote nothing')
  log(run, 'dump', `dumped ${size} bytes, sha256 ${await sha256Of(file)}`)
  return file
}

async function replay(run: Run, ctx: MoveContext, file: string): Promise<void> {
  const { projectId } = run
  const database = run.database as string
  const write = buildConnection('write', { region: ctx.region, database })
  log(run, 'replay', 'replaying as the application, in one transaction')
  await execFileAsync('psql', [...write.args, '-X', '-q', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '--file', file], {
    timeout: REPLAY_TIMEOUT_MS,
    env: write.env,
    maxBuffer: TOOL_OUTPUT_MAX,
  })

  const px = databaseClient(ctx.region, database, projectId)
  const present = (
    await px.$queryRaw<Array<{ name: string }>>`SELECT nspname::text AS name FROM pg_namespace WHERE nspname = ANY(${ctx.schemas}::text[])`
  ).map((r) => r.name)
  const missing = ctx.schemas.filter((schema) => !present.includes(schema))
  if (missing.length > 0) throw new StepFailure('replay', `the replay left out ${missing.join(', ')}`)

  // Served there as here: the canonical schema registered itself as the replay
  // created it (the registry's event trigger); each branch PostgREST served
  // is registered after the same parity check as anywhere.
  for (const schema of ctx.served) {
    const already = await servedAmong(px, [schema])
    if (already.length > 0) continue
    const result = await registerSchemaOn(px, schema)
    if (!result.registered) throw new StepFailure('replay', `${schema} could not be served there: ${result.error ?? 'no reason given'}`)
  }

  // The backup role's read: the helper for the canonical schema, as a new
  // project gets it, and the application's own grant on the rest.
  if (!(await grantBackupReadOn(px, ctx.canonical))) {
    throw new StepFailure('replay', 'its database has no grant helper, so its snapshots could not be taken')
  }
  const dataBackupRole = roleOf(regionDataInstanceUrl(ctx.region, 'backup')) ?? ctx.backupRole
  for (const schema of ctx.schemas.filter((s) => s !== ctx.canonical)) await grantBackupRead(px, dataBackupRole, schema)

  // Its functions' logins, with CONNECT on this database by name.
  for (const schema of ctx.fnSchemas) {
    await px.$queryRaw`SELECT public.backenly_fn_role_sync(${schema}, ${functionRolePassword(schema)}) AS role`
  }

  // Realtime: the notify functions current, and the channel rows under the
  // same names, so every stream label and listener finds its channel there.
  const realtimeSchemas = ctx.schemas.filter((schema) => !isChangeVaultSchema(schema))
  const pxPool = await realtimeDatabasePool({ region: ctx.region, database }, projectId)
  const functions = await bringFunctionsCurrent(pxPool, realtimeSchemas)
  if (functions.failures.length > 0) {
    log(run, 'replay', `realtime functions of ${functions.failures.map((f) => f.schema).join(', ')} not brought current; the listener's repair pass does it`)
  }
  const channels = await sharedChannels(ctx, projectId)
  for (const [schema, channel] of channels) {
    await pxPool.query(
      `INSERT INTO backenly_realtime.channel_secrets (schema_name, channel) VALUES ($1, $2) ON CONFLICT (schema_name) DO NOTHING`,
      [schema, channel],
    )
  }

  // Direct access: its read-write login keeps the schema changes it had on the
  // shared database, none, and the sync makes its grants and pass-through
  // policies there. Its logins are instance-wide, so they are the same roles.
  if (ctx.credentials.length > 0) {
    const { ro, rw, owner } = directAccessRoleNames(projectId)
    const exists = async (role: string) =>
      ((await px.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`)[0]?.n ?? 0) > 0
    const roRole = ctx.credentials.some((c) => c.roleName === ro) && (await exists(ro)) ? ro : null
    const rwRole = ctx.credentials.some((c) => c.roleName === rw) && (await exists(rw)) ? rw : null
    if (rwRole) await px.$queryRaw`SELECT public.backenly_direct_set_schema_changes(${rwRole}, false) AS ok`
    await px.$queryRaw`SELECT public.backenly_direct_sync_schema(${ctx.canonical}, ${roRole}, ${rwRole}, ${rwRole ? owner : null}) AS ok`
  }
  log(run, 'replay', `replayed; ${ctx.served.length} schema(s) served there, ${channels.size} channel(s), ${ctx.fnSchemas.length} function login(s)`)
}

/** The project's realtime channels in the shared database, by schema. The names stay in memory, never in a log or a report. */
async function sharedChannels(ctx: MoveContext, projectId: string): Promise<Map<string, string>> {
  const pool = await realtimeDatabasePool({ region: ctx.region, database: null }, projectId)
  const [{ present }] = (await pool.query<{ present: boolean }>(CHANNEL_TABLE_EXISTS_SQL)).rows
  const found = new Map<string, string>()
  if (!present) return found
  const { rows } = await pool.query<{ schema_name: string; channel: unknown }>(READ_CHANNELS_SQL, [ctx.schemas])
  for (const row of rows) if (isChannelName(row.channel)) found.set(row.schema_name, row.channel)
  return found
}

// ── Step 7: verify ───────────────────────────────────────────────────────────

interface RelationRow {
  name: string
  kind: string
  rls: boolean
  forced: boolean
  owner: string
}

async function relations(db: WorkspaceRawClient, schema: string): Promise<RelationRow[]> {
  return db.$queryRaw<RelationRow[]>`
    SELECT c.relname::text AS name, c.relkind::text AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           pg_get_userbyid(c.relowner)::text AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
     ORDER BY 1`
}

/**
 * Every table's rows, counted and checksummed as the workspace's owner sees
 * them under FORCE ROW LEVEL SECURITY (lib/data-plane/as-owner.ts), with the
 * output settings pinned so a row prints the same in both databases. The
 * checksum is order-independent: the sums of two halves of each row's md5.
 */
async function tableDigests(db: WorkspaceRawClient, schema: string, tables: string[]): Promise<Map<string, { rows: number; digest: string }>> {
  const out = new Map<string, { rows: number; digest: string }>()
  for (const table of tables) {
    const [row] = await asWorkspaceOwner(
      db,
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL timezone = 'UTC'`)
        await tx.$executeRawUnsafe(`SET LOCAL extra_float_digits = 3`)
        await tx.$executeRawUnsafe(`SET LOCAL bytea_output = 'hex'`)
        await tx.$executeRawUnsafe(`SET LOCAL DateStyle = 'ISO, YMD'`)
        await tx.$executeRawUnsafe(`SET LOCAL IntervalStyle = 'postgres'`)
        return tx.$queryRawUnsafe<Array<{ n: string; a: string; b: string }>>(
          `SELECT count(*)::text AS n,
                  coalesce(sum(('x' || substr(h, 1, 16))::bit(64)::bigint::numeric), 0)::text AS a,
                  coalesce(sum(('x' || substr(h, 17, 16))::bit(64)::bigint::numeric), 0)::text AS b
             FROM (SELECT md5(t::text) AS h FROM ${q(schema)}.${q(table)} t) x`,
        )
      },
      { timeoutMs: 30 * 60_000 },
    )
    out.set(table, { rows: Number(row?.n ?? 0), digest: `${row?.a ?? ''}:${row?.b ?? ''}` })
  }
  return out
}

async function sequenceStates(db: WorkspaceRawClient, schema: string, sequences: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const sequence of sequences) {
    const [row] = await db.$queryRawUnsafe<Array<{ v: string; c: boolean }>>(
      `SELECT last_value::text AS v, is_called AS c FROM ${q(schema)}.${q(sequence)}`,
    )
    out.set(sequence, `${row?.v}/${row?.c}`)
  }
  return out
}

/** A service-role read through the project's own PostgREST, with retries while its process starts. */
async function readThroughOwnPostgrest(
  target: RegionPostgrest,
  projectId: string,
  schema: string,
  table: string | null,
  waitMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + waitMs
  const route = table ? `/${encodeURIComponent(table)}?limit=1` : '/'
  let last = ''
  for (;;) {
    try {
      const token = mintInternalToken(internalClaimsFor({ projectId, serviceRole: true, database: target.database }), target.jwtSecret)
      const res = await fetch(`${target.url.replace(/\/$/, '')}${route}`, {
        headers: { authorization: `Bearer ${token}`, 'accept-profile': schema },
        signal: AbortSignal.timeout(10_000),
      })
      await res.text().catch(() => '')
      if (res.status === 200) return { ok: true, detail: `GET ${table ? 'a table' : 'the root'} answered 200` }
      last = `answered ${res.status}`
    } catch (err) {
      last = message(err)
    }
    if (Date.now() >= deadline) return { ok: false, detail: `its own PostgREST ${last}` }
    await sleep(1_000)
  }
}

async function verify(run: Run, ctx: MoveContext, sharedLock: PoolClient, pxLock: PoolClient): Promise<VerificationReport> {
  const { projectId } = run
  const database = run.database as string
  const shared = regionRawClient(ctx.region, projectId)
  const px = databaseClient(ctx.region, database, projectId)
  const checks: MigrationCheck[] = []
  const tables: TableComparison[] = []
  const check = (id: string, problems: string[], okDetail: string) =>
    checks.push(problems.length === 0 ? { id, state: 'ok', detail: okDetail } : { id, state: 'failed', detail: problems.slice(0, 10).join('; ') })
  log(run, 'verify', 'comparing both databases, both frozen')

  // Exactly the project's schemas there, no more.
  const there = (
    await px.$queryRaw<Array<{ name: string }>>`SELECT nspname::text AS name FROM pg_namespace WHERE starts_with(nspname, 'workspace_') ORDER BY 1`
  ).map((r) => r.name)
  check(
    'schemas',
    [
      ...ctx.schemas.filter((s) => !there.includes(s)).map((s) => `${s} is missing`),
      ...there.filter((s) => !ctx.schemas.includes(s)).map((s) => `${s} is extra`),
    ],
    `${ctx.schemas.length} schema(s)`,
  )

  const catalogProblems: string[] = []
  const rowProblems: string[] = []
  const sequenceProblems: string[] = []
  const securityProblems: string[] = []
  const unforcedBefore: string[] = []
  const ownerProblems: string[] = []
  const [{ app }] = await px.$queryRawUnsafe<Array<{ app: string }>>(`SELECT current_user::text AS app`)
  const owners = new Set([app, directAccessRoleNames(projectId).owner])

  for (const schema of ctx.schemas.filter((s) => there.includes(s))) {
    const before = await readCatalogOn(sharedLock, schema)
    const after = await readCatalogOn(pxLock, schema)
    catalogProblems.push(...catalogDifferences(before, after).map((d) => `${schema}: ${d}`))

    const sourceRelations = await relations(shared, schema)
    const targetRelations = await relations(px, schema)
    const tableNames = sourceRelations.filter((r) => r.kind === 'r' || r.kind === 'p').map((r) => r.name)
    const sourceRows = await tableDigests(shared, schema, tableNames)
    const targetRows = await tableDigests(px, schema, tableNames.filter((t) => targetRelations.some((r) => r.name === t)))
    for (const table of tableNames) {
      const a = sourceRows.get(table)
      const b = targetRows.get(table)
      const comparison: TableComparison = {
        schema,
        table,
        sourceRows: a?.rows ?? 0,
        targetRows: b?.rows ?? -1,
        checksumsEqual: !!a && !!b && a.digest === b.digest,
      }
      tables.push(comparison)
      if (!b) rowProblems.push(`${schema}.${table} is missing`)
      else if (comparison.sourceRows !== comparison.targetRows) rowProblems.push(`${schema}.${table}: ${comparison.sourceRows} rows, ${comparison.targetRows} there`)
      else if (!comparison.checksumsEqual) rowProblems.push(`${schema}.${table}: the rows differ`)
    }

    const sequences = sourceRelations.filter((r) => r.kind === 'S').map((r) => r.name)
    const sourceSequences = await sequenceStates(shared, schema, sequences)
    const targetSequences = await sequenceStates(px, schema, sequences.filter((s) => targetRelations.some((r) => r.name === s)))
    for (const sequence of sequences) {
      if (sourceSequences.get(sequence) !== targetSequences.get(sequence)) sequenceProblems.push(`${schema}.${sequence} differs`)
    }

    for (const relation of targetRelations) {
      const source = sourceRelations.find((r) => r.name === relation.name)
      if ((relation.kind === 'r' || relation.kind === 'p') && source && (source.rls !== relation.rls || source.forced !== relation.forced)) {
        securityProblems.push(`${schema}.${relation.name}: row security is not as it was`)
      }
      // On but not forced binds everyone except the owner: a fault wherever it
      // is. Made by the move, it fails it; carried from the shared database, it
      // is reported as it was.
      if (relation.kind === 'r' && relation.rls && !relation.forced) {
        if (source && source.rls && !source.forced) unforcedBefore.push(`${schema}.${relation.name}`)
        else securityProblems.push(`${schema}.${relation.name}: row security is not forced`)
      }
      if (!owners.has(relation.owner)) ownerProblems.push(`${schema}.${relation.name} belongs to ${relation.owner}`)
    }
  }
  check('catalog', catalogProblems, 'every table, view, function and type is as it was')
  check('rows', rowProblems, `${tables.length} table(s): every count and checksum equal`)
  check('sequences', sequenceProblems, 'every sequence where it was')
  check(
    'row_security',
    securityProblems,
    unforcedBefore.length === 0
      ? 'row security as it was, forced wherever it is on'
      : `row security as it was; on but not forced, as in the shared database: ${unforcedBefore.slice(0, 5).join(', ')}`,
  )
  check('owners', ownerProblems, `every relation the application's, or its owner role's`)

  // Served there exactly as in the shared database.
  const servedThere = await servedAmong(px, ctx.schemas)
  check(
    'registry',
    [
      ...ctx.served.filter((s) => !servedThere.includes(s)).map((s) => `${s} is not served there`),
      ...servedThere.filter((s) => !ctx.served.includes(s)).map((s) => `${s} is served there and was not`),
    ],
    `${servedThere.length} schema(s) served: ${servedThere.length === ctx.served.length ? 'the same as before' : 'different'}`,
  )

  const extensionsThere = (await px.$queryRaw<Array<{ name: string }>>`SELECT extname::text AS name FROM pg_extension`).map((r) => r.name)
  check(
    'extensions',
    ctx.extensions.filter((e) => !extensionsThere.includes(e.name)).map((e) => `${e.name} is missing`),
    `${ctx.extensions.length} extension(s) installed`,
  )

  const channelsHere = await sharedChannels(ctx, projectId)
  const pxPool = await realtimeDatabasePool({ region: ctx.region, database }, projectId)
  const channelsThere = new Map(
    (await pxPool.query<{ schema_name: string; channel: string }>(READ_CHANNELS_SQL, [ctx.schemas])).rows.map((r) => [r.schema_name, r.channel]),
  )
  check(
    'channels',
    [...channelsHere].filter(([schema, channel]) => channelsThere.get(schema) !== channel).map(([schema]) => `${schema}: its channel is not there`),
    `${channelsHere.size} realtime channel(s), the same names`,
  )

  const dataBackupRole = roleOf(regionDataInstanceUrl(ctx.region, 'backup')) ?? ctx.backupRole
  check('backup_read', await unreadableByBackup(px, dataBackupRole, ctx.schemas), 'the backup role reads every schema')

  // Its own PostgREST, on the region's host, serving the new database.
  let base: string | null = null
  try {
    base = regionPostgrestHostUrl(ctx.region)
  } catch (err) {
    checks.push({ id: 'postgrest', state: 'failed', detail: message(err) })
  }
  if (base) {
    try {
      const target = await ownDatabasePostgrest(projectId, ctx.region, database)
      const firstTable = tables.find((t) => t.schema === ctx.canonical && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.table) && !t.table.startsWith('_'))
      const answer = await readThroughOwnPostgrest(target, projectId, ctx.canonical, firstTable?.table ?? null, run.waits.probeMs)
      checks.push({ id: 'postgrest', state: answer.ok ? 'ok' : 'failed', detail: answer.detail })
    } catch (err) {
      checks.push({ id: 'postgrest', state: 'skipped', detail: message(err) })
    }
  } else if (!checks.some((c) => c.id === 'postgrest')) {
    checks.push({ id: 'postgrest', state: 'skipped', detail: 'no PostgREST host is configured for the region, so its own PostgREST was not asked' })
  }

  if (run.options.failVerification) checks.push({ id: 'injected', state: 'failed', detail: run.options.failVerification })

  const report: VerificationReport = { ok: checks.every((c) => c.state !== 'failed'), checks, tables }
  const failed = checks.filter((c) => c.state === 'failed')
  log(run, 'verify', report.ok ? `ok: ${checks.length} check(s)` : `failed: ${failed.map((c) => `${c.id} (${c.detail})`).join('; ')}`)
  return report
}

// ── Step 8: flip ─────────────────────────────────────────────────────────────

async function flip(run: Run, ctx: MoveContext, verification: VerificationReport): Promise<number> {
  const { projectId } = run
  const database = run.database as string
  log(run, 'flip', 'recording the database on the project')
  const now = new Date()
  const rows = verification.tables.reduce((n, t) => n + t.targetRows, 0)
  const checkpoint = { database: { schema: ctx.canonical, capturedAt: now.toISOString(), tables: {} } }
  const resultState = { moved: { schemas: ctx.schemas.length, tables: verification.tables.length, rows } }
  const footprint: unknown[] = []

  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const row = await tx.project.findUnique({
            where: { id: projectId },
            select: { deletedAt: true, pausedAt: true, pauseReason: true, databaseTenancy: true, tenancyEpoch: true },
          })
          if (!row) throw new StepFailure('flip', 'the project row is gone')
          if (row.deletedAt) throw new StepFailure('flip', 'its deletion was asked for during the move')
          if (row.databaseTenancy !== 'shared') throw new StepFailure('flip', 'the project is no longer shared')
          if (!row.pausedAt || row.pauseReason !== MIGRATING_PAUSE_REASON) throw new StepFailure('flip', 'the project is no longer paused for its move')
          const epoch = row.tenancyEpoch + 1
          await tx.project.update({
            where: { id: projectId },
            data: { databaseTenancy: 'dedicated', databaseName: database, databaseInstance: PRIMARY_DATA_INSTANCE, tenancyEpoch: epoch },
          })
          // An entry on the project's History, numbered as every change is,
          // under the change lock this move holds on both databases.
          const last = await tx.backendChange.findFirst({ where: { projectId }, orderBy: { seq: 'desc' }, select: { id: true, seq: true } })
          await tx.backendChange.create({
            data: {
              projectId,
              seq: (last?.seq ?? 0) + 1,
              kind: 'tenancy_migration',
              resources: ['database'],
              source: 'system',
              title: 'Moved to a database of its own',
              summary:
                `Moved ${ctx.schemas.length} schema(s), ${verification.tables.length} table(s) and ${rows} row(s), unchanged, ` +
                `into a database of its own in ${ctx.region}.`,
              parentId: last?.id ?? null,
              status: 'healthy',
              checkpoint: checkpoint as any,
              resultState: resultState as any,
              footprint: footprint as any,
              checkpointHash: checkpointHash({ checkpoint, resultState, footprint }),
              verification: {
                outcome: 'confirmed',
                checkedAt: now.toISOString(),
                checks: verification.checks.map((c) => ({
                  id: c.id,
                  label: c.id.replace(/_/g, ' '),
                  outcome: c.state === 'ok' ? 'confirmed' : 'unverified',
                  detail: c.detail,
                })),
              } as any,
              completedAt: now,
            },
          })
          await tx.auditLog.create({
            data: {
              action: DATABASE_MOVED_ACTION,
              type: 'project',
              projectId,
              details: `Moved into a database of its own in ${ctx.region}`,
              metadata: { region: ctx.region, database, instance: PRIMARY_DATA_INSTANCE, epoch, schemas: ctx.schemas.length, jobId: run.options.jobId ?? null },
              timestamp: now,
            },
          })
          return epoch
        },
        { timeout: 30_000, maxWait: 10_000 },
      )
    } catch (err) {
      // Another writer took the next History number between the read and the insert.
      if ((err as { code?: unknown })?.code === 'P2002' && attempt < 2) continue
      throw err
    }
  }
}

// ── Step 9: fence ────────────────────────────────────────────────────────────

/**
 * Stop the shared database serving the project's old schemas, wait, then in
 * one transaction rename them, hand them to the application role (so a login
 * that joined the project's owner role reaches nothing through it) and close
 * them to every role that could reach them, and drop their realtime channel
 * rows. Answers the names they were left under. Checked after: a role that can
 * still use one fails the fence.
 */
async function fence(run: Run, region: CloudRegionId, schemas: string[], epoch: number): Promise<Array<{ name: string; leftAs: string }>> {
  const { projectId } = run
  const shared = regionRawClient(region, projectId)
  const served = await servedAmong(shared, schemas)
  for (const schema of served) await unregisterSchemaOn(shared, schema)
  log(run, 'fence', `${served.length} schema(s) no longer served in the shared database; waiting ${Math.round(run.waits.flipMs / 1000)} s`)
  await sleep(run.waits.flipMs)

  const canonical = workspaceSchemaName(projectId)
  const ordered = [...schemas].sort((a, b) => (a === canonical ? -1 : b === canonical ? 1 : a < b ? -1 : a > b ? 1 : 0))
  const names = ordered.map((name, index) => ({ name, leftAs: movedSchemaName(projectId, epoch, index) }))
  const { ro, rw, owner } = directAccessRoleNames(projectId)
  const candidates = [...FENCED_FROM, ...projectLoginNames(projectId, [ro, rw], schemas), owner]
  const roles = (
    await shared.$queryRaw<Array<{ rolname: string }>>`SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY(${candidates}::text[]) ORDER BY 1`
  ).map((r) => r.rolname)

  await shared.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`)
      const [{ member }] = await tx.$queryRaw<Array<{ member: boolean }>>`
        SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${owner})
                    THEN pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = ${owner}), 'MEMBER')
                    ELSE false END AS member`
      if (member) await tx.$executeRawUnsafe(`REASSIGN OWNED BY ${q(owner)} TO CURRENT_USER`)
      for (const { name, leftAs } of names) {
        await tx.$executeRawUnsafe(`ALTER SCHEMA ${q(name)} RENAME TO ${q(leftAs)}`)
        const from = ['PUBLIC', ...roles.map(q)].join(', ')
        await tx.$executeRawUnsafe(`REVOKE ALL ON SCHEMA ${q(leftAs)} FROM ${from}`)
        await tx.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${q(leftAs)} FROM ${from}`)
        await tx.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${q(leftAs)} FROM ${from}`)
        await tx.$executeRawUnsafe(`REVOKE ALL ON ALL ROUTINES IN SCHEMA ${q(leftAs)} FROM ${from}`)
      }
      const [{ present }] = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(CHANNEL_TABLE_EXISTS_SQL)
      if (present) await tx.$executeRawUnsafe(DELETE_CHANNELS_SQL, schemas)
    },
    { timeout: 120_000, maxWait: 10_000 },
  )

  const problems: string[] = []
  const left = (
    await shared.$queryRaw<Array<{ name: string }>>`SELECT nspname::text AS name FROM pg_namespace WHERE nspname = ANY(${schemas}::text[])`
  ).map((r) => r.name)
  if (left.length > 0) problems.push(`${left.join(', ')} still there`)
  const stillServed = await servedAmong(shared, [...schemas, ...names.map((n) => n.leftAs)])
  if (stillServed.length > 0) problems.push(`${stillServed.join(', ')} still served`)
  const reachable = await shared.$queryRaw<Array<{ role: string; schema: string }>>`
    SELECT r.rolname::text AS role, n.nspname::text AS schema
      FROM pg_namespace n CROSS JOIN pg_roles r
     WHERE n.nspname = ANY(${names.map((n) => n.leftAs)}::text[]) AND r.rolname = ANY(${roles}::text[])
       AND has_schema_privilege(r.oid, n.oid, 'USAGE')`
  for (const { role, schema } of reachable) problems.push(`${role} can still use ${schema}`)
  if (problems.length > 0) throw new StepFailure('fence', problems.join('; '))
  log(run, 'fence', `left as ${names.map((n) => n.leftAs).join(', ')}, closed to ${roles.length} role(s) and PUBLIC`)
  return names
}

// ── Steps 10 and 11: resume, smoke, schedule the drop ────────────────────────

/** Whether a drop of this left-behind schema is already waiting in the region's retired-schema pass. */
async function dropScheduled(projectId: string, leftAs: string): Promise<boolean> {
  const { RETIRED_SCHEMAS_JOB_TYPE, RETIRED_SCHEMAS_STATUS } = await import('@/lib/postgrest/retire-schema')
  const job = await prisma.backgroundJob.findFirst({
    where: {
      type: RETIRED_SCHEMAS_JOB_TYPE,
      status: { in: [RETIRED_SCHEMAS_STATUS.pending, RETIRED_SCHEMAS_STATUS.running] },
      AND: [{ payload: { path: ['projectId'], equals: projectId } }, { payload: { path: ['schemas'], array_contains: [leftAs] } }],
    },
    select: { id: true },
  })
  return job !== null
}

async function scheduleDrop(run: Run, region: CloudRegionId, leftAs: string[]): Promise<void> {
  await scheduleSchemaDrop(prisma, {
    projectId: run.projectId,
    region,
    schemas: leftAs,
    via: 'tenancy migration',
    afterMs: MOVED_SCHEMA_DROP_AFTER_MS,
  })
  log(run, 'schedule_drop', `${leftAs.length} schema(s) dropped by the region's pass after ${MOVED_SCHEMA_DROP_AFTER_MS / 86_400_000} days`)
}

async function resume(run: Run, region: CloudRegionId, database: string, hasCredentials: boolean): Promise<void> {
  const { projectId } = run
  log(run, 'resume', 'restarting its own PostgREST and ending the pause')
  let base: string | null = null
  try {
    base = regionPostgrestHostUrl(region)
  } catch (err) {
    run.report.attention.push(`its own PostgREST was not restarted: ${message(err)}`)
  }
  if (base) {
    const { restartOnHost } = await import('@/lib/postgrest/supervisor')
    const restarted = await restartOnHost(projectId, region, database)
    if (!restarted.ok) run.report.attention.push(`its own PostgREST was not restarted: ${restarted.detail}`)
  }
  const thaw = await withProjectLifecycleLock(projectId, (tx) => applyMigrationThaw(tx, projectId))
  run.frozen = false
  await afterMigrationThawCommitted(projectId, ACTOR)
  if (thaw.deleted) run.report.attention.push('its deletion was asked for during the move, so it stays paused as a deleted project')
  if (hasCredentials) {
    try {
      const { syncDirectAccessGrants } = await import('@/lib/services/direct-access')
      await syncDirectAccessGrants(projectId)
    } catch (err) {
      run.report.attention.push(`direct access grants not synced: ${message(err)}`)
    }
  }
  log(run, 'resume', thaw.thawed ? 'serving again, from its own database' : 'the pause was not the move\'s any more; left as it is')
}

async function smoke(run: Run, region: CloudRegionId, database: string, hasFunctionLogin: boolean): Promise<MigrationCheck[]> {
  const { projectId } = run
  const canonical = workspaceSchemaName(projectId)
  const checks: MigrationCheck[] = []
  const attempt = async (id: string, fn: () => Promise<Omit<MigrationCheck, 'id'>>) => {
    try {
      checks.push({ id, ...(await fn()) })
    } catch (err) {
      checks.push({ id, state: 'failed', detail: message(err) })
    }
  }
  log(run, 'smoke', 'trying its paths')

  await attempt('workspace', async () => {
    const [row] = await (await workspaceRawClient(projectId)).$queryRawUnsafe<Array<{ db: string }>>(`SELECT current_database()::text AS db`)
    return row?.db === database ? { state: 'ok', detail: 'its workspace client reaches its own database' } : { state: 'failed', detail: 'its workspace client reaches another database' }
  })

  await attempt('data_api', async () => {
    if (!regionPostgrestHostUrl(region)) return { state: 'skipped', detail: 'no PostgREST host is configured for the region' }
    const { projectPostgrest } = await import('./regional')
    const target = await projectPostgrest(projectId)
    if (!target?.database) return { state: 'failed', detail: 'the project does not resolve to its own PostgREST' }
    const answer = await readThroughOwnPostgrest(target, projectId, canonical, null, run.waits.probeMs)
    return { state: answer.ok ? 'ok' : 'failed', detail: `${answer.detail} (the path the v1 /db and v2 routes proxy to)` }
  })

  await attempt('realtime', async () => {
    const { listenerHub } = await import('@/lib/realtime/listener-hub')
    const subscription = await listenerHub.subscribe(projectId, () => {})
    if (subscription.ok === false) return { state: 'failed', detail: `${subscription.code}: ${subscription.message}` }
    const heardThere = listenerHub.listenerKeys().includes(`${region}:${database}`)
    subscription.unsubscribe()
    return heardThere ? { state: 'ok', detail: 'a stream opened on its own database' } : { state: 'failed', detail: 'the stream was opened on another database' }
  })

  await attempt('function_login', async () => {
    if (!hasFunctionLogin) return { state: 'skipped', detail: 'the project has no function login' }
    const { functionDbConnection } = await import('@/lib/services/ai-functions/function-db-role')
    const { connectionString } = await functionDbConnection(projectId, { refresh: true })
    const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 })
    client.on('error', () => {})
    await client.connect()
    try {
      const { rows } = await client.query<{ db: string }>('SELECT current_database()::text AS db')
      return rows[0]?.db === database
        ? { state: 'ok', detail: "its functions' login connects to its own database" }
        : { state: 'failed', detail: "its functions' login reaches another database" }
    } finally {
      await client.end().catch(() => {})
    }
  })

  await attempt('snapshot', async () => {
    const result = await backupWorkspace(projectId)
    return result.success ? { state: 'ok', detail: 'a snapshot was taken from its own database' } : { state: 'failed', detail: result.error ?? 'the snapshot failed' }
  })

  const failed = checks.filter((c) => c.state === 'failed')
  for (const c of failed) run.report.attention.push(`smoke ${c.id}: ${c.detail}`)
  log(run, 'smoke', failed.length === 0 ? `ok: ${checks.map((c) => `${c.id} ${c.state}`).join(', ')}` : `failed: ${failed.map((c) => c.id).join(', ')}`)
  return checks
}

/** Everything after a committed flip. Never throws: the move happened, and what is left undone is in `attention`. */
async function afterFlip(run: Run, region: CloudRegionId, database: string, epoch: number, opts: { schemas: string[] | null; hasCredentials: boolean; hasFunctionLogin: boolean; fenced?: Array<{ name: string; leftAs: string }> }): Promise<void> {
  const { projectId } = run
  noteTenancyEpoch(projectId, epoch)
  forgetProjectDatabase(projectId)
  await forgetFunctionDbClient(projectId).catch(() => {})

  let fenced = opts.fenced ?? null
  let scheduled = false
  if (!fenced) {
    try {
      const found = await resolveProjectSchemas(regionRawClient(region, projectId), projectId)
      const schemas = opts.schemas ?? found.filter((s) => !isMovedSchema(s))
      if (schemas.length > 0) {
        fenced = await withChangeLockOn(projectId, [{ region, database: null }], () => fence(run, region, schemas, epoch), { waitMs: CHANGE_LOCK_WAIT_MS })
      } else {
        // Fenced by the run that died: its drop may not have been scheduled.
        const base = movedSchemaName(projectId, epoch)
        const leftAs = found.filter((s) => s === base || s.startsWith(`${base}_`))
        fenced = leftAs.map((name) => ({ name, leftAs: name }))
        scheduled = leftAs.length === 0 || (await dropScheduled(projectId, leftAs[0]))
        log(run, 'fence', `already fenced by an earlier run: ${leftAs.join(', ') || 'nothing left'}`)
      }
    } catch (err) {
      // The old copy is still reachable: the project stays paused, so nothing
      // can write to it, until a person fences it (or runs the move again).
      run.report.attention.push(`the old schemas were not fenced, so the project stays paused: ${message(err)}`)
      log(run, 'fence', `failed: ${message(err)}`)
      return
    }
  }
  run.report.schemas = run.report.schemas.map((s) => ({ ...s, leftAs: fenced!.find((f) => f.name === s.name)?.leftAs }))
  if (run.report.schemas.length === 0) run.report.schemas = fenced.map((f) => ({ name: f.name, leftAs: f.leftAs }))
  try {
    if (fenced.length > 0 && !scheduled) await scheduleDrop(run, region, fenced.map((f) => f.leftAs))
  } catch (err) {
    run.report.attention.push(`the drop of the old schemas was not scheduled: ${message(err)}`)
  }
  try {
    await resume(run, region, database, opts.hasCredentials)
  } catch (err) {
    run.report.attention.push(`the project was not resumed: ${message(err)}`)
    return
  }
  run.report.smoke = await smoke(run, region, database, opts.hasFunctionLogin)
}

// ── Standing down ────────────────────────────────────────────────────────────

/**
 * After a run that stopped before its flip, or a dry run: the project serves
 * from the shared database again, with its function logins as they were, and
 * the database made for it is dropped. Never throws; what could not be done
 * is in the report's `cleanup`.
 */
async function standDown(run: Run, ctx: MoveContext | null): Promise<void> {
  const { projectId } = run
  const notes: string[] = []
  // A flip whose commit reached the database though its answer did not: the
  // project's data is in its own database now. Nothing is dropped and the
  // pause stays, so a later run finishes the move.
  if (run.database) {
    const read = await prisma.project
      .findUnique({ where: { id: projectId }, select: { databaseName: true } })
      .then((row) => ({ ok: true as const, row }), () => ({ ok: false as const, row: null }))
    if (!read.ok || read.row?.databaseName === run.database) {
      run.report.outcome = 'moved'
      run.report.attention.push(
        read.ok
          ? 'the flip committed though it answered with an error: the project stays paused until another run finishes the move'
          : 'the project row could not be read, so its database was kept and its pause left as it is for another run',
      )
      log(run, 'abort', 'not stood down: the flip may have committed')
      return
    }
  }
  let serving = !run.frozen
  if (ctx && run.fnRetired) {
    const shared = regionRawClient(ctx.region, projectId)
    for (const schema of ctx.fnSchemas) {
      await shared.$queryRaw`SELECT public.backenly_fn_role_sync(${schema}, ${functionRolePassword(schema)}) AS role`.catch((err: unknown) => {
        notes.push(`the function login of ${schema} was not re-keyed: ${message(err)}`)
      })
    }
  }
  if (run.frozen) {
    try {
      const thaw = await withProjectLifecycleLock(projectId, (tx) => applyMigrationThaw(tx, projectId))
      await afterMigrationThawCommitted(projectId, ACTOR)
      run.frozen = false
      serving = thaw.thawed
      if (thaw.deleted) notes.push('its deletion was asked for during the run, so it stays paused as a deleted project')
    } catch (err) {
      notes.push(`its pause was not ended: ${message(err)}; a later run ends it`)
    }
  }
  let databaseDropped = run.database === null
  if (run.database && ctx) {
    try {
      await dropProjectDatabase({ region: ctx.region, database: run.database, projectId })
      databaseDropped = true
    } catch (err) {
      notes.push(`${run.database} was not dropped (${message(err)}); the daily orphan sweep drops it`)
    }
  }
  run.report.cleanup = { databaseDropped, serving, detail: notes.join('; ') || 'nothing left behind' }
  log(
    run,
    'abort',
    `stood down: ${databaseDropped ? 'its database is gone again' : 'its database is left for the sweep'}, ` +
      `${serving ? 'serving from the shared database' : 'not serving'}${notes.length ? `; ${notes.join('; ')}` : ''}`,
  )
}

// ── The move ─────────────────────────────────────────────────────────────────

/**
 * Move one project into a database of its own (the module's header has the
 * steps). Never throws: refusals, aborts and what needs a person after a move
 * are all in the report.
 */
export async function migrateProjectToOwnDatabase(projectId: string, options: MigrationOptions = {}): Promise<MigrationReport> {
  const report: MigrationReport = {
    projectId,
    region: null,
    dryRun: options.dryRun === true,
    outcome: 'refused',
    schemas: [],
    extensions: [],
    attention: [],
    steps: [],
    startedAt: new Date().toISOString(),
  }
  const run: Run = {
    projectId,
    report,
    options,
    waits: { ...productionWaits(), ...options.waits },
    step: 'preconditions',
    database: null,
    frozen: false,
    fnRetired: false,
  }
  const done = () => {
    report.finishedAt = new Date().toISOString()
    return report
  }

  try {
    assertValidProjectId(projectId)
  } catch {
    report.code = 'invalid_project'
    report.reason = 'not a project id'
    return done()
  }

  let ctx: MoveContext | null = null
  let dumpFile: string | null = null
  try {
    const outcome = await withMigrationLock(projectId, async () => {
      const prepared = await preconditions(run)
      await progress(run)

      if (prepared.kind === 'finish') {
        // An earlier run flipped and died: fence, resume and smoke now. The
        // move happened, so nothing from here stands it down.
        report.outcome = 'moved'
        report.finishedInterrupted = true
        run.database = prepared.database
        report.database = prepared.database
        report.epoch = prepared.epoch
        run.frozen = true
        log(run, 'flip', `already flipped by an earlier run, to epoch ${prepared.epoch}; finishing`)
        const credentials = await prisma.databaseCredential.count({ where: { projectId } })
        const fnRole = functionRoleName(workspaceSchemaName(projectId))
        const [{ n }] = await regionRawClient(prepared.region, projectId).$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${fnRole}`
        await afterFlip(run, prepared.region, prepared.database, prepared.epoch, { schemas: null, hasCredentials: credentials > 0, hasFunctionLogin: n > 0 })
        return
      }

      ctx = prepared.context
      const context = ctx
      report.schemas = context.schemas.map((name) => ({ name }))
      await create(run, context)
      await freeze(run, context)

      log(run, 'lock', 'taking its change lock on both databases')
      let flipped: { epoch: number; fenced: Array<{ name: string; leftAs: string }> | null } | null = null
      await withChangeLockOn(
        projectId,
        [
          { region: context.region, database: null },
          { region: context.region, database: run.database },
        ],
        async ([sharedLock, pxLock]) => {
          await progress(run)
          await snapshot(run)
          dumpFile = await dump(run, context)
          await replay(run, context, dumpFile)
          await fs.promises.unlink(dumpFile).catch(() => {})
          dumpFile = null
          const verification = await verify(run, context, sharedLock, pxLock)
          report.verification = verification
          if (!verification.ok) {
            throw new StepFailure('verify', verification.checks.filter((c) => c.state === 'failed').map((c) => `${c.id}: ${c.detail}`).join('; '))
          }
          if (report.dryRun) return

          const epoch = await flip(run, context, verification)
          // Committed: from here nothing stands the move down.
          report.outcome = 'moved'
          report.epoch = epoch
          noteTenancyEpoch(projectId, epoch)
          forgetProjectDatabase(projectId)
          log(run, 'flip', `the project names its own database, epoch ${epoch}`)
          let fenced: Array<{ name: string; leftAs: string }> | null = null
          try {
            fenced = await fence(run, context.region, context.schemas, epoch)
          } catch (err) {
            report.attention.push(`the old schemas were not fenced, so the project stays paused: ${message(err)}`)
            log(run, 'fence', `failed: ${message(err)}`)
          }
          flipped = { epoch, fenced }
        },
        { waitMs: CHANGE_LOCK_WAIT_MS },
      )

      if (report.dryRun) {
        await standDown(run, context)
        report.outcome = 'dry_run_ok'
        return
      }

      const moved = flipped as { epoch: number; fenced: Array<{ name: string; leftAs: string }> | null } | null
      if (!moved) throw new StepFailure('flip', 'the flip did not run')
      if (moved.fenced) {
        await afterFlip(run, context.region, run.database as string, moved.epoch, {
          schemas: context.schemas,
          hasCredentials: context.credentials.length > 0,
          hasFunctionLogin: context.fnSchemas.includes(context.canonical),
          fenced: moved.fenced,
        })
      } else {
        // Not fenced: the project stays paused, which keeps every door shut
        // on the old copy, until a person (or another run) fences it.
        noteTenancyEpoch(projectId, moved.epoch)
      }
    })

    if (outcome === BUSY) {
      report.code = 'migration_running'
      report.reason = 'another move of this project is running'
    }
  } catch (err) {
    if (err instanceof Refusal) {
      report.outcome = 'refused'
      report.code = err.code
      report.reason = err.message
      log(run, 'preconditions', `refused (${err.code}): ${err.message}`)
    } else if (report.outcome === 'moved') {
      report.attention.push(message(err))
    } else {
      report.outcome = 'aborted'
      report.step = err instanceof StepFailure ? err.step : run.step
      report.reason = message(err)
      log(run, 'abort', `at ${report.step}: ${report.reason}`)
      await standDown(run, ctx)
    }
  } finally {
    if (dumpFile) await fs.promises.unlink(dumpFile).catch(() => {})
  }
  return done()
}

/**
 * The regional job: one move, as its payload asks (`{ projectId, dryRun }`).
 * Its report is the job's result. Never throws.
 */
export async function runTenancyMigrationJob(jobId: string, payload: unknown): Promise<MigrationReport> {
  const { projectId, dryRun } = (payload ?? {}) as { projectId?: unknown; dryRun?: unknown }
  return migrateProjectToOwnDatabase(typeof projectId === 'string' ? projectId : '', { dryRun: dryRun === true, jobId })
}

/** Ask a project's region to move it. Once: a move that stops is started again by a person. */
export async function enqueueTenancyMigration(
  projectId: string,
  region: CloudRegionId,
  options: { dryRun?: boolean; requestedBy?: string | null } = {},
): Promise<{ id: string }> {
  return enqueueRegionalJob(
    TENANCY_MIGRATION_JOB_TYPE,
    projectId,
    region,
    { dryRun: options.dryRun === true, requestedBy: options.requestedBy ?? 'operator' },
    { maxAttempts: 1 },
  )
}

/** The projects a region holds, by their rows: home's unnamed ones included. */
export function projectsInRegionWhere(region: CloudRegionId) {
  return region === HOME_REGION ? { OR: [{ region: null }, { region: HOME_REGION }] } : { region }
}

/** Moves of a region not yet ended: queued or running. */
export async function migrationsInFlight(region: CloudRegionId): Promise<number> {
  return prisma.backgroundJob.count({
    where: {
      type: TENANCY_MIGRATION_JOB_TYPE,
      status: { in: [REGIONAL_STATUS.pending, REGIONAL_STATUS.running] },
      payload: { path: ['region'], equals: region },
    },
  })
}

// ── Closing the shared database once it holds no project ────────────────────

export interface RevokeConnectReport {
  region: CloudRegionId
  database: string
  granted: string[]
  /** What puts it back, should a person need to. */
  reverse: string
}

/**
 * Once every project of a region has a database of its own, its control
 * database (the region's own, which held the shared schemas) need not be open
 * to every login on the instance: CONNECT is taken from PUBLIC and given by
 * name to the platform's roles that use it, and to any other login connected
 * to it now that is not a project's. A project's own logins then cannot open
 * it at all. Refused while any project of the region is still shared (deleted
 * ones not yet purged included), or while it holds a workspace schema other
 * than what a move left behind.
 *
 * Run as the database's owner (the region's administrator), over the region's
 * admin connection (BACKENLY_ADMIN_DATABASE_URL, with the region appended
 * outside the home region): only the owner may take what PUBLIC holds.
 */
export async function revokePublicConnect(region: CloudRegionId, options: { extraRoles?: string[] } = {}): Promise<RevokeConnectReport> {
  const shared = await prisma.project.count({ where: { databaseTenancy: 'shared', ...projectsInRegionWhere(region) } })
  if (shared > 0) {
    throw new Error(`Refusing: ${shared} project(s) in ${region} still keep their data in its shared database. Move them first.`)
  }
  for (const role of options.extraRoles ?? []) if (!ROLE_NAME.test(role)) throw new Error(`Not a role name: ${role}`)

  const client = new Client({ connectionString: requireRegionDatabaseUrl(region, 'admin'), connectionTimeoutMillis: 10_000 })
  client.on('error', () => {})
  await client.connect()
  try {
    const { rows: [me] } = await client.query<{ db: string; me: string; owner: string; superuser: boolean }>(
      `SELECT current_database()::text AS db, current_user::text AS me,
              (SELECT pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = current_database()) AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
    )
    if (me.me !== me.owner && !me.superuser) {
      throw new Error(`Refusing: connected as ${me.me}, and only ${me.owner}, the owner of ${me.db}, may take CONNECT from PUBLIC on it.`)
    }
    const { rows: schemas } = await client.query<{ name: string }>(`SELECT nspname::text AS name FROM pg_namespace WHERE starts_with(nspname, 'workspace_')`)
    const unmoved = schemas.map((s) => s.name).filter((name) => !isMovedSchema(name))
    if (unmoved.length > 0) {
      throw new Error(`Refusing: ${me.db} still holds ${unmoved.length} workspace schema(s) no move left behind, such as ${unmoved[0]}.`)
    }
    const { rows: connected } = await client.query<{ name: string }>(
      `SELECT DISTINCT a.usename::text AS name FROM pg_stat_activity a JOIN pg_roles r ON r.rolname = a.usename
        WHERE a.datname = current_database() AND r.rolcanlogin AND a.usename <> current_user
          AND a.usename !~ '^bkn_(ro|rw|fn)_[0-9a-f]{12}$'`,
    )
    const wanted = [
      'backenly_app',
      'backenly_backup',
      'backenly_authenticator',
      'backenly_dbcreator',
      'backenly_pooler_auth',
      ...connected.map((r) => r.name),
      ...(options.extraRoles ?? []),
    ]
    const { rows: existing } = await client.query<{ name: string }>(
      `SELECT rolname::text AS name FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1`,
      [[...new Set(wanted)]],
    )
    const missing = (options.extraRoles ?? []).filter((role) => !existing.some((r) => r.name === role))
    if (missing.length > 0) throw new Error(`Refusing: no role named ${missing.join(', ')}.`)
    const granted = existing.map((r) => r.name)

    const db = q(me.db)
    await client.query('BEGIN')
    try {
      for (const role of granted) await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${q(role)}`)
      await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
    const { rows: [after] } = await client.query<{ open: boolean }>(`SELECT has_database_privilege('public', current_database(), 'CONNECT') AS open`)
    if (after.open) throw new Error(`PUBLIC still holds CONNECT on ${me.db}: a grant another role made was not taken back.`)
    const { rows: lacking } = await client.query<{ name: string }>(
      `SELECT rolname::text AS name FROM pg_roles WHERE rolname = ANY($1::text[]) AND NOT has_database_privilege(oid, current_database(), 'CONNECT')`,
      [granted],
    )
    if (lacking.length > 0) throw new Error(`${lacking.map((r) => r.name).join(', ')} cannot connect to ${me.db} after the grant.`)
    console.log(`[TenancyMigration] region=${region} CONNECT on ${me.db} taken from PUBLIC; given to ${granted.join(', ')}`)
    return { region, database: me.db, granted, reverse: `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO PUBLIC;` }
  } finally {
    await client.end().catch(() => {})
  }
}
