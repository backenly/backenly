/**
 * A PROJECT'S DATA IS READ IN ITS OWN REGION, AND NOWHERE ELSE
 * ============================================================
 * Backenly Cloud keeps each project's workspace schema in the region it was
 * created in (lib/data-plane/regional.ts). This suite creates a second
 * database as the stand-in for another region's, puts one project's schema
 * ONLY there, and pins:
 *
 *   home project (region null)          served from DATABASE_URL, as always
 *   regional project, no connection     refused with REGION_NOT_CONFIGURED
 *   regional project, connection set    served from the regional database,
 *                                       whose marker row exists nowhere else
 *   the raw-SQL client                  the same split
 *   RLS-scoped SQL (executeWithUserContext), the workspace client
 *   (getWorkspacePostgresClient) and a function's role sync
 *                                       the same split, each in the region
 *   end-user auth: the users table, the token blacklist and the
 *   request-time blocked check          in the region; without a connection
 *                                       the request fails, it never fails open
 *   the v1 data routes and the health check
 *                                       the region's catalog and rows; 503
 *                                       without a connection
 *   PostgREST                           the region's own URL and secret, and
 *                                       schema registration in the region
 *   a region this build does not know   refused, never read as home
 *
 * The refusal is the property that matters. The home database holds no schema
 * for the regional project, and Postgres accepts a missing schema on the
 * search_path without complaint, so falling back would not reliably fail: a
 * query could answer from the platform's own tables instead.
 */

