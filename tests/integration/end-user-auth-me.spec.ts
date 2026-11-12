/**
 * GET /api/v1/{projectId}/auth/me ANSWERS WHO IS SIGNED IN
 * ========================================================
 *
 * Production QA (2026-11-09), report 28: the obvious current-user path answered
 * 404 'Provider "me" is not supported. Supported: google, github, discord,
 * facebook'. Neither server had a current-user endpoint, so the path fell
 * through to the OAuth route (/auth/:provider), and an app had to decode its
 * own token to know who was signed in.
 *
 * Both servers now answer it from one flow (lib/services/end-user-auth-flows.ts
 * currentEndUser): the token checked the way every data request checks it, and
 * the user read from the users table. Real database, the real Express runtime
 * and the real Next route.
 */
import '@/tests/helpers/real-web-standard'
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { GET as nextMe } from '@/app/api/v1/[projectId]/auth/me/route'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

const PASSWORD = 'Correct-Horse-Battery-9!'
let server: http.Server
let base: string
let ownerId: string
let projectId: string

const express = (path: string, init: RequestInit = {}) => fetch(`${base}/api/v1/${projectId}${path}`, init)

/** A shopper who signed up through the runtime, with the token sign-up returned. */
async function shopper(name = 'Asha'): Promise<{ id: string; email: string; token: string }> {
  const email = `shopper-${crypto.randomBytes(4).toString('hex')}@gmail.com`
  const res = await express('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.18.9.${crypto.randomInt(1, 250)}` },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  })
  const body = await res.json()
  expect(res.status).toBe(201)
  return { id: String(body.data.user.id), email, token: body.data.token }
}

const me = async (headers: Record<string, string>) => {
  const res = await express('/auth/me', { headers })
  return { status: res.status, body: await res.json() }
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `auth-me-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Auth Me Suite' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({
    data: { name: 'auth-me', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
    select: { id: true },
  })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "workspace_${projectId}"."users" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text NOT NULL,
       name text, role text DEFAULT 'user', is_blocked boolean NOT NULL DEFAULT false,
       last_login timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  )
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  await flushRecordedRequests().catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}, 120_000)

describe('the runtime', () => {
  it('answers the signed-in user, from Authorization or X-User-Token', async () => {
    const asha = await shopper('Asha')
    const expected = { data: { user: { id: asha.id, email: asha.email, name: 'Asha', role: 'user' } } }

    await expect(me({ authorization: `Bearer ${asha.token}` })).resolves.toEqual({ status: 200, body: expected })
    await expect(me({ 'x-user-token': asha.token })).resolves.toEqual({ status: 200, body: expected })
  }, 60_000)

  it('reads the account as it is now, not as the token remembers it', async () => {
    const asha = await shopper('Asha')
    await prisma.$executeRawUnsafe(`UPDATE "workspace_${projectId}"."users" SET name = 'Asha K' WHERE id = $1::uuid`, asha.id)
    const { body } = await me({ authorization: `Bearer ${asha.token}` })
    expect(body.data.user.name).toBe('Asha K')
  }, 60_000)

  it('says to sign in when there is no token, rather than naming an OAuth provider', async () => {
    const { status, body } = await me({})
    expect(status).toBe(401)
    expect(body.error).toMatchObject({ code: 'UNAUTHORIZED', message: expect.stringContaining('Not signed in') })
    expect(JSON.stringify(body)).not.toContain('Provider')
  }, 60_000)

  it('refuses a token that is not valid, one revoked by logout, and a suspended account', async () => {
    await expect(me({ authorization: 'Bearer not-a-token' })).resolves.toMatchObject({ status: 401, body: { error: { code: 'UNAUTHORIZED' } } })

    const leaving = await shopper('Leaving')
    const out = await express('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${leaving.token}` } })
    expect(out.status).toBe(200)
    await expect(me({ authorization: `Bearer ${leaving.token}` })).resolves.toMatchObject({ status: 401 })

    const blocked = await shopper('Blocked')
    await prisma.$executeRawUnsafe(`UPDATE "workspace_${projectId}"."users" SET is_blocked = true WHERE id = $1::uuid`, blocked.id)
    await expect(me({ authorization: `Bearer ${blocked.token}` })).resolves.toMatchObject({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: 'This account has been suspended.' } },
    })
  }, 60_000)
})

describe('reads from one address', () => {
  it('are limited, since no API key is needed here, and the refusal says when to try again', async () => {
    const ip = `198.18.12.${crypto.randomInt(1, 250)}`
    for (let i = 0; i < 300; i++) {
      const res = await express('/auth/me', { headers: { 'x-forwarded-for': ip } })
      await res.text()
      expect(res.status).toBe(401)
    }
    const refused = await express('/auth/me', { headers: { 'x-forwarded-for': ip } })
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await refused.json()).error).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' })
    // Another address is not held back by it.
    expect((await express('/auth/me', { headers: { 'x-forwarded-for': '198.18.13.1' } })).status).toBe(401)
  }, 120_000)
})

describe('the Next route', () => {
  it('answers the same as the runtime', async () => {
    const asha = await shopper('Asha')
    const res = await nextMe(
      new NextRequest(`http://localhost/api/v1/${projectId}/auth/me`, { headers: { authorization: `Bearer ${asha.token}` } }),
      { params: Promise.resolve({ projectId }) },
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: { user: { id: asha.id, email: asha.email, name: 'Asha', role: 'user' } } })

    const anonymous = await nextMe(
      new NextRequest(`http://localhost/api/v1/${projectId}/auth/me`),
      { params: Promise.resolve({ projectId }) },
    )
    expect(anonymous.status).toBe(401)
  }, 60_000)
})
