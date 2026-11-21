/**
 * A PROJECT'S OWN DATABASE: CREATED, DROPPED, AND SWEPT
 * =====================================================
 * A project with a database of its own (Project.databaseTenancy 'dedicated',
 * lib/data-plane/regional.ts) keeps its workspace schema in a database named
 * on its row, p_ followed by 32 lowercase hex digits, on its region's data
 * instance. This module is the only application code that creates or drops a
 * database (scripts/verify-project-provisioning.ts holds it to that).
 *
 * WHO. Every statement here runs as the region's database creator, a role that
 * may create databases and nothing else (backenly_dbcreator, made by the
 * regional procedure, tools/managed-db/regional/sql/roles.sql), over
 * DBCREATOR_DATABASE_URL in the home region and DBCREATOR_DATABASE_URL_<REGION>
 * elsewhere. The web and runtime connections never hold it. It owns each
 * database it creates, so it is also the one that may drop it.
 *
 * CREATE. The name is random (32 hex digits of a fresh UUID), never derived
 * from the project: pg_database is readable by every login on the instance,
 * and a name must say nothing about whose it is. For the same reason no
 * comment is ever set on a database. The database is cloned from the
 * procedure's template (backenly_project_template), which carries every helper,
 * event trigger and extension a project database needs; a clone carries none
 * of the grants on the template database itself, so the creator then gives it
 * its own (PROJECT_DATABASE_ACL_SQL, the text of
 * scripts/sql/project-database-acl.sql, which closes it to every login it does
 * not name). Cloning fails while the procedure is converging the template
 * (42501: it is not a template for that moment) or while anyone is connected
 * to it (55006); both are retried with backoff for about 30 seconds.
 *
 * A RECORD BEFORE THE DATABASE. Each creation writes an audit row
 * (PROJECT_DATABASE_CREATED, with the region and the name) on the platform
 * database before CREATE DATABASE runs, so a database this module made never
 * exists without one. That row is the orphan sweep's age signal: PostgreSQL
 * records no creation time for a database (pg_stat_file is not available on
 * Amazon RDS, and a database's oid orders creations without dating them), and
 * the creator cannot write into the new database's backenly_meta, which
 * belongs to the procedure. A row whose CREATE then failed names a database
 * that does not exist, which nothing reads as anything.
 *
 * DROP. This process's own connections to the database are closed first, then
 * the creator takes CONNECT back from the platform's roles and drops it WITH
 * (FORCE), which ends every other session it may end. DROP DATABASE cannot run
 * in a transaction, so it is idempotent instead: a database already gone is
 * not an error, and a purge that failed after it simply runs again.
 *
 * ORPHANS. A crash between the clone and the platform row that records it
 * leaves a database no project names. Once a day (instrumentation.ts) the
 * sweep lists the creator's p_ databases on each data instance and drops those
 * that no Project row names and whose creation row is more than an hour old.
 * A p_ database with no creation row is never dropped by the sweep, only
 * reported: this module did not make it.
 *
 * PAUSED. While its project is paused, a project database's own logins hold no
 * CONNECT on it (setProjectDatabaseConnect), beside the NOLOGIN a pause already
 * sets (lib/projects/paused-logins.ts).
 */

