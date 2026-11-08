/**
 * What a realtime subscriber may receive of a change (lib/realtime/visibility.ts),
 * decided with the checks injected so every rule is pinned without a database:
 * what is delivered, in what order, and how the checks reach the database,
 * batched, bounded, and retried before a failure is reported rather than
 * dropped (#622). The live checks against real row-level security are in
 * __tests__/database/realtime-row-visibility.test.ts.
 */

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }))

import {
  CHANGES_NOT_DELIVERED,
  changesNotDelivered,
  createVisibilityChecker,
  createVisibleEventQueue,
  visibleChange,
  VisibilityCheckFailed,
  type PrimaryKeyColumn,
  type RealtimeChange,
  type RealtimeSubscriber,
  type VisibilityDeps,
} from '@/lib/realtime/visibility'

const PROJECT = '11111111-2222-4333-8444-555555555555'
const alice: RealtimeSubscriber = { projectId: PROJECT, endUserId: 'alice', endUserRole: 'user', serviceRole: false }
const anonymous: RealtimeSubscriber = { projectId: PROJECT, endUserId: null, endUserRole: null, serviceRole: false }
const service: RealtimeSubscriber = { projectId: PROJECT, endUserId: null, endUserRole: null, serviceRole: true }
const userNamed = (id: string): RealtimeSubscriber => ({ projectId: PROJECT, endUserId: id, endUserRole: 'user', serviceRole: false })
const KEY: PrimaryKeyColumn[] = [{ name: 'id', type: 'uuid' }]

/** Checks that answer each row with `visible(values)`, and record every query. */
function deps(visible: boolean | ((values: unknown[]) => boolean | Promise<boolean>), key: PrimaryKeyColumn[] | null = KEY) {
  let inFlight = 0
  const stats = { maxInFlight: 0 }
  const visibleRows = jest.fn(async (_s: RealtimeSubscriber, _t: string, _k: PrimaryKeyColumn[], rows: unknown[][]) => {
    inFlight++
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight)
    try {
      const answers = await Promise.all(rows.map((values) => (typeof visible === 'function' ? visible(values) : visible)))
      return new Set(answers.flatMap((yes, i) => (yes ? [i] : [])))
    } finally {
      inFlight--
    }
  })
  const primaryKey = jest.fn(async () => key)
  return { deps: { primaryKey, visibleRows } as VisibilityDeps, visibleRows, primaryKey, stats }
}

const checkerOver = (d: { deps: VisibilityDeps }, retryDelaysMs = [0, 0]) => createVisibilityChecker(d.deps, { retryDelaysMs })

const insert = (id: string, extra: Record<string, unknown> = {}): RealtimeChange => ({
  type: 'insert', table: 'notes', data: { id, owner_id: 'bob', body: 'secret', ...extra }, old: null, timestamp: 1,
})

/** Until every queued check has answered and been sent. */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

describe('visibleChange', () => {
  it('gives a service-role subscriber every change as sent, without checking', async () => {
    const d = deps(false)
    const change = insert('n1')
    expect(await visibleChange(service, change, checkerOver(d))).toBe(change)
    expect(d.visibleRows).not.toHaveBeenCalled()
  })

  it('delivers an insert the subscriber can select, and nothing when it cannot', async () => {
    expect(await visibleChange(alice, insert('n1'), checkerOver(deps(true)))).toMatchObject({ type: 'insert', data: { id: 'n1', body: 'secret' } })
    expect(await visibleChange(alice, insert('n2'), checkerOver(deps(false)))).toBeNull()
  })

  it('checks the row by its primary key value', async () => {
    const d = deps(true)
    await visibleChange(alice, insert('n9'), checkerOver(d))
    expect(d.visibleRows).toHaveBeenCalledWith(alice, 'notes', KEY, [['n9']])
  })

  it("reduces an update's old values to the primary key", async () => {
    const change: RealtimeChange = { type: 'update', table: 'notes', data: { id: 'n1', body: 'new' }, old: { id: 'n1', body: 'old secret' } }
    const out = await visibleChange(alice, change, checkerOver(deps(true)))
    expect(out).toMatchObject({ data: { id: 'n1', body: 'new' }, old: { id: 'n1' } })
    expect(JSON.stringify(out)).not.toContain('old secret')
  })

  it('reduces a delete to its primary key, without a check it could not make', async () => {
    const d = deps(false)
    const change: RealtimeChange = { type: 'delete', table: 'notes', data: { id: 'n1', owner_id: 'bob', body: 'secret' }, old: null }
    const out = await visibleChange(alice, change, checkerOver(d))
    expect(out).toMatchObject({ type: 'delete', data: { id: 'n1' } })
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(d.visibleRows).not.toHaveBeenCalled()
  })

  it('sends nothing for a row that has no key to check it by: no primary key, or a missing key value', async () => {
    expect(await visibleChange(alice, insert('n1'), checkerOver(deps(true, null)))).toBeNull()
    expect(await visibleChange(alice, { type: 'insert', table: 'notes', data: { body: 'x' } }, checkerOver(deps(true)))).toBeNull()
  })

  it('rejects, rather than answering nothing, when the database cannot answer a check', async () => {
    const failing = createVisibilityChecker(
      { primaryKey: async () => KEY, visibleRows: async () => { throw new Error('Unable to start a transaction in the given time.') } },
      { retryDelaysMs: [0, 0] },
    )
    await expect(visibleChange(alice, insert('n1'), failing)).rejects.toBeInstanceOf(VisibilityCheckFailed)
    const noCatalog = createVisibilityChecker(
      { primaryKey: async () => { throw new Error('region unreachable') }, visibleRows: async () => new Set([0]) },
      { retryDelaysMs: [0, 0] },
    )
    await expect(visibleChange(alice, insert('n1'), noCatalog)).rejects.toBeInstanceOf(VisibilityCheckFailed)
  })

  it('passes a change that carries no row data (too large to send) as it was sent', async () => {
    const truncated: RealtimeChange = { type: 'update', table: 'notes', data: null, truncated: true }
    expect(await visibleChange(alice, truncated, checkerOver(deps(false)))).toBe(truncated)
  })
})

