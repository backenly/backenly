/**
 * GET /api/security/scans lists one project's security scans. Asked without a
 * projectId, it skipped its access check and its project filter, and listed
 * every project's scans to any signed-in account: each project's id and name,
 * its score and the titles of the issues found. Both methods now need a
 * projectId and check the caller's access to it. A scan without one could not
 * be created before either (500); it is now refused plainly (400).
 *
 * Real database, real signed sessions, the real handlers. `next/headers` is the
 * request's cookie jar, which Next provides and Jest does not; the session put
 * in it is a real one (tests/integration/readiness-reads-reuse-verification.spec.ts
 * does the same).
 */

let cookieToken: string | null = null
jest.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'auth-token' && cookieToken ? { value: cookieToken } : undefined) }),
  headers: async () => new Map<string, string>(),
}))

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const userIds: string[] = []
const projectIds: string[] = []

interface Account {
  token: string
  project: { id: string; name: string }
  marker: string
}
let alice: Account
let bob: Account

async function account(label: string): Promise<Account> {
  const email = `scans-${label}-${randomUUID()}@test.invalid`
  const user = await prisma.user.create({ data: { email, name: label }, select: { id: true } })
  userIds.push(user.id)
  const { token } = await createSession(user.id, email, 'user')
  const project = await prisma.project.create({
    data: { name: `scans-${label}-${randomUUID().slice(0, 8)}`, userId: user.id },
    select: { id: true, name: true },
  })
  projectIds.push(project.id)
  const marker = `issue-title-${label}-${randomUUID()}`
  await prisma.securityScan.create({
    data: {
      projectId: project.id,
      scanType: 'configuration',
      status: 'completed',
      issuesFound: 1,
      score: 40,
      metadata: { issues: [{ severity: 'high', title: marker, category: 'configuration' }] },
    },
  })
  return { token, project, marker }
}

/** jest.setup.js replaces the global Request; this is the subset the handlers touch. */
function req(method: string, query = '', body?: unknown): any {
  return {
    method,
    url: `http://localhost:3000/api/security/scans${query ? `?${query}` : ''}`,
    nextUrl: { pathname: '/api/security/scans', searchParams: new URLSearchParams(query) },
    headers: { get: () => null },
    cookies: { get: () => undefined },
    json: async () => body,
  }
}

async function call(method: 'GET' | 'POST', query = '', body?: unknown) {
  const route = await import('@/app/api/security/scans/route')
  const res: any = await route[method](req(method, query, body) as any)
  const json = await res.json()
  return { status: res.status, body: json, text: JSON.stringify(json) }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  alice = await account('alice')
  bob = await account('bob')
})

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
  cookieToken = alice.token
})

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
})

afterAll(async () => {
  cookieToken = null
  await prisma.securityScan.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
})

describe('GET /api/security/scans', () => {
  it("refuses a list that names no project, and shows no other account's project", async () => {
    const r = await call('GET')

    expect(r.status).toBe(400)
    expect(r.body.code).toBe('PROJECT_ID_REQUIRED')
    expect(r.text).not.toContain(bob.project.id)
    expect(r.text).not.toContain(bob.project.name)
    expect(r.text).not.toContain(bob.marker)
  })

  it("lists the scans of the caller's own project, and only those", async () => {
    const r = await call('GET', `projectId=${alice.project.id}`)

    expect(r.status).toBe(200)
    expect(r.body.scans.length).toBeGreaterThan(0)
    expect(r.body.scans.every((s: { projectId: string }) => s.projectId === alice.project.id)).toBe(true)
    expect(r.text).toContain(alice.marker)
    expect(r.text).not.toContain(bob.marker)
  })

  it("refuses another account's project", async () => {
    const r = await call('GET', `projectId=${bob.project.id}`)

    expect(r.status).toBe(403)
    expect(r.text).not.toContain(bob.marker)
  })

  it('refuses a caller with no session', async () => {
    cookieToken = null

    const r = await call('GET', `projectId=${alice.project.id}`)

    expect(r.status).toBe(401)
  })
})

describe('POST /api/security/scans', () => {
  it('refuses a scan that names no project', async () => {
    const r = await call('POST', '', { scanType: 'configuration' })

    expect(r.status).toBe(400)
    expect(r.body.code).toBe('PROJECT_ID_REQUIRED')
  })

  it("refuses a scan of another account's project", async () => {
    const r = await call('POST', '', { scanType: 'configuration', projectId: bob.project.id })

    expect(r.status).toBe(403)
  })
})
