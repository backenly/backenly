/**
 * What a realtime subscriber may receive of a change (lib/realtime/visibility.ts),
 * decided with the checks injected so every rule is pinned without a database.
 * The live checks against real row-level security are in
 * __tests__/database/realtime-row-visibility.test.ts.
 */

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }))

import {
  createVisibleEventQueue,
  visibleChange,
  type PrimaryKeyColumn,
  type RealtimeChange,
  type RealtimeSubscriber,
  type VisibilityDeps,
} from '@/lib/realtime/visibility'

const PROJECT = '11111111-2222-4333-8444-555555555555'
const alice: RealtimeSubscriber = { projectId: PROJECT, endUserId: 'alice', endUserRole: 'user', serviceRole: false }
const service: RealtimeSubscriber = { projectId: PROJECT, endUserId: null, endUserRole: null, serviceRole: true }
const KEY: PrimaryKeyColumn[] = [{ name: 'id', type: 'uuid' }]

function deps(visible: boolean | ((values: unknown[]) => boolean | Promise<boolean>), key: PrimaryKeyColumn[] | null = KEY) {
  const canSelect = jest.fn(async (_s: RealtimeSubscriber, _t: string, _k: PrimaryKeyColumn[], values: unknown[]) =>
    typeof visible === 'function' ? visible(values) : visible,
  )
  const primaryKey = jest.fn(async () => key)
  return { deps: { primaryKey, canSelect } as VisibilityDeps, canSelect, primaryKey }
}

const insert = (id: string, extra: Record<string, unknown> = {}): RealtimeChange => ({
  type: 'insert', table: 'notes', data: { id, owner_id: 'bob', body: 'secret', ...extra }, old: null, timestamp: 1,
})

describe('visibleChange', () => {
  it('gives a service-role subscriber every change as sent, without checking', async () => {
    const d = deps(false)
    const change = insert('n1')
    expect(await visibleChange(service, change, d.deps)).toBe(change)
    expect(d.canSelect).not.toHaveBeenCalled()
  })

  it('delivers an insert the subscriber can select, and nothing when it cannot', async () => {
    expect(await visibleChange(alice, insert('n1'), deps(true).deps)).toMatchObject({ type: 'insert', data: { id: 'n1', body: 'secret' } })
    expect(await visibleChange(alice, insert('n2'), deps(false).deps)).toBeNull()
  })

  it('checks the row by its primary key value', async () => {
    const d = deps(true)
    await visibleChange(alice, insert('n9'), d.deps)
    expect(d.canSelect).toHaveBeenCalledWith(alice, 'notes', KEY, ['n9'])
  })

  it("reduces an update's old values to the primary key", async () => {
    const change: RealtimeChange = { type: 'update', table: 'notes', data: { id: 'n1', body: 'new' }, old: { id: 'n1', body: 'old secret' } }
    const out = await visibleChange(alice, change, deps(true).deps)
    expect(out).toMatchObject({ data: { id: 'n1', body: 'new' }, old: { id: 'n1' } })
    expect(JSON.stringify(out)).not.toContain('old secret')
  })

  it('reduces a delete to its primary key, without a check it could not make', async () => {
    const d = deps(false)
    const change: RealtimeChange = { type: 'delete', table: 'notes', data: { id: 'n1', owner_id: 'bob', body: 'secret' }, old: null }
    const out = await visibleChange(alice, change, d.deps)
    expect(out).toMatchObject({ type: 'delete', data: { id: 'n1' } })
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(d.canSelect).not.toHaveBeenCalled()
  })

  it('sends nothing when the row cannot be checked: no primary key, a missing key value, a failing check', async () => {
    expect(await visibleChange(alice, insert('n1'), deps(true, null).deps)).toBeNull()
    expect(await visibleChange(alice, { type: 'insert', table: 'notes', data: { body: 'x' } }, deps(true).deps)).toBeNull()
    const failing: VisibilityDeps = { primaryKey: async () => KEY, canSelect: async () => { throw new Error('relation does not exist') } }
    expect(await visibleChange(alice, insert('n1'), failing)).toBeNull()
    const noCatalog: VisibilityDeps = { primaryKey: async () => { throw new Error('region unreachable') }, canSelect: async () => true }
    expect(await visibleChange(alice, insert('n1'), noCatalog)).toBeNull()
  })

  it('passes a change that carries no row data (too large to send) as it was sent', async () => {
    const truncated: RealtimeChange = { type: 'update', table: 'notes', data: null, truncated: true }
    expect(await visibleChange(alice, truncated, deps(false).deps)).toBe(truncated)
  })
})

describe('createVisibleEventQueue', () => {
  it('sends what the subscriber may see, in the order the changes arrived, however late a check answers', async () => {
    const delays: Record<string, number> = { slow: 40, hidden: 0, fast: 0 }
    const d = deps(async (values) => {
      const id = String(values[0])
      await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 0))
      return id !== 'hidden'
    })
    const sent: string[] = []
    const deliver = createVisibleEventQueue(alice, (change) => sent.push(String(change.data?.id)), d.deps)
    deliver(insert('slow'))
    deliver(insert('hidden'))
    deliver(insert('fast'))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(sent).toEqual(['slow', 'fast'])
  })
})
