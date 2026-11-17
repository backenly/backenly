/**
 * DIRECT POSTGRES: STRINGS THAT VERIFY THE SERVER, AND CONNECTIONS BY PLAN
 * =======================================================================
 *
 * Owner's decision for the regional database endpoint (2026-11-17):
 *
 *   - Where the region's endpoint fronts its RDS instance (DIRECT_DB_TLS_HOST
 *     and DIRECT_DB_HOSTADDR set, beside DIRECT_DB_HOST), a login has two
 *     strings. For libpq tools: the instance's own name as the host, which its
 *     certificate carries, the endpoint's address as hostaddr, sslmode
 *     verify-full. For every other client: the endpoint's own name, sslmode
 *     verify-ca. Both name the RDS CA bundle the images ship as sslrootcert,
 *     published at /certs/rds-ca-cloud-regions.pem. Settings are per region,
 *     like DIRECT_DB_HOST; half of them configured leaves the strings as before.
 *   - Each login may hold its plan's number of connections at once: Free 2,
 *     Pro 5, Enterprise 20. Set when the login is created and on every read of
 *     its credentials, so a plan change (made in Cloud's billing) applies at
 *     the next one. PostgreSQL enforces it, and run_query, which connects as
 *     the read-only login, says so when the login is full.
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
import { existsSync } from 'fs'
import { join } from 'path'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import {
  CA_BUNDLE_FILE,
  CA_BUNDLE_PATH,
  directAccessRoleNames,
  getDirectAccessStatus,
  provisionDirectAccess,
  readOnlyLogin,
  revokeDirectAccess,
} from '@/lib/services/direct-access'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { READ_CONNECTION_LIMIT_REACHED, runReadQuery } from '@/lib/mcp/read-query'

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const ENV_KEYS = [
  'BACKENLY_EDITION',
  'NODE_ENV',
  'DIRECT_DB_HOST',
  'DIRECT_DB_TLS_HOST',
  'DIRECT_DB_HOSTADDR',
  'DIRECT_DB_HOST_US_EAST_1',
  'DIRECT_DB_TLS_HOST_US_EAST_1',
  'DIRECT_DB_HOSTADDR_US_EAST_1',
  'DATABASE_URL_US_EAST_1',
] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

let db: Client
let ownerId = ''
let projectId = ''
let schema = ''
const sessions: Client[] = []

const limitOf = async (role: string) =>
  (await db.query(`SELECT rolconnlimit FROM pg_roles WHERE rolname = $1`, [role])).rows[0]?.rolconnlimit as number | undefined

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) if (k !== 'BACKENLY_EDITION' && k !== 'NODE_ENV' && k !== 'DATABASE_URL_US_EAST_1') delete process.env[k]
  Object.assign(process.env, values)
}

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

describe('strings that verify the server', () => {
  const VERIFIED = {
    NODE_ENV: 'production',
    DIRECT_DB_HOST: 'db.example.test',
    DIRECT_DB_TLS_HOST: 'instance-1.abc123.ap-south-1.rds.example.test',
    DIRECT_DB_HOSTADDR: '192.0.2.10',
  }

  afterEach(() => setEnv({ NODE_ENV: 'test' }))

  it('gives libpq tools verify-full through hostaddr, every other client verify-ca, both naming the published CA bundle', async () => {
    setEnv(VERIFIED)
    const status = await getDirectAccessStatus(projectId)
    const ro = status.credentials.find((c) => c.mode === 'READ_ONLY')!
    const { roleName, password } = await readOnlyLogin(projectId)
    const database = ro.database

    expect(ro.connectionString).toBe(
      `postgresql://${roleName}:${password}@instance-1.abc123.ap-south-1.rds.example.test:5432/${database}` +
        `?hostaddr=192.0.2.10&sslmode=verify-full&sslrootcert=rds-ca-cloud-regions.pem`,
    )
    expect(ro.otherClientsConnectionString).toBe(
      `postgresql://${roleName}:${password}@db.example.test:5432/${database}?sslmode=verify-ca&sslrootcert=rds-ca-cloud-regions.pem`,
    )
    expect(ro.psqlCommand).toBe(`psql "${ro.connectionString}"`)
    expect(ro.pgDumpCommand.startsWith(`pg_dump "${ro.connectionString}"`)).toBe(true)
    expect(ro.caBundle).toEqual({ file: CA_BUNDLE_FILE, url: expect.stringMatching(/\/certs\/rds-ca-cloud-regions\.pem$/) })
    // The URL serves the file the strings name.
    expect(CA_BUNDLE_PATH).toBe('/certs/rds-ca-cloud-regions.pem')
    expect(existsSync(join(process.cwd(), 'public', CA_BUNDLE_PATH))).toBe(true)
  })

  it('tells an agent which string is for which client, and where the CA bundle is', async () => {
    setEnv(VERIFIED)
    const res = await dispatchTool('get_database_credentials', { mode: 'READ_ONLY' }, { projectId })
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({
      connectionString: expect.stringContaining('sslmode=verify-full'),
      otherClientsConnectionString: expect.stringContaining('sslmode=verify-ca'),
      caBundle: { file: 'rds-ca-cloud-regions.pem' },
      connectionLimit: 2,
    })
    expect(res.summary).toContain('sslrootcert=rds-ca-cloud-regions.pem')
    expect(res.summary).toMatch(/download it from \S+\/certs\/rds-ca-cloud-regions\.pem/)
    expect(res.summary).toContain('node-postgres needs uselibpqcompat=true')
    expect(res.summary).toContain('Each login may hold 2 connections at once')
  })

  it('reads the settings of the project’s own region', async () => {
    const east = await prisma.project.create({ data: { name: 'east', userId: ownerId, region: 'us-east-1' }, select: { id: true } })
    try {
      setEnv({
        ...VERIFIED,
        DIRECT_DB_HOST_US_EAST_1: 'db.us-east-1.example.test',
        DIRECT_DB_TLS_HOST_US_EAST_1: 'instance-2.us-east-1.rds.example.test',
        DIRECT_DB_HOSTADDR_US_EAST_1: '198.51.100.10',
        DATABASE_URL_US_EAST_1: CONN,
      })
      const { databaseCredential } = prisma
      const { encryptValue } = await import('@/lib/security/projectEnvCrypto')
      const enc = encryptValue('not-a-real-password-' + 'x'.repeat(12))
      await databaseCredential.create({
        data: { projectId: east.id, mode: 'READ_ONLY', roleName: directAccessRoleNames(east.id).ro, passwordCipher: enc.valueCipher, passwordIv: enc.valueIv, passwordTag: enc.valueTag },
      })
      const [cred] = (await getDirectAccessStatus(east.id)).credentials
      expect(cred.connectionString).toContain('@instance-2.us-east-1.rds.example.test:5432/')
      expect(cred.connectionString).toContain('?hostaddr=198.51.100.10&sslmode=verify-full')
      expect(cred.otherClientsConnectionString).toContain('@db.us-east-1.example.test:5432/')
    } finally {
      await prisma.databaseCredential.deleteMany({ where: { projectId: east.id } })
      await prisma.project.delete({ where: { id: east.id } })
    }
  })

  it('keeps one string, as before, where only part of the endpoint is configured, and says why', async () => {
    const said = jest.spyOn(console, 'warn').mockImplementation(() => {})
    setEnv({ NODE_ENV: 'production', DIRECT_DB_HOST: 'db.example.test', DIRECT_DB_HOSTADDR: '192.0.2.10' })
    const ro = (await getDirectAccessStatus(projectId)).credentials.find((c) => c.mode === 'READ_ONLY')!
    expect(ro.connectionString).toMatch(/@db\.example\.test:5432\/[^?]+\?sslmode=require$/)
    expect(ro.otherClientsConnectionString).toBeUndefined()
    expect(ro.caBundle).toBeUndefined()
    expect(said.mock.calls.map((c) => String(c[0])).join('\n')).toContain('DIRECT_DB_HOSTADDR is set without DIRECT_DB_TLS_HOST')
    said.mockRestore()
  })
})