import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { allSettledBounded, SWEEP_CONCURRENCY } from '@/lib/scheduler/bounded'
import { CLOUD_REGIONS, HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { isProjectOwnedSchema, projectSchemaPrefix, workspaceSchemaName } from '@/lib/security/workspace-schema'
import {
  PRIMARY_DATA_INSTANCE,
  ProjectDatabaseNameError,
  RegionNotConfiguredError,
  closeProjectDatabaseConnections,
  dataInstanceRawClient,
  databaseClient,
  isProjectDatabaseName,
  projectDatabase,
  regionSetting,
  type WorkspaceRawClient,
} from './regional'

type Env = Readonly<Record<string, string | undefined>>

/** The database every project database is cloned from, kept by the regional procedure. */
export const PROJECT_DATABASE_TEMPLATE = 'backenly_project_template'

/** The setting naming a region's database creator connection. */
export const DBCREATOR_URL_SETTING = 'DBCREATOR_DATABASE_URL'

/** The audit row written before each database is created: the orphan sweep's age signal. */
export const DATABASE_CREATED_ACTION = 'PROJECT_DATABASE_CREATED'
/** The audit row of a database the orphan sweep dropped. */
export const ORPHAN_DROPPED_ACTION = 'PROJECT_DATABASE_ORPHAN_DROPPED'

/** A database no project names is dropped only once its creation row is this old. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000
/** At most this many orphans are dropped per region per sweep; the rest wait for the next. */
const ORPHAN_SWEEP_LIMIT = 50

/** How long a clone is retried while the template is busy. */
export const CLONE_RETRY_BUDGET_MS = 30_000
const CLONE_FIRST_DELAY_MS = 250
const CLONE_MAX_DELAY_MS = 4_000

/** The database creator's sessions: bounded, so a stuck statement cannot hold a creation. */
const CREATOR_CONNECT_TIMEOUT_MS = 10_000
const CREATOR_STATEMENT_TIMEOUT_MS = 120_000

/** The platform's roles a project database names in its grants (PROJECT_DATABASE_ACL_SQL). */
const PLATFORM_ROLES = ['backenly_app', 'backenly_backup', 'backenly_authenticator'] as const

/** A project's own logins: read-only, read-write and its functions'. */
const PROJECT_LOGIN = /^bkn_(ro|rw|fn)_[0-9a-f]{12}$/

// ── The database creator ─────────────────────────────────────────────────────

/** The region's database creator connection string, or undefined when this process has none. */
export function regionDbcreatorUrl(region: CloudRegionId, env: Env = process.env): string | undefined {
  return regionSetting(DBCREATOR_URL_SETTING, region, env).value
}

/** regionDbcreatorUrl, or RegionNotConfiguredError naming the variable. */
export function requireRegionDbcreatorUrl(
  region: CloudRegionId,
  { env = process.env, projectId }: { env?: Env; projectId?: string } = {},
): string {
  const { variable, value } = regionSetting(DBCREATOR_URL_SETTING, region, env)
  if (value) return value
  throw new RegionNotConfiguredError(
    region,
    variable,
    projectId,
    `No database creator connection for ${region}: ${variable} is not set, so no project database can be created or dropped there.`,
  )
}

async function creatorClient(region: CloudRegionId, projectId?: string): Promise<Client> {
  const client = new Client({
    connectionString: requireRegionDbcreatorUrl(region, { projectId }),
    connectionTimeoutMillis: CREATOR_CONNECT_TIMEOUT_MS,
    statement_timeout: CREATOR_STATEMENT_TIMEOUT_MS,
  })
  // An error on an idle client is emitted on it; unhandled, it ends the process.
  client.on('error', (err) => console.error(`[ProjectDatabases] database creator connection in ${region}:`, err.message))
  await client.connect()
  return client
}

/** Run `fn` on a database creator session of its own, closed after. */
async function asCreator<T>(region: CloudRegionId, projectId: string | undefined, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await creatorClient(region, projectId)
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

function refuseBadName(database: string): void {
  if (!isProjectDatabaseName(database)) {
    throw new ProjectDatabaseNameError(
      `${JSON.stringify(String(database).slice(0, 80))} is not the name of a project's own database (p_ followed by 32 lowercase hex digits).`,
    )
  }
}

/** A validated project database name, quoted. The pattern admits nothing that needs escaping. */
function quotedDatabase(database: string): string {
  refuseBadName(database)
  return `"${database}"`
}

// ── Creating ─────────────────────────────────────────────────────────────────

/** A fresh project database name: p_ and the 32 hex digits of a random UUID. Never derived from the project. */
export function newProjectDatabaseName(): string {
  return `p_${randomUUID().replace(/-/g, '')}`
}

/**
 * Whether a failed clone may succeed if tried again shortly: the template is
 * being converged by the procedure and is not a template for that moment
 * (42501), or a session is connected to it (55006).
 */
export function isRetryableCloneError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return code === '42501' || code === '55006'
}

/** The template stayed unavailable for the whole retry budget. Retryable later. */
export class ProjectDatabaseTemplateBusyError extends Error {
  readonly code = 'PROJECT_DATABASE_TEMPLATE_BUSY'
  readonly status = 503
  readonly retryable = true

  constructor(
    readonly attempts: number,
    readonly last: unknown,
  ) {
    const code = (last as { code?: unknown } | null)?.code
    super(
      `${PROJECT_DATABASE_TEMPLATE} could not be cloned in ${attempts} attempt(s) over about ${CLONE_RETRY_BUDGET_MS / 1000} s ` +
        `(${code ? `${code}: ` : ''}${last instanceof Error ? last.message : String(last)}). ` +
        'It is being converged, or a session is connected to it. Nothing was created; try again shortly.',
    )
    this.name = 'ProjectDatabaseTemplateBusyError'
  }
}

export interface CloneRetryOptions {
  budgetMs?: number
  firstDelayMs?: number
  maxDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * `attempt`, tried again on a retryable clone error (isRetryableCloneError)
 * with a doubling delay, for at most `budgetMs`; then
 * ProjectDatabaseTemplateBusyError. Any other error is thrown at once.
 */
export async function withCloneRetry<T>(attempt: () => Promise<T>, options: CloneRetryOptions = {}): Promise<T> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxDelay = options.maxDelayMs ?? CLONE_MAX_DELAY_MS
  const deadline = now() + (options.budgetMs ?? CLONE_RETRY_BUDGET_MS)
  let delay = options.firstDelayMs ?? CLONE_FIRST_DELAY_MS
  for (let attempts = 1; ; attempts++) {
    try {
      return await attempt()
    } catch (err) {
      if (!isRetryableCloneError(err)) throw err
      const left = deadline - now()
      if (left <= 0) throw new ProjectDatabaseTemplateBusyError(attempts, err)
      await sleep(Math.min(delay, left))
      delay = Math.min(delay * 2, maxDelay)
    }
  }
}

export interface CreatedProjectDatabase {
  region: CloudRegionId
  database: string
  /** The data instance it is on: the region's primary one. */
  instance: string
}

/**
 * Create a database of its own for a project about to be created: record it,
 * clone the template as the region's database creator, and give the clone its
 * grants. On any failure after the clone, the clone is dropped and the error
 * rethrown. The project's row does not exist yet; its id is recorded beside the
 * name, for the record only.
 */
export async function createProjectDatabase(
  input: { region: CloudRegionId; projectId: string },
  options: { retry?: CloneRetryOptions } = {},
): Promise<CreatedProjectDatabase> {
  const { region, projectId } = input
  // Refused before anything is written when this process cannot create there.
  requireRegionDbcreatorUrl(region, { projectId })
  const database = newProjectDatabaseName()

  await prisma.auditLog.create({
    data: {
      action: DATABASE_CREATED_ACTION,
      type: 'project',
      details: `A database of its own for a new project in ${region}`,
      // The project's row does not exist yet, so its id is not the relation.
      metadata: { region, database, instance: PRIMARY_DATA_INSTANCE, projectId },
      timestamp: new Date(),
    },
  })

  await asCreator(region, projectId, async (client) => {
    await withCloneRetry(() => client.query(`CREATE DATABASE ${quotedDatabase(database)} TEMPLATE ${PROJECT_DATABASE_TEMPLATE}`), options.retry)
    try {
      // On the session that created it, before anything else can reach it.
      await client.query(`SELECT set_config('backenly.project_database', $1, false)`, [database])
      await client.query(PROJECT_DATABASE_ACL_SQL)
    } catch (err) {
      await client.query(`DROP DATABASE IF EXISTS ${quotedDatabase(database)} WITH (FORCE)`).catch((dropErr: unknown) => {
        console.error(
          `[ProjectDatabases] ${database} in ${region} was cloned, could not be given its grants, and could not be dropped ` +
            `(${dropErr instanceof Error ? dropErr.message : String(dropErr)}); the orphan sweep drops it`,
        )
      })
      throw err
    }
  })
  console.log(`[ProjectDatabases] created ${database} in ${region} for project ${projectId}`)
  return { region, database, instance: PRIMARY_DATA_INSTANCE }
}

// ── Dropping ─────────────────────────────────────────────────────────────────

/** The creator may not drop a database it does not own; it never tries. */
export class ProjectDatabaseNotOursError extends Error {
  readonly code = 'PROJECT_DATABASE_NOT_OURS'

  constructor(database: string, owner: string) {
    super(`Refusing to drop ${database}: it belongs to ${owner}, not to the database creator.`)
    this.name = 'ProjectDatabaseNotOursError'
  }
}

/**
 * Close every connection this process holds on a project database: its
 * clients and pools (lib/data-plane/regional.ts), its change lock pool
 * (lib/changes/lock.ts), its realtime listener (lib/realtime/listener-hub.ts),
 * and the project's function client (lib/services/ai-functions/function-db-role.ts).
 */
export async function closeThisProcessConnections(region: CloudRegionId, database: string, projectId?: string): Promise<void> {
  await closeProjectDatabaseConnections(region, database)
  const [{ closeChangeLockPoolOn }, { listenerHub }] = await Promise.all([
    import('@/lib/changes/lock'),
    import('@/lib/realtime/listener-hub'),
  ])
  await closeChangeLockPoolOn(region, database)
  listenerHub.closeDatabase({ region, database })
  if (projectId) {
    const { forgetFunctionDbClient } = await import('@/lib/services/ai-functions/function-db-role')
    await forgetFunctionDbClient(projectId).catch(() => {})
  }
}

/** How long a drop waits for other roles' sessions to end before it ends what it may. */
const OTHER_SESSIONS_WAIT_MS = 5_000

/**
 * Wait, at most OTHER_SESSIONS_WAIT_MS, until no client session of a role
 * other than the creator is connected to `database`. Answers how many are
 * left. pg_stat_activity shows every login which database each session is on,
 * though not what it runs.
 */
async function waitForOtherSessions(client: Client, database: string, waitMs: number = OTHER_SESSIONS_WAIT_MS): Promise<number> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = $1 AND backend_type = 'client backend' AND usename IS DISTINCT FROM current_user`,
      [database],
    )
    const left = Number(rows[0]?.n ?? 0)
    if (left === 0 || Date.now() >= deadline) return left
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** CONNECT taken from PUBLIC and the platform's roles, as the owner that gave it. */
function revokeConnectSql(database: string): string {
  refuseBadName(database)
  return `DO $$
DECLARE r text;
BEGIN
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', '${database}');
  FOREACH r IN ARRAY ARRAY[${PLATFORM_ROLES.map((role) => `'${role}'`).join(', ')}] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', '${database}', r);
    END IF;
  END LOOP;
END $$`
}

/**
 * Drop a project database, as the region's database creator. Idempotent: a
 * database already gone answers `existed: false`. This process's own
 * connections are closed first; FORCE then ends every other session the
 * creator may end. One of another role it may not end (it needs
 * pg_signal_backend for those) fails the drop, which is said, and the caller
 * tries again later.
 */
export async function dropProjectDatabase(input: {
  region: CloudRegionId
  database: string
  projectId?: string
}): Promise<{ existed: boolean }> {
  const { region, database, projectId } = input
  refuseBadName(database)
  requireRegionDbcreatorUrl(region, { projectId })
  await closeThisProcessConnections(region, database, projectId)

  return asCreator(region, projectId, async (client) => {
    const { rows } = await client.query<{ owner: string; me: string }>(
      `SELECT pg_get_userbyid(datdba)::text AS owner, current_user::text AS me FROM pg_database WHERE datname = $1`,
      [database],
    )
    if (rows.length === 0) return { existed: false }
    if (rows[0].owner !== rows[0].me) throw new ProjectDatabaseNotOursError(database, rows[0].owner)

    await client.query(revokeConnectSql(database))
    // A connection just closed (this process's, above) is still a backend for
    // a moment; FORCE may end only the sessions the creator may signal, so the
    // others are given a little time to go first. None of the platform's roles
    // can open a new one now.
    await waitForOtherSessions(client, database)
    try {
      await client.query(`DROP DATABASE IF EXISTS ${quotedDatabase(database)} WITH (FORCE)`)
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === '42501' || code === '55006') {
        throw new Error(
          `${database} in ${region} was not dropped: a session the database creator may not end is still connected to it ` +
            `(${code}: ${err instanceof Error ? err.message : String(err)}). It needs pg_signal_backend, or the session must end first.`,
        )
      }
      throw err
    }
    console.log(`[ProjectDatabases] dropped ${database} in ${region}${projectId ? ` (project ${projectId})` : ''}`)
    return { existed: true }
  })
}

/** Whether a project database exists on its region's data instance, read from the instance's catalog. */
export async function projectDatabaseExists(region: CloudRegionId, database: string): Promise<boolean> {
  refuseBadName(database)
  const rows = await dataInstanceRawClient(region).$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${database}) AS present`
  return rows[0]?.present === true
}

