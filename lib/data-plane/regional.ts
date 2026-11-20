/**
 * WHERE A PROJECT'S DATA LIVES
 * ============================
 * Backenly Cloud is one control plane and several data planes. Accounts,
 * billing, the dashboard and the platform database stay in the home region;
 * each project's `workspace_{projectId}` schema, runtime and storage live in
 * the region the project was created in (backenly-infra aws/REGIONS_SPEC.md).
 *
 * So every connection to a project's data has to be opened in that project's
 * region. This module is the one place that knows how:
 *
 *   projectRegion(id)                the region recorded on the project
 *   projectDatabase(id)              the region, and which database in it
 *   regionDatabaseUrl(region, role)  that region's connection string for a role
 *   projectDatabaseUrl(id, role)     the project's database's connection string
 *   workspaceRawClient(id)           raw SQL on the project's database
 *   projectPool(id, name)            a pg pool on the project's database
 *   projectPostgrest(id)             the PostgREST serving the project's region
 *   projectApiOrigin(id, home)       the address the project's API is called at
 *   projectDriftEvents(id)           the schema drift events, kept where captured
 *
 * The home region keeps the variables it always had: DATABASE_URL, DIRECT_URL,
 * BACKUP_DATABASE_URL, BACKENLY_ADMIN_DATABASE_URL, POSTGREST_URL and
 * POSTGREST_JWT_SECRET. Every other region uses the same names with the region
 * appended, e.g. DATABASE_URL_US_EAST_1.
 *
 * A DATABASE OF A PROJECT'S OWN. A project's row records its tenancy
 * (Project.databaseTenancy). 'shared', the default and every project's until
 * now, keeps its workspace schema in its region's own database, reached as
 * above. 'dedicated' gives the project a database of its own, named on its row
 * (p_ followed by 32 lowercase hex digits), on the region's data instance:
 * DATA_DATABASE_URL (and DATA_DIRECT_URL, DATA_BACKUP_DATABASE_URL), with the
 * region appended outside the home region, its database replaced by the
 * project's. Outside the home region an unset data variable means the region's
 * own connection: its instance is the data instance. In the home region the
 * region's own connection is the platform database, which never holds a
 * project's own database, so there the data variable is required and a
 * dedicated project is refused without it. Work about a region rather than a
 * project (regionRawClient, regionPool) stays on the region's own database.
 *
 * NO FALLBACK BETWEEN REGIONS. A project in a region this process has no
 * connection for gets RegionNotConfiguredError, never the home database. Its
 * schema is not there, and Postgres does not object to a missing schema on the
 * search_path (workspace-pool.ts), so a query sent to the wrong database does
 * not necessarily fail: it can answer from the platform's own tables, or find
 * nothing and report a healthy empty result for data it never saw.
 *
 * Callers move onto this in phases, each merged with the home region behaving
 * exactly as before:
 *   1. this module, Project.region and the per-project pool (workspace-pool.ts)
 *   2. services, execution and recovery
 *   3. the v1 runtime API, PostgREST, end-user auth and realtime
 *   4. MCP, the AI build runtime, type generation, the SQL console, import and
 *      branches
 *   5. autonomy, backups and exports, and usage, per region. A fail-soft
 *      probe that swallows RegionNotConfiguredError would report a project it
 *      never reached as healthy, so autonomy skips such a project and says so
 *   6. creating a project in its region (the Cloud lifecycle), the regional API
 *      URL, and then opening the region in lib/regions.ts
 * Nothing writes Project.region before phase 6, so until then every project
 * resolves to the home region and every connection is the one it always was.
 */

import { PrismaClient } from '@prisma/client'
import { Pool, type PoolConfig } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { installSqlRecorder } from '@/lib/execution/sql-recorder'
import { HOME_REGION, findRegion, type CloudRegionId } from '@/lib/regions'
import { DatabaseBusyError, DatabaseRegistry, type UseTracker } from './database-registry'
import { DriftEventStore } from './drift-events'
import { EpochBehindError, EpochCache } from './epoch-cache'
import { withoutStatementCache } from './statement-cache'

export { DatabaseBusyError } from './database-registry'
export { DriftEventStore, type DriftEvent, type PendingGroup } from './drift-events'

/**
 * Which credential a caller needs. Each region has its own of every kind, for
 * the same reasons the home region does:
 *   app     the application role, subject to row-level security
 *   direct  a connection that bypasses any pooler, for LISTEN and migrations
 *   backup  the role pg_dump reads with
 *   admin   the owner connection a restore drops and re-creates schemas with
 */
export type DataPlaneRole = 'app' | 'direct' | 'backup' | 'admin'

const HOME_VARIABLES: Record<DataPlaneRole, string> = {
  app: 'DATABASE_URL',
  direct: 'DIRECT_URL',
  backup: 'BACKUP_DATABASE_URL',
  admin: 'BACKENLY_ADMIN_DATABASE_URL',
}

/** A plain record rather than NodeJS.ProcessEnv, so a test can pass one in. */
type Env = Readonly<Record<string, string | undefined>>

/** The home region's variable name as is; any other region's with the region appended. */
function regionalVariable(name: string, region: CloudRegionId): string {
  if (region === HOME_REGION) return name
  return `${name}_${region.toUpperCase().replace(/-/g, '_')}`
}

