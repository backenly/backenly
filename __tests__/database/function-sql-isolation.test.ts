/**
 * FUNCTION SQL RUNS AS THE PROJECT, NOT AS THE PLATFORM
 * =====================================================
 * Route-module functions reach the database through the `prisma` the runner
 * hands them. Every query set the caller's claims first, but ran on the app's
 * own connection, and the app role owns every platform table and every
 * workspace schema. Claims decide which ROWS a policy admits; they never
 * stopped a statement that names another schema. So function code could read
 * public.users, public.api_keys or another project's tables, and the generator
 * writes that code from the requester's own description.
 *
 * Function SQL now runs on a connection that logs in as the project's own
 * role (scripts/sql/function-roles.sql). These tests call the real runner and
 * assert that POSTGRESQL refuses, including after `RESET ROLE`, which is why
 * the boundary is a login and not a SET ROLE on the app's connection. The
 * positive cases are here so the refusals cannot pass because nothing works.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { execFileSync } from 'child_process'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db/prisma'
import { executeRouteModuleFunction } from '@/lib/services/ai-functions/route-module-runner'
import { forgetFunctionDbClient, functionRoleName } from '@/lib/services/ai-functions/function-db-role'

let userId: string
let projectId: string
let otherProjectId: string
let schema: string
let otherSchema: string

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

/**
 * The helper, installed the way an operator installs it. setup-direct-access.sql
 * first because function-roles.sql refuses to install without
 * public.backenly_app_role(), which a real install gets from ddl-sync.
 */
function installSql(file: string): void {
  // Options BEFORE the database, passed with -d; see sql-workspace-isolation.
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', file, '-d', process.env.TEST_DATABASE_URL!], {
    stdio: 'pipe',
  })
}

const PROJECT_JWT_SECRET = 'function-sql-isolation-not-a-real-secret'

/**
 * Run a GET handler whose body is `body` as `projectId`'s function: anonymously,
 * or as the end user `asUser` with a token signed by the project's own secret.
 */
async function run(pid: string, body: string, asUser?: string): Promise<any> {
  const code = `
    import { NextResponse } from 'next/server'
    import { prisma } from '@/lib/db'
    export async function GET(request: Request) {
      ${body}
    }
  `
  const headers = asUser
    ? { 'x-user-token': `Bearer ${jwt.sign({ sub: asUser }, PROJECT_JWT_SECRET, { algorithm: 'HS256' })}` }
    : undefined
  const result = await executeRouteModuleFunction(code, pid, { type: 'manual', data: {} }, 'GET /fn/probe', {
    authMaterial: { jwtSecret: PROJECT_JWT_SECRET, adminKey: null },
    headers,
  })
  return result.returnValue.body
}

