/**
 * Work that outlives the request that scheduled it runs as its own actor,
 * outside the governed change and the attribution it was scheduled in
 * (lib/changes/context.ts).
 *
 * The repair loop's kick, the observer's passes and the post-build passes all
 * start inside an agent's request, the kick even inside its governed change.
 * Node carries that context into every timer and promise, so their work joined
 * the change after it had closed, was recorded nowhere, and carried the agent's
 * key. Real timers throughout: fake ones run each callback in the test's own
 * context, where nothing leaks, and would prove nothing.
 */
import fs from 'node:fs'
import path from 'node:path'

jest.mock('@/lib/autonomy/reconciler', () => ({ runReconciler: jest.fn() }))
jest.mock('@/lib/changes/lock', () => ({ ...jest.requireActual('@/lib/changes/lock'), changeLockHeld: jest.fn(async () => false) }))
jest.mock('@/lib/services/workspace-observer', () => ({ runObserverForProject: jest.fn() }))
jest.mock('@/lib/ai/background-monitor', () => ({ runMonitoredHealthScan: jest.fn() }))
jest.mock('@/lib/ai/schema-reconciler', () => ({
  detectSchemaDrift: jest.fn(async () => ({ drifts: [], hasCritical: false, hasWarnings: false })),
}))

import { heldChangeLock, openChangeContext, outsideAnyChange } from '@/lib/changes/context'
import { currentAttribution, withChangeAttribution } from '@/lib/changes/attribution'
import { isCapturing, withSqlCapture } from '@/lib/execution/sql-recorder'
import { currentChange } from '@/lib/changes/ledger'
import { kickReconciler } from '@/lib/autonomy/event-trigger'
import { emit } from '@/lib/events/bus'
import { triggerPostBuildOrchestration } from '@/lib/ai/build-runtime/post-build-orchestrator'
import { runReconciler } from '@/lib/autonomy/reconciler'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { runMonitoredHealthScan } from '@/lib/ai/background-monitor'

const PROJECT = '00000000-0000-4000-8000-00000000c0de'

/**
 * What a piece of work runs inside: the open change, the change lock it holds,
 * whether its statements are being captured, and who is attributed. All four
 * are carried into timers; work that is its own actor must leave all four.
 */
const where = () => ({
  change: openChangeContext.getStore() ?? null,
  lock: heldChangeLock.getStore() ?? null,
  capturing: isCapturing(),
  attribution: currentAttribution() ?? null,
})
const NOWHERE = { change: null, lock: null, capturing: false, attribution: null }

/**
 * As an agent's apply_migration runs a step: its key attributed, its change
 * open, the project's change lock held on its connection, its statements
 * captured (lib/changes/ledger.ts, lib/changes/lock.ts).
 */
function insideAgentsChange<T>(fn: () => T): Promise<T> {
  return withChangeAttribution({ source: 'mcp', actorUserId: 'owner', apiKeyId: 'agent-key' }, () =>
    heldChangeLock.run({ projectId: PROJECT, client: {} as never, released: false }, async () =>
      (await withSqlCapture(async () => openChangeContext.run({ projectId: PROJECT, finished: false }, fn))).result))
}

async function until(check: () => boolean, byMs = 5_000): Promise<void> {
  const deadline = Date.now() + byMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const seen: Record<'loop' | 'observer' | 'healthScan', Array<ReturnType<typeof where>>> = { loop: [], observer: [], healthScan: [] }

beforeAll(() => {
  process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
  jest.mocked(runReconciler).mockImplementation(async () => { seen.loop.push(where()); return null })
  jest.mocked(runObserverForProject).mockImplementation(async () => { seen.observer.push(where()); return { skipped: true } as any })
  jest.mocked(runMonitoredHealthScan).mockImplementation(async () => { seen.healthScan.push(where()) })
})

describe('the async context of a change', () => {
  it('is carried into a plain timer started inside it, which is the hazard', async () => {
    const inTimer = await insideAgentsChange(() => new Promise<ReturnType<typeof where>>((r) => setTimeout(() => r(where()), 10)))
    expect(inTimer.change).toMatchObject({ projectId: PROJECT })
    expect(inTimer.lock).toMatchObject({ projectId: PROJECT })
    expect(inTimer.capturing).toBe(true)
    expect(inTimer.attribution).toMatchObject({ source: 'mcp', apiKeyId: 'agent-key' })
  })

  it('is left behind by outsideAnyChange, and by any timer started there', async () => {
    const inTimer = await insideAgentsChange(() =>
      outsideAnyChange(() => new Promise<ReturnType<typeof where>>((r) => setTimeout(() => r(where()), 10))))
    expect(inTimer).toEqual(NOWHERE)
    // Leaving is for the work inside only: the change around it is untouched.
    await insideAgentsChange(() => {
      outsideAnyChange(() => undefined)
      expect(where()).toMatchObject({ change: { projectId: PROJECT }, lock: { projectId: PROJECT }, capturing: true })
    })
  })

  it('a capture is never joined or written to once it has closed', async () => {
    let late: Promise<boolean> | undefined
    await withSqlCapture(async () => {
      late = new Promise((r) => setTimeout(() => r(isCapturing()), 10))
    })
    expect(await late).toBe(false)
  })

  it('is never joined once its work is over', async () => {
    const change = { projectId: PROJECT, finished: false }
    const later = openChangeContext.run(change, () => {
      expect(currentChange(PROJECT)).toBe(change)
      return new Promise((r) => setTimeout(() => r(currentChange(PROJECT)), 10))
    })
    // As the ledger marks it when the change's own work returns (lib/changes/ledger.ts).
    change.finished = true
    expect(await later).toBeNull()
  })
})

describe('work scheduled from inside an agent\'s change runs as its own actor', () => {
  it('the repair loop the kick starts', async () => {
    // Twice: the second goes through the debounce's re-armed timer.
    await insideAgentsChange(() => {
      kickReconciler(PROJECT, 'add_column')
      kickReconciler(PROJECT, 'add_column')
    })
    await until(() => seen.loop.length > 0)
    expect(seen.loop).toEqual([NOWHERE])
  })

  it('every timer the kick module starts goes through the one that leaves the change behind', () => {
    // The settled observer pass waits a minute, too long to wait for here.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib/autonomy/event-trigger.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src.match(/setTimeout\(/g)).toHaveLength(1)
    expect(src).toMatch(/return outsideAnyChange\(\(\) => setTimeout\(fn, ms\)\)/)
  })

  it('the observer pass a schema.changed event starts', async () => {
    await insideAgentsChange(() => emit('schema.changed', PROJECT, { tables: ['notes'] }))
    await until(() => seen.observer.length > 0)
    expect(seen.observer).toEqual([NOWHERE])
  })

  it('the post-build passes, the repair loop\'s health scan among them', async () => {
    await insideAgentsChange(() => triggerPostBuildOrchestration(PROJECT, 'owner', { built: [{}] } as any))
    await until(() => seen.healthScan.length > 0)
    expect(seen.healthScan).toEqual([NOWHERE])
  })
})
