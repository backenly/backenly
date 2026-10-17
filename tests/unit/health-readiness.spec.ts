/**
 * Liveness and readiness of a web task (lib/health/readiness.ts).
 *
 * A regional load balancer replaces tasks on liveness only, and readiness
 * says what a region can still serve when Mumbai does not answer:
 *
 *   - liveness asks nothing of any database;
 *   - a region whose own database answers is ready while it can authorize:
 *     home answers, or the copy is enforced and fresh;
 *   - losing home with an enforced, fresh copy is degraded, not down; with the
 *     copy off, in shadow, or stale, nothing can authorize and it is not ready;
 *   - the region's own database not answering is not ready, whatever home says;
 *   - a dependency that hangs counts as not answering within the timeout, and
 *     failures are reported as codes, never error text.
 */

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }))

import { readFileSync } from 'fs'
import { join } from 'path'
import { regionalReadiness, within, type RegionalProbes } from '@/lib/health/readiness'

const never = () => new Promise<never>(() => {})
const fails = () => Promise.reject(new Error('connect ECONNREFUSED db.internal.example:5432'))
const answers = () => Promise.resolve(1)

function probes(overrides: Partial<RegionalProbes> & { copy?: { fresh: boolean; ageMs: number | null } } = {}): RegionalProbes {
  return {
    regionDatabase: overrides.regionDatabase ?? answers,
    homeDatabase: overrides.homeDatabase ?? answers,
    copyFreshness: overrides.copyFreshness ?? (async () => overrides.copy ?? { fresh: true, ageMs: 2_000 }),
  }
}

describe('liveness', () => {
  it('imports nothing but the response type, so it can never wait on a database', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/health/live/route.ts'), 'utf8')
    const imported = [...source.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imported).toEqual(['next/server'])
    expect(source).not.toMatch(/\brequire\(|\bimport\(/)
  })

  it('answers 200', async () => {
    const { GET } = await import('@/app/api/health/live/route')
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ live: true })
  })
})

describe('within', () => {
  it('turns a hang into a timeout and a throw into an error code, never the message', async () => {
    expect(await within(answers, 50)).toEqual({ ok: true, value: 1 })
    expect(await within(never, 20)).toEqual({ ok: false, reason: 'timeout' })
    const failed = await within(fails, 50)
    expect(failed).toEqual({ ok: false, reason: 'error' })
    expect(JSON.stringify(failed)).not.toContain('db.internal')
  })
})

describe('regional readiness', () => {
  const region = 'us-east-1' as const

  it('is ready and not degraded when the region, home and a fresh copy all answer', async () => {
    const r = await regionalReadiness(region, probes(), { mode: 'enforce', maxStalenessMs: 15_000, timeoutMs: 50 })
    expect(r).toMatchObject({ healthy: true, degraded: false, region, checks: { database: true, authorization: true } })
    expect(r.dependencies.home).toEqual({ reachable: true })
    expect(r.dependencies.authProjection).toEqual({ mode: 'enforce', fresh: true, ageMs: 2_000, boundMs: 15_000 })
  })

  it('keeps serving, degraded, when home is lost and the enforced copy is still fresh', async () => {
    const r = await regionalReadiness(region, probes({ homeDatabase: never }), { mode: 'enforce', timeoutMs: 30 })
    expect(r).toMatchObject({ healthy: true, degraded: true, checks: { database: true, authorization: true } })
    expect(r.dependencies.home).toEqual({ reachable: false, reason: 'timeout' })
  })

  it('is not ready when home is lost and the enforced copy has gone stale', async () => {
    const r = await regionalReadiness(region, probes({ homeDatabase: fails, copy: { fresh: false, ageMs: 16_000 } }), {
      mode: 'enforce',
      timeoutMs: 50,
    })
    expect(r).toMatchObject({ healthy: false, degraded: false, checks: { database: true, authorization: false } })
    expect(r.dependencies.authProjection).toMatchObject({ fresh: false, ageMs: 16_000 })
  })

  it.each(['off', 'shadow'] as const)('is not ready when home is lost and the copy is %s, because home authorizes', async (mode) => {
    const r = await regionalReadiness(region, probes({ homeDatabase: fails }), { mode, timeoutMs: 50 })
    expect(r).toMatchObject({ healthy: false, checks: { database: true, authorization: false } })
  })

  it('does not read the copy at all when the projection is off', async () => {
    const copyFreshness = jest.fn(async () => ({ fresh: true, ageMs: 1 }))
    const r = await regionalReadiness(region, probes({ copyFreshness }), { mode: 'off', timeoutMs: 50 })
    expect(copyFreshness).not.toHaveBeenCalled()
    expect(r).toMatchObject({ healthy: true, degraded: false })
    expect(r.dependencies.authProjection).toEqual({ mode: 'off' })
  })

  it('is ready but degraded while home answers for a stale or unreadable copy', async () => {
    const stale = await regionalReadiness(region, probes({ copy: { fresh: false, ageMs: null } }), { mode: 'shadow', timeoutMs: 50 })
    expect(stale).toMatchObject({ healthy: true, degraded: true })
    const unreadable = await regionalReadiness(region, probes({ copyFreshness: fails }), { mode: 'enforce', timeoutMs: 50 })
    expect(unreadable).toMatchObject({ healthy: true, degraded: true, checks: { authorization: true } })
    expect(unreadable.dependencies.authProjection).toMatchObject({ fresh: false, reason: 'error' })
  })

  it('is not ready when its own database does not answer, whatever home and the copy say', async () => {
    const r = await regionalReadiness(region, probes({ regionDatabase: never }), { mode: 'enforce', timeoutMs: 30 })
    expect(r).toMatchObject({ healthy: false, degraded: false, checks: { database: false, authorization: true } })
  })

  it('answers within the timeout when every dependency hangs', async () => {
    const started = Date.now()
    const r = await regionalReadiness(
      region,
      { regionDatabase: never, homeDatabase: never, copyFreshness: never },
      { mode: 'enforce', timeoutMs: 40 },
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(r.healthy).toBe(false)
    expect(r.dependencies.home).toEqual({ reachable: false, reason: 'timeout' })
  })
})
