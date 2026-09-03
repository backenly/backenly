/**
 * Tenant Isolation Tests
 * ======================
 * `requireProjectId` is the gate in front of every `withTenantIsolation` route.
 * It no longer DECIDES anything: the decision moved to ProjectResolver, so that
 * "may this caller reach this project" has one authority instead of the ~70
 * this repository had accumulated. What is left here is the request-shaped part,
 * and it is still worth pinning:
 *
 *   1. It extracts the requested project from the header, then the query string,
 *      and treats whatever it finds as a REQUEST rather than a grant.
 *   2. It authenticates once, delegates once, and cannot reach its own verdict.
 *   3. It reports a cross-tenant attempt, and does NOT report a client that
 *      simply forgot to send a project.
 *
 * (2) also preserves the older regression this file was written for: the
 * function used to re-run `authenticateRequest` and repeat the ownership lookup
 * after `getCurrentProjectId` had already enforced it, doubling per-request
 * reads without being able to disagree with itself.
 *
 * WHAT CHANGED, and why the assertions below are not the ones that used to be
 * here. This suite previously mocked `prisma.project.findFirst` and asserted the
 * query shape `where: { id, userId }` — owner only — plus a test named "falls
 * back to the caller's own default project when none is requested". Both encoded
 * the defect rather than the contract:
 *
 *   - owner-only denied every invited organization member, across storage,
 *     logs, monitoring, security issues, end-user auth and env vars
 *   - the fallback answered a request that named NO project with the caller's
 *     OLDEST OWNED one, so a member reading storage got a 200 carrying somebody
 *     else's buckets and the organization's project rendered as empty
 *
 * The resolver is mocked here rather than the database because the adapter has
 * no database access of its own any more, and a prisma mock deep enough to model
 * organization membership would be asserting a fiction. The resolver's real
 * behaviour is pinned against a real database in
 * __tests__/auth/project-resolver.test.ts, and the wiring end to end in
 * __tests__/auth/tenant-isolation-adapter.test.ts.
 */

import type { NextRequest } from 'next/server'
import {
  ProjectAccessDeniedError,
  ProjectContextRequiredError,
} from '@/lib/edition/types'

const resolveForUser = jest.fn()

jest.mock('@/lib/edition', () => {
  const actual = jest.requireActual('@/lib/edition/types')
  return {
    ...actual,
    getProjectResolver: () => ({
      edition: 'cloud',
      resolveForUser,
      resolveForApiKey: jest.fn(),
      resolveTrusted: jest.fn(),
    }),
  }
})
jest.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: jest.fn(),
}))
jest.mock('@/lib/platform/controls', () => ({
  recordSecurityEvent: jest.fn(),
}))

import { authenticateRequest } from '@/lib/auth/middleware'
import { recordSecurityEvent } from '@/lib/platform/controls'
import { requireProjectId, TenantIsolationError } from '@/lib/tenant/isolation'

const authMock = authenticateRequest as unknown as jest.Mock
const securityEventMock = recordSecurityEvent as unknown as jest.Mock

const OWNER = 'user_owner'

function makeRequest(
  opts: { url?: string; headers?: Record<string, string>; method?: string } = {}
): NextRequest {
  const url = opts.url ?? 'https://api.backenly.com/api/logs'
  return {
    url,
    method: opts.method ?? 'GET',
    headers: new Headers(opts.headers ?? {}),
    nextUrl: new URL(url),
  } as unknown as NextRequest
}

describe('requireProjectId', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // `getCurrentProjectId` calls `.catch()` on this without awaiting it.
    securityEventMock.mockResolvedValue(undefined)
    authMock.mockResolvedValue({
      authenticated: true,
      userId: OWNER,
      userEmail: 'owner@example.com',
    })
  })

  it('returns the resolved project, using one auth pass and one resolver call', async () => {
    resolveForUser.mockResolvedValue({ id: 'proj_owned' })

    const projectId = await requireProjectId(
      makeRequest({ headers: { 'x-project-id': 'proj_owned' } })
    )

    expect(projectId).toBe('proj_owned')

    // The regression this file exists for: resolving a project must not cost
    // two identity checks and two lookups.
    expect(authMock).toHaveBeenCalledTimes(1)
    expect(resolveForUser).toHaveBeenCalledTimes(1)

    // And it asks the authority about the caller and the REQUESTED project,
    // rather than deciding anything itself.
    expect(resolveForUser).toHaveBeenCalledWith(OWNER, 'proj_owned')
  })

  it('refuses a project the caller may not have and records the cross-tenant event', async () => {
    resolveForUser.mockRejectedValue(new ProjectAccessDeniedError())

    await expect(
      requireProjectId(makeRequest({ headers: { 'x-project-id': 'proj_someone_else' } }))
    ).rejects.toBeInstanceOf(TenantIsolationError)

    expect(securityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'cross_tenant',
        severity: 'high',
        userId: OWNER,
        projectId: 'proj_someone_else',
      })
    )
  })

  it('reads the project id from the query string when no header is present', async () => {
    resolveForUser.mockRejectedValue(new ProjectAccessDeniedError())

    await expect(
      requireProjectId(
        makeRequest({ url: 'https://api.backenly.com/api/logs?projectId=proj_someone_else' })
      )
    ).rejects.toBeInstanceOf(TenantIsolationError)

    expect(resolveForUser).toHaveBeenCalledWith(OWNER, 'proj_someone_else')
  })

  it('rejects an unauthenticated caller without consulting the resolver', async () => {
    authMock.mockResolvedValue({ authenticated: false })

    const err = await requireProjectId(
      makeRequest({ headers: { 'x-project-id': 'proj_owned' } })
    ).then(
      () => null,
      (e: TenantIsolationError) => e
    )

    expect(err).toBeInstanceOf(TenantIsolationError)
    expect(err!.status).toBe(401)
    expect(resolveForUser).not.toHaveBeenCalled()
  })

  it('asks for nothing when the request names no project, and never substitutes one', async () => {
    // Replaces "falls back to the caller's own default project". The adapter
    // must hand the resolver a null and let it refuse, so that a client which
    // forgot to send a project gets an error rather than another project's data.
    resolveForUser.mockRejectedValue(new ProjectContextRequiredError())

    const err = await requireProjectId(makeRequest()).then(
      () => null,
      (e: TenantIsolationError) => e
    )

    expect(err).toBeInstanceOf(TenantIsolationError)
    expect(err!.status).toBe(400)
    expect(err!.code).toBe('PROJECT_REQUIRED')
    expect(resolveForUser).toHaveBeenCalledWith(OWNER, null)
  })

  it('does not report a missing project as a cross-tenant attempt', async () => {
    // A client that forgot a header is a bug, not an attack. Filing it on the
    // Security tab would bury the real signal in noise.
    resolveForUser.mockRejectedValue(new ProjectContextRequiredError())

    await expect(requireProjectId(makeRequest())).rejects.toBeInstanceOf(TenantIsolationError)

    expect(securityEventMock).not.toHaveBeenCalled()
  })
})
