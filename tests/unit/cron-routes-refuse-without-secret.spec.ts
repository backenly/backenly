/**
 * EVERY /api/cron ROUTE REFUSES A CALLER WITHOUT THIS SERVER'S CRON_SECRET
 * ========================================================================
 * middleware.ts lets /api/cron/ through without a session, so each route's
 * own check is the whole of its authorization. With CRON_SECRET unset, a
 * self-host's default (README, "CRON_SECRET"), ten routes let callers in:
 * four anyone, one anyone who sent no secret, and five anyone who sent
 * `Authorization: Bearer undefined`. Every route now asks
 * lib/security/cron-auth.ts, which refuses when no secret is configured.
 *
 * Each handler is called here as Next calls it. A refused call returns before
 * the route touches anything, so no database is needed.
 */
// The runtime's own Request and Headers, before next/server loads (NextRequest
// cannot extend jest.setup.js's stand-ins).
import '@/tests/helpers/real-web-standard'

import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'

import { CRON_SECRET_PLACEHOLDER, cronSecretMatches, isCronRequest } from '@/lib/security/cron-auth'

const ROOT = path.resolve(__dirname, '../..')
const CRON_DIR = path.join(ROOT, 'app/api/cron')
/** Every cron route but health, whose liveness answers anyone (below). */
const GUARDED = fs
  .readdirSync(CRON_DIR)
  .filter((name) => name !== 'health' && fs.existsSync(path.join(CRON_DIR, name, 'route.ts')))
  .sort()

const SECRET = 'cron-secret-for-this-test-0123456789abcdef'
const request = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  new NextRequest(new URL(url, 'http://127.0.0.1:3000'), { method, headers })

const saved = process.env.CRON_SECRET
const setSecret = (value: string | undefined) => {
  if (value === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = value
}
afterEach(() => setSecret(saved))

describe('isCronRequest', () => {
  it('refuses every caller when CRON_SECRET is unset, empty or the .env.example placeholder', () => {
    for (const value of [undefined, '', CRON_SECRET_PLACEHOLDER]) {
      setSecret(value)
      const sent = value ?? 'undefined'
      expect(isCronRequest(request('/api/cron/x'))).toBe(false)
      expect(isCronRequest(request('/api/cron/x', { authorization: 'Bearer undefined' }))).toBe(false)
      expect(isCronRequest(request('/api/cron/x', { authorization: `Bearer ${sent}` }))).toBe(false)
      expect(isCronRequest(request('/api/cron/x', { 'x-cron-secret': sent }))).toBe(false)
      expect(isCronRequest(request(`/api/cron/x?secret=${encodeURIComponent(sent)}`), { query: true })).toBe(false)
      expect(cronSecretMatches(sent)).toBe(false)
    }
  })

  it('accepts the secret as a bearer token or an x-cron-secret header, and as ?secret= only where a route asks', () => {
    setSecret(SECRET)
    expect(isCronRequest(request('/api/cron/x', { authorization: `Bearer ${SECRET}` }))).toBe(true)
    expect(isCronRequest(request('/api/cron/x', { 'x-cron-secret': SECRET }))).toBe(true)
    expect(isCronRequest(request(`/api/cron/x?secret=${SECRET}`))).toBe(false)
    expect(isCronRequest(request(`/api/cron/x?secret=${SECRET}`), { query: true })).toBe(true)
  })

  it('refuses a wrong or partial secret, and one sent without the Bearer scheme', () => {
    setSecret(SECRET)
    for (const wrong of ['undefined', 'null', SECRET.slice(0, -1), SECRET.slice(1), SECRET.toUpperCase(), `${SECRET}x`]) {
      expect(isCronRequest(request('/api/cron/x', { authorization: `Bearer ${wrong}` }))).toBe(false)
      expect(isCronRequest(request('/api/cron/x', { 'x-cron-secret': wrong }))).toBe(false)
      expect(isCronRequest(request(`/api/cron/x?secret=${encodeURIComponent(wrong)}`), { query: true })).toBe(false)
    }
    expect(isCronRequest(request('/api/cron/x', { authorization: SECRET }))).toBe(false)
    expect(isCronRequest(request('/api/cron/x', { authorization: `Basic ${SECRET}` }))).toBe(false)
  })
})

describe('the cron routes', () => {
  it('each ask isCronRequest, and none compares CRON_SECRET itself', () => {
    expect(GUARDED.length).toBeGreaterThanOrEqual(12)
    for (const name of GUARDED) {
      const src = fs.readFileSync(path.join(CRON_DIR, name, 'route.ts'), 'utf8')
      expect([name, /isCronRequest\(request/.test(src)]).toEqual([name, true])
      expect([name, /process\.env\.CRON_SECRET/.test(src)]).toEqual([name, false])
    }
  })

  it.each(GUARDED)('%s answers 401 to callers without the secret when CRON_SECRET is unset', async (name) => {
    setSecret(undefined)
    const route = await import(path.join(CRON_DIR, name, 'route.ts'))
    const methods = ['GET', 'POST'].filter((m) => typeof route[m] === 'function')
    expect(methods.length).toBeGreaterThan(0)
    for (const method of methods) {
      for (const headers of [{}, { authorization: 'Bearer undefined' }, { 'x-cron-secret': 'undefined' }]) {
        const res = await route[method](request(`/api/cron/${name}?secret=undefined`, headers, method))
        expect([method, JSON.stringify(headers), res.status]).toEqual([method, JSON.stringify(headers), 401])
      }
    }
  })
})

describe('/api/cron/health', () => {
  it('answers liveness to anyone, and what the scheduler ran across projects only with the secret', async () => {
    const { GET } = await import('@/app/api/cron/health/route')

    setSecret(undefined)
    const open = await GET(request('/api/cron/health', { authorization: 'Bearer undefined' }))
    expect(open.status).toBe(200)
    const liveness = await open.json()
    expect(liveness.ok).toBe(true)
    expect(liveness).not.toHaveProperty('activeCronJobs')
    expect(liveness).not.toHaveProperty('lastExecutedJob')

    setSecret(SECRET)
    const full = await (await GET(request('/api/cron/health', { 'x-cron-secret': SECRET }))).json()
    expect(full.ok).toBe(true)
    expect(full).toHaveProperty('activeCronJobs')
    expect(full).toHaveProperty('lastExecutedJob')
  })
})
