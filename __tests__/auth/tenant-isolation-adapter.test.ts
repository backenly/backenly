/**
 * THE ADAPTER IS NOW LOAD-BEARING FOR 36 CALLERS
 * ==============================================
 * `withTenantIsolation` (22 files) calls `requireProjectId` calls
 * `getCurrentProjectId` (14 more). One function decides which project every one
 * of those routes acts on: storage, uploads, multipart, logs, monitoring,
 * security issues, end-user auth, workspace files, provider credentials,
 * manifests, preflight, database-brain.
 *
 * It used to decide with `where: { id, userId }` and, when the request named no
 * project at all, with the caller's OLDEST OWNED project. Those two facts
 * together are why an invited organization member saw an empty bucket list
 * instead of an error: not a denial, a wrong answer with a 200 on it.
 *
 * It now delegates to ProjectResolver. Because concentrating 36 callers behind
 * one function is only safe if that function is pinned, this file asserts the
 * adapter's contract directly, and then asserts it again through a real route
 * so the wiring is proven and not assumed.
 *
 * Real database and real signed sessions. The defect lived in a `where` clause
 * and in an auth branch, neither of which a mocked client models.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import {
  getCurrentProjectId,
  withTenantIsolation,
  TenantIsolationError,
} from '@/lib/tenant/isolation'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const createdUserIds: string[] = []
const createdOrgIds: string[] = []
const createdProjectIds: string[] = []

async function makeUser(): Promise<{ id: string; email: string; token: string }> {
  const email = `adapter-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Adapter Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, email, token }
}

async function makeProject(userId: string | null, orgId?: string): Promise<string> {
  const p = await prisma.project.create({
    data: { name: `adapter-${randomUUID().slice(0, 8)}`, userId, organizationId: orgId ?? null },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return p.id
}

/**
 * jest.setup.js replaces the global `Request`, so a real NextRequest cannot be
 * constructed here. This is the subset the adapter and `authenticateRequest`
 * actually touch.
 */
function req(opts: {
  token?: string | null
  projectHeader?: string | null
  projectQuery?: string | null
  apiKey?: string | null
  path?: string
}): any {
  const path = opts.path ?? '/api/storage/buckets'
  const qs = opts.projectQuery ? `?projectId=${encodeURIComponent(opts.projectQuery)}` : ''
  const href = `http://localhost:3000${path}${qs}`
  const headers: Record<string, string> = {}
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  if (opts.projectHeader) headers['x-project-id'] = opts.projectHeader
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey

  return {
    method: 'GET',
    url: href,
    nextUrl: { pathname: path },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
  }
}

/** Run and return the thrown TenantIsolationError, failing if none is thrown. */
async function expectRefusal(fn: () => Promise<unknown>): Promise<TenantIsolationError> {
  const err = await fn().then(
    v => {
      throw new Error(`expected a refusal, got a resolved value: ${JSON.stringify(v)}`)
    },
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(TenantIsolationError)
  return err as TenantIsolationError
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_PINNED = process.env.BACKENLY_PROJECT_ID

beforeAll(() => {
  assertSafeTestDatabase()
})

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
})

