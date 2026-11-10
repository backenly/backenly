/**
 * /api/auth/session reaches its route without a token; /api/auth/me does not.
 *
 * The middleware answers any /api request without a token with 401 unless the
 * path is listed as public. The session route checks the token itself and
 * answers a signed-out browser with { user: null }, so it is listed, exactly
 * (production QA 2026-11-09: the signed-out login page logged 401s).
 */

import '@/tests/helpers/real-web-standard'

// `jose` ships ESM-only and jest cannot parse it; no token is verified on the
// paths under test, so a stub is faithful here.
jest.mock('jose', () => ({ jwtVerify: jest.fn(async () => ({ payload: {} })) }))

import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

const run = (path: string) =>
  middleware(new NextRequest(`http://localhost:3000${path}`, { headers: { host: 'localhost:3000' } }))

it('lets /api/auth/session through without a token', async () => {
  const res = await run('/api/auth/session')
  expect(res?.status).not.toBe(401)
})

it('CONTROL: still answers /api/auth/me without a token with 401', async () => {
  expect((await run('/api/auth/me'))?.status).toBe(401)
})

it('lists the path exactly: a route added under it later is not public by accident', async () => {
  expect((await run('/api/auth/session/anything'))?.status).toBe(401)
})
