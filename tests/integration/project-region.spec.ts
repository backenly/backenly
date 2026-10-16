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
import { scoreReadiness } from '@/lib/deployment/readiness-scorer'
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
import http from 'http'
import type { AddressInfo } from 'net'
import { pruneDanglingSchemas } from '@/lib/postgrest/health'
import { healDataPlane } from '@/lib/postgrest/supervisor'
import { applyRemedy } from '@/lib/autonomy/hypothesis/remedy'
import { PROBE_REGISTRY } from '@/lib/autonomy/hypothesis/probes'
import { executeMaintenanceAddStructure } from '@/lib/autonomy/maintenance/primitives/add-structure'
import { dualWriteInstalled, installDualWrite, removeDualWrite } from '@/lib/autonomy/maintenance/primitives/dual-write'
import { runBackfillBatch } from '@/lib/autonomy/maintenance/primitives/backfill'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { measureProjectDbBytes, snapshotProjectDbStorage } from '@/lib/usage/db-storage'
import { getSchemaVersion, rollbackToVersion, snapshotSchema } from '@/lib/versioning/schema-versions'

// workspace-backup reads BACKUP_DIR when it loads, so it is pinned here and the
// module is only loaded lazily, in the backup block below.
const BACKUP_DIR = mkdtempSync(join(tmpdir(), 'project-region-backups-'))
process.env.BACKUP_DIR = BACKUP_DIR

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

describe('schema history is recorded and rolled back in the project’s region', () => {
  // Read from the home database, a regional project's schema has no tables: a
  // snapshot recorded none, and a rollback diffed two empty sets and reported
  // there was nothing to roll back while the table it should drop stayed.
  const probe = () => `"${schemaOf(regionalProject)}".rollback_probe`
  let versionId = ''

  afterAll(async () => {
    await run(regionalUrl, `DROP TABLE IF EXISTS ${probe()} CASCADE`).catch(() => {})
    await prisma.schemaVersion.deleteMany({ where: { projectId: regionalProject } }).catch(() => {})
  })

  it('records the regional schema, and rolls back a table added there since', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    versionId = await snapshotSchema(regionalProject, 'before rollback_probe', 'test')
    expect((await getSchemaVersion(versionId, regionalProject))?.snapshot.tables.map((t) => t.name)).toEqual(['marker'])

    await run(regionalUrl, `CREATE TABLE ${probe()} (id int PRIMARY KEY)`)
    const result = await rollbackToVersion(regionalProject, versionId)
    expect(result).toMatchObject({ success: true, message: expect.stringMatching(/Dropped 1 table/) })

    const left = await rowsIn<{ table_name: string }>(
      regionalUrl,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schemaOf(regionalProject)}' ORDER BY table_name`,
    )
    expect(left.map((t) => t.table_name)).toEqual(['marker'])
    expect(await rowsIn(regionalUrl, `SELECT note FROM "${schemaOf(regionalProject)}".marker`)).toEqual([{ note: 'us-east-1' }])
  })

  it('refuses without a connection to the region, never recording an empty schema or reporting nothing to roll back', async () => {
    delete process.env[REGION_VARIABLE]
    const refused = { code: 'REGION_NOT_CONFIGURED' }
    await expect(snapshotSchema(regionalProject, 'no connection', 'test')).rejects.toMatchObject(refused)
    await expect(rollbackToVersion(regionalProject, versionId)).rejects.toMatchObject(refused)
  })
})