import '@/tests/helpers/real-web-standard'
import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { Client } from 'pg'
import { GET as queryRoute } from '@/app/api/v1/[projectId]/database/query/route'
import { GET as healthzRoute } from '@/app/api/v1/[projectId]/healthz/route'
import { POST as broadcastRoute } from '@/app/api/v1/[projectId]/broadcast/route'
import { mintKey } from '@/lib/auth/key-prefix'
import { prisma } from '@/lib/db'
import { disconnectRegionalClients, partitionReachable, projectPostgrest, projectRegion, workspaceRawClient } from '@/lib/data-plane/regional'
import { PostgresService } from '@/lib/db/hybrid'
import { clearRegistrationCache, ensureSchemaRegistered } from '@/lib/postgrest/registration'
import { listenerHub } from '@/lib/realtime/listener-hub'
import { mintSseTicket, redeemSseTicket } from '@/lib/realtime/sse-ticket'
import { existingTables } from '@/lib/mcp/apply-migration'
import { runReadQuery } from '@/lib/mcp/read-query'
import { createBranch, discardBranch } from '@/lib/branches/engine'
import { readWorkspaceSchema } from '@/lib/typegen/schema-reader'
import { executeAction, introspectSchema } from '@/lib/ai/minimal-executor'
import { logActivity } from '@/lib/ai/activity-log-engine'
import { buildWorkspaceTableNameMap } from '@/lib/ai/fk-repair'
import { collectProof } from '@/lib/ai/proof-system'
import { describeTable } from '@/lib/ai/schema-tools'
import { detectSchemaDrift } from '@/lib/ai/schema-reconciler'
import { analyzeProductionReadiness } from '@/lib/ai/production-intelligence'
import { runInfraIntelligence } from '@/lib/ai/infra-intelligence'
import { listExtensions } from '@/lib/services/extensions'
import { AUTONOMY_SKIPPED, canReach, resetSkipRecords, skipUnreachable } from '@/lib/autonomy/region-skip'
import { directAccessRoleNames, provisionDirectAccess, revokeDirectAccess } from '@/lib/services/direct-access'
import { columnTypes } from '@/lib/mcp/runtime-db'
import { getTableSchema, listExposedTables, workspaceTableExists } from '@/lib/mcp/schema-introspection'
import { functionDbClient, functionRoleHelperInstalled, functionRoleName, provisionFunctionRole } from '@/lib/services/ai-functions/function-db-role'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { ensureEmailVerifiedColumn, logoutEndUser } from '@/lib/services/end-user-auth-flows'
import { buildUserInsert, introspectAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { hashApiKey, resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { closeAllWorkspacePools, queryWorkspace } from '@/lib/services/workspace-pool'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { getWorkspacePostgresClient } from '@/lib/services/workspaceDatabase'
import { computeDesiredStateDiff } from '@/lib/autonomy/desired-state'
import { detectExpiredTokenBuildup } from '@/lib/autonomy/invariant-probes'
import { detectUnregisteredSchema } from '@/lib/autonomy/schema-registration'
import { detectRuntimeEngineMismatch } from '@/lib/autonomy/engine-conformance'
import { detectMigrationResidue } from '@/lib/autonomy/migration-residue'
import { detectIdleInTransaction } from '@/lib/autonomy/connection-health'
import { collectBaseline } from '@/lib/autonomy/baseline/collector'
import { checkIntentConformance } from '@/lib/autonomy/intent-conformance'
import { verifyPostcondition } from '@/lib/autonomy/action-postconditions'
import { hasCapability, resetCapabilityCache } from '@/lib/autonomy/platform-capabilities'
import { measureProjectDbBytes, snapshotProjectDbStorage } from '@/lib/usage/db-storage'

jest.setTimeout(120_000)

const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_region_${randomBytes(4).toString('hex')}`

let homeDb = ''
let regionalUrl = ''
let ownerId = ''
let homeProject = ''
let regionalProject = ''
let unknownProject = ''
let regionalDbCreated = false

const homeUrl = () => process.env.DATABASE_URL as string
const schemaOf = (projectId: string) => getWorkspaceDatabaseNames(projectId).postgresSchema

function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function run(connectionString: string, sql: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end().catch(() => {})
  }
}

async function rowsIn<T>(connectionString: string, sql: string): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}

async function createProject(region: string | null): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `region-${randomUUID()}`, userId: ownerId, region },
    select: { id: true },
  })
  return project.id
}

async function seedMarker(connectionString: string, schema: string, note: string): Promise<void> {
  await run(
    connectionString,
    `CREATE SCHEMA "${schema}";
     CREATE TABLE "${schema}".marker (note text);
     INSERT INTO "${schema}".marker VALUES ('${note}')`,
  )
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  delete process.env[REGION_VARIABLE]
  homeDb = new URL(homeUrl()).pathname.slice(1)
  regionalUrl = urlFor(REGIONAL_DB)

  const user = await prisma.user.create({
    data: { email: `region-${randomUUID()}@example.test`, name: 'region fixture' },
    select: { id: true },
  })
  ownerId = user.id

  homeProject = await createProject(null)
  regionalProject = await createProject('us-east-1')
  unknownProject = await createProject('mars-north-1')

  await seedMarker(homeUrl(), schemaOf(homeProject), 'home')

  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  await seedMarker(regionalUrl, schemaOf(regionalProject), 'us-east-1')

  // The workspace row a provisioned project has, so getWorkspacePostgresClient
  // goes straight to its queries instead of provisioning.
  await prisma.workspace.create({
    data: {
      name: 'region fixture',
      projectId: regionalProject,
      postgresSchema: schemaOf(regionalProject),
      databaseProvisioned: true,
    },
  })

  // A stand-in for the function-role helper (scripts/sql/function-roles.sql),
  // in the regional database only. It records where it ran and answers with
  // the role name the real helper derives.
  await run(
    regionalUrl,
    `CREATE TABLE public.fn_role_sync_calls (schema_name text);
     CREATE FUNCTION public.backenly_fn_role_sync(s text, p text) RETURNS text LANGUAGE sql AS $$
       INSERT INTO public.fn_role_sync_calls VALUES (s);
       SELECT 'bkn_fn_' || left(encode(sha256(convert_to(s, 'UTF8')), 'hex'), 12);
     $$`,
  )
})

afterAll(async () => {
  delete process.env[REGION_VARIABLE]
  await closeAllWorkspacePools()
  await disconnectRegionalClients()
  if (regionalDbCreated) {
    await run(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
  }
  // The direct-access block's role is cluster-wide; its grants went with the database.
  if (regionalProject) {
    await run(homeUrl(), `DROP ROLE IF EXISTS "${directAccessRoleNames(regionalProject).ro}"`).catch(() => {})
  }
  if (homeProject) {
    await run(homeUrl(), `DROP SCHEMA IF EXISTS "${schemaOf(homeProject)}" CASCADE`).catch(() => {})
  }
  const ids = [homeProject, regionalProject, unknownProject].filter(Boolean)
  await prisma.project.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('a home-region project', () => {
  it('is served from DATABASE_URL, exactly as before regions', async () => {
    expect(await projectRegion(homeProject)).toBe('ap-south-1')
    const rows = await queryWorkspace<{ db: string; note: string }>(
      homeProject,
      'SELECT current_database() AS db, note FROM marker',
    )
    expect(rows).toEqual([{ db: homeDb, note: 'home' }])
  })

  it('keeps the shared raw client', async () => {
    expect(await workspaceRawClient(homeProject)).toBe(prisma)
  })
})

describe('a project in another region', () => {
  it('is refused while this process has no connection for its region', async () => {
    delete process.env[REGION_VARIABLE]
    expect(await projectRegion(regionalProject)).toBe('us-east-1')
    await expect(queryWorkspace(regionalProject, 'SELECT note FROM marker')).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
      variable: REGION_VARIABLE,
    })
    await expect(workspaceRawClient(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })

  it('has no schema in the home database that a fallback could have reached', async () => {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*)::bigint AS n FROM pg_namespace WHERE nspname = $1',
      schemaOf(regionalProject),
    )
    expect(Number(rows[0].n)).toBe(0)
  })

  it('is served from its own region once that connection exists', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const rows = await queryWorkspace<{ db: string; note: string }>(
      regionalProject,
      'SELECT current_database() AS db, note FROM marker',
    )
    expect(rows).toEqual([{ db: REGIONAL_DB, note: 'us-east-1' }])
  })

  it('gets a raw client on the regional database, not the shared one', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const raw = await workspaceRawClient(regionalProject)
    expect(raw).not.toBe(prisma)
    const rows = await raw.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db')
    expect(rows[0].db).toBe(REGIONAL_DB)
  })

  it('is refused again once the connection is gone, even with a pool and a client open', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(queryWorkspace(regionalProject, 'SELECT 1')).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(workspaceRawClient(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('the shared helpers that run a project’s SQL', () => {
  it('run RLS-scoped SQL for a home project in the home database', async () => {
    const rows = await executeWithUserContext<{ db: string; note: string }>(
      homeProject,
      '',
      true,
      `SELECT current_database() AS db, note FROM "${schemaOf(homeProject)}".marker`,
    )
    expect(rows).toEqual([{ db: homeDb, note: 'home' }])
  })

  it('run RLS-scoped SQL for a regional project in its region, and refuse without a connection', async () => {
    const sql = `SELECT current_database() AS db, note FROM "${schemaOf(regionalProject)}".marker`

    delete process.env[REGION_VARIABLE]
    await expect(executeWithUserContext(regionalProject, '', true, sql)).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
    })

    process.env[REGION_VARIABLE] = regionalUrl
    const rows = await executeWithUserContext<{ db: string; note: string }>(regionalProject, '', true, sql)
    expect(rows).toEqual([{ db: REGIONAL_DB, note: 'us-east-1' }])
  })

  it('give a regional project a workspace client on its own database', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const client = await getWorkspacePostgresClient(regionalProject)
    const rows = await client.queryRaw('SELECT current_database() AS db, note FROM {schema}.marker')
    expect(rows).toEqual([{ db: REGIONAL_DB, note: 'us-east-1' }])
  })

  it('sync a regional project’s function role in its own database', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const schema = schemaOf(regionalProject)
    const { role } = await provisionFunctionRole(regionalProject)
    expect(role).toBe(functionRoleName(schema))
    // The stand-in helper exists only in the regional database, and it ran there.
    const calls = await rowsIn<{ schema_name: string }>(regionalUrl, 'SELECT schema_name FROM public.fn_role_sync_calls')
    expect(calls).toEqual([{ schema_name: schema }])
  })

  it('refuse a regional function login when this process cannot reach the region', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(functionDbClient(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('schema introspection reads the project’s own database', () => {
  // Each answer below exists only in the regional database: a misrouted read
  // would find no schema, no tables and no columns rather than these.
  it('finds a regional project’s schema, tables and columns in its region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const schema = schemaOf(regionalProject)

    expect(await PostgresService.schemaExists(regionalProject, schema)).toBe(true)
    const tables = await PostgresService.listTables(regionalProject, schema)
    expect(tables.map((t) => t.name)).toEqual(['marker'])
    const columns = await PostgresService.getTableStructure(regionalProject, schema, 'marker')
    expect(columns.map((c) => c.name)).toEqual(['note'])
  })

  it('still reads a home project’s schema in the home database', async () => {
    const schema = schemaOf(homeProject)
    expect(await PostgresService.schemaExists(homeProject, schema)).toBe(true)
    expect((await PostgresService.listTables(homeProject, schema)).map((t) => t.name)).toEqual(['marker'])
    // The regional project's schema is not in the home database at all.
    expect(await PostgresService.schemaExists(homeProject, schemaOf(regionalProject))).toBe(false)
  })

  it('refuses to introspect a regional project without a connection', async () => {
    delete process.env[REGION_VARIABLE]
    const schema = schemaOf(regionalProject)
    await expect(PostgresService.schemaExists(regionalProject, schema)).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
    })
    await expect(PostgresService.getTableStructure(regionalProject, schema, 'marker')).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
    })
  })
})

describe('end-user auth reads and writes the project’s own database', () => {
  // The users table below exists only in the regional database, with shapes
  // the home database could not have answered: a `password_hash` column, a
  // CHECK that allows only 'member' or 'admin', and one blocked user.
  const secret = randomBytes(32).toString('hex')
  const activeUser = randomUUID()
  const blockedUser = randomUUID()
  const tokenFor = (userId: string) =>
    jwt.sign(
      { userId, email: `${userId}@region.test`, projectId: regionalProject, role: 'member', jti: randomUUID() },
      secret,
      { algorithm: 'HS256', expiresIn: '1h' },
    )

  beforeAll(async () => {
    await prisma.project.update({ where: { id: regionalProject }, data: { jwtSecret: secret } })
    const schema = schemaOf(regionalProject)
    await run(
      regionalUrl,
      `CREATE TABLE "${schema}".users (
         id uuid PRIMARY KEY,
         email text UNIQUE NOT NULL,
         password_hash text,
         role text NOT NULL CHECK (role IN ('member', 'admin')),
         is_blocked boolean NOT NULL DEFAULT false
       );
       INSERT INTO "${schema}".users VALUES
         ('${activeUser}', 'active@region.test', 'x', 'member', false),
         ('${blockedUser}', 'blocked@region.test', 'x', 'member', true)`,
    )
  })

  it('describes the regional users table and builds its insert from the regional catalog', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const schema = await introspectAuthUsersTable(regionalProject)
    expect(schema.projectId).toBe(regionalProject)
    expect(schema.passwordColumn).toBe('password_hash')
    // The role default honours the CHECK that exists only in the region.
    const plan = await buildUserInsert(schema, { email: 'new@region.test', password_hash: 'x' })
    expect(plan.values).toContain('member')
  })

  it('adds the email_verified column in the region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    await ensureEmailVerifiedColumn(regionalProject, schemaOf(regionalProject))
    const cols = await rowsIn<{ column_name: string }>(
      regionalUrl,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = '${schemaOf(regionalProject)}' AND table_name = 'users' AND column_name = 'email_verified'`,
    )
    expect(cols).toHaveLength(1)
  })

  it('reads blocking from the regional users table at request time', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    expect(await resolveEndUserFromToken(regionalProject, tokenFor(blockedUser))).toBe('blocked')
    expect(await resolveEndUserFromToken(regionalProject, tokenFor(activeUser))).toEqual({
      userId: activeUser,
      role: 'member',
    })
  })

  it('revokes a token on the regional blacklist, which the next request then honours', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const token = tokenFor(activeUser)
    const result = await logoutEndUser(regionalProject, token)
    expect(result.status).toBe(200)
    const listed = await rowsIn<{ n: string }>(
      regionalUrl,
      `SELECT count(*)::text AS n FROM "${schemaOf(regionalProject)}"."_token_blacklist"`,
    )
    expect(listed[0].n).toBe('1')
    expect(await resolveEndUserFromToken(regionalProject, token)).toBeNull()
  })

  it('without a connection, fails the request instead of failing open or reporting a logout', async () => {
    delete process.env[REGION_VARIABLE]
    // Both checks accept a token whose status cannot be read. A region that
    // cannot be reached must not be read that way: the blocked user stays out.
    await expect(resolveEndUserFromToken(regionalProject, tokenFor(blockedUser))).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
    })
    const result = await logoutEndUser(regionalProject, tokenFor(activeUser))
    expect(result.status).toBe(503)
    expect(result.body.error.code).toBe('REGION_NOT_CONFIGURED')
    await expect(introspectAuthUsersTable(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('the v1 data routes read the project’s own database', () => {
  // A soft-delete column and a deleted row exist only in the regional
  // database. The query route excludes deleted rows only when its catalog
  // read finds `deleted_at`, so a read sent anywhere else returns both rows.
  let key = ''
  const get = (handler: typeof queryRoute, path: string) =>
    handler(
      new NextRequest(`https://backenly.test/api/v1/${regionalProject}${path}`, { headers: { 'x-api-key': key } }),
      { params: Promise.resolve({ projectId: regionalProject }) },
    )

  beforeAll(async () => {
    const minted = mintKey({ keyType: 'public', serviceRole: true })
    key = minted.key
    await prisma.apiKey.create({
      data: {
        name: 'region fixture', keyPrefix: minted.prefix, keyHash: hashApiKey(key), keyType: 'public',
        serviceRole: true, permissions: ['read', 'write', 'admin'], capabilities: ['database'],
        projectId: regionalProject, userId: ownerId,
      },
    })
    await prisma.table.create({ data: { name: 'marker', projectId: regionalProject } })
    await run(
      regionalUrl,
      `ALTER TABLE "${schemaOf(regionalProject)}".marker ADD COLUMN deleted_at timestamptz;
       INSERT INTO "${schemaOf(regionalProject)}".marker VALUES ('deleted', now())`,
    )
  })

  it('serves a regional project’s rows from its region, with its soft-delete column honoured', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const res = await get(queryRoute, '/database/query?table=marker')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.data).toEqual([{ note: 'us-east-1', deleted_at: null }])
  })

  it('answers 503 REGION_NOT_CONFIGURED without a connection, not an empty result', async () => {
    delete process.env[REGION_VARIABLE]
    const res = await get(queryRoute, '/database/query?table=marker')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('REGION_NOT_CONFIGURED')
    expect(JSON.stringify(body)).not.toContain(REGION_VARIABLE)
  })

  it('reports the regional database in the health check, and an unreachable region as degraded', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const up = await (await get(healthzRoute, '/healthz')).json()
    expect(up.database.status).toBe('ok')

    delete process.env[REGION_VARIABLE]
    const down = await (await get(healthzRoute, '/healthz')).json()
    expect(down.status).toBe('degraded')
    expect(down.database).toMatchObject({ status: 'error', error: 'Data region not reachable from this server' })
  })
})

