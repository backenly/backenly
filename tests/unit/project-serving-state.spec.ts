/**
 * The serving-state reader's failure and memory policy.
 *
 * Driven through `createServingStateReader` with a loader that can be made to
 * throw on demand and a clock the test owns. The loader stands in for "the
 * database answered" / "the database did not"; what is under test is what the
 * reader does with each, which does not depend on why the lookup failed.
 *
 * The real Prisma loader, the real Express app and the real mount order are
 * covered end to end by tests/integration/runtime-serving-gate.spec.ts.
 */
import {
  createServingStateReader,
  withStalenessBound,
  type ServingRow,
} from '@/lib/projects/serving-state'

const NO_PAUSE = { pausedAt: null, pauseReason: null }
const LOCKED: ServingRow = { lockedDownAt: new Date('2026-09-01T00:00:00Z'), lockedDownReason: 'abuse', ...NO_PAUSE }
const OPEN: ServingRow = { lockedDownAt: null, lockedDownReason: null, ...NO_PAUSE }
const PAUSED_AT = new Date('2026-09-10T00:00:00Z')
const PAUSED: ServingRow = { lockedDownAt: null, lockedDownReason: null, pausedAt: PAUSED_AT, pauseReason: 'inactivity' }
const LOCKED_AND_PAUSED: ServingRow = { ...LOCKED, pausedAt: PAUSED_AT, pauseReason: 'inactivity' }

function harness(opts: { maxEntries?: number } = {}) {
  let clock = 1_000_000
  const rows = new Map<string, ServingRow | null>()
  let failing = false
  let loads = 0

  const reader = createServingStateReader({
    load: async id => {
      loads++
      if (failing) throw new Error('P1017: Server has closed the connection.')
      return rows.has(id) ? rows.get(id)! : null
    },
    now: () => clock,
    freshMs: 15_000,
    notFoundFreshMs: 5_000,
    staleServingGraceMs: 60_000,
    maxEntries: opts.maxEntries ?? 100,
  })

  return {
    reader,
    set: (id: string, row: ServingRow | null) => rows.set(id, row),
    advance: (ms: number) => { clock += ms },
    fail: (on: boolean) => { failing = on },
    loads: () => loads,
  }
}

describe('what the reader answers when the database answers', () => {
  it('maps a row to serving, locked or not_found', async () => {
    const h = harness()
    h.set('open', OPEN)
    h.set('sealed', LOCKED)

    await expect(h.reader.get('open')).resolves.toEqual({ kind: 'serving' })
    await expect(h.reader.get('sealed')).resolves.toEqual({ kind: 'locked', reason: 'abuse' })
    await expect(h.reader.get('missing')).resolves.toEqual({ kind: 'not_found' })
  })

  it('serves a fresh answer from cache and re-reads once it goes stale', async () => {
    const h = harness()
    h.set('p', OPEN)

    await h.reader.get('p')
    await h.reader.get('p')
    expect(h.loads()).toBe(1)

    h.set('p', LOCKED)
    h.advance(15_001)
    await expect(h.reader.get('p')).resolves.toEqual({ kind: 'locked', reason: 'abuse' })
    expect(h.loads()).toBe(2)
  })

  it('keeps an answer that was already old when read only for what is left of the bound', async () => {
    // A region's copy answers with its watermark's age: 11 s of a 15 s bound,
    // so the answer may be trusted 4 s more, not the cache's full 15.
    const h = harness()
    h.set('p', { ...OPEN, freshForMs: 4_000 })
    await h.reader.get('p')
    h.advance(3_999)
    await h.reader.get('p')
    expect(h.loads()).toBe(1)

    h.set('p', LOCKED)
    h.advance(2)
    await expect(h.reader.get('p')).resolves.toEqual({ kind: 'locked', reason: 'abuse' })
    expect(h.loads()).toBe(2)
  })

  it("keeps home's answer in a region no longer than the region's bound, so a lock arrives within it", async () => {
    // Staging regions run a 10 s bound. Home answered (the copy was stale), and
    // the answer was kept the cache's full 15 s; now it is kept the bound.
    const h = harness()
    h.set('p', withStalenessBound({ row: OPEN, ageMs: 0 }, 10_000))
    await h.reader.get('p')
    h.set('p', LOCKED)
    h.advance(10_001)
    await expect(h.reader.get('p')).resolves.toEqual({ kind: 'locked', reason: 'abuse' })
    expect(h.loads()).toBe(2)
  })

  it('bounds every answer by what is left of the staleness bound after its age', () => {
    expect(withStalenessBound({ row: OPEN, ageMs: 0 }, 10_000)).toEqual({ ...OPEN, freshForMs: 10_000 })
    expect(withStalenessBound({ row: OPEN, ageMs: 7_000 }, 10_000)).toEqual({ ...OPEN, freshForMs: 3_000 })
    // At home the bound is the 15 s ceiling: the cache's own 15 s, as before.
    expect(withStalenessBound({ row: OPEN, ageMs: 0 }, 15_000)).toEqual({ ...OPEN, freshForMs: 15_000 })
    expect(withStalenessBound({ row: null, ageMs: 0 }, 10_000)).toBeNull()
  })

  it('never keeps an answer longer than the cache would, nor for a negative time', async () => {
    const h = harness()
    h.set('long', { ...OPEN, freshForMs: 60_000 })
    h.set('spent', { ...OPEN, freshForMs: -5 })
    await h.reader.get('long')
    await h.reader.get('spent')
    h.advance(1)
    await h.reader.get('spent')
    expect(h.loads()).toBe(3)
    h.advance(15_000)
    await h.reader.get('long')
    expect(h.loads()).toBe(4)
  })

  it('reports a pause with when and why', async () => {
    const h = harness()
    h.set('idle', PAUSED)
    await expect(h.reader.get('idle')).resolves.toEqual({
      kind: 'paused',
      pausedAt: PAUSED_AT,
      reason: 'inactivity',
    })
  })

  it('lets a lock outrank a pause, so resuming can never look like lifting a lock', async () => {
    const h = harness()
    h.set('both', LOCKED_AND_PAUSED)
    await expect(h.reader.get('both')).resolves.toEqual({ kind: 'locked', reason: 'abuse' })
  })

  it('caches not_found for less time than a real project', async () => {
    const h = harness()
    await h.reader.get('ghost')
    h.advance(5_001)
    await h.reader.get('ghost')
    expect(h.loads()).toBe(2)
  })
})