describe('the deploy readiness gate reads the project’s region', () => {
  // Asked of the home database, a regional project had no tables there: the
  // blocking route-protection check passed without looking at any, and the
  // users table that auth needs was always missing.
  let gated = ''
  const schema = () => schemaOf(gated)
  const check = (checks: Array<{ id: string }>, id: string) => checks.find((c) => c.id === id) as any

  beforeAll(async () => {
    gated = await createProject('us-east-1')
    await prisma.project.update({
      where: { id: gated },
      data: { jwtSecret: randomBytes(32).toString('hex'), authManifest: { enabled: true } },
    })
    await run(
      regionalUrl,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
       CREATE SCHEMA "${schema()}";
       CREATE TABLE "${schema()}".users (id uuid PRIMARY KEY);
       CREATE TABLE "${schema()}".open_writes (id int PRIMARY KEY);
       GRANT INSERT ON "${schema()}".open_writes TO anon`,
    )
  })

  afterAll(async () => {
    await run(regionalUrl, `DROP SCHEMA IF EXISTS "${schema()}" CASCADE`).catch(() => {})
    await prisma.project.deleteMany({ where: { id: gated } }).catch(() => {})
  })

  it('finds the regional table anyone can write, and the regional users table', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const { checks } = await scoreReadiness(gated)
    expect(check(checks, 'route_protection')).toMatchObject({ status: 'fail' })
    expect(check(checks, 'route_protection').details.join(' ')).toMatch(/open_writes/)
    expect(check(checks, 'end_user_auth_table')).toMatchObject({ status: 'pass' })
  })

  it('without a connection to the region, is refused rather than scored', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(scoreReadiness(gated)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
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

  // A regional project's data routes are served by its region's own service
  // (lib/data-plane/serving.ts); this process plays that service.
  afterAll(() => {
    delete process.env.BACKENLY_SERVICE_REGION
  })

  beforeAll(async () => {
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
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
    // Served by the region's own service, which this process plays here.
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
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
      delete process.env.BACKENLY_SERVICE_REGION
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
    // As Virginia's own service with no connection to Virginia's database: its
    // project is the one this process must handle, and it cannot reach it. The
    // home project is Mumbai's service's, so it is not this pass's at all.
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    try {
      delete process.env[REGION_VARIABLE]
      const targets = [{ id: homeProject }, { id: regionalProject }]
      expect(await skipUnreachable(targets, 'test-pass')).toEqual([])
      expect(await skipUnreachable(targets, 'test-pass')).toEqual([])
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
    } finally {
      delete process.env.BACKENLY_SERVICE_REGION
    }
  })

  it('leaves another region’s projects to that region, even when it could reach them, and records nothing', async () => {
    await prisma.auditLog.deleteMany({ where: { action: AUTONOMY_SKIPPED, projectId: { in: [homeProject, regionalProject] } } })
    process.env[REGION_VARIABLE] = regionalUrl
    delete process.env.BACKENLY_SERVICE_REGION
    const targets = [{ id: homeProject }, { id: regionalProject }]
    expect(await skipUnreachable(targets, 'test-pass')).toEqual([{ id: homeProject }])
    expect(await canReach(regionalProject, 'test-pass')).toBe(false)

    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    try {
      expect(await skipUnreachable(targets, 'test-pass')).toEqual([{ id: regionalProject }])
    } finally {
      delete process.env.BACKENLY_SERVICE_REGION
    }
    expect(await skipRows()).toEqual([])
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

describe('each region’s data plane is checked and healed on its own', () => {
  // Stand-ins for the registry helpers (scripts/sql/postgrest-schema-registry.sql),
  // in the regional database only. The registry holds the project's schema and
  // one that no longer exists; every call is recorded, so a call sent to any
  // other database leaves no row here.
  const saved = { url: process.env.POSTGREST_URL }
  let regionalPostgrest: http.Server
  const calls = () => rowsIn<{ op: string; arg: string | null }>(regionalUrl, 'SELECT op, arg FROM public.pgrst_calls ORDER BY seq')

  beforeAll(async () => {
    await run(
      regionalUrl,
      `CREATE TABLE public.pgrst_registry (schema_name text);
          CREATE TABLE public.pgrst_calls (seq serial, op text, arg text);
          CREATE FUNCTION public.backenly_pgrst_current_schemas() RETURNS text LANGUAGE sql AS $$
            SELECT coalesce(string_agg(schema_name, ',' ORDER BY schema_name), '') FROM public.pgrst_registry
          $$;
          CREATE FUNCTION public.backenly_pgrst_prune_schemas() RETURNS void LANGUAGE sql AS $$
            INSERT INTO public.pgrst_calls (op) VALUES ('prune');
            DELETE FROM public.pgrst_registry r
             WHERE NOT EXISTS (SELECT 1 FROM information_schema.schemata s WHERE s.schema_name = r.schema_name);
          $$;
          CREATE FUNCTION public.backenly_pgrst_reload() RETURNS void LANGUAGE sql AS $$
            INSERT INTO public.pgrst_calls (op) VALUES ('reload')
          $$;
          CREATE FUNCTION public.backenly_pgrst_prepare_schema(s text) RETURNS void LANGUAGE sql AS $$
            INSERT INTO public.pgrst_calls (op, arg) VALUES ('prepare', s)
          $$;`,
    )
    await run(
      regionalUrl,
      `INSERT INTO public.pgrst_registry VALUES ('${schemaOf(regionalProject)}'), ('workspace_gone_from_virginia')`,
    )
    // The region's PostgREST: answers its root, as a healthy one does.
    regionalPostgrest = http.createServer((_req, res) => res.writeHead(200).end('{}'))
    await new Promise<void>((resolve) => regionalPostgrest.listen(0, '127.0.0.1', () => resolve()))
  })

  afterAll(async () => {
    if (saved.url === undefined) delete process.env.POSTGREST_URL
    else process.env.POSTGREST_URL = saved.url
    delete process.env.POSTGREST_URL_US_EAST_1
    await new Promise((resolve) => regionalPostgrest.close(resolve))
    await run(
      regionalUrl,
      `DROP FUNCTION IF EXISTS public.backenly_pgrst_current_schemas(), public.backenly_pgrst_prune_schemas(),
         public.backenly_pgrst_reload(), public.backenly_pgrst_prepare_schema(text);
       DROP TABLE IF EXISTS public.pgrst_registry, public.pgrst_calls`,
    ).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: regionalProject, type: 'health' } })
  })

  it('reads the registry of the project’s region when diagnosing, and repairs it there', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const ctx = { projectId: regionalProject }
    expect(await PROBE_REGISTRY.dangling_registrations(ctx)).toMatchObject({ outcome: 'present' })
    expect(await PROBE_REGISTRY.database_reachable(ctx)).toEqual({ outcome: 'reachable' })

    expect(await pruneDanglingSchemas('us-east-1')).toBe(1)
    const verdict = {
      kind: 'conclusive',
      hypothesis: { id: 'h', statement: 's', prior: 1, predicts: {}, remedy: { summary: 'prepare', autoApplicable: true, action: 'POSTGREST_PREPARE_SCHEMA' } },
    } as unknown as Parameters<typeof applyRemedy>[1]
    expect(await applyRemedy(regionalProject, verdict)).toMatchObject({ applied: true })

    expect(await calls()).toEqual([
      { op: 'prune', arg: null },
      { op: 'prepare', arg: schemaOf(regionalProject) },
      { op: 'reload', arg: null },
    ])
  })

  it('heals the project’s region, asking that region’s PostgREST and never the home one', async () => {
    // The home PostgREST is down. A heal that asked it would not come back healthy.
    process.env.POSTGREST_URL = 'http://127.0.0.1:9'
    process.env.POSTGREST_URL_US_EAST_1 = `http://127.0.0.1:${(regionalPostgrest.address() as AddressInfo).port}`

    const result = await healDataPlane(regionalProject)

    expect(result).toMatchObject({ outcome: 'already_healthy', healthy: true })
    const rows = await prisma.auditLog.findMany({ where: { projectId: regionalProject, action: 'DATA_PLANE_HEAL_VERIFIED' } })
    expect(rows.map((r) => JSON.parse(r.details ?? '{}').region)).toEqual(['us-east-1'])
  })

  it('reports a region it has no PostgREST address for as unreachable, never healthy', async () => {
    delete process.env.POSTGREST_URL_US_EAST_1
    const result = await healDataPlane(regionalProject)
    expect(result).toMatchObject({ outcome: 'region_not_reachable', healthy: false })
    expect(result.notes.join(' ')).toMatch(/POSTGREST_URL_US_EAST_1/)
  })

  it('refuses without a connection to the region', async () => {
    delete process.env[REGION_VARIABLE]
    const refused = { code: 'REGION_NOT_CONFIGURED' }
    await expect(PROBE_REGISTRY.dangling_registrations({ projectId: regionalProject })).rejects.toMatchObject(refused)
    await expect(pruneDanglingSchemas('us-east-1')).rejects.toMatchObject(refused)
    const verdict = {
      kind: 'conclusive',
      hypothesis: { id: 'h', statement: 's', prior: 1, predicts: {}, remedy: { summary: 'reload', autoApplicable: true, action: 'POSTGREST_RELOAD_SCHEMA' } },
    } as unknown as Parameters<typeof applyRemedy>[1]
    await expect(applyRemedy(regionalProject, verdict)).rejects.toMatchObject(refused)
  })
})

describe('the maintenance primitives act on the project’s region', () => {
  // `ledger` exists only in the regional database. Read from the home one, every
  // primitive below would see no table at all.
  const ledger = () => `"${schemaOf(regionalProject)}".ledger`
  const upper = { kind: 'upper' } as const
  // A function: regionalProject is only assigned in the top-level beforeAll.
  const spec = () => ({ projectId: regionalProject, table: 'ledger', sourceColumn: 'status', targetColumn: 'state', transform: upper })

  beforeAll(async () => {
    await run(
      regionalUrl,
      `CREATE TABLE ${ledger()} (id int PRIMARY KEY, status text, state text);
       INSERT INTO ${ledger()} VALUES (1, 'open', NULL), (2, 'shut', NULL)`,
    )
  })

  afterAll(async () => {
    await run(regionalUrl, `DROP TABLE IF EXISTS ${ledger()} CASCADE`).catch(() => {})
  })

  it('reads the regional catalog before it acts, and acts there', async () => {
    process.env[REGION_VARIABLE] = regionalUrl

    // The column add_structure would add is already on the regional table.
    expect(
      await executeMaintenanceAddStructure({ projectId: regionalProject, table: 'ledger', column: 'status', columnType: 'text' }),
    ).toMatchObject({ added: false, refusal: expect.stringMatching(/already exists/) })

    const dualWrite = await installDualWrite(spec())
    expect(dualWrite).toMatchObject({ installed: true, refusal: null })
    expect(await dualWriteInstalled(regionalProject, 'ledger', dualWrite.objectName)).toBe(true)

    expect(await runBackfillBatch(spec(), null)).toMatchObject({ refusal: null, scanned: 2, updated: 2, done: true })
    expect(await rowsIn(regionalUrl, `SELECT state FROM ${ledger()} ORDER BY id`)).toEqual([{ state: 'OPEN' }, { state: 'SHUT' }])

    expect(await removeDualWrite(regionalProject, 'ledger', 'state')).toMatchObject({ removed: true })
    expect(await dualWriteInstalled(regionalProject, 'ledger', dualWrite.objectName)).toBe(false)
  })

  it('refuses without a connection to the region, and never reports a removal it could not confirm', async () => {
    delete process.env[REGION_VARIABLE]
    const refused = { code: 'REGION_NOT_CONFIGURED' }
    await expect(dualWriteInstalled(regionalProject, 'ledger', 'bkn_dw_ledger_state')).rejects.toMatchObject(refused)
    expect(await removeDualWrite(regionalProject, 'ledger', 'state')).toMatchObject({ removed: false })
    await expect(installDualWrite(spec())).rejects.toMatchObject(refused)
    await expect(runBackfillBatch(spec(), null)).rejects.toMatchObject(refused)
    await expect(
      executeMaintenanceAddStructure({ projectId: regionalProject, table: 'ledger', column: 'extra', columnType: 'text' }),
    ).rejects.toMatchObject(refused)
  })
})

describe('backups, restores and archive cleanup use the project’s region', () => {
  let backups: typeof import('@/lib/services/workspace-backup')
  let archives: typeof import('@/lib/rollback/non-destructive-restore')
  const refused = { code: 'REGION_NOT_CONFIGURED' }
  const archivedTable = () => `"${schemaOf(regionalProject)}"."Marker__archived__1"`
  const oldArchive = (archivedName: string) =>
    prisma.tableArchive.create({
      data: {
        projectId: regionalProject,
        originalName: 'marker',
        archivedName,
        archivedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
        reason: 'rollback',
      },
    })

  beforeAll(async () => {
    backups = await import('@/lib/services/workspace-backup')
    archives = await import('@/lib/rollback/non-destructive-restore')
  })

  afterAll(async () => {
    delete process.env.BACKUP_DATABASE_URL_US_EAST_1
    await prisma.workspaceBackup.deleteMany({ where: { projectId: regionalProject } })
    await prisma.backgroundJob.deleteMany({ where: { projectId: regionalProject, type: { in: ['workspace_backup', 'workspace_restore'] } } })
    await prisma.tableArchive.deleteMany({ where: { projectId: regionalProject } })
    await run(regionalUrl, `DROP TABLE IF EXISTS ${archivedTable()}`).catch(() => {})
    rmSync(BACKUP_DIR, { recursive: true, force: true })
  })

  /** Run `work` as Virginia's own process: snapshots of its projects are taken and restored only there. */
  async function asVirginia<T>(work: () => Promise<T>): Promise<T> {
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    try {
      return await work()
    } finally {
      delete process.env.BACKENLY_SERVICE_REGION
    }
  }

  it('dumps the regional schema and restores it in the region, creating nothing at home', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const schema = schemaOf(regionalProject)

    const snapshot = await asVirginia(() => backups.backupWorkspace(regionalProject))
    expect(snapshot).toMatchObject({ success: true })
    expect(snapshot.filePath?.startsWith(BACKUP_DIR)).toBe(true)

    await run(regionalUrl, `DELETE FROM "${schema}".marker`)
    expect(await asVirginia(() => backups.restoreWorkspace(regionalProject))).toMatchObject({ success: true })

    const notes = await rowsIn<{ note: string }>(regionalUrl, `SELECT note FROM "${schema}".marker WHERE note = 'us-east-1'`)
    expect(notes).toEqual([{ note: 'us-east-1' }])
    expect(await rowsIn(homeUrl(), `SELECT 1 FROM information_schema.schemata WHERE schema_name = '${schema}'`)).toEqual([])
  })

  it('is never dumped or restored at home: the home process queues both for the region, which carries them out', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const { processRegionalJobs } = await import('@/lib/queue/worker')
    const schema = schemaOf(regionalProject)
    const elsewhere = { code: 'SNAPSHOT_IN_ANOTHER_REGION', region: 'us-east-1' }

    // At home: refused outright, before anything is dumped, read or written.
    const before = await prisma.workspaceBackup.count({ where: { projectId: regionalProject } })
    await expect(backups.backupWorkspace(regionalProject)).rejects.toMatchObject(elsewhere)
    await expect(backups.restoreWorkspace(regionalProject)).rejects.toMatchObject(elsewhere)
    await expect(backups.resolveSnapshotFile(regionalProject, 'any')).rejects.toMatchObject(elsewhere)
    expect(await prisma.workspaceBackup.count({ where: { projectId: regionalProject } })).toBe(before)

    // Asked for at home, the snapshot is queued for us-east-1, which the home
    // region's scheduler leaves alone and Virginia's carries out.
    const asked = await backups.requestBackup(regionalProject, ownerId)
    expect(asked).toMatchObject({ kind: 'queued', region: 'us-east-1' })
    const jobId = asked.kind === 'queued' ? asked.jobId : ''
    expect(await prisma.backgroundJob.findUnique({ where: { id: jobId } })).toMatchObject({ status: 'regional_pending' })
    expect(await processRegionalJobs()).toMatchObject({ processed: 0 })
    expect(await asVirginia(() => processRegionalJobs())).toMatchObject({ processed: 1, succeeded: 1 })
    expect(await prisma.backgroundJob.findUnique({ where: { id: jobId } })).toMatchObject({ status: 'completed' })
    const taken = await prisma.workspaceBackup.findFirst({
      where: { projectId: regionalProject, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    })
    expect(taken?.filePath.startsWith(BACKUP_DIR)).toBe(true)
    // A snapshot on the region's disk has no bucket a link could reach: the
    // download is refused rather than streamed out through here.
    expect(await backups.regionalSnapshotLink(regionalProject, taken!.id)).toEqual({ kind: 'unavailable' })
    expect(await backups.regionalSnapshotLink(regionalProject, randomUUID())).toEqual({ kind: 'missing' })

    // Restored the same way, from that snapshot, in the region.
    await run(regionalUrl, `DELETE FROM "${schema}".marker`)
    const restore = await backups.requestRestore(regionalProject, taken!.id, ownerId)
    expect(restore).toMatchObject({ kind: 'queued', region: 'us-east-1' })
    expect(await asVirginia(() => processRegionalJobs())).toMatchObject({ processed: 1, succeeded: 1 })
    expect(await rowsIn(regionalUrl, `SELECT note FROM "${schema}".marker WHERE note = 'us-east-1'`)).toEqual([{ note: 'us-east-1' }])

    // A snapshot that is not this project's is refused at once, not queued.
    expect(await backups.requestRestore(regionalProject, randomUUID(), ownerId)).toMatchObject({
      kind: 'done',
      result: { success: false },
    })
  })

  it('drops an expired archive in the region, and only then records it deleted', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    await run(regionalUrl, `CREATE TABLE ${archivedTable()} (note text)`)
    const archive = await oldArchive('marker__archived__1')

    expect(await archives.cleanupOldArchives(regionalProject)).toMatchObject({ deletedTables: 1 })
    expect(
      await rowsIn(regionalUrl, `SELECT 1 FROM information_schema.tables WHERE table_name = 'Marker__archived__1'`),
    ).toEqual([])
    expect(await prisma.tableArchive.findUnique({ where: { id: archive.id } })).toMatchObject({ canRestore: false })
  })

  it('connects with the region’s own credentials, and scrubs them from messages', () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const dbname = (args: string[]) => args[args.indexOf('--dbname') + 1]
    expect(dbname(backups.buildConnection('read', 'us-east-1').args)).toBe(REGIONAL_DB)
    expect(dbname(backups.buildConnection('write', 'us-east-1').args)).toBe(REGIONAL_DB)

    process.env.BACKUP_DATABASE_URL_US_EAST_1 = 'postgresql://reader:regional-secret-7f3a@127.0.0.1:5432/x'
    expect(backups.sanitizeError('pg_dump: password regional-secret-7f3a rejected')).not.toContain('regional-secret-7f3a')
    delete process.env.BACKUP_DATABASE_URL_US_EAST_1
  })

  it('refuses without a connection to the region, and records no failed snapshot', async () => {
    delete process.env[REGION_VARIABLE]
    // In the region itself, so the refusal is the missing connection's.
    await expect(asVirginia(() => backups.backupWorkspace(regionalProject))).rejects.toMatchObject(refused)
    expect(await prisma.workspaceBackup.count({ where: { projectId: regionalProject, status: 'failed' } })).toBe(0)
    await expect(asVirginia(() => backups.restoreWorkspace(regionalProject))).rejects.toMatchObject(refused)
    let thrown: unknown
    try {
      backups.buildConnection('read', 'us-east-1')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject(refused)

    await oldArchive('marker__archived__2')
    await expect(archives.cleanupOldArchives(regionalProject)).rejects.toMatchObject(refused)
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

describe('schema drift events live in the project’s region', () => {
  // The real capture apparatus (scripts/setup-direct-access.sql) and the real
  // regional table (scripts/sql/schema-drift-events.sql), installed in the
  // regional database only, so an event found there was captured there. The
  // DDL is run as a genuine bkn_rw_ login role, the only kind the triggers record.
  // Loaded here rather than at the top, so this block adds no import lines.
  const load = async () => ({
    fs: await import('fs'),
    watch: await import('@/lib/autonomy/drift-watch'),
    upkeep: await import('@/lib/autonomy/drift-event-upkeep'),
    regional: await import('@/lib/data-plane/regional'),
  })
  const password = randomBytes(18).toString('hex')
  const notices: string[] = []
  let rw: Client | null = null

  const regionalEvents = (projectId: string) =>
    rowsIn<{ commandTag: string; objectIdentity: string | null; status: string }>(
      regionalUrl,
      `SELECT "commandTag", "objectIdentity", status FROM public.schema_drift_events
        WHERE "projectId" = '${projectId}' ORDER BY "capturedAt"`,
    )
  const columnsOf = (url: string) =>
    rowsIn<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      url,
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schema_drift_events' ORDER BY column_name`,
    )
  const indexesOf = (url: string) =>
    rowsIn<{ indexname: string }>(
      url,
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'schema_drift_events' ORDER BY indexname`,
    )

  beforeAll(async () => {
    const { fs } = await load()
    await run(regionalUrl, fs.readFileSync('scripts/setup-direct-access.sql', 'utf8'))
    await run(regionalUrl, fs.readFileSync('scripts/sql/schema-drift-events.sql', 'utf8'))
    const schema = schemaOf(regionalProject)
    const role = directAccessRoleNames(regionalProject).rw
    await run(
      regionalUrl,
      `SELECT public.backenly_direct_create_role('${role}', '${password}', '${schema}', 'READ_WRITE');
       GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${role}";`,
    )
    const url = new URL(regionalUrl)
    url.username = role
    url.password = password
    rw = new Client({ connectionString: url.toString() })
    rw.on('notice', (msg) => notices.push(msg.message ?? ''))
    await rw.connect()
  })

  afterAll(async () => {
    await rw?.end().catch(() => {})
    await run(regionalUrl, `SELECT public.backenly_direct_drop_role('${directAccessRoleNames(regionalProject).rw}')`).catch(() => {})
  })

  it('creates the regional table exactly as the platform model defines it', async () => {
    expect(await columnsOf(regionalUrl)).toEqual(await columnsOf(homeUrl()))
    expect(await indexesOf(regionalUrl)).toEqual(await indexesOf(homeUrl()))
  })

  it('records DDL from a direct connection in the region, and nowhere else', async () => {
    const schema = schemaOf(regionalProject)
    await rw!.query(`CREATE TABLE "${schema}".drift_probe (id int)`)
    const events = await regionalEvents(regionalProject)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ commandTag: 'CREATE TABLE', status: 'pending' })
    expect(events[0].objectIdentity).toContain('drift_probe')
    // The home table, the only one the platform model read before, has none.
    expect(await prisma.schemaDriftEvent.count({ where: { projectId: regionalProject } })).toBe(0)
  })

  it('is what the drift probe reads, and a region it cannot reach is not "no drift"', async () => {
    const { watch } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    const findings = await watch.detectPendingSchemaDrift(regionalProject)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe('external_schema_change')
    expect(JSON.stringify(findings[0].details)).toContain('drift_probe')

    delete process.env[REGION_VARIABLE]
    await expect(watch.detectPendingSchemaDrift(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })

  it('adopts the events in the region', async () => {
    const { watch } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    const result = await watch.adoptExternalSchema(regionalProject)
    expect(result.outcome).not.toBe('unverified')
    expect(result.adoptedEvents).toBe(1)
    expect((await regionalEvents(regionalProject)).map((e) => e.status)).toEqual(['adopted'])
    expect(await watch.reapDriftFindings(regionalProject)).toBeGreaterThanOrEqual(0)
  })

  it('never breaks the developer’s DDL when capture fails, and never fails silently', async () => {
    const { upkeep } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    expect(await upkeep.driftCaptureHealth('us-east-1')).toEqual({ status: 'healthy', problems: [] })

    await run(regionalUrl, 'ALTER TABLE public.schema_drift_events RENAME TO schema_drift_events_away')
    try {
      notices.length = 0
      await rw!.query(`CREATE TABLE "${schemaOf(regionalProject)}".drift_probe_2 (id int)`)
      expect(notices.some((n) => n.includes('BACKENLY_DRIFT_CAPTURE_FAILED'))).toBe(true)
      const health = await upkeep.driftCaptureHealth('us-east-1')
      expect(health.status).toBe('broken')
      expect(health.problems.join(' ')).toContain('schema_drift_events is missing')
    } finally {
      await run(regionalUrl, 'ALTER TABLE public.schema_drift_events_away RENAME TO schema_drift_events')
    }
    expect((await upkeep.driftCaptureHealth('us-east-1')).status).toBe('healthy')
  })

  it('keeps pending events, prunes resolved ones past retention, and reports the backlog', async () => {
    const { upkeep } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    await run(
      regionalUrl,
      `INSERT INTO public.schema_drift_events ("id", "projectId", "roleName", "commandTag", "capturedAt", "status", "resolvedAt")
       VALUES ('old-adopted', '${regionalProject}', 'bkn_rw_test', 'CREATE TABLE',
               (now() AT TIME ZONE 'UTC') - interval '120 days', 'adopted', (now() AT TIME ZONE 'UTC') - interval '119 days'),
              ('old-pending', '${regionalProject}', 'bkn_rw_test', 'CREATE TABLE',
               (now() AT TIME ZONE 'UTC') - interval '120 days', 'pending', NULL)`,
    )
    const backlog = await upkeep.driftEventBacklog('us-east-1')
    expect(backlog.pending).toBe(1)
    expect(backlog.oldestPendingSeconds).toBeGreaterThan(119 * 24 * 3600)

    expect(await upkeep.pruneResolvedDriftEvents('us-east-1', 90)).toBe(1)
    const ids = await rowsIn<{ id: string }>(regionalUrl, `SELECT id FROM public.schema_drift_events WHERE id LIKE 'old-%'`)
    expect(ids.map((r) => r.id)).toEqual(['old-pending'])

    // As Virginia's own scheduler runs it: each region upkeeps its own database.
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    try {
      const reports = await upkeep.runDriftEventUpkeep()
      expect(reports.map((r) => r.region)).toEqual(['us-east-1'])
      expect(reports[0]).toMatchObject({ health: { status: 'healthy' }, backlog: { pending: 1 }, errors: [] })
    } finally {
      delete process.env.BACKENLY_SERVICE_REGION
    }
    await run(regionalUrl, `DELETE FROM public.schema_drift_events WHERE id = 'old-pending'`)
  })

  it('is upkept by the region’s own scheduler, and not by the home region’s', async () => {
    const { upkeep } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    // Mumbai's process reaches Virginia's database for routing, and still
    // leaves Virginia's upkeep to Virginia.
    const reports = await upkeep.runDriftEventUpkeep()
    expect(reports.map((r) => r.region)).toEqual(['ap-south-1'])
  })

  it('attributes a statement that names no object to the login’s project', async () => {
    // A GRANT or REVOKE reaches the capture with no schema. It used to be stored
    // with no project, which no adoption could ever clear.
    const schema = schemaOf(regionalProject)
    const role = directAccessRoleNames(regionalProject).rw
    await rw!.query(`REVOKE ALL ON "${schema}".drift_probe FROM PUBLIC`)
    const revokes = await rowsIn<{ projectId: string | null; schemaName: string | null }>(
      regionalUrl,
      `SELECT "projectId", "schemaName" FROM public.schema_drift_events WHERE "commandTag" = 'REVOKE' AND "roleName" = '${role}'`,
    )
    expect(revokes).toEqual([{ projectId: regionalProject, schemaName: schema }])
    await run(regionalUrl, `DELETE FROM public.schema_drift_events WHERE "commandTag" = 'REVOKE' AND "roleName" = '${role}'`)
  })

  it('reads a login’s project from its name, as the platform names it, and nothing else', async () => {
    const schema = schemaOf(regionalProject)
    const names = directAccessRoleNames(regionalProject)
    const home = async (role: string) =>
      (await rowsIn<{ home: string | null }>(regionalUrl, `SELECT public.backenly_capture_home_schema('${role}') AS home`))[0].home
    expect(await home(names.rw)).toBe(schema)
    expect(await home(names.ro)).toBe(schema)
    // Function logins are named from the schema (scripts/sql/function-roles.sql).
    expect(await home(functionRoleName(schema))).toBe(schema)
    // Owner roles never log in, and no other name is anyone's.
    expect(await home(names.owner)).toBeNull()
    expect(await home('bkn_rw_000000000000')).toBeNull()
    expect(await home('backenly_app')).toBeNull()
  })

  it('counts events no adoption can clear apart from the backlog, and prunes them past retention', async () => {
    const { upkeep } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    const gone = randomUUID()
    await run(
      regionalUrl,
      `INSERT INTO public.schema_drift_events ("id", "projectId", "roleName", "commandTag", "capturedAt", "status")
       VALUES ('orphan-unnamed-old', NULL, 'bkn_rw_test', 'GRANT', (now() AT TIME ZONE 'UTC') - interval '120 days', 'pending'),
              ('orphan-gone-old', '${gone}', 'bkn_rw_test', 'CREATE TABLE', (now() AT TIME ZONE 'UTC') - interval '120 days', 'pending'),
              ('orphan-unnamed-new', NULL, 'bkn_rw_test', 'GRANT', now() AT TIME ZONE 'UTC', 'pending'),
              ('held-old', '${regionalProject}', 'bkn_rw_test', 'CREATE TABLE', (now() AT TIME ZONE 'UTC') - interval '120 days', 'pending')`,
    )
    try {
      const backlog = await upkeep.driftEventBacklog('us-east-1')
      expect(backlog).toMatchObject({ pending: 1, orphaned: 3 })
      expect(backlog.oldestPendingSeconds).toBeGreaterThan(119 * 24 * 3600)

      // Past the window only, and never a project's own pending work.
      expect(await upkeep.pruneOrphanedDriftEvents('us-east-1', 90)).toBe(2)
      const left = await rowsIn<{ id: string }>(regionalUrl, `SELECT id FROM public.schema_drift_events WHERE id LIKE 'orphan-%' OR id = 'held-old' ORDER BY id`)
      expect(left.map((r) => r.id)).toEqual(['held-old', 'orphan-unnamed-new'])

      const [virginia] = await upkeep.runDriftEventUpkeep(new Date(), ['us-east-1'])
      expect(virginia).toMatchObject({ region: 'us-east-1', backlog: { pending: 1, orphaned: 1 }, prunedOrphans: 0, errors: [] })
    } finally {
      await run(regionalUrl, `DELETE FROM public.schema_drift_events WHERE id LIKE 'orphan-%' OR id = 'held-old'`)
    }
  })
})