describe('PostgREST, per region', () => {
  const saved = { url: process.env.POSTGREST_URL, secret: process.env.POSTGREST_JWT_SECRET }

  beforeAll(async () => {
    // A stand-in for the registry helper (scripts/sql/postgrest-schema-registry.sql),
    // in the regional database only. It records which schemas it was asked to
    // register, so a registration sent anywhere else leaves no row here.
    await run(
      regionalUrl,
      `CREATE TABLE public.pgrst_register_calls (schema_name text);
       CREATE FUNCTION public.backenly_pgrst_register_schema(s text) RETURNS void LANGUAGE sql AS $$
         INSERT INTO public.pgrst_register_calls VALUES (s)
       $$`,
    )
  })

  beforeEach(() => clearRegistrationCache())

  afterAll(() => {
    for (const [name, value] of [['POSTGREST_URL', saved.url], ['POSTGREST_JWT_SECRET', saved.secret]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    delete process.env.POSTGREST_URL_US_EAST_1
    delete process.env.POSTGREST_JWT_SECRET_US_EAST_1
  })

  it('serves a regional project only from its own region’s PostgREST', async () => {
    process.env.POSTGREST_URL = 'http://postgrest.home.test:3000'
    process.env.POSTGREST_JWT_SECRET = 'home-secret'
    delete process.env.POSTGREST_URL_US_EAST_1
    delete process.env.POSTGREST_JWT_SECRET_US_EAST_1

    expect(await projectPostgrest(homeProject)).toEqual({ url: 'http://postgrest.home.test:3000', jwtSecret: 'home-secret' })
    // The home PostgREST serves the home database, which has no schema for it.
    expect(await projectPostgrest(regionalProject)).toBeNull()

    process.env.POSTGREST_URL_US_EAST_1 = 'http://postgrest.virginia.test:3000'
    process.env.POSTGREST_JWT_SECRET_US_EAST_1 = 'virginia-secret'
    expect(await projectPostgrest(regionalProject)).toEqual({
      url: 'http://postgrest.virginia.test:3000',
      jwtSecret: 'virginia-secret',
    })
  })

  it('registers a regional project’s schema in its own region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const result = await ensureSchemaRegistered(regionalProject)
    expect(result).toMatchObject({ registered: true, schema: schemaOf(regionalProject) })
    const calls = await rowsIn<{ schema_name: string }>(regionalUrl, 'SELECT schema_name FROM public.pgrst_register_calls')
    expect(calls).toEqual([{ schema_name: schemaOf(regionalProject) }])
  })

  it('reports the schema unregistered when the region cannot be reached, and asks nowhere else', async () => {
    delete process.env[REGION_VARIABLE]
    const result = await ensureSchemaRegistered(regionalProject)
    expect(result.registered).toBe(false)
    expect(result.error).toMatch(REGION_VARIABLE)
    process.env[REGION_VARIABLE] = regionalUrl
    const calls = await rowsIn<{ schema_name: string }>(regionalUrl, 'SELECT schema_name FROM public.pgrst_register_calls')
    expect(calls).toHaveLength(1)
  })
})

describe('realtime listens and notifies on the project’s own database', () => {
  // LISTEN/NOTIFY never crosses databases: a listener on the home database
  // would subscribe successfully and then hear nothing a regional project's
  // database sends. Each event below is sent on one database only.
  const channelOf = (projectId: string) => `workspace_${projectId}_changes`

  async function subscribe(projectId: string) {
    let deliver!: (payload: Record<string, unknown>) => void
    const received = new Promise<Record<string, unknown>>((resolve) => { deliver = resolve })
    const result = await listenerHub.subscribe(projectId, (payload) => deliver(payload))
    if (!result.ok) throw new Error(result.message)
    const event = () =>
      Promise.race([
        received,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no notification arrived')), 10_000)),
      ])
    return { event, unsubscribe: result.unsubscribe }
  }

  it('refuses to subscribe while this process has no connection to the region', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(listenerHub.subscribe(regionalProject, () => {})).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    expect(listenerHub.connectionCount(regionalProject)).toBe(0)
  })

  it('hears a regional project’s channel on the regional database', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const sub = await subscribe(regionalProject)
    try {
      await run(regionalUrl, `SELECT pg_notify('${channelOf(regionalProject)}', '{"from":"us-east-1"}')`)
      expect(await sub.event()).toEqual({ from: 'us-east-1' })
    } finally {
      sub.unsubscribe()
    }
  })

  it('still hears a home project’s channel on the home database', async () => {
    const sub = await subscribe(homeProject)
    try {
      await run(homeUrl(), `SELECT pg_notify('${channelOf(homeProject)}', '{"from":"home"}')`)
      expect(await sub.event()).toEqual({ from: 'home' })
    } finally {
      sub.unsubscribe()
    }
  })

  it('refuses again once the connection is gone, though the regional listener is still open', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(listenerHub.subscribe(regionalProject, () => {})).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })

  it('delivers a broadcast to a regional project’s subscribers', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const minted = mintKey({ keyType: 'public', serviceRole: true })
    await prisma.apiKey.create({
      data: {
        name: 'region broadcast', keyPrefix: minted.prefix, keyHash: hashApiKey(minted.key), keyType: 'public',
        serviceRole: true, permissions: ['read', 'write', 'admin'], capabilities: ['database'],
        projectId: regionalProject, userId: ownerId,
      },
    })
    const sub = await subscribe(regionalProject)
    try {
      const res = await broadcastRoute(
        new NextRequest(`https://backenly.test/api/v1/${regionalProject}/broadcast`, {
          method: 'POST',
          headers: { 'x-api-key': minted.key, 'content-type': 'application/json' },
          body: JSON.stringify({ channel: 'room', payload: { hello: 'virginia' } }),
        }),
        { params: Promise.resolve({ projectId: regionalProject }) },
      )
      expect(res.status).toBe(200)
      expect(await sub.event()).toMatchObject({ type: 'broadcast', channel: 'room', payload: { hello: 'virginia' } })
    } finally {
      sub.unsubscribe()
    }
  })

  it('burns a realtime ticket once, on the regional ledger, and mints none without a connection', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const secret = randomBytes(32).toString('hex')
    const minted = await mintSseTicket(secret, { projectId: regionalProject, serviceRole: true })
    expect(minted.singleUse).toBe(true)
    expect((await redeemSseTicket(regionalProject, secret, minted.ticket)).ok).toBe(true)
    expect(await redeemSseTicket(regionalProject, secret, minted.ticket)).toMatchObject({ ok: false, code: 'ALREADY_USED' })

    delete process.env[REGION_VARIABLE]
    await expect(mintSseTicket(secret, { projectId: regionalProject, serviceRole: true })).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
    })
  })
})