describe('what the reader answers when the database does NOT', () => {
  it('keeps a known lock sealed, however stale the cached answer is', async () => {
    // The property the whole module exists for. An error must never be what
    // unseals a project the operator locked.
    const h = harness()
    h.set('sealed', LOCKED)
    await h.reader.get('sealed')

    h.fail(true)
    h.advance(24 * 60 * 60 * 1000)
    await expect(h.reader.get('sealed')).resolves.toEqual({ kind: 'locked', reason: 'abuse' })
  })

  it('keeps a known pause in force, so an error never resumes a project', async () => {
    const h = harness()
    h.set('idle', PAUSED)
    await h.reader.get('idle')

    h.fail(true)
    h.advance(24 * 60 * 60 * 1000)
    await expect(h.reader.get('idle')).resolves.toEqual({
      kind: 'paused',
      pausedAt: PAUSED_AT,
      reason: 'inactivity',
    })
  })

  it('refuses when it has nothing to go on', async () => {
    const h = harness()
    h.fail(true)
    await expect(h.reader.get('never-seen')).resolves.toEqual({ kind: 'unavailable' })
  })

  it('rides out a blip for a project it recently saw serving', async () => {
    const h = harness()
    h.set('live', OPEN)
    await h.reader.get('live')

    h.fail(true)
    h.advance(15_000 + 30_000) // stale, but within the 60s grace
    await expect(h.reader.get('live')).resolves.toEqual({ kind: 'serving' })
  })

  it('stops vouching for a serving answer once the grace is spent', async () => {
    const h = harness()
    h.set('live', OPEN)
    await h.reader.get('live')

    h.fail(true)
    h.advance(15_000 + 60_001)
    await expect(h.reader.get('live')).resolves.toEqual({ kind: 'unavailable' })
  })

  it('recovers as soon as the database answers again', async () => {
    const h = harness()
    h.fail(true)
    await expect(h.reader.get('p')).resolves.toEqual({ kind: 'unavailable' })

    h.fail(false)
    h.set('p', OPEN)
    await expect(h.reader.get('p')).resolves.toEqual({ kind: 'serving' })
  })
})

describe('memory', () => {
  it('never holds more than maxEntries, however many ids are requested', async () => {
    // The key comes straight from the URL, before authentication.
    const h = harness({ maxEntries: 50 })
    for (let i = 0; i < 5_000; i++) await h.reader.get(`random-${i}`)
    expect(h.reader.size()).toBe(50)
  })

  it('evicts the least recently USED entry, not the oldest inserted', async () => {
    const h = harness({ maxEntries: 2 })
    h.set('a', LOCKED)
    h.set('b', OPEN)
    h.set('c', OPEN)

    await h.reader.get('a')
    await h.reader.get('b')
    await h.reader.get('a') // touch a, so b is now the least recently used
    await h.reader.get('c') // evicts b

    // a survived: a DB failure still has its lock to fall back on.
    h.fail(true)
    await expect(h.reader.get('a')).resolves.toEqual({ kind: 'locked', reason: 'abuse' })
    await expect(h.reader.get('b')).resolves.toEqual({ kind: 'unavailable' })
  })

  it('drops an entry on invalidate, so a same-process writer is seen at once', async () => {
    const h = harness()
    h.set('p', OPEN)
    await h.reader.get('p')

    h.set('p', LOCKED)
    h.reader.invalidate('p')
    await expect(h.reader.get('p')).resolves.toEqual({ kind: 'locked', reason: 'abuse' })
  })
})
