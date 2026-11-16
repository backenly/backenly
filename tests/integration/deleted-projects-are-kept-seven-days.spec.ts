/**
 * A DELETED PROJECT IS KEPT FOR SEVEN DAYS, THEN REMOVED FOR GOOD
 * ===============================================================
 * Deleting a project dropped its schemas, backups and files in the same
 * request (production QA re-test 2026-11-16, report #106: "Deleting a project is
 * immediate, with no grace period"). Now it is asked for and carried out a week
 * later (lib/projects/deletion.ts), as Neon does:
 *
 *   • the project stays, with deletedAt and purgeAfter seven days on;
 *   • every door refuses it (the deletion pause), saying it was deleted;
 *   • it is not listed, not readable from the console, does not count toward
 *     the plan's project limit, and background passes leave it alone;
 *   • the daily purge removes it for good once purgeAfter has passed, and not
 *     before;
 *   • a project an import made and never finished is still removed at once.
 *
 * Real sessions, projects, jobs and serving state.
 */

import { randomUUID } from 'crypto'

let currentToken = ''
jest.mock('@/lib/auth/server', () => {
  const actual = jest.requireActual('@/lib/auth/server')
  return { ...actual, requireUser: jest.fn(async () => actual.userFromToken(currentToken)) }
})
// The plan: one project, so the limit is what a deletion frees.
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', maxProjects: 1 }) }
})

import '@/tests/helpers/real-web-standard'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { DELETE as deleteProjectRoute, GET as getProjectRoute } from '@/app/api/projects/[id]/route'
import { GET as listProjectsRoute } from '@/app/api/projects/route'
import { projectCreationVerdict } from '@/lib/projects/creation-verdict'
import { getProjectServingState, invalidateProjectServingState } from '@/lib/projects/serving-state'
import { refusalForState } from '@/lib/projects/serving-response'
import { maintenanceTargets } from '@/lib/edition/oss/fleet-scheduler'
import { activeProjectsWhere } from '@/lib/autonomy/activity-gate'
import { IMPORT_JOB_TYPE } from '@/lib/import/jobs'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const DAY = 24 * 60 * 60 * 1000
let ownerId = ''
let email = ''
const projectIds: string[] = []

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

async function project(name = `shop-${randomUUID().slice(0, 8)}`) {
  const p = await prisma.project.create({ data: { name, userId: ownerId }, select: { id: true, name: true } })
  projectIds.push(p.id)
  return p
}

async function deleteProject(p: { id: string; name: string }) {
  const res: any = await deleteProjectRoute(request('DELETE', `/api/projects/${p.id}`, { confirm: p.name }), {} as any)
  return { status: res.status as number, body: await res.json() }
}

const row = (id: string) =>
  prisma.project.findUnique({ where: { id }, select: { deletedAt: true, purgeAfter: true, pausedAt: true, pauseReason: true } })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  email = `kept-${randomUUID()}@example.test`
  ownerId = (await prisma.user.create({ data: { email, name: 'Kept', password: 'not-a-real-hash' }, select: { id: true } })).id
  currentToken = (await createSession(ownerId, email, 'user')).token
})

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
})

describe('deleting a project', () => {
  let p: { id: string; name: string }
  let answer: { status: number; body: any }
  const before = Date.now()

  beforeAll(async () => {
    p = await project()
    answer = await deleteProject(p)
  })

  it('keeps it for seven days and says when it is removed for good', async () => {
    expect(answer.status).toBe(200)
    const kept = await row(p.id)
    expect(kept?.deletedAt).not.toBeNull()
    const purgeAfter = kept!.purgeAfter!.getTime()
    expect(purgeAfter).toBeGreaterThanOrEqual(before + 7 * DAY - 1000)
    expect(purgeAfter).toBeLessThanOrEqual(Date.now() + 7 * DAY + 1000)
    expect(answer.body.purgeAfter).toBe(kept!.purgeAfter!.toISOString())
    expect(answer.body.message).toBe(`Project deleted. It is removed for good on ${kept!.purgeAfter!.toISOString().slice(0, 10)}.`)
  })

  it('stops it serving at every door, saying it was deleted', async () => {
    expect(await row(p.id)).toMatchObject({ pauseReason: 'deleted' })
    invalidateProjectServingState(p.id)
    const state = await getProjectServingState(p.id)
    expect(state).toMatchObject({ kind: 'paused', reason: 'deleted' })
    const refusal = refusalForState(p.id, state)!
    expect(refusal.status).toBe(503)
    const body = await refusal.json()
    expect(body.error).toMatchObject({ code: 'PROJECT_PAUSED', message: 'This project was deleted. It is removed for good 7 days after it was deleted.' })
  })

  it('leaves it out of the list, and the console reads it as deleted', async () => {
    const list: any = await listProjectsRoute(request('GET', '/api/projects'), {} as any)
    expect((await list.json()).data.map((x: { id: string }) => x.id)).not.toContain(p.id)

    const one: any = await getProjectRoute(request('GET', `/api/projects/${p.id}`), {} as any)
    expect(one.status).toBe(404)
    expect((await one.json()).code).toBe('PROJECT_DELETED')
  })

  it('leaves it out of background passes', async () => {
    expect((await maintenanceTargets()).map((t) => t.id)).not.toContain(p.id)
    expect(await prisma.project.count({ where: { AND: [{ id: p.id }, activeProjectsWhere()] } })).toBe(0)
  })

  it('a second deletion keeps the first date', async () => {
    const first = (await row(p.id))!.purgeAfter
    const again = await deleteProject(p)
    expect(again.status).toBe(200)
    expect((await row(p.id))!.purgeAfter).toEqual(first)
  })
})

describe('the plan’s project limit', () => {
  it('does not count a deleted project', async () => {
    // Every earlier project of this owner is deleted; one live project fills the plan.
    const live = await project()
    expect(await projectCreationVerdict(ownerId, null, { initialize: false })).toMatchObject({ allowed: false, code: 'PLAN_LIMIT_EXCEEDED' })

    expect((await deleteProject(live)).status).toBe(200)

    expect(await projectCreationVerdict(ownerId, null, { initialize: false })).toMatchObject({ allowed: true })
  })
})

describe('the daily purge', () => {
  // Read when used, so each test here fails on its own where the purge does not exist.
  const purgeDeletedProjects = async (now: Date) => (await import('@/lib/projects/deletion')).purgeDeletedProjects(now)

  it('removes a deleted project once its date has passed, and not before', async () => {
    const p = await project()
    await deleteProject(p)
    const purgeAfter = (await row(p.id))!.purgeAfter!

    const early = await purgeDeletedProjects(new Date(purgeAfter.getTime() - 60_000))
    expect(early.purged).not.toContain(p.id)
    expect(await row(p.id)).not.toBeNull()

    const due = await purgeDeletedProjects(new Date(purgeAfter.getTime() + 60_000))
    expect(due.purged).toContain(p.id)
    expect(await row(p.id)).toBeNull()
  })

  it('never removes a project nobody deleted', async () => {
    const p = await project()
    await purgeDeletedProjects(new Date(Date.now() + 30 * DAY))
    expect(await row(p.id)).toMatchObject({ deletedAt: null })
  })
})

describe('an import that never finished', () => {
  it('is removed at once, as before', async () => {
    const p = await project()
    await prisma.backgroundJob.create({
      data: { type: IMPORT_JOB_TYPE, status: 'failed', projectId: p.id, payload: {}, attempts: 1, maxAttempts: 1, runAt: new Date() },
    })

    const r = await deleteProject(p)

    expect(r.status).toBe(200)
    expect(await row(p.id)).toBeNull()
  })
})
