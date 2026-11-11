/**
 * A SIGNED-OUT BROWSER IS ANSWERED, NOT REFUSED
 * =============================================
 *
 * Production QA (2026-11-09): the signed-out login page logged a 401 from
 * /api/auth/me and another from /api/auth/refresh-token on every load, because
 * the session hook asked /me and then tried a refresh it had no cookie for.
 * GET /api/auth/session answers every browser with 200: the user for a live
 * session, otherwise { user: null, canRefresh } so the hook refreshes only
 * when a refresh cookie is there. The token is checked by the same function
 * requireUser uses (userFromToken), against real session rows here.
 */

import '../helpers/real-web-standard'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { GET } from '@/app/api/auth/session/route'

let userId: string
let email: string

beforeAll(async () => {
  email = `session-answer-${crypto.randomBytes(6).toString('hex')}@example.test`
  userId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'Session Answer' } })).id
}, 60_000)

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
}, 60_000)

const ask = async (opts: { cookies?: Record<string, string>; bearer?: string } = {}) => {
  const headers: Record<string, string> = {}
  const cookie = Object.entries(opts.cookies ?? {}).map(([k, v]) => `${k}=${v}`).join('; ')
  if (cookie) headers.cookie = cookie
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  const res = await GET(new NextRequest('http://localhost:3000/api/auth/session', { headers }))
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }
}

it('answers a browser with no session and nothing to refresh: no user, nothing to refresh', async () => {
  const r = await ask()
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ user: null, canRefresh: false })
  expect(r.cache).toBe('no-store')
})

it('answers a browser whose access session is gone but whose refresh cookie is there: refresh', async () => {
  const r = await ask({ cookies: { 'refresh-token': 'some-refresh-token' } })
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ user: null, canRefresh: true })
})

it('answers a live session cookie with the profile /api/auth/me gives', async () => {
  const s = await createSession(userId, email)
  const r = await ask({ cookies: { 'auth-token': s.token } })
  expect(r.status).toBe(200)
  expect(r.body.user).toMatchObject({ id: userId, email, name: 'Session Answer', hasPassword: true, projectsCount: 0 })
  expect(r.body.user).not.toHaveProperty('password')
})

it('answers a live Bearer token the same way', async () => {
  const s = await createSession(userId, email)
  expect((await ask({ bearer: s.token })).body.user).toMatchObject({ id: userId })
})

it('answers an expired session as signed out', async () => {
  const s = await createSession(userId, email)
  await prisma.session.update({ where: { token: s.token }, data: { expiresAt: new Date(Date.now() - 1000) } })
  expect((await ask({ cookies: { 'auth-token': s.token } })).body).toEqual({ user: null, canRefresh: false })
})

it('answers a forged token as signed out', async () => {
  expect((await ask({ cookies: { 'auth-token': 'not.a.jwt' } })).body).toEqual({ user: null, canRefresh: false })
})