// ── The orphan sweep ─────────────────────────────────────────────────────────

export interface OrphanSweepReport {
  region: CloudRegionId
  /** Dropped: no project names it, and its creation row is older than the minimum age. */
  dropped: string[]
  /** No project names it yet, but it was created too recently to tell. */
  tooRecent: string[]
  /** No project names it and no creation row of this region does: not this module's, so kept. */
  unrecorded: string[]
  failed: Array<{ database: string; error: string }>
  /** Set when the region could not be swept at all. */
  error?: string
}

/** The creator's p_ databases on a region's data instance. */
async function creatorDatabases(region: CloudRegionId): Promise<string[]> {
  return asCreator(region, undefined, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `SELECT datname::text AS name FROM pg_database
        WHERE datname ~ '^p_[0-9a-f]{32}$' AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        ORDER BY 1`,
    )
    return rows.map((r) => r.name).filter(isProjectDatabaseName)
  })
}

/** When each of these databases was recorded as created in `region`, from its creation row. */
async function creationTimes(region: CloudRegionId, databases: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>()
  if (databases.length === 0) return out
  const rows = await prisma.auditLog.findMany({
    where: { action: DATABASE_CREATED_ACTION, OR: databases.map((database) => ({ metadata: { path: ['database'], equals: database } })) },
    select: { timestamp: true, metadata: true },
  })
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as { database?: unknown; region?: unknown }
    if (typeof meta.database !== 'string' || meta.region !== region) continue
    const seen = out.get(meta.database)
    if (!seen || row.timestamp < seen) out.set(meta.database, row.timestamp)
  }
  return out
}

