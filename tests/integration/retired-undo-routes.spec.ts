/**
 * THE UNDO ROUTES THAT WORKED OUTSIDE THE CHANGE LEDGER ARE RETIRED
 * ================================================================
 * Restoring is one thing now: the state before a governed change, from
 * History (lib/changes/recovery.ts). Each route that undid changes
 * some other way answers 410 with where restoring lives, changes nothing, and
 * still answers only someone who administers the project:
 *
 *   /undo, /undo-last-live-update   moved the active-graph pointer, schema untouched
 *   /restore                        moved the pointer and re-created what a version named
 *   /rollback/archives              listed archives nothing writes; its restore always threw
 *   /approvals/[findingId]/rollback re-ran a snapshot's "DDL", which was not SQL
 *
 * Real database, real guard; only the session identity is supplied by the test,
 * because requireUser reads next/headers, which jest cannot drive.
 */

import { randomUUID } from 'crypto'

let currentUserId = ''

jest.mock('@/lib/auth/server', () => {
  const actual = jest.requireActual('@/lib/auth/server')
  return {
    ...actual,
    requireUser: jest.fn(async () => {
      if (!currentUserId) throw new actual.UnauthorizedError('No session')
      return { userId: currentUserId, email: `${currentUserId}@test.invalid`, role: 'user' }
    }),
  }
})

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const users: Array<{ id: string; token: string }> = []
let owner: { id: string; token: string }
let stranger: { id: string; token: string }
let projectId: string

async function makeUser() {
  const email = `retired-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Retired routes' }, select: { id: true } })
  const { token } = await createSession(u.id, email, 'user')
  const user = { id: u.id, token }
  users.push(user)
  return user
}

function req(method: string, path: string, token: string): any {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  return {
    method,
    url: `http://localhost:3000${path}`,
    nextUrl: { pathname: path },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => ({ graphId: randomUUID(), sequenceNumber: 1, snapshotId: randomUUID() }),
  }
}
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) })

type Call = (user: { id: string; token: string }) => Promise<Response>
const routes: Record<string, Call> = {
  undo: async (u) => {
    const { POST } = await import('@/app/api/projects/[id]/undo/route')
    return POST(req('POST', `/api/projects/${projectId}/undo`, u.token), params({ id: projectId }))
  },
  'undo-last-live-update': async (u) => {
    const { POST } = await import('@/app/api/projects/[id]/undo-last-live-update/route')
    return POST(req('POST', `/api/projects/${projectId}/undo-last-live-update`, u.token), params({ id: projectId }))
  },
  restore: async (u) => {
    const { POST } = await import('@/app/api/projects/[id]/restore/route')
    return POST(req('POST', `/api/projects/${projectId}/restore`, u.token), params({ id: projectId }))
  },
  'rollback/archives GET': async (u) => {
    const { GET } = await import('@/app/api/projects/[id]/rollback/archives/route')
    return GET(req('GET', `/api/projects/${projectId}/rollback/archives`, u.token), params({ id: projectId }))
  },
  'rollback/archives POST': async (u) => {
    const { POST } = await import('@/app/api/projects/[id]/rollback/archives/route')
    return POST(req('POST', `/api/projects/${projectId}/rollback/archives`, u.token), params({ id: projectId }))
  },
}

async function asUser(user: { id: string; token: string }, call: Call) {
  currentUserId = user.id
  try {
    return await call(user)
  } finally {
    currentUserId = ''
  }
}

const projectState = () =>
  prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { activeGraphId: true, updatedAt: true } })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  owner = await makeUser()
  stranger = await makeUser()
  projectId = (await prisma.project.create({
    data: { name: `retired-${randomUUID().slice(0, 8)}`, userId: owner.id },
    select: { id: true },
  })).id
}, 60_000)

afterAll(async () => {
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  const ids = users.map((u) => u.id)
  await prisma.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
})

describe('each retired undo route', () => {
  it.each(Object.keys(routes))('%s answers 410 MOVED to the project admin, and changes nothing', async (name) => {
    const before = await projectState()
    const res = await asUser(owner, routes[name])
    expect(res.status).toBe(410)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'MOVED' })
    expect(body.error).toMatch(/Open History/)
    expect(body.error).toMatch(/Nothing was changed\./)
    expect(await projectState()).toEqual(before)
  })

  it.each(Object.keys(routes))('%s answers 404 to anyone who does not administer the project', async (name) => {
    const res = await asUser(stranger, routes[name])
    expect(res.status).toBe(404)
  })

  it('the approved-fix rollback keeps its administer floor, then answers 410', async () => {
    const { POST } = await import('@/app/api/projects/[id]/approvals/[findingId]/rollback/route')
    const findingId = randomUUID()
    const path = `/api/projects/${projectId}/approvals/${findingId}/rollback`
    const asOwner = await POST(req('POST', path, owner.token))
    expect(asOwner.status).toBe(410)
    expect(await asOwner.json()).toMatchObject({ code: 'MOVED' })
    const asStranger = await POST(req('POST', path, stranger.token))
    expect([403, 404]).toContain(asStranger.status)
  })
})