describe('MCP reads a project’s catalog in its own region', () => {
  // The regional marker table alone has a `deleted_at` column (added by the v1
  // routes block above); the home one, under the home project, has `note` only.
  it('describes a regional project’s table from its region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    expect(await workspaceTableExists(regionalProject, 'marker')).toBe(true)
    const table = await getTableSchema(regionalProject, 'marker')
    expect(table.columns.map((c) => c.name).sort()).toEqual(['deleted_at', 'note'])
    // `users` is the one the end-user auth block created, also only in the region.
    const listed = await listExposedTables(regionalProject)
    expect(listed.map((t) => [t.name, t.columns]).sort()).toEqual([['marker', 2], ['users', 6]])
  })

  it('reads column types and existing tables from the region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const schema = schemaOf(regionalProject)
    const types = await columnTypes(regionalProject, schema, 'marker')
    expect(types.get('deleted_at')).toBe('timestamp with time zone')
    expect(await existingTables(regionalProject, schema, ['marker', 'absent'])).toEqual(new Set(['marker']))
  })

  it('refuses without a connection instead of answering “no such table”', async () => {
    delete process.env[REGION_VARIABLE]
    const schema = schemaOf(regionalProject)
    await expect(workspaceTableExists(regionalProject, 'marker')).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(listExposedTables(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(columnTypes(regionalProject, schema, 'marker')).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(existingTables(regionalProject, schema, ['marker'])).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('direct database access and agents’ read-only SQL use the project’s region', () => {
  // Stand-ins for the definer helpers (scripts/setup-direct-access.sql), in the
  // regional database only. They record each call, and create_role makes a real
  // login role with SELECT on the schema, so read-only SQL can connect as it.
  // Locally both databases share one cluster, so the role is told apart by the
  // database it reads: the regional marker row says 'us-east-1'.
  const HOST_VARIABLE = 'DIRECT_DB_HOST_US_EAST_1'
  const calls = () =>
    rowsIn<{ op: string; role: string | null; schema_name: string | null }>(
      regionalUrl,
      'SELECT op, role, schema_name FROM public.direct_access_calls ORDER BY seq',
    )

  beforeAll(async () => {
    await run(
      regionalUrl,
      `CREATE TABLE public.direct_access_calls (seq serial, op text, role text, schema_name text);
       CREATE FUNCTION public.backenly_direct_create_role(r text, p text, s text, m text) RETURNS boolean
       LANGUAGE plpgsql AS $$
       BEGIN
         INSERT INTO public.direct_access_calls (op, role, schema_name) VALUES ('create', r, s);
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
           EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r, p);
         END IF;
         EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
         EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, r);
         EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', s, r);
         RETURN true;
       END $$;
       CREATE FUNCTION public.backenly_direct_sync_schema(s text, ro text, rw text, o text) RETURNS boolean
       LANGUAGE sql AS $$ INSERT INTO public.direct_access_calls (op, role, schema_name) VALUES ('sync', ro, s) RETURNING true $$;
       CREATE FUNCTION public.backenly_direct_drop_role(r text) RETURNS boolean
       LANGUAGE sql AS $$ INSERT INTO public.direct_access_calls (op, role) VALUES ('drop', r) RETURNING true $$;`,
    )
  })

  afterAll(async () => {
    delete process.env[HOST_VARIABLE]
    await prisma.databaseCredential.deleteMany({ where: { projectId: regionalProject } }).catch(() => {})
  })

  it('refuses to hand out a credential with no public host for the region, before creating any role', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    delete process.env[HOST_VARIABLE]
    await expect(provisionDirectAccess(regionalProject, 'READ_ONLY')).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
      variable: HOST_VARIABLE,
    })
    expect(await calls()).toEqual([])
  })

  it('creates the role in the region and points the developer at the region’s host and database', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    process.env[HOST_VARIABLE] = 'db.virginia.test'
    const schema = schemaOf(regionalProject)
    const credential = await provisionDirectAccess(regionalProject, 'READ_ONLY')
    expect(credential).toMatchObject({ host: 'db.virginia.test', database: REGIONAL_DB })
    expect(credential.connectionString).toContain(`@db.virginia.test:5432/${REGIONAL_DB}?`)
    expect(await calls()).toEqual([
      { op: 'create', role: credential.roleName, schema_name: schema },
      { op: 'sync', role: credential.roleName, schema_name: schema },
    ])
  })

  it('runs an agent’s read-only SQL on the regional database as that role', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const result = await runReadQuery(regionalProject, 'SELECT note FROM marker WHERE deleted_at IS NULL')
    expect(result.rows).toEqual([{ note: 'us-east-1' }])
  })

  it('revokes the role in the region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    await revokeDirectAccess(regionalProject, 'READ_ONLY')
    const ops = (await calls()).map((c) => c.op)
    expect(ops[ops.length - 1]).toBe('drop')
  })

  it('refuses read-only SQL without a connection to the region', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(runReadQuery(regionalProject, 'SELECT 1')).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('type generation and preview branches use the project’s region', () => {
  const savedEdition = process.env.BACKENLY_EDITION
  const inSchema = (url: string, schema: string) =>
    rowsIn<{ table_name: string }>(
      url,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`,
    )

  afterAll(async () => {
    if (savedEdition === undefined) delete process.env.BACKENLY_EDITION
    else process.env.BACKENLY_EDITION = savedEdition
    await prisma.workspaceBranch.deleteMany({ where: { projectId: regionalProject } }).catch(() => {})
  })

  it('reads a regional project’s schema for its generated types from its region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const schema = await readWorkspaceSchema(regionalProject)
    const marker = schema.tables.find((t) => t.tableName === 'marker')
    expect(marker?.columns.map((c) => c.columnName).sort()).toEqual(['deleted_at', 'note'])
  })

  it('cuts and discards a regional project’s branch in its region, and nowhere else', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    process.env.BACKENLY_EDITION = 'cloud'
    const created = await createBranch(regionalProject, ownerId, 'feature-x')
    if (!created.ok) throw new Error(created.error)
    const branchSchema = created.branch.schemaName

    expect((await inSchema(regionalUrl, branchSchema)).map((r) => r.table_name)).toContain('marker')
    expect(await inSchema(homeUrl(), branchSchema)).toEqual([])

    expect(await discardBranch(regionalProject, ownerId, created.branch.id)).toEqual({ ok: true })
    expect(await inSchema(regionalUrl, branchSchema)).toEqual([])
  })

  it('refuses without a connection to the region', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(readWorkspaceSchema(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('the AI executor reads and writes the project’s region', () => {
  const regionalColumns = (table: string) =>
    rowsIn<{ column_name: string }>(
      regionalUrl,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = '${schemaOf(regionalProject)}' AND table_name = '${table}' ORDER BY column_name`,
    )
  const addColumn = (columnName: string) =>
    executeAction(
      { action: 'ADD_COLUMN', params: { tableName: 'marker', columnName, columnType: 'text' } } as any,
      regionalProject,
      undefined,
      0,
      undefined,
      false,
    )

  it('describes a regional project’s schema to the AI from its region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const described = await introspectSchema(regionalProject)
    expect(described).toContain('marker')
    expect(described).toContain('deleted_at')
  })

  it('adds a column to a regional project’s table in its region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const result = await addColumn('tag')
    expect(result.success).toBe(true)
    expect((await regionalColumns('marker')).map((c) => c.column_name)).toContain('tag')
  })

  it('fails without a connection instead of reading the project as empty', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(introspectSchema(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    const result = await addColumn('never_added').catch((err) => ({ success: false, error: err }))
    expect(result.success).toBe(false)
    process.env[REGION_VARIABLE] = regionalUrl
    expect((await regionalColumns('marker')).map((c) => c.column_name)).not.toContain('never_added')
  })
})