/**
 * Drop the project databases no project names, on each region's data instance
 * this process has a database creator connection for (by default every region
 * it has one for). Only databases the creator owns, whose creation row in that
 * region is at least `minAgeMs` old, and that no Project row names when looked
 * at again just before the drop. One line per region is logged. Never throws.
 */
export async function sweepOrphanProjectDatabases(
  options: { now?: Date; regions?: CloudRegionId[]; minAgeMs?: number; env?: Env } = {},
): Promise<OrphanSweepReport[]> {
  const now = options.now ?? new Date()
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS
  const regions = options.regions ?? CLOUD_REGIONS.map((r) => r.id).filter((id) => regionDbcreatorUrl(id, options.env))
  const reports: OrphanSweepReport[] = []

  for (const region of regions) {
    const report: OrphanSweepReport = { region, dropped: [], tooRecent: [], unrecorded: [], failed: [] }
    try {
      const found = await creatorDatabases(region)
      const named = new Set(
        found.length === 0
          ? []
          : (await prisma.project.findMany({ where: { databaseName: { in: found } }, select: { databaseName: true } })).map((p) => p.databaseName),
      )
      const unnamed = found.filter((database) => !named.has(database))
      const created = await creationTimes(region, unnamed)
      for (const database of unnamed) {
        const at = created.get(database)
        if (!at) report.unrecorded.push(database)
        else if (now.getTime() - at.getTime() < minAgeMs) report.tooRecent.push(database)
      }
      const due = unnamed.filter((database) => created.has(database) && !report.tooRecent.includes(database)).slice(0, ORPHAN_SWEEP_LIMIT)
      for (const database of due) {
        try {
          // A creation that committed since the listing names it now.
          if (await prisma.project.findFirst({ where: { databaseName: database }, select: { id: true } })) continue
          await dropProjectDatabase({ region, database })
          report.dropped.push(database)
          await prisma.auditLog
            .create({
              data: {
                action: ORPHAN_DROPPED_ACTION,
                type: 'project',
                details: `Dropped ${database} in ${region}: no project names it, and it was created ${created.get(database)?.toISOString()}`,
                metadata: { region, database },
                timestamp: new Date(),
              },
            })
            .catch(() => {})
        } catch (err) {
          report.failed.push({ database, error: err instanceof Error ? err.message : String(err) })
        }
      }
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err)
    }
    console.log(
      JSON.stringify({
        event: 'project_database_orphan_sweep',
        region,
        dropped: report.dropped,
        tooRecent: report.tooRecent.length,
        unrecorded: report.unrecorded,
        failed: report.failed,
        error: report.error ?? null,
      }),
    )
    reports.push(report)
  }
  return reports
}

