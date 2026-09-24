/**
 * A BUILD IS OBSERVED ONCE IT SETTLES
 * ===================================
 * MCP builds emit no `schema.changed`, and the reconciler persists only what
 * it would repair on its own, so an approval-tier gap from a build waited for
 * the daily observer run. The post-mutation kick now schedules one observer
 * pass after the last mutation of a burst. Timers are faked; the observer and
 * the reconciler are stubbed because this pins the SCHEDULE, and the real
 * observer path is covered by autonomy-watches-one-population.test.ts.
 */

jest.mock('@/lib/services/workspace-observer', () => ({
  runObserverForProject: jest.fn().mockResolvedValue({}),
}))
jest.mock('@/lib/autonomy/reconciler', () => ({
  runReconciler: jest.fn().mockResolvedValue(null),
}))

import { kickReconciler, OBSERVER_SETTLE_MS } from '@/lib/autonomy/event-trigger'
import { runObserverForProject } from '@/lib/services/workspace-observer'

const observe = runObserverForProject as unknown as jest.Mock

describe('one observer pass after a burst of mutations', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    observe.mockClear()
  })
  afterEach(() => jest.useRealTimers())

  it('waits for the burst to end, then scans once', async () => {
    kickReconciler('p-settle', 'create_table')
    jest.advanceTimersByTime(OBSERVER_SETTLE_MS - 1000)
    kickReconciler('p-settle', 'add_column')
    jest.advanceTimersByTime(OBSERVER_SETTLE_MS - 1000)
    expect(observe).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    await new Promise(r => jest.requireActual('timers').setImmediate(r))
    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith('p-settle')
  })

  it('does not scan for events that change nothing', () => {
    kickReconciler('p-quiet', 'list_tables')
    jest.advanceTimersByTime(OBSERVER_SETTLE_MS * 2)
    expect(observe).not.toHaveBeenCalled()
  })
})
