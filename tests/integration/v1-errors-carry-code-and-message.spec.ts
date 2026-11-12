/**
 * v1 ERRORS CARRY A TOP-LEVEL code AND message, ON BOTH SERVERS
 * ===============================================================
 *
 * Production QA (2026-11-09), report 16: four error envelopes across the APIs.
 * Each v1 error now also says `code` and `message` at the top, taken from what
 * it already said, so a client reads every v1 error the same way and one that
 * read `error.message` or `error` still can (lib/api/v1/error-shape.ts).
 *
 * Real Express runtime and a real Next route; a function's own reply is the
 * app's and is answered as written (tests/integration/function-replies-as-written.spec.ts).
 */
import '@/tests/helpers/real-web-standard'
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { POST as nextSignin } from '@/app/api/v1/[projectId]/auth/signin/route'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

let server: http.Server
let base: string
let ownerId: string
let projectId: string

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `v1-errors-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'v1 errors' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({
    data: { name: 'v1-errors', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
    select: { id: true },
  })).id
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  await flushRecordedRequests().catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}, 120_000)

describe('the runtime', () => {
  it('a nested { error: { code, message } } keeps it, and says both at the top', async () => {
    const res = await fetch(`${base}/api/v1/${projectId}/auth/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.18.11.1' },
      body: JSON.stringify({}),
    })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.any(String) })
    expect(body).toMatchObject({ code: 'VALIDATION_ERROR', message: body.error.message })
  }, 60_000)

  it('a gate\'s { error, code } keeps it, and says the message at the top', async () => {
    const res = await fetch(`${base}/api/v1/${projectId}/db/orders`)
    const body = await res.json()
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(typeof body.error).toBe('string')
    expect(body).toMatchObject({ code: expect.any(String), message: body.error })
  }, 60_000)
})

describe('a Next route', () => {
  it('says code and message at the top as the runtime does', async () => {
    const res = await nextSignin(
      new NextRequest(`http://localhost/api/v1/${projectId}/auth/signin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.18.11.2' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ projectId }) },
    )
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body).toMatchObject({ code: 'VALIDATION_ERROR', message: body.error.message })
  }, 60_000)
})
