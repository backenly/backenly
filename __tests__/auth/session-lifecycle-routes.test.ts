/**
 * SIGNING OUT ENDS THIS BROWSER'S SESSION, WHATEVER STATE IT IS IN
 * ================================================================
 *
 * `/api/auth/logout` used to sit behind withAuth. A browser whose access
 * session had expired got a 401 and kept its 30-day refresh cookie, the client
 * read the 401 as "already signed out", and the login page's session check
 * used the surviving cookie to sign the browser straight back in.
 *
 * Current-browser logout now needs no live session: it ends exactly the
 * sessions named by the credentials the request presents, and clears both
 * cookies. These tests pin the three halves of that bargain:
 *
 *  - it works from every state a browser can be in (live, access expired,
 *    cookie-only, Bearer and cookie drifted apart, nothing at all);
 *  - it can end ONLY what the caller holds (not the user's other devices, not
 *    another user's session, not anything on a cross-site request);
 *  - logout-all-devices still requires a live session, because it acts on the
 *    user's identity rather than on credentials the caller holds.
 *
 * The real exported handlers run against real session rows, and the refresh
 * route is driven afterwards to prove the refresh token cannot be replayed.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import type { NextRequest, NextResponse } from 'next/server'

import { POST as logout } from '@/app/api/auth/logout/route'
import { POST as refresh } from '@/app/api/auth/refresh-token/route'
import { createSession } from '@/lib/auth/session'

const prisma = new PrismaClient()
const userIds: string[] = []

/**
 * The request surface the handlers read. Not a NextRequest, because one cannot
 * be constructed here (`jest.setup.js` replaces `global.Request`; see
 * tests/integration/signin-enumeration.spec.ts). Only the transport envelope
 * is built by hand; the handlers, the session queries and Postgres are real.
 */