describe('each region’s scheduler runs only its own projects’ cron functions', () => {
  // A function's SQL and its data are in its project's region, so its schedule
  // fires there. The home region's scheduler used to fire every region's.
  const ids: string[] = []
  const due = async () => {
    const { dueCronJobs } = await import('@/lib/services/cron-runner')
    return (await dueCronJobs(new Date())).due.filter((job) => ids.includes(job.id)).map((job) => job.projectId)
  }

  beforeAll(async () => {
    for (const projectId of [homeProject, regionalProject]) {
      const fn = await prisma.aiFunction.create({
        data: {
          projectId,
          name: `cron-${projectId.slice(0, 8)}`,
          description: 'region fixture',
          generatedCode: 'return 1',
          triggerType: 'cron',
          triggerTable: '* * * * *',
          status: 'active',
        },
        select: { id: true },
      })
      ids.push(fn.id)
    }
  })

  afterAll(async () => {
    await prisma.aiFunction.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  })

  it('fires a home project’s function in the home region, and not a Virginia project’s', async () => {
    expect(await due()).toEqual([homeProject])
  })

  it('fires a Virginia project’s function in Virginia, and not the home project’s', async () => {
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    try {
      expect(await due()).toEqual([regionalProject])
    } finally {
      delete process.env.BACKENLY_SERVICE_REGION
    }
  })
})

