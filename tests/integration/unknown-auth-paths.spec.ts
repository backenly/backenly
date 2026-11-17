/**
 * An end-user auth path that does not exist answers as one: 404
 * ROUTE_NOT_FOUND, naming the path and listing the auth routes there are.
 *
 * Production QA re-test, 2026-11-16, N15: GET /auth/user and /auth/session
 * answered 404 'Provider "user" is not supported. Supported: google, github,
 * discord, facebook', because the OAuth route (/auth/:provider) took every
 * unknown name for a provider. The route that answers the question,
 * GET /auth/me, was not in the 404's own list either.
 *
 * Real runtime (served in this process) and the Next route that answers when
 * no runtime is configured.
 */
import '@/tests/helpers/real-web-standard'
import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import app from '@/server/app'
import { GET as nextUnmatched } from '@/app/api/v1/[projectId]/[...unmatched]/route'

let server: http.Server
let base = ''
const projectId = randomUUID()
const ME = 'GET    /auth/me               Authorization: Bearer <token> → { data: { user } }'
const ME_HINT = 'Auth has no user or session route: GET /auth/me returns the signed-in user, with their session token in Authorization: Bearer.'
const originalRuntimeUrl = process.env.RUNTIME_API_URL

beforeAll(async () => {
  delete process.env.RUNTIME_API_URL
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (originalRuntimeUrl === undefined) delete process.env.RUNTIME_API_URL
  else process.env.RUNTIME_API_URL = originalRuntimeUrl
})

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v1/${projectId}${path}`)
  return { status: res.status, body: await res.json() }
}

describe('the runtime', () => {
  it.each(['/auth/user', '/auth/session'])('answers %s as a route that does not exist, pointing at GET /auth/me', async (path) => {
    const { status, body } = await get(path)
    expect(status).toBe(404)
    expect(body).toMatchObject({
      code: 'ROUTE_NOT_FOUND',
      message: `No route matches /api/v1/${projectId}${path}`,
      hint: ME_HINT,
    })
    expect(body.availableRoutes).toContain(ME)
    expect(JSON.stringify(body)).not.toContain('Provider')
  }, 60_000)

  it('answers a mistyped provider with the auth routes, providers included', async () => {
    for (const path of ['/auth/gogle', '/auth/gogle/callback?code=x&state=y']) {
      const { status, body } = await get(path)
      expect(status).toBe(404)
      expect(body.code).toBe('ROUTE_NOT_FOUND')
      expect(body.availableRoutes).toContain('GET    /auth/{provider}       google, github, discord or facebook: starts that sign-in')
    }
  }, 60_000)

  it('CONTROL: still says a real provider is not set up for the project', async () => {
    const { status, body } = await get('/auth/google')
    expect(status).toBe(404)
    expect(body.message).toBe('google authentication is not configured for this project. Configure it under Auth → Social sign-in.')
  }, 60_000)
})

it('Next, with no runtime, gives the same answer', async () => {
  const res = await nextUnmatched(new NextRequest(`https://backenly.test/api/v1/${projectId}/auth/user`), {
    params: Promise.resolve({ projectId, unmatched: ['auth', 'user'] }),
  })
  expect(res.status).toBe(404)
  const body = await res.json()
  expect(body).toMatchObject({ code: 'ROUTE_NOT_FOUND', hint: ME_HINT })
  expect(body.availableRoutes).toContain(ME)
}, 60_000)