function request(opts: {
  cookies?: Record<string, string>
  bearer?: string
  site?: string
  all?: boolean
} = {}): NextRequest {
  const headers = new Map<string, string>()
  if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`)
  if (opts.site) headers.set('sec-fetch-site', opts.site)
  const cookies = opts.cookies ?? {}
  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    cookies: { get: (name: string) => (name in cookies ? { name, value: cookies[name] } : undefined) },
    nextUrl: { searchParams: new URLSearchParams(opts.all ? 'all=true' : '') },
    json: async () => { throw new SyntaxError('no body') },
  } as unknown as NextRequest
}

async function newUser(): Promise<{ id: string; email: string }> {
  const email = `session-lifecycle-${crypto.randomBytes(6).toString('hex')}@example.test`
  const user = await prisma.user.create({
    data: { email, password: 'not-a-real-hash', name: 'Session Lifecycle Suite' },
    select: { id: true, email: true },
  })
  userIds.push(user.id)
  return user
}

const exists = async (token: string) => !!(await prisma.session.findUnique({ where: { token } }))

function cleared(res: NextResponse, name: string): boolean {
  const cookie = res.cookies.get(name)
  return cookie?.value === '' && new Date(cookie.expires ?? 1).getTime() === 0
}

async function replayRefresh(refreshToken: string): Promise<number> {
  return (await refresh(request({ cookies: { 'refresh-token': refreshToken } }))).status
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

describe('POST /api/auth/logout, this browser', () => {
  it('ends a live session and clears both cookies, as before', async () => {
    const user = await newUser()
    const s = await createSession(user.id, user.email)

    const res = await logout(request({ bearer: s.token, cookies: { 'auth-token': s.token, 'refresh-token': s.refreshToken } }))

    expect(res.status).toBe(200)
    expect(await exists(s.token)).toBe(false)
    expect(cleared(res, 'auth-token')).toBe(true)
    expect(cleared(res, 'refresh-token')).toBe(true)
    expect(await replayRefresh(s.refreshToken)).toBe(401)
  })

  it('ends the session when the access session has expired but the refresh cookie is live', async () => {
    const user = await newUser()
    const s = await createSession(user.id, user.email)
    await prisma.session.update({ where: { token: s.token }, data: { expiresAt: new Date(Date.now() - 60_000) } })

    // The 7-day access cookie has lapsed in the browser; the stale localStorage
    // copy still goes as a Bearer, and the 30-day refresh cookie is there.
    const res = await logout(request({ bearer: s.token, cookies: { 'refresh-token': s.refreshToken } }))

    expect(res.status).toBe(200)
    expect(await exists(s.token)).toBe(false)
    expect(cleared(res, 'refresh-token')).toBe(true)
    expect(await replayRefresh(s.refreshToken)).toBe(401)
  })

  it('ends the session named by the refresh cookie alone', async () => {
    const user = await newUser()
    const s = await createSession(user.id, user.email)

    const res = await logout(request({ cookies: { 'refresh-token': s.refreshToken } }))

    expect(res.status).toBe(200)
    expect(await exists(s.token)).toBe(false)
  })

  it('ends a cookie-only session (no localStorage copy)', async () => {
    const user = await newUser()
    const s = await createSession(user.id, user.email)

    const res = await logout(request({ cookies: { 'auth-token': s.token, 'refresh-token': s.refreshToken } }))

    expect(res.status).toBe(200)
    expect(await exists(s.token)).toBe(false)
  })

  it('ends both sessions when the Bearer and the cookie have drifted apart', async () => {
    const user = await newUser()
    const a = await createSession(user.id, user.email)
    const b = await createSession(user.id, user.email)

    const res = await logout(request({ bearer: a.token, cookies: { 'auth-token': b.token, 'refresh-token': b.refreshToken } }))

    expect(res.status).toBe(200)
    expect(await exists(a.token)).toBe(false)
    expect(await exists(b.token)).toBe(false)
    expect(await replayRefresh(b.refreshToken)).toBe(401)
  })

  it('is harmless from a browser that is already signed out, and on repeat', async () => {
    const user = await newUser()
    const s = await createSession(user.id, user.email)
    const creds = { cookies: { 'auth-token': s.token, 'refresh-token': s.refreshToken } }

    expect((await logout(request(creds))).status).toBe(200)
    const again = await logout(request(creds))
    const empty = await logout(request())

    expect(again.status).toBe(200)
    expect(empty.status).toBe(200)
    expect(cleared(empty, 'auth-token')).toBe(true)
    expect(cleared(empty, 'refresh-token')).toBe(true)
  })

  it("ends only what it was given: not the user's other devices, not another user", async () => {
    const user = await newUser()
    const other = await newUser()
    const here = await createSession(user.id, user.email)
    const laptop = await createSession(user.id, user.email)
    const stranger = await createSession(other.id, other.email)

    await logout(request({ cookies: { 'auth-token': here.token, 'refresh-token': here.refreshToken } }))
    // A value that names nobody's session ends nothing.
    await logout(request({ bearer: 'not-a-token', cookies: { 'refresh-token': crypto.randomBytes(48).toString('hex') } }))

    expect(await exists(here.token)).toBe(false)
    expect(await exists(laptop.token)).toBe(true)
    expect(await exists(stranger.token)).toBe(true)
  })

  it.each(['cross-site', 'same-site'])('refuses a %s browser request, changing nothing', async (site) => {
    const user = await newUser()
    const s = await createSession(user.id, user.email)

    const res = await logout(request({ site, cookies: { 'auth-token': s.token, 'refresh-token': s.refreshToken } }))

    expect(res.status).toBe(403)
    expect(await exists(s.token)).toBe(true)
    expect(res.cookies.get('auth-token')).toBeUndefined()
  })

  it('accepts the same-origin request the console makes', async () => {
    const user = await newUser()
    const s = await createSession(user.id, user.email)

    const res = await logout(request({ site: 'same-origin', cookies: { 'auth-token': s.token, 'refresh-token': s.refreshToken } }))

    expect(res.status).toBe(200)
    expect(await exists(s.token)).toBe(false)
  })
})

describe('POST /api/auth/logout?all=true, every device', () => {
  it('refuses without a live session and ends nothing', async () => {
    const user = await newUser()
    const s = await createSession(user.id, user.email)
    await prisma.session.update({ where: { token: s.token }, data: { expiresAt: new Date(Date.now() - 60_000) } })

    const anonymous = await logout(request({ all: true }))
    const expired = await logout(request({ all: true, bearer: s.token, cookies: { 'refresh-token': s.refreshToken } }))

    expect(anonymous.status).toBe(401)
    expect(expired.status).toBe(401)
    expect(await exists(s.token)).toBe(true)
    expect(anonymous.cookies.get('refresh-token')).toBeUndefined()
  })

  it("ends every session of the signed-in user and no one else's", async () => {
    const user = await newUser()
    const other = await newUser()
    const here = await createSession(user.id, user.email)
    const laptop = await createSession(user.id, user.email)
    const stranger = await createSession(other.id, other.email)

    const res = await logout(request({ all: true, bearer: here.token }))

    expect(res.status).toBe(200)
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0)
    expect(await exists(laptop.token)).toBe(false)
    expect(await exists(stranger.token)).toBe(true)
    expect(cleared(res, 'auth-token')).toBe(true)
    expect(cleared(res, 'refresh-token')).toBe(true)
    expect(await replayRefresh(laptop.refreshToken)).toBe(401)
  })
})
