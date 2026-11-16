/**
 * A DELETED PROJECT CAN BE RESTORED UNTIL IT IS REMOVED FOR GOOD
 * ==============================================================
 * Deleting keeps a project for seven days (lib/projects/deletion.ts). This is
 * the way back (production QA re-test 2026-11-16, report #106):
 *
 *   • GET /api/projects?deleted=1 lists the projects asked to be deleted, each
 *     with when it is removed for good;
 *   • POST /api/projects/[id]/undelete brings one back: listed, counted and
 *     serving again; a project paused for inactivity before it was deleted
 *     stays paused;
 *   • it is refused, in the plan's words, when the plan has no room for it, and
 *     the project stays deleted;
 *   • only an owner or admin may restore it; anyone else gets the same 404.
 *
 * Real sessions, projects and serving state.
 */

import { randomUUID } from 'crypto'

let currentToken = ''
jest.mock('@/lib/auth/server', () => {
  const actual = jest.requireActual('@/lib/auth/server')
  return { ...actual, requireUser: jest.fn(async () => actual.userFromToken(currentToken)) }
})
// The plan: one project, so restoring one can find the plan full.
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', maxProjects: 1 }) }
})

import '@/tests/helpers/real-web-standard'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { DELETE as deleteProjectRoute } from '@/app/api/projects/[id]/route'
import { GET as listProjectsRoute } from '@/app/api/projects/route'
import { getProjectServingState, invalidateProjectServingState } from '@/lib/projects/serving-state'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const userIds: string[] = []

function request(method: string, path: string, body?: unknown): any {
  return {
    method,
    url: `http://localhost:3000${path}`,
    nextUrl: new URL(`http://localhost:3000${path}`),
    headers: new Headers(),
    cookies: { get: () => undefined, getAll: () => [] },
    json: async () => body ?? {},
  }
}

async function account() {
  const email = `restore-${randomUUID()}@example.test`
  const id = (await prisma.user.create({ data: { email, name: 'Restore', password: 'not-a-real-hash' }, select: { id: true } })).id
  userIds.push(id)
  return { id, token: (await createSession(id, email, 'user')).token }
}

async function project(ownerId: string) {
  return prisma.project.create({ data: { name: `shop-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true, name: true } })
}

async function deleteProject(p: { id: string; name: string }) {
  const res: any = await deleteProjectRoute(request('DELETE', `/api/projects/${p.id}`, { confirm: p.name }), {} as any)
  expect(res.status).toBe(200)
}

async function undelete(id: string) {
  const { POST } = await import('@/app/api/projects/[id]/undelete/route')
  const res: any = await POST(request('POST', `/api/projects/${id}/undelete`), { params: Promise.resolve({ id }) } as any)
  return { status: res.status as number, body: await res.json() }
}

async function listed(query = '') {
  const res: any = await listProjectsRoute(request('GET', `/api/projects${query}`), {} as any)
  return (await res.json()).data as Array<{ id: string; purgeAfter?: string | null }>
}

const row = (id: string) =>
  prisma.project.findUnique({ where: { id }, select: { deletedAt: true, purgeAfter: true, pausedAt: true, pauseReason: true } })

beforeAll(() => {
  process.env.BACKENLY_EDITION = 'cloud'
})

afterAll(async () => {
  await prisma.project.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {})
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
})

describe('restoring a deleted project', () => {
  it('lists it as deleted with its date, then brings it back, listed and serving', async () => {
    const owner = await account()
    currentToken = owner.token
    const p = await project(owner.id)
    await deleteProject(p)

    const deleted = await listed('?deleted=1')
    expect(deleted.map((x) => x.id)).toContain(p.id)
    expect(deleted.find((x) => x.id === p.id)!.purgeAfter).toBe((await row(p.id))!.purgeAfter!.toISOString())

    const r = await undelete(p.id)

    expect(r.status).toBe(200)
    expect(await row(p.id)).toEqual({ deletedAt: null, purgeAfter: null, pausedAt: null, pauseReason: null })
    invalidateProjectServingState(p.id)
    expect(await getProjectServingState(p.id)).toEqual({ kind: 'serving' })
    expect((await listed()).map((x) => x.id)).toContain(p.id)
    expect((await listed('?deleted=1')).map((x) => x.id)).not.toContain(p.id)
  })

  it('leaves a project that was paused for inactivity before it was deleted paused', async () => {
    const owner = await account()
    currentToken = owner.token
    const p = await project(owner.id)
    const pausedAt = new Date(Date.now() - 86_400_000)
    await prisma.project.update({ where: { id: p.id }, data: { pausedAt, pauseReason: 'inactivity' } })
    await deleteProject(p)

    expect((await undelete(p.id)).status).toBe(200)

    expect(await row(p.id)).toEqual({ deletedAt: null, purgeAfter: null, pausedAt, pauseReason: 'inactivity' })
  })

  it('is refused when the plan has no room for it, and the project stays deleted', async () => {
    const owner = await account()
    currentToken = owner.token
    const gone = await project(owner.id)
    await deleteProject(gone)
    await project(owner.id) // the plan's one project, made after the deletion freed its place

    const r = await undelete(gone.id)

    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' })
    expect(r.body.error).toBe(`${gone.name} cannot be restored: the plan's project limit is reached. Delete another project or upgrade, then restore it.`)
    expect((await row(gone.id))!.deletedAt).not.toBeNull()
  })

  it('answers someone who cannot administer it as if it did not exist', async () => {
    const owner = await account()
    const stranger = await account()
    currentToken = owner.token
    const p = await project(owner.id)
    await deleteProject(p)

    currentToken = stranger.token
    const r = await undelete(p.id)

    expect(r.status).toBe(404)
    expect((await row(p.id))!.deletedAt).not.toBeNull()
    expect((await listed('?deleted=1')).map((x) => x.id)).not.toContain(p.id)
  })

  it('says there is nothing to restore for a project that is not deleted', async () => {
    const owner = await account()
    currentToken = owner.token
    const p = await project(owner.id)

    const r = await undelete(p.id)

    expect(r.status).toBe(409)
    expect(r.body.code).toBe('PROJECT_NOT_DELETED')
  })
})
