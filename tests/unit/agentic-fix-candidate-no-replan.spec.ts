/**
 * The build's fix loop applies each candidate as planned: a failed candidate is
 * reported as failed and the loop's next round decides what to try. The
 * executor is never asked to replan it into a model-chosen action, which would
 * run outside the agent dispatcher's gates (approval, protected production,
 * table existence).
 */

const mockCalls: unknown[][] = []

jest.mock('@/lib/ai/minimal-executor', () => ({
  executeAction: jest.fn(async (...args: unknown[]) => {
    mockCalls.push(args)
    return { success: false, error: 'column "x" does not exist' }
  }),
}))
jest.mock('@/lib/ai/build-runtime/build-lock', () => ({
  withBuildLock: jest.fn(async (_projectId: string, _kind: string, run: () => Promise<unknown>) => run()),
}))
jest.mock('@/lib/core/auto-fix-engine', () => ({ processOpenFindings: jest.fn() }))
jest.mock('@/lib/ai/behavioral-verifier', () => ({ runBehavioralVerification: jest.fn() }))
jest.mock('@/lib/ai/agentic-fix-author', () => ({ authorFixForCheck: jest.fn(), MAX_AUTHORED_FIXES_PER_BUILD: 0 }))
jest.mock('@/lib/ai/scan/scan-to-fixes', () => ({ harvestScanFixes: jest.fn() }))
const mockHold = jest.fn(async (_projectId: string, _repair: unknown): Promise<string | null> => null)
jest.mock('@/lib/evolution-engine/holds', () => ({ repairHold: (projectId: string, repair: unknown) => mockHold(projectId, repair) }))

import { applyCandidate } from '@/lib/ai/agentic-fix-loop'

const PROJECT = '11111111-2222-4333-8444-555555555555'

it('asks the executor for the planned action only, with replanning off', async () => {
  const out = await applyCandidate({ action: 'ADD_COLUMN', params: { tableName: 'orders', column: 'x' } } as any, PROJECT)
  expect(out.success).toBe(false)
  expect(mockCalls).toHaveLength(1)
  const [action, projectId, , retryCount, , allowReplan] = mockCalls[0] as [any, string, unknown, number, unknown, boolean]
  expect(action).toEqual({ action: 'ADD_COLUMN', params: { tableName: 'orders', column: 'x' } })
  expect(projectId).toBe(PROJECT)
  expect(retryCount).toBe(0)
  expect(allowReplan).toBe(false)
})

it('leaves a table alone while an architecture change works on it, asking about the table the action changes', async () => {
  mockCalls.length = 0
  mockHold.mockResolvedValueOnce('an architecture change to orders is working on orders; Backenly repairs it once the change is in place')
  const out = await applyCandidate({ action: 'SET_PERMISSION', params: { table: 'orders', policy: 'own_rows' } } as any, PROJECT)
  expect(out).toEqual({ success: false, message: expect.stringMatching(/^Held: an architecture change to orders is working on orders/) })
  expect(mockHold).toHaveBeenLastCalledWith(PROJECT, { table: 'orders', action: 'SET_PERMISSION', tablelessWaits: true })
  expect(mockCalls).toHaveLength(0)
})

it('asks about every table for a candidate that names none', async () => {
  mockCalls.length = 0
  mockHold.mockResolvedValueOnce("an architecture change to orders is working on this project's tables, and this repair names none")
  const out = await applyCandidate({ action: 'FIX_REALTIME', params: {} } as any, PROJECT)
  expect(out.success).toBe(false)
  expect(mockHold).toHaveBeenLastCalledWith(PROJECT, { table: null, action: 'FIX_REALTIME', tablelessWaits: true })
  expect(mockCalls).toHaveLength(0)
})
