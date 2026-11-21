/**
 * The connections one process keeps to a data instance stay under one cap,
 * across every set that opens them (lib/data-plane/database-registry.ts
 * ConnectionBudget; lib/data-plane/regional.ts dataInstanceBudget).
 *
 * Pure rules with stand-in values, so this runs without a database: an open
 * value counts its most connections, whichever set opened it; at the cap the
 * least recently used idle one of ANY set is let go, never a pinned, running or
 * just-used one; a value let go that still holds connections counts them until
 * they close; a caller that can wait waits for room and is then refused with
 * the retryable busy error; and DATA_POOL_PROCESS_CAP, with its defaults by
 * kind of process. The database-backed half is
 * tests/integration/project-database-sessions.spec.ts.
 */
import {
  ConnectionBudget,
  DatabaseBusyError,
  DatabaseRegistry,
  whenRoom,
  type Admission,
} from '@/lib/data-plane/database-registry'
import { DATA_POOL_PROCESS_CAP_DEFAULTS, dataInstanceBudget, dataPoolProcessCap } from '@/lib/data-plane/regional'
import { noteProcessKind, processKind } from '@/lib/data-plane/process-kind'

/** A stand-in for a client or a pool: how many connections it holds, and whether it was closed. */
interface StandIn {
  name: string
  open: number
  busy: boolean
  closed: boolean
}

function setOf(name: string, clock: { now: number }, max = 10) {
  const closed: string[] = []
  const registry = new DatabaseRegistry<StandIn>({
    max,
    now: () => clock.now,
    idle: (value) => !value.busy,
    close: (value) => {
      value.closed = true
      closed.push(value.name)
    },
    // A value let go keeps what it holds until it closes on its own.
    held: (value) => value.open,
    what: `${name} values`,
  })
  const open = (key: string, admission: Admission, init: Partial<StandIn> = {}) =>
    registry.get(key, () => ({ name: key, open: 0, busy: false, closed: false, ...init }), admission)
  return { registry, open, closed }
}