describe('a project created in another region', () => {
  const savedEdition = process.env.BACKENLY_EDITION
  const created: string[] = []
  const schemaIn = async (url: string, schema: string) =>
    (await rowsIn<{ n: number }>(url, `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = '${schema}'`))[0].n

  beforeAll(() => {
    // Creating projects is Backenly Cloud's; the single-tenant edition refuses it.
    process.env.BACKENLY_EDITION = 'cloud'
  })

  afterAll(async () => {
    if (savedEdition === undefined) delete process.env.BACKENLY_EDITION
    else process.env.BACKENLY_EDITION = savedEdition
    for (const id of created) {
      await run(homeUrl(), `DROP SCHEMA IF EXISTS "${schemaOf(id)}" CASCADE`).catch(() => {})
    }
    await prisma.project.deleteMany({ where: { id: { in: created } } }).catch(() => {})
  })

  it('is refused before anything is written when this server cannot reach the region', async () => {
    // Loaded here rather than at the top, so this block adds no import lines.
    const { createProject } = await import('@/lib/edition/oss/project-lifecycle')
    delete process.env[REGION_VARIABLE]
    const name = `region-create-${randomUUID()}`
    await expect(createProject({ name, userId: ownerId, region: 'us-east-1' })).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
    })
    expect(await prisma.project.count({ where: { name } })).toBe(0)
  })

  it('records the region and creates its schema in the region’s database only', async () => {
    const { createProject } = await import('@/lib/edition/oss/project-lifecycle')
    process.env[REGION_VARIABLE] = regionalUrl
    const { project } = await createProject({ name: `region-create-${randomUUID()}`, userId: ownerId, region: 'us-east-1' })
    created.push(project.id)

    const row = await prisma.project.findUnique({ where: { id: project.id }, select: { region: true } })
    expect(row?.region).toBe('us-east-1')
    expect(await projectRegion(project.id)).toBe('us-east-1')
    expect(await schemaIn(regionalUrl, schemaOf(project.id))).toBe(1)
    expect(await schemaIn(homeUrl(), schemaOf(project.id))).toBe(0)
  })

  it('creates a project with no region in the home region, recorded as before', async () => {
    const { createProject } = await import('@/lib/edition/oss/project-lifecycle')
    const { project } = await createProject({ name: `region-create-${randomUUID()}`, userId: ownerId })
    created.push(project.id)

    const row = await prisma.project.findUnique({ where: { id: project.id }, select: { region: true } })
    expect(row?.region).toBeNull()
    expect(await schemaIn(homeUrl(), schemaOf(project.id))).toBe(1)
    expect(await schemaIn(regionalUrl, schemaOf(project.id))).toBe(0)
  })
})

