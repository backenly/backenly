/**
 * NO CONNECTION STRING FOR A DATABASE NOTHING OUTSIDE CAN REACH
 * ============================================================
 *
 * Production QA re-test, 2026-11-16, new finding N4: Connect → Direct handed
 * out read-only and read-write logins for backenly.com:5432 (sslmode=require),
 * where nothing listens. lib/services/direct-access.ts fell back to
 * 'backenly.com' when the home region had no DIRECT_DB_HOST, and no Backenly
 * Cloud region has one: every database is private to its VPC.
 *
 * Now a project nothing outside can reach gets no login and no string, in the
 * console's routes and over MCP alike, and is told why; the logins that exist
 * stay listed by name so they can be revoked. On a shared database with no
 * host its operator gave (a self-hosted deployment), that nothing outside can
 * reach it; on Backenly Cloud, where a shared database is never reached from
 * outside, that direct connections are for a project's own database, through
 * the connection pooler (a project database whose region does not offer the
 * pooler is tests/unit/direct-postgres-pooler-logins.spec.ts and
 * tests/integration/pooler-logins.spec.ts). A configured host is still handed
 * out. The platform's own use of the read-only role (run_query) dials the
 * database directly and is untouched.
 */

let mockProjectId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) => handler({ projectId: mockProjectId, userId: 'test-user' }),
}))

import '../helpers/real-web-standard'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { encryptValue } from '@/lib/security/projectEnvCrypto'
import {
  DIRECT_ACCESS_UNAVAILABLE_MESSAGE,
  DIRECT_ACCESS_UNAVAILABLE_MESSAGES,
  directAccessRoleNames,
  getDirectAccessStatus,
  provisionDirectAccess,
} from '@/lib/services/direct-access'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { GET as statusRoute, POST as provisionRoute } from '@/app/api/projects/[id]/database-access/route'
import { POST as rotateRoute } from '@/app/api/projects/[id]/database-access/rotate/route'

const PASSWORD = 'not-a-real-password-' + 'x'.repeat(12)
let ownerId = ''
let roleName = ''

/** Production, with the region's developer-facing host as given (none by default). */
function production(host = '', edition = 'single-tenant') {
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production', DIRECT_DB_HOST: host, BACKENLY_EDITION: edition })
}

const request = (body: unknown = {}) => ({ json: async () => body }) as any

beforeAll(async () => {
  ownerId = (await prisma.user.create({ data: { email: `direct-${randomUUID()}@test.invalid`, name: 'direct' }, select: { id: true } })).id
  mockProjectId = (await prisma.project.create({ data: { name: 'direct-access', userId: ownerId }, select: { id: true } })).id
  roleName = directAccessRoleNames(mockProjectId).ro
  const enc = encryptValue(PASSWORD)
  await prisma.databaseCredential.create({
    data: { projectId: mockProjectId, mode: 'READ_ONLY', roleName, passwordCipher: enc.valueCipher, passwordIv: enc.valueIv, passwordTag: enc.valueTag },
  })
})

afterEach(() => jest.restoreAllMocks())

afterAll(async () => {
  await prisma.databaseCredential.deleteMany({ where: { projectId: mockProjectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: mockProjectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

it('lists the login that exists by name only, with no string, password or host, where no host is set up', async () => {
  production()
  const status = await getDirectAccessStatus(mockProjectId)
  expect(status).toMatchObject({
    available: false,
    unavailable: DIRECT_ACCESS_UNAVAILABLE_MESSAGE,
    credentials: [],
    logins: [{ mode: 'READ_ONLY', roleName, rotatedAt: null }],
  })
  const answer = JSON.stringify(await (await statusRoute({} as any)).json())
  expect(answer).toContain('"available":false')
  expect(answer).not.toContain('backenly.com')
  expect(answer).not.toContain(PASSWORD)
  expect(answer).not.toContain('postgresql://')
})

it('issues and rotates no login there, before anything is created, and says why', async () => {
  production()
  await expect(provisionDirectAccess(mockProjectId, 'READ_WRITE')).rejects.toMatchObject({
    code: 'DIRECT_ACCESS_UNAVAILABLE',
    variable: 'DIRECT_DB_HOST',
  })
  expect(await prisma.databaseCredential.count({ where: { projectId: mockProjectId } })).toBe(1)

  for (const res of [await provisionRoute(request({ mode: 'READ_WRITE' })), await rotateRoute(request({ mode: 'READ_ONLY' }))]) {
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: DIRECT_ACCESS_UNAVAILABLE_MESSAGE, code: 'DIRECT_ACCESS_UNAVAILABLE', reason: 'no_host' })
  }
})

it('tells an agent there is no connection string, and what works instead', async () => {
  production()
  const res = await dispatchTool('get_database_credentials', { mode: 'READ_ONLY' }, { projectId: mockProjectId })
  expect(res.ok).toBe(false)
  expect(res.code).toBe('DIRECT_ACCESS_UNAVAILABLE')
  expect(res.summary).toContain(DIRECT_ACCESS_UNAVAILABLE_MESSAGE)
  expect(res.summary).toContain('run_query')
  expect(JSON.stringify(res)).not.toContain('postgresql://')
})

it('on Backenly Cloud, says a shared database is not reached from outside, to the console and to an agent', async () => {
  production('', 'cloud')
  const status = await getDirectAccessStatus(mockProjectId)
  expect(status).toMatchObject({
    available: false,
    unavailable: DIRECT_ACCESS_UNAVAILABLE_MESSAGES.shared_database,
    unavailableReason: 'shared_database',
    tenancy: 'shared',
    credentials: [],
    logins: [{ mode: 'READ_ONLY', roleName }],
  })
  await expect(provisionDirectAccess(mockProjectId, 'READ_WRITE')).rejects.toMatchObject({ reason: 'shared_database' })
  const res = await dispatchTool('get_database_credentials', { mode: 'READ_ONLY' }, { projectId: mockProjectId })
  expect(res.ok).toBe(false)
  expect(res.summary).toContain(DIRECT_ACCESS_UNAVAILABLE_MESSAGES.shared_database)
  expect(res.data).toMatchObject({ available: false, reason: 'shared_database' })
  expect(JSON.stringify(res)).not.toContain('postgresql://')
})

it('CONTROL: hands out the region’s host where one is set up', async () => {
  production('db.example.test')
  const status = await getDirectAccessStatus(mockProjectId)
  expect(status.available).toBe(true)
  expect(status.credentials).toHaveLength(1)
  expect(status.credentials[0].connectionString).toBe(`postgresql://${roleName}:${PASSWORD}@db.example.test:5432/${status.credentials[0].database}?sslmode=require`)
})
