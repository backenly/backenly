/**
 * Every database handle a test file opens is recorded, and closed when the
 * file ends (tests/helpers/db-release-environment.js).
 *
 * Without it, each file's Prisma clients and pg pools lived for the whole
 * process, and a --runInBand job ran Postgres out of connections partway
 * through. These check the two halves: construction is recorded without
 * changing what gets constructed, and release closes everything within a
 * budget even when one handle hangs. Nothing here connects to a database.
 *
 * And the file's timers: a retry, a keep-alive or a reconnect still pending
 * when the file ended ran later, against a client the release had closed, and
 * reconnected it for the rest of the process.
 */

import { promisify } from 'util'
import { Client, Pool } from 'pg'
import { PrismaClient } from '@prisma/client'

const { releaseDbHandles, trackTimers } = require('../helpers/db-release-environment')

const handles = () =>
  (globalThis as any).__backenlyDbHandles as { pools: Set<unknown>; clients: Set<unknown>; pgClients: Set<unknown> }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

  it('records a pg Client used on its own, and it is still a real Client', async () => {
    const client = new Client({ connectionString: 'postgresql://x:y@127.0.0.1:1/none' })
    expect(handles().pgClients.has(client)).toBe(true)
    expect(client).toBeInstanceOf(Client)
    expect(typeof client.query).toBe('function')
  })

  it('does not record the clients a pool makes for itself', () => {
    const before = handles().pgClients.size
    const pool = new Pool({ connectionString: 'postgresql://x:y@127.0.0.1:1/none' })
    expect(handles().pgClients.size).toBe(before)
    void pool.end()
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

  const fakePgClient = (ending = false) => ({ _ending: ending, end: jest.fn(async () => {}) })

  it('ends every pool and pg client and disconnects every Prisma client, then forgets them', async () => {
    const pools = [fakePool(async () => {}), fakePool(async () => {})]
    const clients = [fakeClient()]
    const pgClients = [fakePgClient()]
    const set = { pools: new Set(pools), clients: new Set(clients), pgClients: new Set(pgClients) }

    const asked = await releaseDbHandles(set)

    expect(asked).toBe(4)
    for (const p of pools) expect(p.end).toHaveBeenCalledTimes(1)
    expect(clients[0].$disconnect).toHaveBeenCalledTimes(1)
    expect(pgClients[0].end).toHaveBeenCalledTimes(1)
    expect(set.pools.size + set.clients.size + set.pgClients.size).toBe(0)
  })

  it('does not end a pg client a test already ended', async () => {
    const ended = fakePgClient(true)
    await releaseDbHandles({ pools: new Set(), clients: new Set(), pgClients: new Set([ended]) })
    expect(ended.end).not.toHaveBeenCalled()
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

describe('timers', () => {
  // A stand-in for a test file's global, with the process's real timers.
  const fileGlobal = () => ({ setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate }) as any

  it('runs timers as usual while the file runs', async () => {
    const g = fileGlobal()
    trackTimers(g)
    const ran = jest.fn()
    g.setTimeout(ran, 5, 'a', 'b')
    g.setImmediate(ran, 'c')
    await wait(30)
    expect(ran).toHaveBeenCalledWith('a', 'b')
    expect(ran).toHaveBeenCalledWith('c')
  })

  it('clears every timer still pending when the file ends: a retry, a keep-alive, a reconnect', async () => {
    const g = fileGlobal()
    const timers = trackTimers(g)
    const retry = jest.fn()
    const keepAlive = jest.fn()
    const soon = jest.fn()
    g.setTimeout(retry, 20)
    g.setInterval(keepAlive, 5)
    g.setImmediate(soon)
    timers.stop()
    await wait(60)
    expect(retry).not.toHaveBeenCalled()
    expect(keepAlive).not.toHaveBeenCalled()
    expect(soon).not.toHaveBeenCalled()
  })

  it('schedules nothing once the file has ended, and still hands back a usable handle', async () => {
    const g = fileGlobal()
    const timers = trackTimers(g)
    timers.stop()
    const late = jest.fn()
    const handle = g.setTimeout(late, 1)
    expect(typeof handle.unref).toBe('function')
    handle.unref()
    g.setInterval(late, 1)
    g.setImmediate(late)
    await wait(30)
    expect(late).not.toHaveBeenCalled()
  })

  it('clears what is pending and keeps timers working, for closing pools and clients', async () => {
    const g = fileGlobal()
    const timers = trackTimers(g)
    const leftover = jest.fn()
    g.setTimeout(leftover, 20)
    timers.clearPending()
    const closing = jest.fn()
    g.setTimeout(closing, 1)
    await wait(40)
    expect(leftover).not.toHaveBeenCalled()
    expect(closing).toHaveBeenCalled()
  })

  it('forgets a timer that ran or was cleared, so ending clears only what is pending', async () => {
    const g = fileGlobal()
    const timers = trackTimers(g)
    g.setTimeout(() => {}, 1)
    const cleared = g.setTimeout(() => {}, 1_000)
    g.clearTimeout(cleared)
    await wait(20)
    expect(timers.pendingCount()).toBe(0)
  })

  it('keeps util.promisify(setTimeout) working', async () => {
    const g = fileGlobal()
    trackTimers(g)
    await expect(promisify(g.setTimeout)(5, 'done')).resolves.toBe('done')
  })
})
