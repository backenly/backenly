/**
 * The agentic fix loop applies no fix while the project is mid-incident.
 *
 * Its fixes run as the repair loop's (processOpenFindings, executeAction), so a
 * freeze holds them as it holds the loop's. Only the verification snapshot, the
 * freeze answer and the two fix paths are stood in for; the loop itself runs.
 */

jest.mock('@/lib/ai/behavioral-verifier', () => ({
  runBehavioralVerification: jest.fn(async (projectId: string) => ({
    projectId,
    passed: false,
    verdict: 'failed',
    checksRun: 1,
    checksSkipped: 0,
    checks: [{ id: 'auth_signup', name: 'Sign-up works', passed: false, skipped: false, error: 'sign-up answered 500', details: [] }],
  })),
}))
const mockHeld = jest.fn(async () => true)
jest.mock('@/lib/autonomy/change-freeze', () => ({ heldForIncident: (...args: unknown[]) => (mockHeld as any)(...args) }))
const mockProcessOpenFindings = jest.fn(async () => [])
jest.mock('@/lib/core/auto-fix-engine', () => ({ processOpenFindings: (...args: unknown[]) => (mockProcessOpenFindings as any)(...args) }))
const mockExecuteAction = jest.fn()
jest.mock('@/lib/ai/minimal-executor', () => ({ executeAction: (...args: unknown[]) => mockExecuteAction(...args) }))

import { runAgenticFixLoop, type FixLoopEvent } from '@/lib/ai/agentic-fix-loop'

describe('the agentic fix loop during an incident', () => {
  it('stops before any fix, says why, and asks the freeze as the repair loop', async () => {
    const events: FixLoopEvent[] = []
    const result = await runAgenticFixLoop('0b9e3a52-7a5d-4c1e-9a2b-1f2e3d4c5b6a', 'user-1', { emit: (e) => events.push(e) })

    expect(result.reason).toBe('held_for_incident')
    expect(result.appliedFixes).toBe(0)
    expect(result.summary).toMatch(/mid-incident, so no fix was applied/)
    expect(mockProcessOpenFindings).not.toHaveBeenCalled()
    expect(mockExecuteAction).not.toHaveBeenCalled()
    expect(mockHeld).toHaveBeenCalledWith('0b9e3a52-7a5d-4c1e-9a2b-1f2e3d4c5b6a', expect.objectContaining({ loop: 'reconciler', via: 'agentic_fix_loop', wouldHaveApplied: 1 }))
    expect(events.at(-1)).toMatchObject({ type: 'fix_loop_complete', success: false, reason: 'held_for_incident' })
  })
})
