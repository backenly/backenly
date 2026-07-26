/**
 * Tenant Isolation Tests
 * ======================
 * `requireProjectId` is the gate in front of every `withTenantIsolation` route,
 * so it has two properties worth pinning down:
 *
 *   1. It never hands back a project the caller does not own.
 *   2. It resolves that answer with a single auth pass and a single project read.
 *
 * (2) is not a micro-optimisation detail — the function used to re-run
 * `authenticateRequest` and repeat the ownership lookup after
 * `getCurrentProjectId` had already enforced it, doubling the per-request reads
 * without being able to reach a different verdict. These tests fail if either
 * the enforcement or the de-duplication regresses.
 */

import type { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({
  prisma: { project: { findFirst: jest.fn() } },
}))
jest.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: jest.fn(),
}))
jest.mock('@/lib/platform/controls', () => ({
  recordSecurityEvent: jest.fn(),
}))

import { prisma } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth/middleware'
import { recordSecurityEvent } from '@/lib/platform/controls'
import { requireProjectId, TenantIsolationError } from '@/lib/tenant/isolation'

const findFirst = prisma.project.findFirst as unknown as jest.Mock
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

  it('returns a project the caller owns, using one auth pass and one project read', async () => {
    findFirst.mockResolvedValue({ id: 'proj_owned' })

    const projectId = await requireProjectId(
      makeRequest({ headers: { 'x-project-id': 'proj_owned' } })
    )

    expect(projectId).toBe('proj_owned')

    // The regression this file exists for: resolving an owned project must not
    // cost two identity checks and two project lookups.
    expect(authMock).toHaveBeenCalledTimes(1)
    expect(findFirst).toHaveBeenCalledTimes(1)

    // And the single lookup it does make is scoped to the caller.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'proj_owned', userId: OWNER } })
    )
  })

  it('refuses a project the caller does not own and records the cross-tenant event', async () => {
    findFirst.mockResolvedValue(null)

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
    findFirst.mockResolvedValue(null)

    await expect(
      requireProjectId(
        makeRequest({ url: 'https://api.backenly.com/api/logs?projectId=proj_someone_else' })
      )
    ).rejects.toBeInstanceOf(TenantIsolationError)

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'proj_someone_else', userId: OWNER } })
    )
  })

  it('rejects an unauthenticated caller without touching the database', async () => {
    authMock.mockResolvedValue({ authenticated: false })

    await expect(
      requireProjectId(makeRequest({ headers: { 'x-project-id': 'proj_owned' } }))
    ).rejects.toBeInstanceOf(TenantIsolationError)

    expect(findFirst).not.toHaveBeenCalled()
  })

  it("falls back to the caller's own default project when none is requested", async () => {
    findFirst.mockResolvedValue({ id: 'proj_default' })

    const projectId = await requireProjectId(makeRequest())

    expect(projectId).toBe('proj_default')
    expect(findFirst).toHaveBeenCalledTimes(1)
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: OWNER } })
    )
  })

  it('throws when the caller has no projects at all', async () => {
    findFirst.mockResolvedValue(null)

    await expect(requireProjectId(makeRequest())).rejects.toBeInstanceOf(TenantIsolationError)
  })
})