/** "DATABASE_URL" in the home region, "DATABASE_URL_US_EAST_1" in us-east-1. */
export function regionEnvName(region: CloudRegionId, role: DataPlaneRole = 'app'): string {
  return regionalVariable(HOME_VARIABLES[role], region)
}

/**
 * Any other per-region setting, named the same way: `name` in the home region,
 * `name_<REGION>` elsewhere (DIRECT_DB_HOST_US_EAST_1). `value` is undefined
 * when unset or blank, and is never the home value for another region.
 */
export function regionSetting(
  name: string,
  region: CloudRegionId,
  env: Env = process.env,
): { variable: string; value: string | undefined } {
  const variable = regionalVariable(name, region)
  const value = env[variable]
  return { variable, value: value && value.trim() ? value : undefined }
}

/**
 * The region's connection string for `role`, or undefined when this process
 * has none. Only ever the region's own variable: an unset regional variable
 * stays unset rather than borrowing the home one.
 */
export function regionDatabaseUrl(region: CloudRegionId, role: DataPlaneRole = 'app', env: Env = process.env): string | undefined {
  const value = env[regionEnvName(region, role)]
  return value && value.trim() ? value : undefined
}

/** This process has no connection to the region a project's data is in. */
export class RegionNotConfiguredError extends Error {
  readonly code = 'REGION_NOT_CONFIGURED'

  constructor(
    readonly region: CloudRegionId,
    readonly variable: string,
    readonly projectId?: string,
    message?: string,
  ) {
    super(
      message ??
        (region === HOME_REGION
          ? `${variable} is not set`
          : `No database connection for ${projectId ? `project ${projectId}, which is in ${region}` : region}: ` +
            `${variable} is not set. The data is only in that region's database, so nothing was sent to another one.`),
    )
    this.name = 'RegionNotConfiguredError'
  }
}

/** A project row names a region this build does not know. */
export class UnknownRegionError extends Error {
  readonly code = 'UNKNOWN_REGION'

  constructor(
    readonly projectId: string,
    readonly recorded: string,
  ) {
    super(
      `Project ${projectId} records region "${recorded}", which this build does not know. ` +
        `Its data was not looked for anywhere else.`,
    )
    this.name = 'UnknownRegionError'
  }
}

/**
 * A project row records a database this build cannot use: a tenancy it does
 * not know, a database of its own with no valid name, or a data instance it
 * has no connection variables for. Refused rather than read as the shared
 * database, which does not hold that project's data.
 */
export class UnknownProjectDatabaseError extends Error {
  readonly code = 'UNKNOWN_PROJECT_DATABASE'

  constructor(
    readonly projectId: string,
    detail: string,
  ) {
    super(`Project ${projectId} ${detail} Its data was not looked for anywhere else.`)
    this.name = 'UnknownProjectDatabaseError'
  }
}

/**
 * Whether an error means the project's data could not be reached at all.
 * A catch that turns failures into an answer ("not revoked", "invalid token",
 * "logged out") rethrows or reports these instead: the data was never read.
 * That includes a project database this server has no room to open right now
 * (DatabaseBusyError), and a project database it has no valid connection
 * string for (ProjectDatabaseNameError): its data was not read either.
 */
export function isRegionError(
  err: unknown,
): err is RegionNotConfiguredError | UnknownRegionError | UnknownProjectDatabaseError | DatabaseBusyError | ProjectDatabaseNameError {
  return (
    err instanceof RegionNotConfiguredError ||
    err instanceof UnknownRegionError ||
    err instanceof UnknownProjectDatabaseError ||
    err instanceof DatabaseBusyError ||
    err instanceof ProjectDatabaseNameError
  )
}

/**
 * A catch handler for a fail-soft read: `fallback` for any failure except a
 * region error, which is rethrown unchanged. "This process cannot reach the
 * project's region" is not the empty or unknown answer a fallback stands for.
 */
export function unlessRegionError<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (isRegionError(err)) throw err
    return fallback
  }
}

/** regionDatabaseUrl, or RegionNotConfiguredError naming the missing variable. */
export function requireRegionDatabaseUrl(
  region: CloudRegionId,
  role: DataPlaneRole = 'app',
  { env = process.env, projectId }: { env?: Env; projectId?: string } = {},
): string {
  const url = regionDatabaseUrl(region, role, env)
  if (!url) throw new RegionNotConfiguredError(region, regionEnvName(region, role), projectId)
  return url
}

/**
 * The variable naming a region's data instance for `role`: DATA_ before the
 * role's own variable, with the region appended outside the home region.
 * "DATA_DATABASE_URL" at home, "DATA_DIRECT_URL_US_EAST_1" in us-east-1.
 */
export function dataInstanceEnvName(region: CloudRegionId, role: DataPlaneRole = 'app'): string {
  return regionalVariable(`DATA_${HOME_VARIABLES[role]}`, region)
}

/**
 * The connection string for `role` on the instance that holds a region's
 * project databases, or undefined when this process has none. Its database
 * part names whatever database the operator gave; a project's own replaces it
 * (withDatabase).
 *
 * Outside the home region an unset data variable is the region's own
 * connection for the role: that region's instance is its data instance. In
 * the home region it is not: the region's own connection is the platform
 * database, so only DATA_* answers. Never another region's, and never the
 * home region's for another region.
 */