describe('createVisibleEventQueue', () => {
  it('sends what the subscriber may see, in the order the changes arrived, however late a check answers', async () => {
    const d = deps(async (values) => {
      const id = String(values[0])
      if (id === 'slow') await new Promise((resolve) => setTimeout(resolve, 40))
      return id !== 'hidden'
    })
    const checker = checkerOver(d)
    const sent: string[] = []
    const deliver = createVisibleEventQueue(alice, (change) => sent.push(String(change.data?.id)), checker)
    deliver(insert('slow'))
    // The next two go in a later batch, which answers first.
    while (d.visibleRows.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve))
    deliver(insert('hidden'))
    deliver(insert('fast'))
    await settle(120)
    expect(d.visibleRows).toHaveBeenCalledTimes(2)
    expect(sent).toEqual(['slow', 'fast'])
  })
})

describe('the checks a burst costs', () => {
  /** Forty streams and a job inserting 100 rows, handed out as the listener hub does: every stream, in one loop. */
  function burst(subscribers: RealtimeSubscriber[], d: ReturnType<typeof deps>) {
    const checker = checkerOver(d)
    const received = subscribers.map(() => [] as string[])
    const queues = subscribers.map((s, n) => createVisibleEventQueue(s, (change) => received[n].push(String(change.data?.id)), checker))
    for (let row = 0; row < 100; row++) {
      const change = insert(`row-${row}`)
      for (const deliver of queues) deliver(change)
    }
    return received
  }

  it('is one query for streams opened as the same identity, not one per stream per change', async () => {
    const d = deps(true)
    const received = burst(Array.from({ length: 40 }, () => anonymous), d)
    await settle()
    expect(d.visibleRows).toHaveBeenCalledTimes(1)
    expect(d.visibleRows.mock.calls[0][3]).toHaveLength(100)
    expect(d.primaryKey).toHaveBeenCalledTimes(1)
    for (const rows of received) expect(rows).toEqual(Array.from({ length: 100 }, (_, row) => `row-${row}`))
  })

  it('is one query per identity, at most two at a time, for streams opened as forty different users', async () => {
    const d = deps(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return true
    })
    const received = burst(Array.from({ length: 40 }, (_, n) => userNamed(`user-${n}`)), d)
    await settle(400)
    expect(d.visibleRows).toHaveBeenCalledTimes(40)
    expect(d.stats.maxInFlight).toBeLessThanOrEqual(2)
    for (const rows of received) expect(rows).toHaveLength(100)
  })

  it('splits a burst too large for one query', async () => {
    const d = deps(true)
    const checker = checkerOver(d)
    const deliver = createVisibleEventQueue(alice, () => {}, checker)
    for (let row = 0; row < 450; row++) deliver(insert(`row-${row}`))
    await settle(60)
    expect(d.visibleRows.mock.calls.map((call) => call[3].length)).toEqual([200, 200, 50])
  })

  it('lets rows that arrive while every slot is busy join the waiting batch', async () => {
    const d = deps(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return true
    })
    const checker = checkerOver(d)
    const queues = [userNamed('a'), userNamed('b'), alice].map((s) => createVisibleEventQueue(s, () => {}, checker))
    // a and b take both slots; alice's rows keep arriving while she waits.
    queues[0](insert('a-1'))
    queues[1](insert('b-1'))
    for (let row = 0; row < 5; row++) {
      queues[2](insert(`alice-${row}`))
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    await settle(150)
    const alicesQueries = d.visibleRows.mock.calls.filter((call) => call[0] === alice)
    expect(alicesQueries).toHaveLength(1)
    expect(alicesQueries[0][3]).toHaveLength(5)
  })
})