beforeAll(async () => {
  installSql('scripts/setup-direct-access.sql')
  installSql('scripts/sql/function-roles.sql')

  const user = await prisma.user.create({
    data: { email: `fnsql-${Date.now()}@example.test`, password: 'x', name: 'function sql' },
  })
  userId = user.id
  projectId = (await prisma.project.create({ data: { name: 'function-sql-test', userId } })).id
  otherProjectId = (await prisma.project.create({ data: { name: 'function-sql-victim', userId } })).id
  schema = `workspace_${projectId}`
  otherSchema = `workspace_${otherProjectId}`

  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."notes" (id serial primary key, body text)`)
  await raw(`INSERT INTO "${schema}"."notes"(body) VALUES ('mine one'), ('mine two')`)
  // Row security still applies under the project role: this row belongs to
  // someone, and an anonymous caller must not see it.
  await raw(`CREATE TABLE "${schema}"."owned" (id serial primary key, owner text, body text)`)
  await raw(`ALTER TABLE "${schema}"."owned" ENABLE ROW LEVEL SECURITY`)
  await raw(`CREATE POLICY own ON "${schema}"."owned" USING (owner = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')`)
  await raw(`INSERT INTO "${schema}"."owned"(owner, body) VALUES ('someone', 'private')`)

  // A second tenant with data worth stealing, so "cannot read another schema"
  // is not passing against a database where no other schema exists.
  await raw(`CREATE SCHEMA "${otherSchema}"`)
  await raw(`CREATE TABLE "${otherSchema}"."secrets" (id serial primary key, body text)`)
  await raw(`INSERT INTO "${otherSchema}"."secrets"(body) VALUES ('not yours')`)
}, 180_000)

afterAll(async () => {
  for (const pid of [projectId, otherProjectId]) await forgetFunctionDbClient(pid).catch(() => {})
  await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await raw(`DROP SCHEMA IF EXISTS "${otherSchema}" CASCADE`).catch(() => {})
  // Roles are cluster-wide, so they outlive the test database unless dropped.
  for (const s of [schema, otherSchema]) {
    const role = functionRoleName(s)
    await raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
      EXECUTE 'DROP OWNED BY ${role}'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$`).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

describe('what a function can do with its own data', () => {
  test('it logs in as its own role, which the SQL and the app name the same way', async () => {
    const body = await run(projectId, `
      const r = await prisma.$queryRawUnsafe("SELECT current_user::text AS cu, session_user::text AS su")
      return NextResponse.json(r[0])
    `)
    expect(body).toEqual({ cu: functionRoleName(schema), su: functionRoleName(schema) })
    const [{ name }] = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT public.backenly_fn_role_name($1) AS name`, schema)
    expect(name).toBe(functionRoleName(schema))
  }, 60_000)

  test('it reads its own table by its unqualified name', async () => {
    const body = await run(projectId, `
      const rows = await prisma.$queryRawUnsafe("SELECT body FROM notes ORDER BY id")
      return NextResponse.json({ rows })
    `)
    expect(body.rows.map((r: any) => r.body)).toEqual(['mine one', 'mine two'])
  }, 60_000)

  test('it writes to its own table', async () => {
    await run(projectId, `
      await prisma.$executeRawUnsafe("INSERT INTO notes(body) VALUES ($1)", 'from a function')
      return NextResponse.json({ ok: true })
    `)
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${schema}"."notes" WHERE body = 'from a function'`)
    expect(rows[0].n).toBe(1)
  }, 60_000)

  test('row security still applies: an anonymous caller does not see a row it does not own', async () => {
    const body = await run(projectId, `
      const rows = await prisma.$queryRawUnsafe("SELECT body FROM owned")
      return NextResponse.json({ rows })
    `)
    expect(body.rows).toEqual([])
  }, 60_000)

  test('and the caller’s identity reaches it: the owner does see the row', async () => {
    // Without this, the case above would also pass if the claims were never
    // set on the new login at all.
    const body = await run(projectId, `
      const rows = await prisma.$queryRawUnsafe("SELECT body FROM owned")
      return NextResponse.json({ rows })
    `, 'someone')
    expect(body.rows).toEqual([{ body: 'private' }])
  }, 60_000)
})

describe('what PostgreSQL refuses', () => {
  test.each([
    ['users'],
    ['api_keys'],
    ['projects'],
    ['project_integration_keys'],
    ['project_env_vars'],
  ])('the platform table public.%s', async (table) => {
    await expect(run(projectId, `
      const r = await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM public.${table}")
      return NextResponse.json(r)
    `)).rejects.toThrow(/permission denied/)
  }, 60_000)

  test('another project’s schema', async () => {
    await expect(run(projectId, `
      const r = await prisma.$queryRawUnsafe('SELECT body FROM "${otherSchema}".secrets')
      return NextResponse.json(r)
    `)).rejects.toThrow(/permission denied/)
  }, 60_000)

  test('a platform table after RESET ROLE, because the login itself is the project role', async () => {
    await expect(run(projectId, `
      const r = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('RESET ROLE')
        return tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM public.users')
      })
      return NextResponse.json(r)
    `)).rejects.toThrow(/permission denied/)
  }, 60_000)

  test('switching to the app role or any other', async () => {
    const [{ app }] = await prisma.$queryRawUnsafe<Array<{ app: string }>>(`SELECT current_user::text AS app`)
    await expect(run(projectId, `
      await prisma.$executeRawUnsafe('SET ROLE "${app}"')
      return NextResponse.json({ switched: true })
    `)).rejects.toThrow(/permission denied/)
  }, 60_000)

  test('the role holds nothing it could abuse', async () => {
    const [attrs] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit,
              (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
         FROM pg_roles r WHERE rolname = $1`, functionRoleName(schema))
    expect(attrs).toEqual({
      rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false,
      rolinherit: false, memberships: 0,
    })
  }, 60_000)
})