describe('the AI build tools read and write the project’s region', () => {
  const activityRows = () =>
    rowsIn<{ entity_id: string }>(
      regionalUrl,
      `SELECT entity_id FROM "${schemaOf(regionalProject)}".activity_logs ORDER BY entity_id`,
    )
  const entry = (entityId: string) => ({
    projectId: regionalProject,
    action: 'created' as const,
    entityType: 'marker',
    entityId,
    description: 'region test',
  })

  beforeAll(async () => {
    await run(
      regionalUrl,
      `CREATE TABLE "${schemaOf(regionalProject)}".activity_logs (
         action text, entity_type text, entity_id text, description text,
         actor_id text, metadata jsonb, created_at timestamptz
       )`,
    )
  })

  it('reads a regional project’s catalog for table descriptions, FK repair and the proof block', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const described = await describeTable(regionalProject, 'marker')
    expect(described?.columns.map((c) => c.name)).toContain('deleted_at')
    expect((await buildWorkspaceTableNameMap(regionalProject)).has('marker')).toBe(true)
    expect((await collectProof(regionalProject)).tables).toContain('marker')
  })

  it('writes the activity log into the regional schema', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    await logActivity(entry('logged-in-region'))
    expect(await activityRows()).toEqual([{ entity_id: 'logged-in-region' }])
  })

  it('refuses the readers without a connection, while activity logging stays best-effort', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(describeTable(regionalProject, 'marker')).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(buildWorkspaceTableNameMap(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(collectProof(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(logActivity(entry('never-logged'))).resolves.toBeUndefined()
    process.env[REGION_VARIABLE] = regionalUrl
    expect(await activityRows()).toEqual([{ entity_id: 'logged-in-region' }])
  })
})

describe('the AI analysis modules with their own pools read the project’s region', () => {
  // A snapshot that expects `marker` with `note` only. Read from the region,
  // the table is there and its regional-only `deleted_at` is an extra column;
  // read anywhere else, `marker` would be a missing table.
  beforeAll(async () => {
    await prisma.workspaceSchemaSnapshot.create({
      data: {
        projectId: regionalProject,
        versionNum: 1,
        trigger: 'manual',
        rawDdl: '',
        tables: [{ name: 'marker', columns: [{ name: 'note', type: 'text', nullable: true }] }],
      },
    })
  })

  afterAll(async () => {
    await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId: regionalProject } }).catch(() => {})
  })

  it('reconciles a regional project’s schema against its regional catalog', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const report = await detectSchemaDrift(regionalProject)
    expect(report.drifts.filter((d) => d.type === 'missing_table')).toEqual([])
    expect(
      report.drifts.some((d) => d.type === 'extra_column' && d.tableName === 'marker' && d.columnName === 'deleted_at'),
    ).toBe(true)
  })

  it('refuses without a connection instead of reporting a clean or empty result', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(detectSchemaDrift(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(analyzeProductionReadiness(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(runInfraIntelligence(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('the remaining services read the project’s region', () => {
  it('finds the function-role helper in the regional database it is installed in', async () => {
    // The stand-in backenly_fn_role_sync exists only in the regional database.
    process.env[REGION_VARIABLE] = regionalUrl
    expect(await functionRoleHelperInstalled('us-east-1')).toBe(true)
  })

  it('lists a regional project’s extensions from its region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const listed = await listExtensions(regionalProject)
    expect(Array.isArray(listed)).toBe(true)
  })

  it('refuses without a connection to the region', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(functionRoleHelperInstalled('us-east-1')).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(listExtensions(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('background work skips what it cannot reach, and says so', () => {
  const skipRows = () =>
    prisma.auditLog.findMany({
      where: { projectId: { in: [homeProject, regionalProject, unknownProject] }, action: AUTONOMY_SKIPPED },
      select: { projectId: true, details: true },
    })

  beforeEach(() => resetSkipRecords())
  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { action: AUTONOMY_SKIPPED, projectId: { in: [regionalProject, unknownProject] } } })
  })

  it('tells reachable projects from those in a region this process has no connection to', async () => {
    delete process.env[REGION_VARIABLE]
    const { reachable, unreachable } = await partitionReachable([
      { id: homeProject },
      { id: regionalProject },
      { id: unknownProject },
    ])
    expect(reachable).toEqual([{ id: homeProject }])
    expect(unreachable).toEqual([
      { projectId: regionalProject, region: 'us-east-1', code: 'REGION_NOT_CONFIGURED', variable: REGION_VARIABLE },
      { projectId: unknownProject, region: 'mars-north-1', code: 'UNKNOWN_REGION' },
    ])

    process.env[REGION_VARIABLE] = regionalUrl
    expect((await partitionReachable([{ id: regionalProject }])).reachable).toEqual([{ id: regionalProject }])
  })

  it('records each skip once an hour per project, and leaves reachable projects alone', async () => {
    delete process.env[REGION_VARIABLE]
    const targets = [{ id: homeProject }, { id: regionalProject }]
    expect(await skipUnreachable(targets, 'test-pass')).toEqual([{ id: homeProject }])
    expect(await skipUnreachable(targets, 'test-pass')).toEqual([{ id: homeProject }])
    expect(await canReach(regionalProject, 'test-pass')).toBe(false)

    const rows = await skipRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].projectId).toBe(regionalProject)
    expect(JSON.parse(rows[0].details ?? '{}')).toEqual({
      reason: 'REGION_NOT_CONFIGURED',
      region: 'us-east-1',
      variable: REGION_VARIABLE,
      pass: 'test-pass',
    })

    process.env[REGION_VARIABLE] = regionalUrl
    expect(await canReach(regionalProject, 'test-pass')).toBe(true)
  })
})

describe('the autonomy probes read the project’s region', () => {
  // Everything here exists only in the regional database: a token table with an
  // expiry column, a PostgREST registry that has not registered the schema, and
  // the marker column a recorded intent and an ADD_COLUMN postcondition name.
  // Read from the home database, the schema is absent and every probe would
  // find nothing.
  beforeAll(async () => {
    await run(
      regionalUrl,
      `CREATE TABLE "${schemaOf(regionalProject)}".sessions (id int, expires_at timestamptz);
       CREATE FUNCTION public.backenly_pgrst_current_schemas() RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$`,
    )
    await prisma.schemaIntent.create({
      data: { projectId: regionalProject, tableName: 'marker', columnName: 'note', requestedType: 'text', source: 'add_column' },
    })
  })

  beforeEach(() => resetCapabilityCache())

  afterAll(async () => {
    await run(
      regionalUrl,
      `DROP TABLE IF EXISTS "${schemaOf(regionalProject)}".sessions;
       DROP FUNCTION IF EXISTS public.backenly_pgrst_current_schemas()`,
    ).catch(() => {})
    await prisma.schemaIntent.deleteMany({ where: { projectId: regionalProject } })
    await prisma.dbBaselineSample.deleteMany({ where: { projectId: regionalProject } })
    await prisma.projectPreference.deleteMany({ where: { projectId: regionalProject, type: 'baseline_raw' } })
  })

  it('finds what is in the region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    expect((await detectExpiredTokenBuildup(regionalProject)).map((f) => f.details?.tableName)).toEqual(['sessions'])
    expect((await detectUnregisteredSchema(regionalProject)).map((f) => f.type)).toEqual(['schema_not_registered'])
    expect(await checkIntentConformance(regionalProject)).toMatchObject({ checked: 1, findings: [] })
    expect(
      await verifyPostcondition('ADD_COLUMN', regionalProject, { tableName: 'marker', columnName: 'note', columnType: 'text' }),
    ).toBe('confirmed')
    expect(await detectRuntimeEngineMismatch(regionalProject)).toEqual([])
    expect(await detectIdleInTransaction(regionalProject)).toEqual([])
    expect(await detectMigrationResidue(regionalProject)).toEqual([])
  })

  it('samples baseline statistics from the region', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    await collectBaseline(regionalProject)
    const samples = await prisma.dbBaselineSample.findMany({
      where: { projectId: regionalProject, kind: 'table' },
      select: { subject: true },
    })
    expect(samples.map((s) => s.subject)).toEqual(expect.arrayContaining(['marker:bytes', 'sessions:bytes']))
  })

  it('fails as the region error without a connection, never as a wrapped probe failure or a clean result', async () => {
    delete process.env[REGION_VARIABLE]
    const refused = { code: 'REGION_NOT_CONFIGURED' }
    await expect(computeDesiredStateDiff(regionalProject)).rejects.toMatchObject(refused)
    await expect(detectExpiredTokenBuildup(regionalProject)).rejects.toMatchObject(refused)
    await expect(detectUnregisteredSchema(regionalProject)).rejects.toMatchObject(refused)
    await expect(detectRuntimeEngineMismatch(regionalProject)).rejects.toMatchObject(refused)
    await expect(detectMigrationResidue(regionalProject)).rejects.toMatchObject(refused)
    await expect(detectIdleInTransaction(regionalProject)).rejects.toMatchObject(refused)
    await expect(checkIntentConformance(regionalProject)).rejects.toMatchObject(refused)
    await expect(collectBaseline(regionalProject)).rejects.toMatchObject(refused)
    await expect(
      verifyPostcondition('ADD_COLUMN', regionalProject, { tableName: 'marker', columnName: 'note', columnType: 'text' }),
    ).rejects.toMatchObject(refused)
    await expect(hasCapability('pg_stat_statements', 'us-east-1')).rejects.toMatchObject(refused)
  })
})

describe('storage is measured in the project’s region', () => {
  afterAll(async () => {
    await prisma.projectUsage.deleteMany({ where: { projectId: regionalProject } })
  })

  it('measures the regional schemas, and records nothing it could not measure', async () => {
    // Read from the home database the schema is absent: 0 bytes, recorded as
    // the project's size for the quota check and for billing.
    delete process.env[REGION_VARIABLE]
    await expect(measureProjectDbBytes(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await snapshotProjectDbStorage(regionalProject)
    expect(await prisma.projectUsage.count({ where: { projectId: regionalProject } })).toBe(0)

    process.env[REGION_VARIABLE] = regionalUrl
    expect(await measureProjectDbBytes(regionalProject)).toBeGreaterThan(BigInt(0))
    await snapshotProjectDbStorage(regionalProject)
    const usage = await prisma.projectUsage.findFirst({ where: { projectId: regionalProject } })
    expect(usage?.dbStorageUsedMb ?? 0).toBeGreaterThan(0)
  })
})

describe('a project recording a region this build does not know', () => {
  it('is refused, never read as the home region', async () => {
    await expect(projectRegion(unknownProject)).rejects.toMatchObject({ code: 'UNKNOWN_REGION' })
    await expect(queryWorkspace(unknownProject, 'SELECT 1')).rejects.toMatchObject({ code: 'UNKNOWN_REGION' })
  })
})

describe('a project with no row', () => {
  it('resolves to the home region, as every project did before regions', async () => {
    expect(await projectRegion(randomUUID())).toBe('ap-south-1')
  })
})