describe('the address a regional project is given', () => {
  // Loaded here rather than at the top, so this block adds no import lines.
  const regional = () => import('@/lib/data-plane/regional')
  const API_VARIABLE = 'PUBLIC_API_ORIGIN_US_EAST_1'
  const VIRGINIA = 'https://us-east-1.api.example.test'
  const HOME = 'https://home.example.test'

  afterEach(() => {
    delete process.env[API_VARIABLE]
  })

  it('is the region’s own API address, never the home one', async () => {
    const { projectApiOrigin } = await regional()
    expect(await projectApiOrigin(homeProject, HOME)).toBe(HOME)

    delete process.env[API_VARIABLE]
    await expect(projectApiOrigin(regionalProject, HOME)).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
      variable: API_VARIABLE,
    })

    process.env[API_VARIABLE] = `${VIRGINIA}/`
    expect(await projectApiOrigin(regionalProject, HOME)).toBe(VIRGINIA)
  })

  it('is what the connect manifest hands an agent, with the SDK pointed at it', async () => {
    const { buildConnectManifest } = await import('@/lib/services/connect-manifest')
    process.env[REGION_VARIABLE] = regionalUrl
    const keys = () => prisma.apiKey.count({ where: { projectId: regionalProject } })

    // Without an address nothing is handed out, and the anon key is not minted.
    const before = await keys()
    await expect(buildConnectManifest(regionalProject, HOME)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    expect(await keys()).toBe(before)

    process.env[API_VARIABLE] = VIRGINIA
    const manifest = await buildConnectManifest(regionalProject, HOME)
    expect(manifest.project.apiBaseUrl).toBe(`${VIRGINIA}/api/v1/${regionalProject}`)
    expect(manifest.sdk.initLine).toContain(`apiUrl: "${VIRGINIA}"`)
    // The SDK file itself is still served by this host.
    expect(manifest.sdk.cdnEsm).toBe(`${HOME}/backenly-sdk.esm.js`)

    // A home project's manifest is what it always was.
    const home = await buildConnectManifest(homeProject, HOME)
    expect(home.project.apiBaseUrl).toBe(`${HOME}/api/v1/${homeProject}`)
    expect(home.sdk.initLine).not.toContain('apiUrl')
  })

  it('is where a sign-in provider is told to send the user back', async () => {
    const { WorkspaceOAuthService } = await import('@/lib/services/workspaceOAuth')
    const { default: app } = await import('@/server/app')
    // The provider's client secret is stored encrypted, and there is no default key.
    const savedKey = process.env.OAUTH_ENCRYPTION_KEY
    process.env.OAUTH_ENCRYPTION_KEY = savedKey || randomBytes(32).toString('hex')
    // A project of its own: the initiate needs a signing secret and a provider.
    const projectId = await createProject('us-east-1')
    const server = http.createServer(app)
    try {
      await prisma.project.update({ where: { id: projectId }, data: { jwtSecret: randomBytes(32).toString('hex') } })
      await WorkspaceOAuthService.upsertConfig(projectId, {
        provider: 'google',
        clientId: 'region-client-id',
        clientSecret: 'region-client-secret',
      } as Parameters<typeof WorkspaceOAuthService.upsertConfig>[1])

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const initiate = () => fetch(`${base}/api/v1/${projectId}/auth/google`, { redirect: 'manual' })
      // The sign-in starts at the region's own service, which this process plays.
      process.env.BACKENLY_SERVICE_REGION = 'us-east-1'

      // No address for the region: refused, not sent to the provider with the home one.
      expect((await initiate()).status).toBe(503)

      process.env[API_VARIABLE] = VIRGINIA
      const res = await initiate()
      expect(res.status).toBe(302)
      const redirectUri = new URL(res.headers.get('location') as string).searchParams.get('redirect_uri')
      expect(redirectUri).toBe(`${VIRGINIA}/api/v1/${projectId}/auth/google/callback`)
    } finally {
      if (server.listening) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      delete process.env.BACKENLY_SERVICE_REGION
      await prisma.workspaceOAuthConfig.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
      if (savedKey === undefined) delete process.env.OAUTH_ENCRYPTION_KEY
      else process.env.OAUTH_ENCRYPTION_KEY = savedKey
    }
  })
})

