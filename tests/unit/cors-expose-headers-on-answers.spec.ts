/**
 * A cross-origin app can read the data API's response headers on the answer
 * itself, not only on the preflight.
 *
 * handleCORS names the headers cross-origin JavaScript may read on the SDK
 * routes: Content-Range (the total behind `count`), Retry-After, and
 * Deprecation and Link (a /db route's successor on /api/v2). The browser reads
 * them from the actual answer. The forwarder drops the runtime's own CORS
 * headers (lib/runtime/forward-to-runtime.ts), so through the web server the
 * middleware's copy is the only one. cors-postgrest-headers.spec.ts checks the
 * list in the source; this runs the real middleware.
 */

import '@/tests/helpers/real-web-standard'

// `jose` ships ESM-only and jest cannot parse it; no token is verified on the
// paths under test, so a stub is faithful here.
jest.mock('jose', () => ({ jwtVerify: jest.fn(async () => ({ payload: {} })) }))

import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

const APP_ORIGIN = 'https://shop.example.com'
const MUST_READ = ['Content-Range', 'Retry-After', 'Deprecation', 'Link']

let projectOrigins: string[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  projectOrigins = []
  // The middleware asks the internal project-origins route which origins a
  // project allows; an empty list means any origin.
  globalThis.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ origins: projectOrigins }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

let n = 0
/** A fresh project id per request: the middleware caches each project's origins. */
const projectId = () => `proj_cors_expose_${++n}`

const send = (path: string, init: { method?: string; origin?: string } = {}) =>
  middleware(
    new NextRequest(`http://localhost:3000${path}`, {
      method: init.method ?? 'GET',
      headers: {
        host: 'localhost:3000',
        origin: init.origin ?? APP_ORIGIN,
        'x-api-key': 'bk_anon_placeholder',
      },
    }),
  )

const exposed = (res: Response | undefined | null) =>
  (res?.headers.get('access-control-expose-headers') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)

describe('the data API answer carries the headers a cross-origin app may read', () => {
  it.each([
    ['/api/v2 read', (id: string) => `/api/v2/${id}/orders`],
    ['/db read', (id: string) => `/api/v1/${id}/db/orders`],
  ])('%s', async (_label, path) => {
    const res = await send(path(projectId()))
    // CONTROL: the origin is allowed, so the answer is readable at all.
    expect(res?.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    expect(exposed(res)).toEqual(expect.arrayContaining(MUST_READ))
  })

  it('the answer exposes the same list as the preflight', async () => {
    const id = projectId()
    const preflight = await send(`/api/v2/${id}/orders`, { method: 'OPTIONS' })
    const answer = await send(`/api/v2/${id}/orders`)
    expect(exposed(preflight).length).toBeGreaterThan(0)
    expect(exposed(answer)).toEqual(exposed(preflight))
  })

  it('CONTROL: an origin the project does not allow gets no CORS headers at all', async () => {
    projectOrigins = ['https://only-this.example.com']
    const res = await send(`/api/v2/${projectId()}/orders`)
    expect(res?.headers.get('access-control-allow-origin')).toBeNull()
    expect(res?.headers.get('access-control-expose-headers')).toBeNull()
  })

  it('CONTROL: a platform route exposes nothing', async () => {
    const res = await send('/api/auth/session', { origin: 'http://localhost:3000' })
    expect(res?.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    expect(res?.headers.get('access-control-expose-headers')).toBeNull()
  })
})
