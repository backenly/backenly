/**
 * WORKSPACE SQL KEEPS WORKING AFTER A TABLE'S COLUMNS CHANGE
 * ==========================================================
 * Prisma keeps a prepared statement on each pooled connection, keyed by its
 * SQL text, and PostgreSQL will not execute one again once its result columns
 * have changed: 0A000 "cached plan must not change result type". Workspace SQL
 * reads and returns whole rows (`SELECT *`, `RETURNING *`), so after a column
 * was added or dropped the same request failed on every connection that had
 * run it before, until the connection was replaced. A staging database showed
 * it on the v1 query route after a column was added and then rolled back.
 * Workspace SQL now runs with Prisma's statement cache off
 * (lib/data-plane/statement-cache.ts).
 *
 * Each case runs the same statement twice, changes the table's columns, and
 * runs it again through the same pooled client:
 *
 *   home region      the v1 query and insert routes, and executeWithUserContext,
 *                    which the MCP data tools, the console's table browser, the
 *                    runtime's data routes and functions' ctx.db all run on
 *   another region   the v1 query and insert routes on the regional client; a
 *                    second database stands in for the region's
 *   a function       a route-module function, on the project's own login
 *
 * Without the fix the run after the change fails with 0A000 every time, except
 * in the home routes' cases: those ran on the platform client's pool, whose
 * other connections may not have prepared the statement, so they failed in
 * most runs rather than all.
 */

import '@/tests/helpers/real-web-standard'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { Client } from 'pg'
import { POST as insertRoute } from '@/app/api/v1/[projectId]/database/insert/route'
import { POST as queryRoute } from '@/app/api/v1/[projectId]/database/query/route'
import { mintKey } from '@/lib/auth/key-prefix'
import { disconnectRegionalClients, workspaceRawClient } from '@/lib/data-plane/regional'
import { prisma } from '@/lib/db'
import { executeRouteModuleFunction } from '@/lib/services/ai-functions/route-module-runner'
import { forgetFunctionDbClient, functionRoleName } from '@/lib/services/ai-functions/function-db-role'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { hashApiKey } from '@/server/lib/end-user-identity'

jest.setTimeout(120_000)

const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_region_${randomBytes(4).toString('hex')}`
const FUNCTION_SECRET = 'cached-plan-function-not-a-real-secret'

let ownerId = ''
let homeProject = ''
let regionalProject = ''
let homeKey = ''
let regionalKey = ''
let regionalDbCreated = false
let functionRoleInstalled = false

const homeUrl = () => process.env.DATABASE_URL as string
const schemaOf = (projectId: string) => `workspace_${projectId}`

function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}

/** DDL on a connection of its own, the way an agent's migration or a rollback reaches the table. */
async function ddl(connectionString: string, sql: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end().catch(() => {})
  }
}

/** A table with a column to drop later. `legacy` is the one a rollback removes. */
const tableSql = (schema: string, table: string) =>
  `CREATE TABLE "${schema}"."${table}" (id serial PRIMARY KEY, body text, legacy text);
   INSERT INTO "${schema}"."${table}" (body, legacy) VALUES ('first', 'old')`

async function apiKeyFor(projectId: string): Promise<string> {
  const minted = mintKey({ keyType: 'public', serviceRole: true })
  await prisma.apiKey.create({
    data: {
      name: 'cached plan fixture', keyPrefix: minted.prefix, keyHash: hashApiKey(minted.key), keyType: 'public',
      serviceRole: true, permissions: ['read', 'write', 'admin'], capabilities: ['database'],
      projectId, userId: ownerId,
    },
  })
  return minted.key
}

type Route = (request: NextRequest, props: { params: Promise<{ projectId: string }> }) => Promise<Response>

/** POST a body to a v1 data route as a server-side app would. */
async function post(route: Route, projectId: string, key: string, path: string, body: unknown) {
  const res = await route(
    new NextRequest(`https://backenly.test/api/v1/${projectId}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) },
  )
  return { status: res.status, body: await res.json() }
}

const columnsOf = (row: Record<string, unknown>) => Object.keys(row).sort()

/**
 * The query route twice, a column added, then the route again on the same
 * clients. Twice after the change: the route reads with two statements at
 * once, so it may hold two pooled connections, and each must answer.
 */