describe('each region’s projects are served only in that region', () => {
  // The guard sits in recordedV1, the wrapper every /api/v1 and /api/v2 Next
  // route exports through, and in the runtime's Express chain for single-box
  // layouts. Driven here through the real healthz route and the real runtime.
  const API_VARIABLE = 'PUBLIC_API_ORIGIN_US_EAST_1'
  const VIRGINIA = 'https://us-east-1.api.example.test'
  const healthz = (projectId: string) =>
    healthzRoute(new NextRequest(`https://backenly.test/api/v1/${projectId}/healthz`), {
      params: Promise.resolve({ projectId }),
    })

  afterEach(() => {
    delete process.env.BACKENLY_SERVICE_REGION
    delete process.env[API_VARIABLE]
  })

  it('answers another region’s project 421 WRONG_REGION with its own address, and never serves it', async () => {
    process.env[REGION_VARIABLE] = regionalUrl // reachable from here over peering, and still refused
    process.env[API_VARIABLE] = VIRGINIA
    const res = await healthz(regionalProject)
    expect(res.status).toBe(421)
    expect(await res.json()).toEqual({
      success: false,
      error: "This project's data is in us-east-1, and it is served only there.",
      code: 'WRONG_REGION',
      region: 'us-east-1',
      apiUrl: `${VIRGINIA}/api/v1/${regionalProject}`,
    })

    // Without an address for the region it still refuses; it just cannot say where to go.
    delete process.env[API_VARIABLE]
    expect(await (await healthz(regionalProject)).json()).toMatchObject({ code: 'WRONG_REGION', apiUrl: null })
  })

  it('serves its own region’s project, and refuses the home one when it is the regional service', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    expect((await healthz(regionalProject)).status).not.toBe(421)

    const home = await healthz(homeProject)
    expect(home.status).toBe(421)
    expect(await home.json()).toMatchObject({ code: 'WRONG_REGION', region: 'ap-south-1' })

    // The home project is served by the home service, as always.
    delete process.env.BACKENLY_SERVICE_REGION
    expect((await healthz(homeProject)).status).not.toBe(421)
  })

  it('refuses to serve anything while BACKENLY_SERVICE_REGION names no known region', async () => {
    process.env.BACKENLY_SERVICE_REGION = 'mars-north-1'
    const res = await healthz(homeProject)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: 'UNKNOWN_SERVICE_REGION' })
  })

  it('refuses the same way in the runtime, before any of its routers', async () => {
    const { default: app } = await import('@/server/app')
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      process.env[REGION_VARIABLE] = regionalUrl
      process.env[API_VARIABLE] = VIRGINIA
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      for (const path of [`/api/v1/${regionalProject}/db/marker`, `/api/v2/${regionalProject}/marker`]) {
        const res = await fetch(`${base}${path}`)
        expect(res.status).toBe(421)
        expect(await res.json()).toMatchObject({ code: 'WRONG_REGION', apiUrl: `${VIRGINIA}/api/v1/${regionalProject}` })
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
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

describe('deleting a project in another region', () => {
  // Its schema and its logins live in its region's cluster, which the platform
  // transaction cannot reach. They are dropped there first (lib/projects/delete.ts).
  const load = async () => import('@/lib/projects/delete')
  const purgeJobPayload = async (projectId: string) =>
    (await prisma.backgroundJob.findFirst({ where: { type: 'purge_project', payload: { path: ['projectId'], equals: projectId } } }))
      ?.payload as Record<string, unknown> | undefined

  /** A regional project with a schema and a direct-access login granted on it, in the region. */
  async function regionalProjectWithLogin(userId = ownerId): Promise<{ projectId: string; schema: string; role: string }> {
    const project = await prisma.project.create({
      data: { name: `region-${randomUUID()}`, userId, region: 'us-east-1' },
      select: { id: true },
    })
    const projectId = project.id
    const schema = schemaOf(projectId)
    const role = directAccessRoleNames(projectId).ro
    await seedMarker(regionalUrl, schema, 'to be deleted')
    await run(
      regionalUrl,
      `CREATE ROLE "${role}" LOGIN PASSWORD '${randomBytes(12).toString('hex')}';
       GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
       GRANT SELECT ON "${schema}".marker TO "${role}"`,
    )
    await prisma.databaseCredential.create({
      data: { projectId, mode: 'READ_ONLY', roleName: role, passwordCipher: 'x', passwordIv: 'x', passwordTag: 'x' },
    })
    return { projectId, schema, role }
  }

  const schemaExists = async (url: string, schema: string) =>
    (await rowsIn(url, `SELECT 1 FROM pg_namespace WHERE nspname = '${schema}'`)).length > 0
  const roleExists = async (role: string) =>
    (await rowsIn(homeUrl(), `SELECT 1 FROM pg_roles WHERE rolname = '${role}'`)).length > 0

  it('drops its schema and its login in its region, then its platform rows', async () => {
    const { deleteProjectCompletely } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    const { projectId, schema, role } = await regionalProjectWithLogin()

    const result = await deleteProjectCompletely(projectId)

    expect(result.schemasDropped).toContain(schema)
    expect(await schemaExists(regionalUrl, schema)).toBe(false)
    expect(await roleExists(role)).toBe(false)
    expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull()
    expect(await prisma.databaseCredential.count({ where: { projectId } })).toBe(0)
    // Where its files live is recorded while that can still be read.
    expect(await purgeJobPayload(projectId)).toMatchObject({ projectId, region: 'us-east-1' })
  })

  it('leaves its files and backups to its own region, whose scheduler purges them', async () => {
    const { deleteProjectCompletely } = await load()
    const { processPurgeJobs } = await import('@/lib/queue/worker')
    process.env[REGION_VARIABLE] = regionalUrl
    const { projectId } = await regionalProjectWithLogin()
    const status = async () =>
      (await prisma.backgroundJob.findFirst({ where: { type: 'purge_project', payload: { path: ['projectId'], equals: projectId } } }))
        ?.status

    const result = await deleteProjectCompletely(projectId)

    // Its bucket and disks are Virginia's, not this process's: the home
    // process leaves them, and says the purge is still to come.
    expect(result.externalPurgeCompleted).toBe(false)
    expect(await status()).toBe('purge_pending')

    // Virginia's scheduler finishes it.
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    try {
      await processPurgeJobs()
    } finally {
      delete process.env.BACKENLY_SERVICE_REGION
    }
    expect(await status()).toBe('completed')
  })

  it('stops before anything is dropped when this process cannot reach the region', async () => {
    const { deleteProjectCompletely } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    const { projectId, schema, role } = await regionalProjectWithLogin()
    delete process.env[REGION_VARIABLE]
    try {
      await expect(deleteProjectCompletely(projectId)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
      expect(await prisma.project.findUnique({ where: { id: projectId } })).not.toBeNull()
      expect(await schemaExists(regionalUrl, schema)).toBe(true)
      expect(await roleExists(role)).toBe(true)
    } finally {
      // The retry, once the region is reachable, finishes the job.
      process.env[REGION_VARIABLE] = regionalUrl
      await deleteProjectCompletely(projectId)
    }
    expect(await schemaExists(regionalUrl, schema)).toBe(false)
  })

  it('deletes an account’s projects in every region', async () => {
    const { deleteAccountCompletely } = await load()
    process.env[REGION_VARIABLE] = regionalUrl
    const user = await prisma.user.create({
      data: { email: `region-delete-${randomUUID()}@example.test`, name: 'region delete fixture' },
      select: { id: true },
    })
    const home = await prisma.project.create({
      data: { name: `region-${randomUUID()}`, userId: user.id, region: null },
      select: { id: true },
    })
    await seedMarker(homeUrl(), schemaOf(home.id), 'home, to be deleted')
    const regional = await regionalProjectWithLogin(user.id)

    const result = await deleteAccountCompletely(user.id)

    expect(result.projectIds.sort()).toEqual([home.id, regional.projectId].sort())
    expect(await schemaExists(homeUrl(), schemaOf(home.id))).toBe(false)
    expect(await schemaExists(regionalUrl, regional.schema)).toBe(false)
    expect(await roleExists(regional.role)).toBe(false)
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull()
  })
})