describe('ConnectionBudget', () => {
  it('counts each open value’s most connections, whichever set opened it', () => {
    const clock = { now: 0 }
    const budget = new ConnectionBudget({ cap: 6, what: 'connections' })
    const clients = setOf('clients', clock)
    const pools = setOf('pools', clock)
    clients.open('a', { budget, weight: 2 })
    pools.open('a/x', { budget, weight: 2 })
    pools.open('a/y', { budget, weight: 1 })
    expect(budget.used()).toBe(5)
    // The same key again opens nothing.
    pools.open('a/x', { budget, weight: 2 })
    expect(budget.used()).toBe(5)
  })

  it('lets go of the least recently used idle value of any set to make room', () => {
    const clock = { now: 0 }
    const budget = new ConnectionBudget({ cap: 4, what: 'connections' })
    const clients = setOf('clients', clock)
    const pools = setOf('pools', clock)
    clients.open('old', { budget, weight: 2 })
    clock.now = 10
    pools.open('newer', { budget, weight: 2 })
    clock.now = 20
    pools.open('newest', { budget, weight: 2 })
    // The client was the least recently used: it was let go, from the other set.
    expect(clients.closed).toEqual(['old'])
    expect(clients.registry.has('old')).toBe(false)
    expect(pools.registry.has('newer')).toBe(true)
    expect(budget.used()).toBe(4)
  })

  it('never lets go of a pinned, running or busy value, and refuses at once when nothing is idle', () => {
    const clock = { now: 0 }
    const budget = new ConnectionBudget({ cap: 6, what: 'connections to project databases in us-east-1' })
    const clients = setOf('clients', clock)
    const pools = setOf('pools', clock)
    const create = () => ({ name: 'pinned', open: 0, busy: false, closed: false })
    const unpin = clients.registry.pin('pinned', create, { budget, weight: 2 })
    clients.open('running', { budget, weight: 2 })
    const done = clients.registry.track('running')
    pools.open('busy', { budget, weight: 2 }, { busy: true })
    clock.now = 1_000_000

    let refused: unknown
    try {
      pools.open('more', { budget, weight: 2 })
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(DatabaseBusyError)
    expect(refused).toMatchObject({ code: 'PROJECT_DATABASE_BUSY', status: 503, retryable: true, max: 6 })
    expect((refused as Error).message).toBe(
      'All 6 connections to project databases in us-east-1 this server keeps open are in use. Nothing was sent; try again shortly.',
    )
    expect([...clients.closed, ...pools.closed]).toEqual([])
    expect(pools.registry.has('more')).toBe(false)

    // Once one is done, it is what makes room.
    done()
    clock.now += 1
    pools.open('more', { budget, weight: 2 })
    expect(clients.closed).toEqual(['running'])
    unpin()
  })

  it('leaves a value used a moment ago open', () => {
    const clock = { now: 0 }
    const budget = new ConnectionBudget({ cap: 2, what: 'connections' })
    const closed: string[] = []
    const registry = new DatabaseRegistry<StandIn>({
      max: 10,
      minIdleMs: 1_000,
      now: () => clock.now,
      close: (value) => {
        closed.push(value.name)
      },
      what: 'clients',
    })
    const create = (name: string) => () => ({ name, open: 0, busy: false, closed: false })
    registry.get('a', create('a'), { budget, weight: 2 })
    clock.now = 500
    expect(() => registry.get('b', create('b'), { budget, weight: 2 })).toThrow(DatabaseBusyError)
    clock.now = 1_500
    registry.get('b', create('b'), { budget, weight: 2 })
    expect(closed).toEqual(['a'])
  })

  it('counts what a value let go still holds until it is gone', () => {
    const clock = { now: 0 }
    const budget = new ConnectionBudget({ cap: 4, what: 'connections' })
    const pools = setOf('pools', clock)
    const first = pools.open('first', { budget, weight: 2 }, { open: 2 })
    clock.now = 1
    pools.open('second', { budget, weight: 2 }, { busy: true })
    clock.now = 2
    // `first` is let go, but its two idle connections are still open.
    expect(() => pools.open('third', { budget, weight: 2 })).toThrow(DatabaseBusyError)
    expect(pools.closed).toEqual(['first'])
    expect(budget.used()).toBe(4)
    // They close on their own; then there is room.
    first.open = 0
    expect(budget.used()).toBe(2)
    pools.open('third', { budget, weight: 2 })
    expect(budget.used()).toBe(4)
  })

  it('frees everything a set closes on shutdown', async () => {
    const clock = { now: 0 }
    const budget = new ConnectionBudget({ cap: 4, what: 'connections' })
    const pools = setOf('pools', clock)
    pools.open('a', { budget, weight: 2 }, { open: 2, busy: true })
    pools.open('b', { budget, weight: 2 }, { open: 1, busy: true })
    await pools.registry.closeAll()
    expect(budget.used()).toBe(0)
  })

  it('reads its cap each time, so a changed setting applies at once', () => {
    const clock = { now: 0 }
    let cap = 2
    const budget = new ConnectionBudget({ cap: () => cap, what: 'connections' })
    const pools = setOf('pools', clock)
    pools.open('a', { budget, weight: 2 }, { busy: true })
    expect(() => pools.open('b', { budget, weight: 2 })).toThrow(DatabaseBusyError)
    cap = 4
    pools.open('b', { budget, weight: 2 })
    expect(budget.used()).toBe(4)
  })

  it('never admits a value larger than the whole cap', () => {
    const budget = new ConnectionBudget({ cap: 1, what: 'connections' })
    expect(budget.makeRoom(2)).toBe(false)
    expect(budget.used()).toBe(0)
  })
})

describe('whenRoom', () => {
  it('waits for room, then is refused with the retryable busy error', async () => {
    const budget = new ConnectionBudget({ cap: 2, what: 'connections' })
    const pools = setOf('pools', { now: 0 })
    pools.open('held', { budget, weight: 2 }, { busy: true })
    const started = Date.now()
    await expect(whenRoom(() => pools.open('waiting', { budget, weight: 2 }), 300)).rejects.toMatchObject({
      code: 'PROJECT_DATABASE_BUSY',
      status: 503,
      retryable: true,
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
    expect(pools.registry.has('waiting')).toBe(false)
  })

  it('lets a waiting caller in as soon as room comes free', async () => {
    const budget = new ConnectionBudget({ cap: 2, what: 'connections' })
    const pools = setOf('pools', { now: 0 })
    const held = pools.open('held', { budget, weight: 2 }, { busy: true })
    setTimeout(() => {
      held.busy = false
    }, 100)
    const started = Date.now()
    const value = await whenRoom(() => pools.open('waiting', { budget, weight: 2 }), 5_000)
    expect(value.name).toBe('waiting')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(pools.closed).toEqual(['held'])
  })

  it('throws any other error at once', async () => {
    let attempts = 0
    await expect(
      whenRoom(() => {
        attempts++
        throw new Error('not configured')
      }, 5_000),
    ).rejects.toThrow('not configured')
    expect(attempts).toBe(1)
  })
})

describe('DATA_POOL_PROCESS_CAP', () => {
  it('defaults to 60 in the web, 30 in the runtime and 30 elsewhere', () => {
    expect(DATA_POOL_PROCESS_CAP_DEFAULTS).toEqual({ web: 60, runtime: 30, other: 30 })
    expect(dataPoolProcessCap({}, 'web')).toBe(60)
    expect(dataPoolProcessCap({}, 'runtime')).toBe(30)
    expect(dataPoolProcessCap({}, 'other')).toBe(30)
  })

  it('takes a whole number of at least one client’s connections, and ignores anything else', () => {
    expect(dataPoolProcessCap({ DATA_POOL_PROCESS_CAP: '12' }, 'web')).toBe(12)
    expect(dataPoolProcessCap({ DATA_POOL_PROCESS_CAP: '2' }, 'runtime')).toBe(2)
    expect(dataPoolProcessCap({ DATA_POOL_PROCESS_CAP: '1' }, 'runtime')).toBe(30)
    expect(dataPoolProcessCap({ DATA_POOL_PROCESS_CAP: 'lots' }, 'web')).toBe(60)
    expect(dataPoolProcessCap({ DATA_POOL_PROCESS_CAP: '' }, 'web')).toBe(60)
  })

  it('tells the web by NEXT_RUNTIME and the runtime by what it says as it starts', () => {
    expect(processKind({})).toBe('other')
    expect(processKind({ NEXT_RUNTIME: 'nodejs' })).toBe('web')
    noteProcessKind('runtime')
    expect(processKind({ NEXT_RUNTIME: 'nodejs' })).toBe('runtime')
  })

  it('keeps one budget per data instance', () => {
    expect(dataInstanceBudget('us-east-1')).toBe(dataInstanceBudget('us-east-1'))
    expect(dataInstanceBudget('us-east-1')).not.toBe(dataInstanceBudget('eu-central-1'))
    expect(dataInstanceBudget('us-east-1', 'primary')).toBe(dataInstanceBudget('us-east-1'))
  })
})