async function queryRouteSurvivesAddedColumn(projectId: string, key: string, connectionString: string) {
  const table = 'notes_query'
  const query = () => post(queryRoute, projectId, key, '/database/query', { table })
  for (let i = 0; i < 2; i++) expect(await query()).toMatchObject({ status: 200 })
  await ddl(connectionString, `ALTER TABLE "${schemaOf(projectId)}"."${table}" ADD COLUMN added text DEFAULT 'new'`)
  for (let i = 0; i < 2; i++) {
    const res = await query()
    expect(res).toMatchObject({ status: 200 })
    expect(columnsOf(res.body.data.data[0])).toEqual(['added', 'body', 'id', 'legacy'])
  }
}

/** The insert route (RETURNING *) twice, a column dropped, then the route again. */
async function insertRouteSurvivesDroppedColumn(projectId: string, key: string, connectionString: string) {
  const table = 'notes_insert'
  for (const body of ['one', 'two']) {
    expect(await post(insertRoute, projectId, key, '/database/insert', { table, data: { body } })).toMatchObject({ status: 200 })
  }
  await ddl(connectionString, `ALTER TABLE "${schemaOf(projectId)}"."${table}" DROP COLUMN legacy`)
  for (const body of ['three', 'four']) {
    const res = await post(insertRoute, projectId, key, '/database/insert', { table, data: { body } })
    expect(res).toMatchObject({ status: 200, body: { data: { data: { body } } } })
    expect(columnsOf(res.body.data.data)).toEqual(['body', 'id'])
  }
}

/** The workspace tables a project's routes are given, in its own database. */
async function routeTables(projectId: string, connectionString: string, extra: string[] = []) {
  const schema = schemaOf(projectId)
  const tables = ['notes_query', 'notes_insert', ...extra]
  await ddl(connectionString, `CREATE SCHEMA "${schema}"; ${tables.map((t) => tableSql(schema, t)).join('; ')}`)
  for (const name of ['notes_query', 'notes_insert']) await prisma.table.create({ data: { name, projectId } })
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  delete process.env[REGION_VARIABLE]

  const user = await prisma.user.create({
    data: { email: `cached-plan-${randomUUID()}@example.test`, name: 'cached plan fixture' },
    select: { id: true },
  })
  ownerId = user.id

  homeProject = (await prisma.project.create({ data: { name: `cached-plan-${randomUUID()}`, userId: ownerId }, select: { id: true } })).id
  regionalProject = (
    await prisma.project.create({ data: { name: `cached-plan-${randomUUID()}`, userId: ownerId, region: 'us-east-1' }, select: { id: true } })
  ).id

  await routeTables(homeProject, homeUrl(), ['notes_rls', 'notes_fn'])
  homeKey = await apiKeyFor(homeProject)

  await ddl(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  await routeTables(regionalProject, urlFor(REGIONAL_DB))
  regionalKey = await apiKeyFor(regionalProject)
})