afterEach(() => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_PINNED === undefined) delete process.env.BACKENLY_PROJECT_ID
  else process.env.BACKENLY_PROJECT_ID = ORIGINAL_PINNED
  resetSingleTenantCache()
})

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  }
  if (createdProjectIds.length) {
    await prisma.projectMember.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdOrgIds.length) {
    await prisma.organizationMember.deleteMany({ where: { orgId: { in: createdOrgIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

// ============================================================================
// CLOUD
// ============================================================================

describe('cloud adapter', () => {
  it('resolves a project the caller owns, from the header', async () => {
    const user = await makeUser()
    const projectId = await makeProject(user.id)

    await expect(getCurrentProjectId(req({ token: user.token, projectHeader: projectId }))).resolves.toBe(
      projectId
    )
  })

  it('accepts ?projectId= as well as the header', async () => {
    const user = await makeUser()
    const projectId = await makeProject(user.id)

    await expect(getCurrentProjectId(req({ token: user.token, projectQuery: projectId }))).resolves.toBe(
      projectId
    )
  })

  it('resolves an org project for a member who does not own it', async () => {
    // The fix. Every route behind this adapter denied this caller before.
    const owner = await makeUser()
    const member = await makeUser()
    const org = await prisma.organization.create({
      data: { name: `adapter-org-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
      select: { id: true },
    })
    createdOrgIds.push(org.id)
    await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } })
    await prisma.organizationMember.create({ data: { orgId: org.id, userId: member.id, role: 'DEVELOPER' } })
    const projectId = await makeProject(owner.id, org.id)

    await expect(getCurrentProjectId(req({ token: member.token, projectHeader: projectId }))).resolves.toBe(
      projectId
    )
  })

  it('refuses a request that names no project, and names no project of its own', async () => {
    const user = await makeUser()
    const ownProjectId = await makeProject(user.id)

    const err = await expectRefusal(() => getCurrentProjectId(req({ token: user.token })))

    expect(err.status).toBe(400)
    expect(err.code).toBe('PROJECT_REQUIRED')
    // The old behaviour returned this id. Asserting the message cannot leak it
    // is the difference between a denial and a wrong answer.
    expect(err.message).not.toContain(ownProjectId)
  })

  it('denies a project the caller may not have', async () => {
    const owner = await makeUser()
    const stranger = await makeUser()
    const projectId = await makeProject(owner.id)

    const err = await expectRefusal(() =>
      getCurrentProjectId(req({ token: stranger.token, projectHeader: projectId }))
    )

    expect(err.status).toBe(403)
    expect(err.code).toBe('PROJECT_FORBIDDEN')
  })

  it('reports a project that does not exist as not found', async () => {
    const user = await makeUser()

    const err = await expectRefusal(() =>
      getCurrentProjectId(req({ token: user.token, projectHeader: randomUUID() }))
    )

    expect(err.status).toBe(404)
    expect(err.code).toBe('PROJECT_NOT_FOUND')
  })

  it('invents nothing for a caller who owns no projects at all', async () => {
    const user = await makeUser()

    const err = await expectRefusal(() => getCurrentProjectId(req({ token: user.token })))
    expect(err.code).toBe('PROJECT_REQUIRED')
  })

  it('passes the resolved project to a withTenantIsolation handler', async () => {
    const user = await makeUser()
    const projectId = await makeProject(user.id)

    const seen = await withTenantIsolation(
      req({ token: user.token, projectHeader: projectId }),
      async id => id
    )
    expect(seen).toBe(projectId)
  })
})

// ============================================================================
// CREDENTIALS
// ============================================================================

describe('credential handling', () => {
  it('rejects an unauthenticated request before any project lookup', async () => {
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)

    const err = await expectRefusal(() => getCurrentProjectId(req({ projectHeader: projectId })))

    expect(err.status).toBe(401)
    expect(err.code).toBe('UNAUTHENTICATED')
  })

  it('does not accept an API key on this path, so keys never meet the human check', async () => {
    // authenticateRequest verifies a JWT from the bearer header or the auth
    // cookie and has no API-key branch. A key presented here is simply not a
    // session, which is the point: a machine credential must be authorized by
    // the project it was ISSUED for (resolveForApiKey), never by whether the
    // human who created it currently holds organization membership. Routing it
    // through here would revoke a live production key when its creator changes
    // teams, and widen one when they are promoted.
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)

    const err = await expectRefusal(() =>
      getCurrentProjectId(req({ apiKey: 'bk_live_not_a_real_key', projectHeader: projectId }))
    )

    expect(err.status).toBe(401)
    expect(err.code).toBe('UNAUTHENTICATED')
  })

  it('rejects a syntactically valid but unverifiable token', async () => {
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)

    const err = await expectRefusal(() =>
      getCurrentProjectId(req({ token: 'not.a.real.jwt', projectHeader: projectId }))
    )
    expect(err.status).toBe(401)
  })
})

// ============================================================================
// SINGLE-TENANT
// ============================================================================

describe('single-tenant adapter', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    resetSingleTenantCache()
  })

  it('resolves THE project when the request names none', async () => {
    const user = await makeUser()
    const projectId = await makeProject(user.id)
    process.env.BACKENLY_PROJECT_ID = projectId

    // Correct here for the reason it is wrong in cloud: one project, nothing
    // to disambiguate.
    await expect(getCurrentProjectId(req({ token: user.token }))).resolves.toBe(projectId)
  })

  it('still requires authentication', async () => {
    const user = await makeUser()
    const projectId = await makeProject(user.id)
    process.env.BACKENLY_PROJECT_ID = projectId

    const err = await expectRefusal(() => getCurrentProjectId(req({})))
    expect(err.status).toBe(401)
  })

  it('invents nothing when the pinned project does not exist', async () => {
    const user = await makeUser()
    process.env.BACKENLY_PROJECT_ID = randomUUID()

    const err = await expectRefusal(() => getCurrentProjectId(req({ token: user.token })))
    expect(err.code).toBe('PROJECT_NOT_FOUND')
  })
})

// ============================================================================
// THROUGH A REAL ROUTE
// ============================================================================

describe('a real route behind the adapter', () => {
  it('storage buckets refuses a request with no project context', async () => {
    // Proves the wiring, not just the helper. This route is one of the 22
    // behind withTenantIsolation, and is exactly where the old fallback caused
    // an organization member to be shown their OWN project's buckets under a
    // 200. The assertion that matters is that it is no longer a success.
    //
    // The status is 403 rather than 400 because every one of these routes maps
    // TenantIsolationError to 403 flat. The error now carries status 400 and
    // code PROJECT_REQUIRED, so refining the surfaced status is a per-route
    // edit; it is deliberately not done here, where it would mean rewriting 22
    // call sites in a commit scoped to the chokepoint.
    const { GET } = await import('@/app/api/storage/buckets/route')

    const user = await makeUser()
    await makeProject(user.id)

    const res: any = await GET(req({ token: user.token }))

    expect(res.status).not.toBe(200)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(String(body.error)).toMatch(/project/i)
  })

  it('storage buckets still serves a project the caller owns', async () => {
    // The other half: the refusal above must be the fallback going away, not
    // the route breaking.
    const { GET } = await import('@/app/api/storage/buckets/route')

    const user = await makeUser()
    const projectId = await makeProject(user.id)

    const res: any = await GET(req({ token: user.token, projectHeader: projectId }))

    expect(res.status).toBe(200)
  })
})