// ── Every project database of a region ───────────────────────────────────────

export interface ProjectDatabaseRef {
  region: CloudRegionId
  database: string
  projectId: string
}

/**
 * The project databases a region's projects' rows name, on its primary data
 * instance, deleted projects' included (their databases are there until they
 * are purged). Read from the platform's rows, which are the authority on which
 * database is whose.
 */
export async function projectDatabasesOf(region: CloudRegionId): Promise<ProjectDatabaseRef[]> {
  const rows = await prisma.project.findMany({
    where: {
      databaseTenancy: 'dedicated',
      databaseName: { not: null },
      ...(region === HOME_REGION ? { OR: [{ region: null }, { region: HOME_REGION }] } : { region }),
    },
    select: { id: true, databaseName: true, databaseInstance: true },
    orderBy: { id: 'asc' },
  })
  return rows
    .filter((row) => isProjectDatabaseName(row.databaseName) && (row.databaseInstance ?? PRIMARY_DATA_INSTANCE) === PRIMARY_DATA_INSTANCE)
    .map((row) => ({ region, database: row.databaseName as string, projectId: row.id }))
}

/**
 * Run `fn` for each project database of a region (projectDatabasesOf), a few
 * at a time (lib/scheduler/bounded.ts), so a region-wide pass opens the
 * connections of a handful of databases at once rather than all of them. One
 * failing never stops the rest; each settles in the order listed.
 */