afterAll(async () => {
  delete process.env[REGION_VARIABLE]
  delete process.env.BACKENLY_SERVICE_REGION
  if (homeProject) await forgetFunctionDbClient(homeProject).catch(() => {})
  await closeAllWorkspacePools()
  await disconnectRegionalClients()
  if (regionalDbCreated) await ddl(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
  if (homeProject) {
    await ddl(homeUrl(), `DROP SCHEMA IF EXISTS "${schemaOf(homeProject)}" CASCADE`).catch(() => {})
    // Roles are cluster-wide, so they outlive the test database unless dropped.
    if (functionRoleInstalled) {
      const role = functionRoleName(schemaOf(homeProject))
      await ddl(
        homeUrl(),
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
           EXECUTE 'DROP OWNED BY ${role}'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$`,
      ).catch(() => {})
    }
  }
  const ids = [homeProject, regionalProject].filter(Boolean)
  await prisma.project.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('a home-region project', () => {
  it('reads the new column through the query route after one is added', async () => {
    await queryRouteSurvivesAddedColumn(homeProject, homeKey, homeUrl())
  })

  it('returns the row without the dropped column through the insert route (RETURNING *)', async () => {
    await insertRouteSurvivesDroppedColumn(homeProject, homeKey, homeUrl())
  })

  it('reads and returns whole rows through executeWithUserContext, on one client, as the columns change', async () => {
    const client = await workspaceRawClient(homeProject)
    const table = `"${schemaOf(homeProject)}"."notes_rls"`
    const run = (sql: string, values: unknown[] = []) =>
      executeWithUserContext<Record<string, unknown>>(homeProject, '', true, sql, values)

    const select = `SELECT * FROM ${table} ORDER BY id`
    await run(select)
    await run(select)
    await ddl(homeUrl(), `ALTER TABLE ${table} ADD COLUMN added text DEFAULT 'new'`)
    expect(columnsOf((await run(select))[0])).toEqual(['added', 'body', 'id', 'legacy'])

    const insert = `INSERT INTO ${table} (body) VALUES ($1) RETURNING *`
    await run(insert, ['one'])
    await run(insert, ['two'])
    await ddl(homeUrl(), `ALTER TABLE ${table} DROP COLUMN legacy`)
    const [row] = await run(insert, ['three'])
    expect(row).toMatchObject({ body: 'three', added: 'new' })
    expect(columnsOf(row)).toEqual(['added', 'body', 'id'])

    // The same pooled client throughout: nothing was reconnected to get here.
    expect(await workspaceRawClient(homeProject)).toBe(client)
  })
})

describe('a project in another region', () => {
  // A regional project's data routes are served by its region's own service
  // (lib/data-plane/serving.ts); this process plays that service here.
  //
  // Which pooled connection a statement lands on is the pool's choice. With
  // the regional client held to one connection, the statement prepared before
  // the change is certainly the one asked to run after it.
  beforeAll(() => {
    const url = new URL(urlFor(REGIONAL_DB))
    url.searchParams.set('connection_limit', '1')
    process.env[REGION_VARIABLE] = url.toString()
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
  })

  afterAll(() => {
    delete process.env.BACKENLY_SERVICE_REGION
  })

  it('reads the new column through the query route after one is added', async () => {
    await queryRouteSurvivesAddedColumn(regionalProject, regionalKey, urlFor(REGIONAL_DB))
  })

  it('returns the row without the dropped column through the insert route (RETURNING *)', async () => {
    await insertRouteSurvivesDroppedColumn(regionalProject, regionalKey, urlFor(REGIONAL_DB))
  })
})

describe('a route-module function, on the project’s own login', () => {
  beforeAll(() => {
    // The helpers, installed the way an operator installs them
    // (__tests__/database/function-sql-isolation.test.ts does the same).
    for (const file of ['scripts/setup-direct-access.sql', 'scripts/sql/function-roles.sql']) {
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', file, '-d', process.env.TEST_DATABASE_URL!], { stdio: 'pipe' })
    }
    functionRoleInstalled = true
  })

  /** Run `sql` in a function and answer the columns of the first row it returns. */
  async function columnsFromFunction(sql: string, ...values: unknown[]): Promise<string[]> {
    const code = `
      import { NextResponse } from 'next/server'
      import { prisma } from '@/lib/db'
      export async function GET() {
        try {
          const rows = await prisma.$queryRawUnsafe(${JSON.stringify(sql)}, ...${JSON.stringify(values)})
          return NextResponse.json({ columns: Object.keys(rows[0]).sort() })
        } catch (err) {
          return NextResponse.json({ error: String(err && err.message) }, { status: 500 })
        }
      }
    `
    const result = await executeRouteModuleFunction(code, homeProject, { type: 'manual', data: {} }, 'GET /fn/columns', {
      authMaterial: { jwtSecret: FUNCTION_SECRET, adminKey: null },
    })
    const { status, body } = result.returnValue
    // The error text, when there is one, is what a failure here should show.
    expect({ status, error: body?.error }).toEqual({ status: 200, error: undefined })
    return body.columns
  }

  it('reads and returns whole rows as the table’s columns change', async () => {
    const table = `"${schemaOf(homeProject)}"."notes_fn"`
    const select = 'SELECT * FROM notes_fn ORDER BY id'
    await columnsFromFunction(select)
    await columnsFromFunction(select)
    await ddl(homeUrl(), `ALTER TABLE ${table} ADD COLUMN added text DEFAULT 'new'`)
    expect(await columnsFromFunction(select)).toEqual(['added', 'body', 'id', 'legacy'])

    const insert = 'INSERT INTO notes_fn (body) VALUES ($1) RETURNING *'
    await columnsFromFunction(insert, 'one')
    await columnsFromFunction(insert, 'two')
    await ddl(homeUrl(), `ALTER TABLE ${table} DROP COLUMN legacy`)
    expect(await columnsFromFunction(insert, 'three')).toEqual(['added', 'body', 'id'])
  })
})
