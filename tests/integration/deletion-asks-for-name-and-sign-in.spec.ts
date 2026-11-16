/**
 * DELETING ASKS FOR THE NAME AND A RECENT SIGN-IN
 * ===============================================
 * Deleting a project or an account was one request on any open session: no
 * name, no fresh sign-in, and the Projects list deleted in one click
 * (production QA re-test 2026-11-16, report #106). Both cannot be undone.
 *
 *   • a project is deleted only with its name in `confirm`, an account only
 *     with its email;
 *   • and only on a session signed in within the last ten minutes: an older
 *     one is answered 403 REAUTH_REQUIRED, saying how the person can sign in
 *     again; refreshing a session does not make it recent;
 *   • every refusal leaves the project or the account as it was;
 *   • a stranger still learns nothing: access is checked first.
 *
 * Real sessions, projects and accounts. Only requireUser's cookie read is
 * replaced (next/headers cannot run under jest): it hands the test's session
 * token to the real userFromToken.
 */

import { randomUUID } from 'crypto'

let currentToken = ''
jest.mock('@/lib/auth/server', () => {
  const actual = jest.requireActual('@/lib/auth/server')
  return { ...actual, requireUser: jest.fn(async () => actual.userFromToken(currentToken)) }
})

import '@/tests/helpers/real-web-standard'
import { prisma } from '@/lib/db/prisma'
import { createSession, refreshAccessToken } from '@/lib/auth/session'
import { DELETE as deleteProjectRoute } from '@/app/api/projects/[id]/route'
import { DELETE as deleteAccountRoute } from '@/app/api/auth/delete-account/route'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const userIds: string[] = []
const ELEVEN_MINUTES = 11 * 60 * 1000

async function account(opts: { password?: boolean; provider?: string } = {}) {
  const email = `deleting-${randomUUID()}@example.test`
  const user = await prisma.user.create({
    data: {
      email,
      name: 'Deleting',
      provider: opts.provider ?? 'email',
      ...(opts.password === false ? {} : { password: 'not-a-real-hash' }),
    },
    select: { id: true },
  })
  userIds.push(user.id)
  const session = await createSession(user.id, email, 'user')
  return { userId: user.id, email, token: session.token, refreshToken: session.refreshToken, sessionId: session.sessionId }
}

/** The session was opened `ms` ago. */
const signedInAgo = (sessionId: string, ms: number) =>
  prisma.session.update({ where: { id: sessionId }, data: { createdAt: new Date(Date.now() - ms) } })

async function project(ownerId: string) {
  return prisma.project.create({ data: { name: `shop-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true, name: true } })
}

function deleteRequest(path: string, body?: unknown): any {
  return {
    method: 'DELETE',
    url: `http://localhost:3000${path}`,
    nextUrl: new URL(`http://localhost:3000${path}`),
    headers: new Headers(),
    cookies: { get: () => undefined, getAll: () => [] },
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input')
      return body
    },
  }
}

async function deleteProject(id: string, body?: unknown) {
  const res: any = await deleteProjectRoute(deleteRequest(`/api/projects/${id}`, body), {} as any)
  return { status: res.status as number, body: await res.json() }
}

async function deleteAccount(body?: unknown) {
  const res: any = await deleteAccountRoute(deleteRequest('/api/auth/delete-account', body), {} as any)
  return { status: res.status as number, body: await res.json() }
}

/** Still there and not asked to be deleted. */
const projectExists = async (id: string) => (await prisma.project.count({ where: { id, deletedAt: null } })) === 1
/** Asked to be deleted: kept for seven days, then removed (lib/projects/deletion.ts). */
const projectDeleted = async (id: string) => (await prisma.project.count({ where: { id, deletedAt: { not: null } } })) === 1
const accountExists = async (id: string) => (await prisma.user.count({ where: { id } })) === 1

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

describe('deleting a project', () => {
  it('is refused without its name, and the project stays', async () => {
    const owner = await account()
    currentToken = owner.token
    const p = await project(owner.userId)

    const none = await deleteProject(p.id)
    expect(none.status).toBe(400)
    expect(none.body.code).toBe('CONFIRMATION_REQUIRED')
    expect(none.body.error).toContain(p.name)

    const wrong = await deleteProject(p.id, { confirm: `${p.name}-not` })
    expect(wrong.status).toBe(400)
    expect(await projectExists(p.id)).toBe(true)
  })

  it('is refused on a session signed in more than ten minutes ago, and says how to sign in again', async () => {
    const owner = await account()
    currentToken = owner.token
    await signedInAgo(owner.sessionId, ELEVEN_MINUTES)
    const p = await project(owner.userId)

    const r = await deleteProject(p.id, { confirm: p.name })

    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ code: 'REAUTH_REQUIRED', reauth: { email: owner.email, password: true, provider: null } })
    expect(r.body.error).toBe('Deleting this project needs a sign-in from the last 10 minutes. Sign in again, then delete it.')
    expect(await projectExists(p.id)).toBe(true)
  })

  it('does not count a refreshed session as a new sign-in', async () => {
    const owner = await account({ password: false, provider: 'google' })
    await signedInAgo(owner.sessionId, ELEVEN_MINUTES)
    currentToken = (await refreshAccessToken(owner.refreshToken)).token
    const p = await project(owner.userId)

    const r = await deleteProject(p.id, { confirm: p.name })

    expect(r.status).toBe(403)
    expect(r.body.reauth).toMatchObject({ password: false, provider: 'google' })
    expect(await projectExists(p.id)).toBe(true)
  })

  it('deletes with its name on a session signed in within ten minutes', async () => {
    const owner = await account()
    currentToken = owner.token
    await signedInAgo(owner.sessionId, 9 * 60 * 1000)
    const p = await project(owner.userId)

    const r = await deleteProject(p.id, { confirm: p.name })

    expect(r.status).toBe(200)
    expect(await projectDeleted(p.id)).toBe(true)
  })

  it("answers a stranger as before, without saying the project exists", async () => {
    const owner = await account()
    const stranger = await account()
    const p = await project(owner.userId)
    currentToken = stranger.token

    const r = await deleteProject(p.id, { confirm: p.name })

    expect(r.status).toBe(404)
    expect(r.body).toEqual({ success: false, error: 'Project not found or access denied' })
    expect(await projectExists(p.id)).toBe(true)
  })
})

describe('deleting an account', () => {
  it('is refused without its email, and the account stays', async () => {
    const me = await account()
    currentToken = me.token

    const r = await deleteAccount()
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('CONFIRMATION_REQUIRED')
    expect((await deleteAccount({ confirm: 'DELETE' })).status).toBe(400)
    expect(await accountExists(me.userId)).toBe(true)
  })

  it('is refused on a session signed in more than ten minutes ago, and the account stays', async () => {
    const me = await account()
    currentToken = me.token
    await signedInAgo(me.sessionId, ELEVEN_MINUTES)

    const r = await deleteAccount({ confirm: me.email })

    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ code: 'REAUTH_REQUIRED', reauth: { password: true } })
    expect(await accountExists(me.userId)).toBe(true)
  })

  it('deletes with its email, in any case, on a recent sign-in', async () => {
    const me = await account()
    currentToken = me.token

    const r = await deleteAccount({ confirm: me.email.toUpperCase() })

    expect(r.status).toBe(200)
    expect(await accountExists(me.userId)).toBe(false)
  })
})