export async function forEachProjectDatabase<R>(
  region: CloudRegionId,
  fn: (ref: ProjectDatabaseRef) => Promise<R>,
  { concurrency = SWEEP_CONCURRENCY }: { concurrency?: number } = {},
): Promise<Array<{ ref: ProjectDatabaseRef; result: PromiseSettledResult<R> }>> {
  const refs = await projectDatabasesOf(region)
  const results = await allSettledBounded(refs, (ref) => fn(ref), concurrency)
  return refs.map((ref, i) => ({ ref, result: results[i] }))
}

// ── Grants inside a project database ─────────────────────────────────────────

/**
 * Give the backup role read on a workspace schema in the database `db`
 * reaches, and the default privileges that cover each table added to it later:
 * public.backenly_direct_sync_schema with no login, the call a project without
 * direct access gets (lib/services/direct-access.ts grantWorkspaceBackupAccess
 * makes the same call on a region's database). False where the helper is not
 * installed.
 */
export async function grantBackupReadOn(db: WorkspaceRawClient, schema: string): Promise<boolean> {
  const [probe] = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regprocedure('public.backenly_direct_sync_schema(text,text,text,text)') IS NOT NULL AS present`
  if (!probe?.present) return false
  await db.$queryRaw`SELECT public.backenly_direct_sync_schema(${schema}, NULL, NULL, NULL)`
  return true
}

/** The project's schemas in its own database: its canonical one, its branches and its vaults. */
export async function projectSchemasIn(db: WorkspaceRawClient, projectId: string): Promise<string[]> {
  const canonical = workspaceSchemaName(projectId)
  const prefix = projectSchemaPrefix(projectId)
  const rows = await db.$queryRaw<Array<{ nspname: string }>>`
    SELECT nspname::text AS nspname FROM pg_namespace
     WHERE nspname = ${canonical} OR left(nspname, length(${prefix})) = ${prefix}
     ORDER BY nspname`
  return rows.map((r) => r.nspname).filter((schema) => isProjectOwnedSchema(projectId, schema))
}

/** The project logins that hold CONNECT on `database` by name, read from the instance's catalog. */
async function loginsWithConnect(instance: WorkspaceRawClient, database: string): Promise<string[]> {
  const rows = await instance.$queryRaw<Array<{ rolname: string }>>`
    SELECT DISTINCT r.rolname::text AS rolname
      FROM pg_database d
     CROSS JOIN LATERAL aclexplode(d.datacl) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE d.datname = ${database} AND a.privilege_type = 'CONNECT'
     ORDER BY 1`
  return rows.map((r) => r.rolname).filter((name) => PROJECT_LOGIN.test(name))
}

/**
 * Whether a project's own logins may connect to its own database: taken away
 * while the project is paused or asked to be deleted, given back when it is
 * resumed or restored (lib/projects/paused-logins.ts). A no-op for a project in
 * a shared database, and when nothing needs to change, which is read from the
 * instance's catalog first so the database creator is reached only to change it.
 *
 * Taking it away, as the database's owner: the grants the owner made, and the
 * ones the procedure's administrator made through the helpers (it holds CONNECT
 * WITH GRANT OPTION on the database, scripts/sql/project-database-acl.sql), by
 * taking that grant option back with CASCADE and giving it back at once, in one
 * transaction. In a database that holds one project, the administrator's grants
 * of CONNECT are that project's logins' alone. Logins still holding it after
 * that are answered in `left` and said; NOLOGIN still keeps them out.
 *
 * Giving it back: to each of the project's logins that can log in and lacks it.
 */
export async function setProjectDatabaseConnect(
  projectId: string,
  allowed: boolean,
): Promise<{ changed: string[]; left: string[] }> {
  const placement = await projectDatabase(projectId)
  if (placement.tenancy !== 'dedicated') return { changed: [], left: [] }
  const region = placement.region
  const database = placement.database as string
  const instance = dataInstanceRawClient(region)
  const holding = await loginsWithConnect(instance, database)

  if (!allowed) {
    if (holding.length === 0) return { changed: [], left: [] }
    await asCreator(region, projectId, async (client) => {
      const [{ admin, me }] = (
        await client.query<{ admin: string | null; me: string }>(
          `SELECT (SELECT pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = $1) AS admin, current_user::text AS me`,
          [PROJECT_DATABASE_TEMPLATE],
        )
      ).rows
      await client.query('BEGIN')
      try {
        for (const login of holding) {
          await client.query(`REVOKE CONNECT ON DATABASE ${quotedDatabase(database)} FROM ${client.escapeIdentifier(login)}`)
        }
        if (admin && admin !== me) {
          const who = client.escapeIdentifier(admin)
          await client.query(`REVOKE GRANT OPTION FOR CONNECT ON DATABASE ${quotedDatabase(database)} FROM ${who} CASCADE`)
          await client.query(`GRANT CONNECT ON DATABASE ${quotedDatabase(database)} TO ${who} WITH GRANT OPTION`)
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      }
    })
    const left = await loginsWithConnect(instance, database)
    if (left.length > 0) {
      console.warn(`[ProjectDatabases] project=${projectId}: ${left.join(',')} still hold CONNECT on its database after the pause; they cannot log in`)
    }
    return { changed: holding.filter((login) => !left.includes(login)), left }
  }

  const [{ projectLoginNames }, credentials, schemas] = await Promise.all([
    import('@/lib/projects/logins'),
    prisma.databaseCredential.findMany({ where: { projectId }, select: { roleName: true } }),
    projectSchemasIn(databaseClient(region, database, projectId), projectId),
  ])
  const names = projectLoginNames(projectId, credentials.map((c) => c.roleName), schemas)
  if (names.length === 0) return { changed: [], left: [] }
  const canLogIn = (
    await instance.$queryRaw<Array<{ rolname: string }>>`
      SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY(${names}::text[]) AND rolcanlogin ORDER BY 1`
  ).map((r) => r.rolname)
  const missing = canLogIn.filter((login) => PROJECT_LOGIN.test(login) && !holding.includes(login))
  if (missing.length === 0) return { changed: [], left: [] }
  await asCreator(region, projectId, async (client) => {
    for (const login of missing) {
      await client.query(`GRANT CONNECT ON DATABASE ${quotedDatabase(database)} TO ${client.escapeIdentifier(login)}`)
    }
  })
  return { changed: missing, left: [] }
}

// ── The clone's grants ───────────────────────────────────────────────────────

/**
 * scripts/sql/project-database-acl.sql, byte for byte
 * (tests/unit/project-databases.spec.ts compares them). Carried here because
 * the web image carries no scripts/ directory; the file stays the source the
 * procedure's tests read.
 */
export const PROJECT_DATABASE_ACL_SQL = `-- ============================================================================
-- A project's own database, right after it is cloned: the grants on it
-- ============================================================================
-- CREATE DATABASE p_<hex> TEMPLATE backenly_project_template copies everything
-- the template holds, and none of the grants on the template database itself:
-- a clone starts with PostgreSQL's defaults, under which its creator owns it
-- and PUBLIC, every login on the instance, may connect to it and make
-- temporary tables there. This gives the clone the grants
-- tools/managed-db/regional/sql/project-db.sql gives the template, and must run
-- before the clone is used for anything.
--
-- ── Inputs ───────────────────────────────────────────────────────────────────
--   backenly.project_database   session setting: the new database's name,
--                               p_<32 lowercase hex>. Set it in the same
--                               session first, as a parameter, never spliced:
--                                 SELECT set_config('backenly.project_database', $1, false)
--   the session's role          the new database's owner, which is the role
--                               that ran CREATE DATABASE (on Backenly Cloud the
--                               region's backenly_dbcreator). Anyone else is
--                               refused: only the owner can take what PUBLIC
--                               holds on a database.
--   backenly_project_template   must exist. Its owner is the administrator that
--                               made it and converges every project database
--                               (tools/managed-db/regional/bootstrap.sh); that
--                               role is read from the catalog, never passed in.
--
-- Run it on any database of the instance, preferably the connection that ran
-- CREATE DATABASE, so the clone is closed before anything else can reach it.
-- Plain SQL with no psql commands, so a driver can send it as it is. Idempotent.
--
-- ── What it grants ───────────────────────────────────────────────────────────
--   PUBLIC                   nothing: no CONNECT, TEMPORARY or CREATE
--   backenly_app             CONNECT, TEMPORARY, CREATE (it creates the
--                            project's workspace schema)
--   backenly_backup          CONNECT
--   backenly_authenticator   CONNECT
--   the administrator        CONNECT, TEMPORARY, CREATE WITH GRANT OPTION: it
--                            converges the clone as the template's helpers
--                            change, and the helpers it owns give each login
--                            they create CONNECT on this database by name
--                            (scripts/setup-direct-access.sql section 2,
--                            scripts/sql/function-roles.sql), which a GRANT
--                            needs the grant option for when the grantor does
--                            not own the database.

DO $$
DECLARE
  db    text := current_setting('backenly.project_database', true);
  admin text := (SELECT pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = 'backenly_project_template');
  owner text;
  rname text;
BEGIN
  IF db IS NULL OR db !~ '^p_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'project-database-acl: set backenly.project_database to the new database''s name (p_<32 lowercase hex>) first, not %',
      coalesce(quote_literal(db), 'nothing');
  END IF;
  owner := (SELECT pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = db);
  IF owner IS NULL THEN
    RAISE EXCEPTION 'project-database-acl: database % does not exist', db;
  END IF;
  IF owner <> current_user THEN
    RAISE EXCEPTION 'project-database-acl: run this as %, the owner of %, not as %', owner, db, current_user;
  END IF;
  IF admin IS NULL THEN
    RAISE EXCEPTION 'project-database-acl: backenly_project_template does not exist, so % was not cloned from it', db;
  END IF;
  FOREACH rname IN ARRAY ARRAY['backenly_app', 'backenly_backup', 'backenly_authenticator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rname) THEN
      RAISE EXCEPTION 'project-database-acl: role % does not exist', rname;
    END IF;
  END LOOP;

  EXECUTE format('REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', db);
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO backenly_app', db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO backenly_backup, backenly_authenticator', db);
  IF admin <> owner THEN
    EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO %I WITH GRANT OPTION', db, admin);
  END IF;
END $$;
`