describe('a check that fails', () => {
  it('is tried again, and the change is delivered when a retry answers', async () => {
    const d = deps(true)
    d.visibleRows.mockRejectedValueOnce(new Error('Unable to start a transaction in the given time.'))
    d.visibleRows.mockRejectedValueOnce(new Error('Timed out fetching a new connection from the connection pool.'))
    const sent: RealtimeChange[] = []
    createVisibleEventQueue(alice, (change) => sent.push(change), checkerOver(d))(insert('n1'))
    await settle()
    expect(d.visibleRows).toHaveBeenCalledTimes(3)
    expect(sent).toEqual([expect.objectContaining({ type: 'insert', data: expect.objectContaining({ id: 'n1' }) })])
  })

  it('is reported to the subscriber, once for a run of failures and never with the row, instead of dropped', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let down = true
      const d = deps(true)
      d.visibleRows.mockImplementation(async (_s, _t, _k, rows) => {
        if (down) throw new Error('Unable to start a transaction in the given time.')
        return new Set(rows.map((_, i) => i))
      })
      const sent: RealtimeChange[] = []
      const deliver = createVisibleEventQueue(alice, (change) => sent.push(change), checkerOver(d))
      deliver(insert('n1'))
      deliver(insert('n2'))
      await settle()
      deliver(insert('n3'))
      await settle()

      expect(sent).toEqual([expect.objectContaining({ type: 'error', code: CHANGES_NOT_DELIVERED, table: 'notes' })])
      expect(String(sent[0].message)).toMatch(/Read that table again to catch up/)
      expect(JSON.stringify(sent)).not.toContain('secret')
      // Logged once per failed query: the first batch (n1, n2) and the second (n3).
      expect(error).toHaveBeenCalledTimes(2)
      expect(String(error.mock.calls[0][0])).toMatch(/visibility check on .*\/notes failed after retries; 2 change\(s\) for 2 row\(s\)/)

      // The database answers again: the next change is delivered, and a later failure is reported anew.
      down = false
      deliver(insert('n4'))
      await settle()
      down = true
      deliver(insert('n5'))
      await settle()
      expect(sent.map((change) => change.type === 'error' ? 'reported' : change.data?.id)).toEqual(['reported', 'n4', 'reported'])
    } finally {
      error.mockRestore()
    }
  })

  it('is reported when the primary key cannot be read either, and one lookup answers every stream', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const d = deps(true)
      d.primaryKey.mockRejectedValue(new Error('region unreachable'))
      const checker = checkerOver(d)
      const sent: RealtimeChange[][] = [[], []]
      const queues = [alice, anonymous].map((s, n) => createVisibleEventQueue(s, (change) => sent[n].push(change), checker))
      for (const deliver of queues) deliver(insert('n1'))
      await settle()
      expect(d.primaryKey).toHaveBeenCalledTimes(3)
      for (const frames of sent) expect(frames).toEqual([expect.objectContaining({ code: CHANGES_NOT_DELIVERED, table: 'notes' })])
    } finally {
      error.mockRestore()
    }
  })
})

describe('the report of changes not delivered', () => {
  it('never reads as a fatal error to the SDK, whatever the table is called', () => {
    // packages/sdk/src/realtime.ts _isFatalError: these codes, or a message matching this.
    const fatalCodes = ['PLAN_LIMIT_EXCEEDED', 'INVALID_PROJECT', 'PROJECT_PAUSED', 'PROJECT_LOCKED']
    for (const table of ['notes', 'unauthorized_logins', 'api key audit', 'reached its limit']) {
      const frame = changesNotDelivered(table)
      expect(frame).toMatchObject({ type: 'error', code: CHANGES_NOT_DELIVERED, table })
      expect(fatalCodes).not.toContain(frame.code)
      expect(String(frame.message)).not.toMatch(/reached its limit|api key|unauthor/i)
    }
  })
})
