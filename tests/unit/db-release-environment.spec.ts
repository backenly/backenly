/**
 * Every database handle a test file opens is recorded, and closed when the
 * file ends (tests/helpers/db-release-environment.js).
 *
 * Without it, each file's Prisma clients and pg pools lived for the whole
 * process, and a --runInBand job ran Postgres out of connections partway
 * through. These check the two halves: construction is recorded without
 * changing what gets constructed, and release closes everything within a
 * budget even when one handle hangs. Nothing here connects to a database.
 */

import { Pool } from 'pg'
import { PrismaClient } from '@prisma/client'

const { releaseDbHandles } = require('../helpers/db-release-environment')

const handles = () => (globalThis as any).__backenlyDbHandles as { pools: Set<unknown>; clients: Set<unknown> }

describe('recording', () => {
  it('records a pool as it is constructed, and it is still a real Pool', async () => {
    const pool = new Pool({ connectionString: 'postgresql://x:y@127.0.0.1:1/none' })
    expect(handles().pools.has(pool)).toBe(true)
    expect(pool).toBeInstanceOf(Pool)
    expect(typeof pool.query).toBe('function')
    await pool.end()
  })

  it('records a subclass of Pool too', async () => {
    class LockPool extends Pool {}
    const pool = new LockPool({ connectionString: 'postgresql://x:y@127.0.0.1:1/none' })
    expect(handles().pools.has(pool)).toBe(true)
    expect(pool).toBeInstanceOf(LockPool)
    await pool.end()
  })

  it('records a Prisma client, and it keeps its model accessors', async () => {
    const client = new PrismaClient()
    expect(handles().clients.has(client)).toBe(true)
    expect(typeof (client as any).$disconnect).toBe('function')
    expect((client as any).project).toBeDefined()
    await client.$disconnect()
  })
})

describe('release', () => {
  const fakePool = (end: () => Promise<void>) => ({ ending: false, ended: false, end: jest.fn(end) })
  const fakeClient = () => ({ $disconnect: jest.fn(async () => {}) })

  it('ends every pool and disconnects every client, then forgets them', async () => {
    const pools = [fakePool(async () => {}), fakePool(async () => {})]
    const clients = [fakeClient()]
    const set = { pools: new Set(pools), clients: new Set(clients) }

    const asked = await releaseDbHandles(set)

    expect(asked).toBe(3)
    for (const p of pools) expect(p.end).toHaveBeenCalledTimes(1)
    expect(clients[0].$disconnect).toHaveBeenCalledTimes(1)
    expect(set.pools.size + set.clients.size).toBe(0)
  })

  it('does not end a pool a test already ended', async () => {
    const ended = { ending: true, ended: true, end: jest.fn(async () => {}) }
    await releaseDbHandles({ pools: new Set([ended]), clients: new Set() })
    expect(ended.end).not.toHaveBeenCalled()
  })

  it('gives up on a handle that never closes instead of hanging the run', async () => {
    const stuck = fakePool(() => new Promise<void>(() => {}))
    const started = Date.now()
    await releaseDbHandles({ pools: new Set([stuck]), clients: new Set() }, 50)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('survives a close that throws', async () => {
    const failing = fakePool(async () => { throw new Error('already closing') })
    await expect(releaseDbHandles({ pools: new Set([failing]), clients: new Set() })).resolves.toBe(1)
  })
})
