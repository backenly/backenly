/**
 * health.ts decides whether a PostgREST restart is recommended. It is small,
 * and it is the kind of small that takes a system down when it is wrong.
 *
 * The theme is FAILING CLOSED: an ambiguous health signal must not trigger a
 * restart, because the cautious branch is the one that preserves a working
 * system. This matters more since the single-engine cutover — there is no
 * legacy executor to fall back to, so a needless restart is a real outage
 * rather than a degraded path.
 *
 * (This file was tests/unit/postgrest-flag-health.spec.ts. The flag half went
 * with lib/postgrest/flag.ts when the per-project engine flag was retired;
 * these probe cases are unaffected by that and kept as-is.)
 */

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
  },
}))

import { probePostgrest } from '@/lib/postgrest/health'

describe('probePostgrest', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
  })

  it('reports not_configured rather than guessing', async () => {
    delete process.env.POSTGREST_URL
    expect((await probePostgrest()).state).toBe('not_configured')
  })

  // Duck-typed rather than a real Response: the global Response constructor is
  // not available in this Jest environment, and a mock that throws would make
  // every case look like an unreachable service — the probe reads only status,
  // ok and text(), so this exercises the identical path.
  const reply = (status: number, body: string) =>
    (jest.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    })) as unknown as typeof fetch)

  it('distinguishes a wedged schema cache from ordinary unavailability', async () => {
    // Both are 503. Only the first is cleared by a restart, and restarting for
    // the other turns a transient blip into dropped connections.
    process.env.POSTGREST_URL = 'http://127.0.0.1:3002'
    global.fetch = reply(503, '{"code":"PGRST002","message":"Could not query the database"}')
    expect((await probePostgrest()).state).toBe('schema_cache_failed')

    global.fetch = reply(503, 'service unavailable')
    expect((await probePostgrest()).state).toBe('unreachable')
  })

  it('reports healthy on a normal response', async () => {
    process.env.POSTGREST_URL = 'http://127.0.0.1:3002'
    global.fetch = reply(200, '{}')
    expect((await probePostgrest()).state).toBe('healthy')
  })

  it('treats a network failure as unreachable, not as a cache failure', async () => {
    // Misreading this as a wedged cache would recommend a restart for a problem
    // a restart cannot fix.
    process.env.POSTGREST_URL = 'http://127.0.0.1:3002'
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect((await probePostgrest()).state).toBe('unreachable')
  })
})
