/**
 * The post-mutation kick waits for a change on the project to settle before it
 * runs the repair loop (lib/autonomy/event-trigger.ts).
 *
 * The mutation that kicks the loop is often one step of a governed change still
 * under way: an agent's migration with more statements to run, its
 * verification, its automatic recovery. The reconciler skips a project whose
 * change lock is held, so a kick that ran then was lost. It looks again instead,
 * as the same kick, and runs the loop once the lock is free. Real timers: the
 * kick's timers leave the change behind (work-outside-the-change.spec.ts), and
 * fake ones would run its callbacks somewhere else.
 */
jest.mock('@/lib/autonomy/reconciler', () => ({ runReconciler: jest.fn(async () => null) }))
jest.mock('@/lib/services/workspace-observer', () => ({ runObserverForProject: jest.fn(async () => ({})) }))
jest.mock('@/lib/changes/lock', () => ({ changeLockHeld: jest.fn(async () => false) }))

import { kickReconciler, SETTLE_POLL_MS } from '@/lib/autonomy/event-trigger'
import { runReconciler } from '@/lib/autonomy/reconciler'
import { changeLockHeld } from '@/lib/changes/lock'

const loop = runReconciler as unknown as jest.Mock
const held = changeLockHeld as unknown as jest.Mock
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, byMs: number): Promise<void> {
  const end = Date.now() + byMs
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(50)
  }
}

const saved = process.env.ENABLE_AUTONOMY_RECONCILER
beforeAll(() => { process.env.ENABLE_AUTONOMY_RECONCILER = 'true' })
afterAll(() => {
  if (saved === undefined) delete process.env.ENABLE_AUTONOMY_RECONCILER
  else process.env.ENABLE_AUTONOMY_RECONCILER = saved
})
beforeEach(() => { loop.mockClear(); held.mockReset() })

describe('the kick and a change still under way', () => {
  it('runs the loop at once when nothing holds the project\'s lock', async () => {
    held.mockResolvedValue(false)
    kickReconciler('p-free', 'create_table')
    await until(() => loop.mock.calls.length > 0, 5_000)
    expect(loop.mock.calls).toEqual([['p-free']])
  })

  it('waits while a change holds the lock, then runs the loop once', async () => {
    let busy = true
    held.mockImplementation(async (projectId: string) => projectId === 'p-busy' && busy)
    kickReconciler('p-busy', 'create_table')
    // The debounce, then two more looks: still held, so nothing ran.
    await sleep(1_500 + 2 * SETTLE_POLL_MS + 300)
    expect(loop).not.toHaveBeenCalled()
    expect(held.mock.calls.length).toBeGreaterThanOrEqual(2)

    busy = false
    await until(() => loop.mock.calls.length > 0, 2 * SETTLE_POLL_MS + 1_000)
    await sleep(SETTLE_POLL_MS + 300)
    expect(loop.mock.calls).toEqual([['p-busy']])
  }, 20_000)

  it('a kick that arrives while it waits joins it: one pass, not two', async () => {
    let busy = true
    held.mockImplementation(async () => busy)
    kickReconciler('p-join', 'create_table')
    await sleep(1_500 + SETTLE_POLL_MS + 300)
    kickReconciler('p-join', 'add_column')
    busy = false
    await until(() => loop.mock.calls.length > 0, 1_500 + SETTLE_POLL_MS + 1_000)
    await sleep(1_500 + SETTLE_POLL_MS + 300)
    expect(loop.mock.calls).toEqual([['p-join']])
  }, 20_000)
})
