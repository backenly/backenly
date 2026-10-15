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
 *   regionDatabaseUrl(region, role)  that region's connection string for a role
 *   projectDatabaseUrl(id, role)     both together
 *   workspaceRawClient(id)           raw SQL on the project's database
 *   projectPostgrest(id)             the PostgREST serving the project's region
 *
 * The home region keeps the variables it always had: DATABASE_URL, DIRECT_URL,
 * BACKUP_DATABASE_URL, BACKENLY_ADMIN_DATABASE_URL, POSTGREST_URL and
 * POSTGREST_JWT_SECRET. Every other region uses the same names with the region
 * appended, e.g. DATABASE_URL_US_EAST_1.
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
import { HOME_REGION, findRegion, type CloudRegionId } from '@/lib/regions'

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
  ) {
    super(
      region === HOME_REGION
        ? `${variable} is not set`
        : `No database connection for ${projectId ? `project ${projectId}, which is in ${region}` : region}: ` +
            `${variable} is not set. The data is only in that region's database, so nothing was sent to another one.`,
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
 * Whether an error means the project's data could not be reached at all.
 * A catch that turns failures into an answer ("not revoked", "invalid token",
 * "logged out") rethrows or reports these instead: the data was never read.
 */
export function isRegionError(err: unknown): err is RegionNotConfiguredError | UnknownRegionError {
  return err instanceof RegionNotConfiguredError || err instanceof UnknownRegionError
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

// A project's region is recorded once, at creation, and never changes, so it
// is cached for the life of the process. Bounded, oldest entry out first.
const REGION_CACHE_MAX = 10_000
const regionCache = new Map<string, CloudRegionId>()

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
  const cached = regionCache.get(projectId)
  if (cached) return cached

  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { region: true } })
  if (!row) return HOME_REGION

  const region = regionOfRecord(projectId, row.region)
  if (regionCache.size >= REGION_CACHE_MAX) {
    const oldest = regionCache.keys().next().value
    if (oldest !== undefined) regionCache.delete(oldest)
  }
  regionCache.set(projectId, region)
  return region
}

/** The connection string for `role` on the database holding this project's data. */
export async function projectDatabaseUrl(projectId: string, role: DataPlaneRole = 'app'): Promise<string> {
  return requireRegionDatabaseUrl(await projectRegion(projectId), role, { projectId })
}

/**
 * Raw SQL against a project's database. Narrowed to the raw methods because a
 * regional database holds workspace schemas only: the platform tables a model
 * accessor would reach are not there.
 */
export type WorkspaceRawClient = Pick<
  PrismaClient,
  '$queryRaw' | '$queryRawUnsafe' | '$executeRaw' | '$executeRawUnsafe' | '$transaction'
>

const regionalClients = new Map<CloudRegionId, PrismaClient>()

/**
 * Raw SQL against a region's database: the shared client in the home region,
 * exactly as before; one client per other region, created on first use. The
 * region's connection is checked on every call, so an unconfigured region is
 * refused even after a client exists.
 *
 * For work about a region rather than one project, such as reading its
 * PostgREST registry. A project's own queries go through workspaceRawClient.
 */
export function regionRawClient(region: CloudRegionId, projectId?: string): WorkspaceRawClient {
  if (region === HOME_REGION) return prisma

  const url = requireRegionDatabaseUrl(region, 'app', { projectId })
  const existing = regionalClients.get(region)
  if (existing) return existing

  const client = new PrismaClient({ datasourceUrl: url, log: ['error'] })
  regionalClients.set(region, client)
  return client
}

/** Raw SQL against the database holding a project's data, in its region. */
export async function workspaceRawClient(projectId: string): Promise<WorkspaceRawClient> {
  return regionRawClient(await projectRegion(projectId), projectId)
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

/** Close every regional client. The home client is the shared one and stays. */
export async function disconnectRegionalClients(): Promise<void> {
  const clients = [...regionalClients.values()]
  regionalClients.clear()
  const pools = [...regionPools.values()]
  regionPools.clear()
  await Promise.all([
    ...clients.map((client) => client.$disconnect().catch(() => {})),
    ...pools.map((pool) => pool.end().catch(() => {})),
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

/** regionPool for the region holding this project's data. */
export async function projectPool(
  projectId: string,
  name: string,
  config: Omit<PoolConfig, 'connectionString'> = {},
): Promise<Pool> {
  return regionPool(await projectRegion(projectId), name, config, projectId)
}
