/**
 * DIRECT POSTGRES: CONNECTIONS AT ONCE, BY PLAN
 * =============================================
 *
 * Each login may hold its plan's number of connections at once: Free 2, Pro 5,
 * Enterprise 20 (lib/entitlements/direct-postgres.ts). Set when the login is
 * created and on every read of its credentials, and every hour for every
 * login, so a plan change (made in Cloud's billing) reaches it within the hour
 * without anyone reading it. PostgreSQL enforces it, and run_query, which
 * connects as the read-only login, says so when the login is full. The same
 * limit holds through the connection pooler, which signs a login in to the
 * server as itself.
 *
 * (The strings that verified a regional endpoint's RDS certificate went with
 * that endpoint: a project database's strings name the pooler, and
 * tests/unit/direct-postgres-pooler-logins.spec.ts and
 * tests/integration/pooler-logins.spec.ts hold them.)
 *
 * Real database and the real definer functions (scripts/setup-direct-access.sql).
 */

let mockPlan = 'SANDBOX'
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: mockPlan }) }
})

import { execFileSync } from 'child_process'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import {
  directAccessRoleNames,
  getDirectAccessStatus,
  provisionDirectAccess,
  readOnlyLogin,
  reconcileDirectConnectionLimits,
  revokeDirectAccess,
} from '@/lib/services/direct-access'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { READ_CONNECTION_LIMIT_REACHED, runReadQuery } from '@/lib/mcp/read-query'

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const ENV_KEYS = ['BACKENLY_EDITION'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

let db: Client
let ownerId = ''
let projectId = ''
let schema = ''
const sessions: Client[] = []

const limitOf = async (role: string) =>
  (await db.query(`SELECT rolconnlimit FROM pg_roles WHERE rolname = $1`, [role])).rows[0]?.rolconnlimit as number | undefined

/** A session that logs in as `role`, as a developer's psql does. */
async function login(role: string, password: string): Promise<Client> {
  const url = new URL(CONN)
  url.username = role
  url.password = password
  const c = new Client({ connectionString: url.toString() })
  c.on('error', () => {})
  await c.connect()
  sessions.push(c)
  return c
}

beforeAll(async () => {
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', CONN], { stdio: 'pipe' })
  db = new Client({ connectionString: CONN })
  await db.connect()
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({ data: { email: `strings-limits-${Date.now()}@example.test`, name: 'owner' }, select: { id: true } })).id
  const project = await createProvisionedProject({ name: 'strings-and-limits', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterEach(() => {
  mockPlan = 'SANDBOX'
})

afterAll(async () => {
  for (const c of sessions) await c.end().catch(() => {})
  if (projectId) {
    await revokeDirectAccess(projectId, 'READ_ONLY').catch(() => {})
    await revokeDirectAccess(projectId, 'READ_WRITE').catch(() => {})
    const own = directAccessRoleNames(projectId).owner
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await db.query(`DROP OWNED BY ${own}`).catch(() => {})
    await db.query(`DROP ROLE IF EXISTS ${own}`).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await db.end()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}, 120_000)

describe('connections at once, by plan', () => {
  it('creates each login with its plan’s limit: Free 2', async () => {
    const ro = await provisionDirectAccess(projectId, 'READ_ONLY')
    const rw = await provisionDirectAccess(projectId, 'READ_WRITE')
    expect(await limitOf(ro.roleName)).toBe(2)
    expect(await limitOf(rw.roleName)).toBe(2)
    expect((await getDirectAccessStatus(projectId)).connectionLimit).toBe(2)
  }, 60_000)

  it('applies a new plan’s limit at the next read of the credentials, up and down', async () => {
    const { ro, rw } = directAccessRoleNames(projectId)
    mockPlan = 'BUILDER'
    expect((await getDirectAccessStatus(projectId)).connectionLimit).toBe(5)
    expect([await limitOf(ro), await limitOf(rw)]).toEqual([5, 5])

    mockPlan = 'SCALE'
    await getDirectAccessStatus(projectId)
    expect([await limitOf(ro), await limitOf(rw)]).toEqual([20, 20])

    mockPlan = 'SANDBOX'
    await dispatchTool('get_database_credentials', { mode: 'READ_ONLY' }, { projectId })
    expect([await limitOf(ro), await limitOf(rw)]).toEqual([2, 2])
  }, 60_000)

  it('reaches every login within the hour, with no read of its credentials, through the hourly pass', async () => {
    const { ro, rw } = directAccessRoleNames(projectId)
    mockPlan = 'BUILDER'
    await getDirectAccessStatus(projectId)
    expect([await limitOf(ro), await limitOf(rw)]).toEqual([5, 5])

    // The plan shrinks in Cloud's billing; nothing reads the credentials.
    mockPlan = 'SANDBOX'
    const pass = await reconcileDirectConnectionLimits()
    expect(pass.changed).toBeGreaterThanOrEqual(2)
    expect([await limitOf(ro), await limitOf(rw)]).toEqual([2, 2])
    // Nothing left to change: the next pass alters nothing of this project's.
    await reconcileDirectConnectionLimits()
    expect([await limitOf(ro), await limitOf(rw)]).toEqual([2, 2])
  }, 60_000)

  it('is enforced by PostgreSQL, and run_query says so when the read-only login is full', async () => {
    const { roleName, password } = await readOnlyLogin(projectId)
    await login(roleName, password)
    await login(roleName, password)
    await expect(login(roleName, password)).rejects.toThrow(/too many connections for role/)

    await expect(runReadQuery(projectId, 'SELECT 1 AS one')).rejects.toMatchObject({
      code: 'CONNECTION_LIMIT_REACHED',
      message: READ_CONNECTION_LIMIT_REACHED,
    })

    for (const c of sessions.splice(0)) await c.end()
  }, 60_000)

  it('is set only through the definer, and only for a login, within 1 to 100', async () => {
    const { ro } = directAccessRoleNames(projectId)
    const refusal = (sql: string, params: unknown[]) => db.query(sql, params).then(() => 'ok', (e: Error) => e.message)
    expect(await refusal(`SELECT public.backenly_direct_set_connection_limit($1, $2)`, [ro, 0])).toMatch(/outside 1 to 100/)
    expect(await refusal(`SELECT public.backenly_direct_set_connection_limit($1, $2)`, [ro, 101])).toMatch(/outside 1 to 100/)
    expect(await refusal(`SELECT public.backenly_direct_set_connection_limit($1, $2)`, [ro, null])).toMatch(/outside 1 to 100/)
    expect(await refusal(`SELECT public.backenly_direct_set_connection_limit($1, $2)`, ['postgres', 5])).toMatch(/invalid role name/)
    const missing = await db.query(`SELECT public.backenly_direct_set_connection_limit($1, $2) AS done`, ['bkn_ro_000000000000', 5])
    expect(missing.rows[0].done).toBe(false)
    const grants = await db.query(
      `SELECT has_function_privilege('public', 'public.backenly_direct_set_connection_limit(text,integer)', 'EXECUTE') AS public_may`,
    )
    expect(grants.rows[0].public_may).toBe(false)
  })
})