export function regionDataInstanceUrl(
  region: CloudRegionId,
  role: DataPlaneRole = 'app',
  env: Env = process.env,
): string | undefined {
  const own = env[dataInstanceEnvName(region, role)]
  if (own && own.trim()) return own
  if (region === HOME_REGION) return undefined
  return regionDatabaseUrl(region, role, env)
}

/** regionDataInstanceUrl, or RegionNotConfiguredError naming the variable that would answer. */
export function requireRegionDataInstanceUrl(
  region: CloudRegionId,
  role: DataPlaneRole = 'app',
  { env = process.env, projectId }: { env?: Env; projectId?: string } = {},
): string {
  const url = regionDataInstanceUrl(region, role, env)
  if (url) return url
  const variable = dataInstanceVariable(region, role)
  const subject = projectId ? `project ${projectId}, which has a database of its own in ${region}` : `databases of their own in ${region}`
  const message =
    region === HOME_REGION
      ? `No database connection for ${subject}: ${variable} is not set. Such a database is never opened on the platform database, so nothing was sent to it.`
      : `No database connection for ${subject}: neither ${dataInstanceEnvName(region, role)} nor ${variable} is set. ` +
        `The data is only in that region, so nothing was sent to another one.`
  throw new RegionNotConfiguredError(region, variable, projectId, message)
}

/**
 * The variable to set when a region's data instance has no connection for
 * `role`: DATA_* at home, where nothing stands in for it, and the region's own
 * variable elsewhere, which serves as the data instance unless a DATA_* one is set.
 */
function dataInstanceVariable(region: CloudRegionId, role: DataPlaneRole): string {
  return region === HOME_REGION ? dataInstanceEnvName(region, role) : regionEnvName(region, role)
}

/** A project's own database: p_ followed by 32 lowercase hex digits. */
const PROJECT_DATABASE_NAME = /^p_[0-9a-f]{32}$/

export function isProjectDatabaseName(name: unknown): name is string {
  return typeof name === 'string' && PROJECT_DATABASE_NAME.test(name)
}

/** A name, a URL or a parameter withDatabase will not build a connection string from. */
export class ProjectDatabaseNameError extends Error {
  readonly code = 'INVALID_PROJECT_DATABASE'

  constructor(message: string) {
    super(message)
    this.name = 'ProjectDatabaseNameError'
  }
}

/**
 * `url` with its database replaced by `name`, a project's own database. Pure.
 *
 * Refuses a name that is not p_ followed by 32 lowercase hex digits, so a
 * value from anywhere else (the platform database, another region's control
 * database, a name with quoting or a path in it) is never connected to. Also
 * refuses a string that is not a PostgreSQL URL with a host, and one that names
 * its database in a parameter, which libpq clients read over the path. Errors
 * never quote the URL: it carries a password.
 */
export function withDatabase(url: string, name: string): string {
  if (!isProjectDatabaseName(name)) {
    throw new ProjectDatabaseNameError(
      `${JSON.stringify(String(name).slice(0, 80))} is not the name of a project's own database (p_ followed by 32 lowercase hex digits).`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ProjectDatabaseNameError('The data instance connection string is not a URL.')
  }
  if ((parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') || !parsed.hostname) {
    throw new ProjectDatabaseNameError('The data instance connection string is not a postgresql:// URL with a host.')
  }
  if (parsed.searchParams.has('dbname') || parsed.searchParams.has('database')) {
    throw new ProjectDatabaseNameError("The data instance connection string names its database in a parameter, which would win over the project's.")
  }
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/**
 * The region a project row records. Null is the home region. Anything else
 * must be a region this build knows: an unknown value is refused rather than
 * read as home, because that row is exactly the project whose data must not
 * be looked for in the wrong place.
 *
 * A known region that is not open yet still resolves. `open` decides where a
 * new project may be created, not whether an existing one can be reached.
 */
export function regionOfRecord(projectId: string, recorded: string | null): CloudRegionId {
  if (recorded === null) return HOME_REGION
  const region = findRegion(recorded)
  if (!region) throw new UnknownRegionError(projectId, recorded)
  return region.id
}

/** Whether a project's data is in its region's own database or in a database of its own. */
export type DatabaseTenancy = 'shared' | 'dedicated'

/** The data instance a project's own database is on when its row names none. */
export const PRIMARY_DATA_INSTANCE = 'primary'

/** Where a project's data is: its region, and which database there. */
export interface ProjectDatabase {
  region: CloudRegionId
  tenancy: DatabaseTenancy
  /** The project's own database (p_ and 32 lowercase hex digits); null when shared. */
  database: string | null
  /** The data instance holding that database; null when shared. */
  instance: string | null
  /** Project.tenancyEpoch: moves each time the project's data moves to another database. */
  epoch: number
}

/** What a project row records about where its data is (the columns projectDatabase reads). */
export interface ProjectPlacementRow {
  region: string | null
  /** Absent or null reads as 'shared', the column's default. */
  databaseTenancy?: string | null
  databaseName?: string | null
  databaseInstance?: string | null
  tenancyEpoch?: number | null
}

/** The columns read, in one platform query, wherever a project's database is resolved. */
const PLACEMENT_COLUMNS = {
  region: true,
  databaseTenancy: true,
  databaseName: true,
  databaseInstance: true,
  tenancyEpoch: true,
} as const

function epochOfRecord(row: ProjectPlacementRow): number {
  return typeof row.tenancyEpoch === 'number' && Number.isFinite(row.tenancyEpoch) ? row.tenancyEpoch : 0
}

/** Where a project with no row is: the home region's shared database, as projectRegion has always said. */
function homeShared(): ProjectDatabase {
  return { region: HOME_REGION, tenancy: 'shared', database: null, instance: null, epoch: 0 }
}

/**
 * Where a project row says its data is, in a region already read from it.
 * Pure. A tenancy this build does not know, a database of its own without a
 * valid name, or a data instance other than the primary one is refused with
 * UnknownProjectDatabaseError, never read as the shared database.
 */
export function databaseOfRecord(projectId: string, region: CloudRegionId, row: ProjectPlacementRow): ProjectDatabase {
  const epoch = epochOfRecord(row)
  const tenancy = row.databaseTenancy ?? 'shared'
  if (tenancy === 'shared') return { region, tenancy, database: null, instance: null, epoch }
  if (tenancy !== 'dedicated') {
    throw new UnknownProjectDatabaseError(projectId, `records database tenancy ${JSON.stringify(String(tenancy).slice(0, 40))}, which this build does not know.`)
  }
  if (!isProjectDatabaseName(row.databaseName)) {
    throw new UnknownProjectDatabaseError(
      projectId,
      row.databaseName
        ? 'records a database of its own whose name is not one Backenly gives (p_ followed by 32 lowercase hex digits).'
        : 'records a database of its own but names none.',
    )
  }
  const instance = row.databaseInstance ?? PRIMARY_DATA_INSTANCE
  if (instance !== PRIMARY_DATA_INSTANCE) {
    // No variables name any instance but a region's primary one yet; another
    // instance's database is never looked for on the primary.
    throw new UnknownProjectDatabaseError(
      projectId,
      `records data instance ${JSON.stringify(String(instance).slice(0, 40))}, which this build has no connection settings for.`,
    )
  }
  return { region, tenancy, database: row.databaseName, instance, epoch }
}

/** A project's region, checked, with the row it was read from and that row's epoch. */
interface Placement {
  region: CloudRegionId
  row: ProjectPlacementRow
  epoch: number
}

// A project's region is recorded once, at creation, and never changes, so it
// is cached for the life of the process, and its database with it. The
// database changes only when the project's data is moved, which moves its
// epoch: an epoch this process learns of (noteTenancyEpoch, or projectDatabase
// with `epoch`) drops an older answer, and no older one is cached or returned
// again (epoch-cache.ts). Bounded, oldest entry out first.
const PLACEMENT_CACHE_MAX = 10_000
const placements = new EpochCache<Placement>(PLACEMENT_CACHE_MAX)

async function placementOf(projectId: string, atLeastEpoch?: number): Promise<Placement | null> {
  try {
    return await placements.get(
      projectId,
      async () => {
        const row = await prisma.project.findUnique({ where: { id: projectId }, select: PLACEMENT_COLUMNS })
        if (!row) return null
        return { region: regionOfRecord(projectId, row.region), row, epoch: epochOfRecord(row) }
      },
      atLeastEpoch,
    )
  } catch (err) {
    if (err instanceof EpochBehindError) {
      throw new UnknownProjectDatabaseError(
        projectId,
        `records tenancy epoch ${err.read}, older than epoch ${err.expected} this server was told its data had moved to.`,
      )
    }
    throw err
  }
}

/**
 * The region holding a project's data, read from the platform database.
 *
 * A project with no row resolves to the home region and is not cached: it is
 * still being provisioned or is already gone, either way it records no region,
 * and a row that appears later is honoured. Provisioning in another region
 * therefore names the region itself rather than asking here (phase 6).
 *
 * A failed lookup throws. Treating an error as "home" would send a regional
 * project's queries to a database that does not hold its schema.
 */
export async function projectRegion(projectId: string): Promise<CloudRegionId> {
  const placement = await placementOf(projectId)
  return placement ? placement.region : HOME_REGION
}

/**
 * Where a project's data is: its region and which database there, read with
 * the region in one platform query and cached with it (projectRegion).
 *
 * `epoch`, when the caller has read the project's tenancyEpoch, is noted
 * first: the answer is then never of an older epoch, read again from the row
 * if the cached one is. A project with no row is the home region's shared
 * database and is not cached.
 */
export async function projectDatabase(projectId: string, { epoch }: { epoch?: number } = {}): Promise<ProjectDatabase> {
  const placement = await placementOf(projectId, epoch)
  if (!placement) return homeShared()
  return databaseOfRecord(projectId, placement.region, placement.row)
}

/**
 * This process has learned that a project's data is at `epoch` or later (a
 * read that carries Project.tenancyEpoch). A cached answer of an older epoch is
 * dropped, and none is returned again.
 */
export function noteTenancyEpoch(projectId: string, epoch: number): void {
  placements.note(projectId, epoch)
}

/** Drop what this process cached about where a project's data is. */
export function forgetProjectDatabase(projectId: string): void {
  placements.forget(projectId)
}

/**
 * The connection string for `role` on the database holding this project's
 * data: its region's own for a shared project, and for a project with a
 * database of its own, the region's data instance with that database.
 */
export async function projectDatabaseUrl(projectId: string, role: DataPlaneRole = 'app'): Promise<string> {
  const placement = await projectDatabase(projectId)
  if (placement.tenancy === 'dedicated') {
    return withDatabase(requireRegionDataInstanceUrl(placement.region, role, { projectId }), placement.database as string)
  }
  return requireRegionDatabaseUrl(placement.region, role, { projectId })
}

/**
 * Whether this process can reach the database holding a project's data,
 * checked from configuration only: nothing is connected to. Returns where the
 * data is; throws RegionNotConfiguredError naming the variable that is not set,
 * or the error of a row this build cannot use.
 */
export async function assertProjectReachable(projectId: string, env: Env = process.env): Promise<ProjectDatabase> {
  const placement = await projectDatabase(projectId)
  if (placement.tenancy === 'dedicated') requireRegionDataInstanceUrl(placement.region, 'app', { env, projectId })
  else requireRegionDatabaseUrl(placement.region, 'app', { env, projectId })
  return placement
}

/**
 * The origin a project's API is served from: what the console, SDK snippets,
 * generated clients, the connect manifest and agents hand out as
 * `{origin}/api/v1/{projectId}`.
 *
 * The home region answers with `homeOrigin`, the deployment's public origin, as
 * every project always has. Another region answers with its own
 * PUBLIC_API_ORIGIN_<REGION>, the API service running in that region. In
 * Backenly Cloud production that is https://<region>.api.backenly.com
 * (founders, 2026-10-16); staging sets its own.
 *
 * Never the home origin for another region. The home service would still
 * answer, by crossing to the region and back on every request, so nothing would
 * fail; but an address handed out is pasted into customers' apps and kept, and
 * a wrong one cannot be taken back later.
 */
export function regionApiOrigin(
  region: CloudRegionId,
  homeOrigin: string,
  { env = process.env, projectId }: { env?: Env; projectId?: string } = {},
): string {
  if (region === HOME_REGION) return homeOrigin
  const { variable, value } = regionSetting('PUBLIC_API_ORIGIN', region, env)
  const subject = projectId ? `project ${projectId}, which is in ${region}` : region
  if (!value) {
    throw new RegionNotConfiguredError(
      region,
      variable,
      projectId,
      `No API address for ${subject}: ${variable} is not set. The home address was not given out instead.`,
    )
  }
  let url: URL | null = null
  try {
    url = new URL(value)
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new RegionNotConfiguredError(region, variable, projectId, `${variable} is not an http(s) URL, so ${subject} has no API address.`)
  }
  return url.origin
}

/** regionApiOrigin for the region recorded on the project. */
export async function projectApiOrigin(projectId: string, homeOrigin: string): Promise<string> {
  return regionApiOrigin(await projectRegion(projectId), homeOrigin, { projectId })
}

/** A project this process cannot reach, and why. */
export interface UnreachableProject {
  projectId: string
  /** The region its row records (an unknown one is reported as recorded). */
  region: string
  code: 'REGION_NOT_CONFIGURED' | 'UNKNOWN_REGION' | 'UNKNOWN_PROJECT_DATABASE'
  /** The variable that would connect this process to the region, when one would. */
  variable?: string
}

/**
 * Split projects by whether this process has a connection to the database
 * their data is in, with one platform query for the lot. Background passes use
 * it to skip what they cannot reach and say so, instead of reaching each
 * project in turn and reading the failure as an empty or healthy project.
 *
 * Only configuration is checked; nothing is connected to. A project with no
 * row resolves to the home region's shared database, as projectDatabase does.
 * The rows are read fresh, so each one's epoch is noted (noteTenancyEpoch).
 */
export async function partitionReachable<T extends { id: string }>(
  projects: T[],
  env: Env = process.env,
): Promise<{ reachable: T[]; unreachable: UnreachableProject[] }> {
  if (projects.length === 0) return { reachable: [], unreachable: [] }
  const rows = await prisma.project.findMany({
    where: { id: { in: [...new Set(projects.map((p) => p.id))] } },
    select: { id: true, ...PLACEMENT_COLUMNS },
  })
  const recorded = new Map<string, ProjectPlacementRow>(rows.map((row) => [row.id, row]))
  for (const row of rows) noteTenancyEpoch(row.id, epochOfRecord(row))

  const reachable: T[] = []
  const unreachable: UnreachableProject[] = []
  for (const project of projects) {
    const row = recorded.get(project.id)
    const region = findRegion(row?.region ?? HOME_REGION)
    if (!region) {
      unreachable.push({ projectId: project.id, region: String(row?.region), code: 'UNKNOWN_REGION' })
      continue
    }
    let placement: ProjectDatabase
    try {
      placement = row ? databaseOfRecord(project.id, region.id, row) : homeShared()
    } catch (err) {
      if (!(err instanceof UnknownProjectDatabaseError)) throw err
      unreachable.push({ projectId: project.id, region: region.id, code: 'UNKNOWN_PROJECT_DATABASE' })
      continue
    }
    if (placement.tenancy === 'dedicated' ? !regionDataInstanceUrl(region.id, 'app', env) : !regionDatabaseUrl(region.id, 'app', env)) {
      unreachable.push({
        projectId: project.id,
        region: region.id,
        code: 'REGION_NOT_CONFIGURED',
        variable: placement.tenancy === 'dedicated' ? dataInstanceVariable(region.id, 'app') : regionEnvName(region.id),
      })
    } else {
      reachable.push(project)
    }
  }
  return { reachable, unreachable }
}

/**
 * Raw SQL against a project's database. Narrowed to the raw methods because a
 * regional database holds workspace schemas only: the platform tables a model
 * accessor would reach are not there. (The one exception, the drift events,
 * has its own store: projectDriftEvents.)
 */
export type WorkspaceRawClient = Pick<
  PrismaClient,
  '$queryRaw' | '$queryRawUnsafe' | '$executeRaw' | '$executeRawUnsafe' | '$transaction'
>

/**
 * Each region's workspace client, the home region's included, and the clients
 * of projects' own databases. Kept on globalThis, as the shared client is
 * (lib/db/postgres.ts), so a development server that reloads this module does
 * not open another pool each time.
 */
const globalForWorkspace = globalThis as unknown as {
  backenlyWorkspaceClients?: Map<CloudRegionId, PrismaClient>
  backenlyDatabaseClients?: DatabaseRegistry<PrismaClient>
}
const workspaceClients = (globalForWorkspace.backenlyWorkspaceClients ??= new Map<CloudRegionId, PrismaClient>())

/**
 * The home workspace client's pool size when DATABASE_URL names none. That
 * client shares the home database with the platform client, so its pool is a
 * small fixed number rather than Prisma's default, which grows with the host's
 * cores. A connection_limit in DATABASE_URL is the operator's size for a pool
 * and is kept.
 */
const HOME_WORKSPACE_CONNECTION_LIMIT = 5

/**
 * The connection string a region's workspace client opens: the region's own,
 * with Prisma's statement cache off (statement-cache.ts). In the home region
 * the pool is also bounded, because the platform client's pool is on the same
 * database.
 */
export function workspaceClientUrl(region: CloudRegionId, url: string): string {
  const parsed = new URL(withoutStatementCache(url))
  if (region === HOME_REGION && !parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', String(HOME_WORKSPACE_CONNECTION_LIMIT))
  }
  return parsed.toString()
}

/**
 * Raw SQL against a region's database, on that region's workspace client: one
 * per region, the home region's included, created on first use. The region's
 * connection is checked on every call, so an unconfigured region is refused
 * even after a client exists.
 *
 * In the home region this is not the shared platform client, although it
 * connects with the same DATABASE_URL. Workspace SQL needs Prisma's statement
 * cache off, because the tables it reads change shape (statement-cache.ts);
 * the platform's own queries keep the cache.
 *
 * For work about a region rather than one project, such as reading its
 * PostgREST registry. A project's own queries go through workspaceRawClient.
 */
export function regionRawClient(region: CloudRegionId, projectId?: string): WorkspaceRawClient {
  return regionClient(region, projectId)
}

/** The full client for a region's database. Private: see WorkspaceRawClient. */
function regionClient(region: CloudRegionId, projectId?: string): PrismaClient {
  const url = requireRegionDatabaseUrl(region, 'app', { projectId })
  const existing = workspaceClients.get(region)
  if (existing) return existing

  const client = new PrismaClient({ datasourceUrl: workspaceClientUrl(region, url), log: ['error'] })
  workspaceClients.set(region, client)
  return client
}

/**
 * A project database client's pool size. One process keeps at most
 * PROJECT_DATABASE_CLIENTS_MAX of them open (16 unless set), so its connections
 * to project databases stay bounded however many projects it serves.
 */
const PROJECT_DATABASE_CONNECTION_LIMIT = 2
const PROJECT_DATABASE_CLIENTS_MAX = 16
/** A client used more recently than this is not closed to make room. */
const PROJECT_DATABASE_CLIENT_MIN_IDLE_MS = 1_000

function capFromEnv(variable: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[variable] ?? '', 10)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback
}

const databaseClients = (globalForWorkspace.backenlyDatabaseClients ??= new DatabaseRegistry<PrismaClient>({
  max: capFromEnv('PROJECT_DATABASE_CLIENTS_MAX', PROJECT_DATABASE_CLIENTS_MAX),
  minIdleMs: PROJECT_DATABASE_CLIENT_MIN_IDLE_MS,
  close: (client) => client.$disconnect(),
  what: 'project database clients',
}))

/**
 * The connection string a project database client opens: the data instance's,
 * on the project's own database, with Prisma's statement cache off
 * (statement-cache.ts) and a pool of PROJECT_DATABASE_CONNECTION_LIMIT.
 */
export function databaseClientUrl(dataInstanceUrl: string, database: string): string {
  const parsed = new URL(withoutStatementCache(withDatabase(dataInstanceUrl, database)))
  parsed.searchParams.set('connection_limit', String(PROJECT_DATABASE_CONNECTION_LIMIT))
  return parsed.toString()
}

const clientKey = (region: CloudRegionId, database: string) => `${region}/${database}`

/** A new client for a project's own database, its recorder and use count installed before anything is sent. */
function newDatabaseClient(dataInstanceUrl: string, database: string, tracker: UseTracker): PrismaClient {
  const client = new PrismaClient({ datasourceUrl: databaseClientUrl(dataInstanceUrl, database), log: ['error'] })
  installSqlRecorder(client as any)
  // Counts each statement while it runs, so the registry never closes the
  // client under it.
  client.$use(async (params, next) => {
    const done = tracker.start()
    try {
      return await next(params)
    } finally {
      done()
    }
  })
  return client
}

/** The open client for a project database, checked against configuration on every use. */
function liveDatabaseClient(region: CloudRegionId, database: string, projectId?: string): PrismaClient {
  const url = requireRegionDataInstanceUrl(region, 'app', { projectId })
  return databaseClients.get(clientKey(region, database), (tracker) => newDatabaseClient(url, database, tracker))
}

function refuseBadName(database: string): void {
  if (!isProjectDatabaseName(database)) {
    throw new ProjectDatabaseNameError(
      `${JSON.stringify(String(database).slice(0, 80))} is not the name of a project's own database (p_ followed by 32 lowercase hex digits).`,
    )
  }
}

/**
 * Raw SQL against a project's own database, on the region's data instance.
 *
 * The client behind it is one of a bounded set per process
 * (database-registry.ts): opened on first use with a pool of
 * PROJECT_DATABASE_CONNECTION_LIMIT and the SQL recorder installed, and
 * closed to make room only while idle, never while pinned or while a query or
 * transaction runs on it. What is returned resolves that client on every call,
 * so holding it across a close is safe: the next call opens the client again.
 * A batch transaction's statements and the transaction resolve the same client,
 * in the same tick.
 *
 * Refused at once when this process has no connection for the data instance,
 * and on every call after that if the connection goes away.
 */
export function databaseClient(region: CloudRegionId, database: string, projectId?: string): WorkspaceRawClient {
  refuseBadName(database)
  requireRegionDataInstanceUrl(region, 'app', { projectId })
  const key = clientKey(region, database)
  const live = () => liveDatabaseClient(region, database, projectId) as any
  const handle = {
    $queryRaw: (...args: any[]) => live().$queryRaw(...args),
    $queryRawUnsafe: (...args: any[]) => live().$queryRawUnsafe(...args),
    $executeRaw: (...args: any[]) => live().$executeRaw(...args),
    $executeRawUnsafe: (...args: any[]) => live().$executeRawUnsafe(...args),
    $transaction: (arg: any, options?: any) => {
      const client = live()
      // The whole transaction counts as one use, between its statements too.
      const done = databaseClients.track(key)
      try {
        return Promise.resolve(client.$transaction(arg, options)).finally(done)
      } catch (err) {
        done()
        throw err
      }
    },
  }
  return handle as unknown as WorkspaceRawClient
}

/**
 * Keep a project database's client open until the returned release is called:
 * a governed change pins its project's for its whole run (lib/changes/ledger.ts),
 * so it is one client from the first statement to the last. Calling the
 * release more than once is harmless.
 */
export function pinDatabaseClient(region: CloudRegionId, database: string, projectId?: string): () => void {
  refuseBadName(database)
  const url = requireRegionDataInstanceUrl(region, 'app', { projectId })
  return databaseClients.pin(clientKey(region, database), (tracker) => newDatabaseClient(url, database, tracker))
}

/**
 * pinDatabaseClient for the database holding a project's data. A shared
 * project's is its region's client, which is never closed to make room: it is
 * opened here (and an unreachable region refused, as workspaceRawClient would)
 * and nothing more is held.
 */
export async function pinWorkspaceClient(projectId: string): Promise<() => void> {
  const placement = await projectDatabase(projectId)
  if (placement.tenancy === 'dedicated') return pinDatabaseClient(placement.region, placement.database as string, projectId)
  regionClient(placement.region, projectId)
  return () => {}
}

/**
 * Raw SQL against the database holding a project's data: its region's own for
 * a shared project, exactly as before, or its own (databaseClient).
 */
export async function workspaceRawClient(projectId: string): Promise<WorkspaceRawClient> {
  const placement = await projectDatabase(projectId)
  if (placement.tenancy === 'dedicated') return databaseClient(placement.region, placement.database as string, projectId)
  return regionRawClient(placement.region, projectId)
}

/**
 * The schema drift events of a region, and of a project.
 *
 * The DDL-capture event triggers (scripts/setup-direct-access.sql) record each
 * statement a direct-access role runs into public.schema_drift_events of the
 * database that ran it: for a project outside the home region that region's
 * (founders, 2026-10-16: the events stay there), and for a project with a
 * database of its own, that database. Those tables are created by
 * scripts/sql/schema-drift-events.sql, kept identical to the Prisma model. In
 * the home region's shared database the table is the platform's own and is
 * read on the shared platform client, as it always was. Every one is read and
 * changed through DriftEventStore (drift-events.ts), the same raw SQL wherever
 * it is.
 */
export function regionDriftEvents(region: CloudRegionId): DriftEventStore {
  return new DriftEventStore(region === HOME_REGION ? prisma : regionClient(region))
}

export async function projectDriftEvents(projectId: string): Promise<DriftEventStore> {
  const placement = await projectDatabase(projectId)
  if (placement.tenancy === 'dedicated') {
    return new DriftEventStore(databaseClient(placement.region, placement.database as string, projectId))
  }
  return new DriftEventStore(placement.region === HOME_REGION ? prisma : regionClient(placement.region, projectId))
}

/** The PostgREST serving a region's projects, and the secret its tokens are signed with. */
export interface RegionPostgrest {
  url: string
  jwtSecret: string
}

/**
 * A region's PostgREST, or null when this process has none for it.
 *
 * The home region keeps POSTGREST_URL and POSTGREST_JWT_SECRET; every other
 * region uses the same names with the region appended (POSTGREST_URL_US_EAST_1).
 * Both must be set. Never the home pair for another region: that PostgREST
 * serves the home database, where a regional project's schema does not exist.
 */
export function regionPostgrest(region: CloudRegionId, env: Env = process.env): RegionPostgrest | null {
  const url = env[regionalVariable('POSTGREST_URL', region)]
  const jwtSecret = env[regionalVariable('POSTGREST_JWT_SECRET', region)]
  if (!url || !url.trim() || !jwtSecret || !jwtSecret.trim()) return null
  return { url, jwtSecret }
}

/** The PostgREST serving this project's region, or null when this process has none for it. */
export async function projectPostgrest(projectId: string): Promise<RegionPostgrest | null> {
  return regionPostgrest(await projectRegion(projectId))
}

/**
 * Close every workspace client, the home region's included, every project
 * database client, and every regional and project database pool. The shared
 * platform client is not one of them and stays open.
 */
export async function disconnectRegionalClients(): Promise<void> {
  const clients = [...workspaceClients.values()]
  workspaceClients.clear()
  const pools = [...regionPools.values()]
  regionPools.clear()
  const retired = [...retiredPools]
  retiredPools.clear()
  await Promise.all([
    ...clients.map((client) => client.$disconnect().catch(() => {})),
    ...pools.map((pool) => pool.end().catch(() => {})),
    ...retired.map((pool) => pool.end().catch(() => {})),
    databaseClients.closeAll(),
    databasePools.closeAll((pool) => pool.end()),
  ])
}

const regionPools = new Map<string, Pool>()

/**
 * A node-postgres pool on a region's database, one per subsystem (`name`), for
 * code that needs pg itself: a transaction on one connection, or a module that
 * has always held its own pool (branches, type generation, import). The home
 * region connects with DATABASE_URL, as those modules did. The region's
 * connection is checked on every call, so an unconfigured region is refused
 * even after a pool exists.
 */
export function regionPool(
  region: CloudRegionId,
  name: string,
  config: Omit<PoolConfig, 'connectionString'> = {},
  projectId?: string,
): Pool {
  const url = requireRegionDatabaseUrl(region, 'app', { projectId })
  const key = `${region}:${name}`
  const existing = regionPools.get(key)
  if (existing) return existing

  const pool = new Pool({ ...config, connectionString: url })
  // An idle client's error is emitted on the pool; unhandled, it ends the process.
  pool.on('error', (err) => console.error(`[regional] ${name} pool in ${region}:`, err.message))
  regionPools.set(key, pool)
  return pool
}

/**
 * Pools on projects' own databases: one per database and subsystem, at most
 * PROJECT_DATABASE_POOL_MAX connections each whatever the subsystem asks for,
 * idle connections closed after PROJECT_DATABASE_POOL_IDLE_MS, and at most
 * PROJECT_DATABASE_POOLS_MAX (64 unless set) kept per process, least recently
 * used out first among those with nothing checked out and nobody waiting.
 *
 * A pool let go to make room is not ended: a caller that resolved it a moment
 * ago may still send on it. It holds idle connections only, which close on
 * their own, and disconnectRegionalClients ends it.
 */
const PROJECT_DATABASE_POOL_MAX = 2
const PROJECT_DATABASE_POOL_IDLE_MS = 10_000
const PROJECT_DATABASE_POOLS_MAX = 64

const retiredPools = new Set<Pool>()

function retirePool(pool: Pool): void {
  for (const old of retiredPools) if (old.totalCount === 0) retiredPools.delete(old)
  if (pool.totalCount > 0) retiredPools.add(pool)
}

const databasePools = new DatabaseRegistry<Pool>({
  max: capFromEnv('PROJECT_DATABASE_POOLS_MAX', PROJECT_DATABASE_POOLS_MAX),
  idle: (pool) => pool.totalCount === pool.idleCount && pool.waitingCount === 0,
  close: (pool) => retirePool(pool),
  what: 'project database pools',
})

function databasePool(
  region: CloudRegionId,
  database: string,
  name: string,
  config: Omit<PoolConfig, 'connectionString'>,
  projectId?: string,
): Pool {
  refuseBadName(database)
  const url = requireRegionDataInstanceUrl(region, 'app', { projectId })
  return databasePools.get(`${region}/${database}/${name}`, () => {
    const pool = new Pool({
      ...config,
      max: Math.min(config.max ?? PROJECT_DATABASE_POOL_MAX, PROJECT_DATABASE_POOL_MAX),
      idleTimeoutMillis: config.idleTimeoutMillis ?? PROJECT_DATABASE_POOL_IDLE_MS,
      allowExitOnIdle: true,
      connectionString: withDatabase(url, database),
    })
    // An idle client's error is emitted on the pool; unhandled, it ends the process.
    pool.on('error', (err) => console.error(`[regional] ${name} pool on a project database in ${region}:`, err.message))
    return pool
  })
}

/**
 * A pool on the database holding this project's data: regionPool for a shared
 * project, exactly as before, and for a project with a database of its own, a
 * small pool on that database (databasePool).
 */
export async function projectPool(
  projectId: string,
  name: string,
  config: Omit<PoolConfig, 'connectionString'> = {},
): Promise<Pool> {
  const placement = await projectDatabase(projectId)
  if (placement.tenancy === 'dedicated') return databasePool(placement.region, placement.database as string, name, config, projectId)
  return regionPool(placement.region, name, config, projectId)
}
