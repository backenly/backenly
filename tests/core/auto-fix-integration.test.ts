/**
 * Phase 12 — Auto-Fix Engine × FixPlan integration tests
 * --------------------------------------------------------
 * Tests the pure logic gates in runFixPlan / processFixPlans that require
 * no DB or executor access:
 *
 *   1. notifyOnly plans always return notify_only (early return, no side effects)
 *   2. ENABLE_AUTO_FIX_EXECUTION off → skipped_flag_off (no executor, no DB)
 *   3. processFixPlans severity ordering (deterministic sort, flag off means no execution)
 *
 * Tests that traverse the executor or DB paths (queued_approval, auto_executed,
 * failed) are integration tests that rely on the test DB set up by `npm test`
 * and are not included here — they live at the observer integration level.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'
import { runFixPlan, processFixPlans } from '@/lib/core/auto-fix-engine'
import type { FixPlan } from '@/lib/core/fix-plan-generator'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<FixPlan> = {}): FixPlan {
  return {
    id: 'fix:missing_rls:posts',
    findingId: 'prev:missing_rls',
    findingType: 'missing_rls',
    findingSeverity: 'warning',
    action: 'apply_rls',
    target: 'posts',
    title: 'Fix: missing RLS',
    reason: 'Apply RLS to protect user rows',
    autoFixable: true,
    requiresApproval: false,
    notifyOnly: false,
    steps: [{ order: 1, description: 'Apply RLS', automated: true }],
    ...overrides,
  }
}

// ─── notifyOnly gate — pure, no DB or executor ────────────────────────────────

describe('runFixPlan — notifyOnly gate', () => {
  test('notifyOnly plan returns notify_only regardless of execution flag', async () => {
    const originalEnv = process.env.ENABLE_AUTO_FIX_EXECUTION
    try {
      process.env.ENABLE_AUTO_FIX_EXECUTION = 'false'
      const r1 = await runFixPlan(makePlan({ notifyOnly: true }), 'proj_test')
      expect(r1.outcome).toBe('notify_only')

      process.env.ENABLE_AUTO_FIX_EXECUTION = 'true'
      const r2 = await runFixPlan(makePlan({ notifyOnly: true }), 'proj_test')
      expect(r2.outcome).toBe('notify_only')
    } finally {
      if (originalEnv === undefined) delete process.env.ENABLE_AUTO_FIX_EXECUTION
      else process.env.ENABLE_AUTO_FIX_EXECUTION = originalEnv
    }
  })

  test('clarify_workflow plan (notifyOnly=false, not autoFixable, no map) returns notify_only', async () => {
    process.env.ENABLE_AUTO_FIX_EXECUTION = 'true'
    try {
      const result = await runFixPlan(
        makePlan({ action: 'clarify_workflow', autoFixable: false, notifyOnly: false }),
        'proj_test',
      )
      // No AIAction mapping for clarify_workflow → notify_only from the engine
      expect(result.outcome).toBe('notify_only')
    } finally {
      delete process.env.ENABLE_AUTO_FIX_EXECUTION
    }
  })
})

// ─── Execution flag gate — pure, no DB or executor ───────────────────────────

describe('runFixPlan — ENABLE_AUTO_FIX_EXECUTION=false', () => {
  const savedEnv = process.env.ENABLE_AUTO_FIX_EXECUTION

  beforeEach(() => { process.env.ENABLE_AUTO_FIX_EXECUTION = 'false' })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ENABLE_AUTO_FIX_EXECUTION
    else process.env.ENABLE_AUTO_FIX_EXECUTION = savedEnv
  })

  test('autoFixable plan returns skipped_flag_off', async () => {
    const result = await runFixPlan(makePlan({ autoFixable: true, requiresApproval: false }), 'proj_test')
    expect(result.outcome).toBe('skipped_flag_off')
    expect(result.planId).toBe('fix:missing_rls:posts')
    expect(result.findingId).toBe('prev:missing_rls')
  })

  test('requiresApproval plan also returns skipped_flag_off (flag check runs first)', async () => {
    const result = await runFixPlan(
      makePlan({ autoFixable: false, requiresApproval: true }),
      'proj_test',
    )
    expect(result.outcome).toBe('skipped_flag_off')
  })

  test('connect_integration plan returns skipped_flag_off', async () => {
    const result = await runFixPlan(
      makePlan({ action: 'connect_integration', autoFixable: false, requiresApproval: true }),
      'proj_test',
    )
    expect(result.outcome).toBe('skipped_flag_off')
  })

  test('critical security_gap returns skipped_flag_off', async () => {
    const result = await runFixPlan(
      makePlan({ action: 'close_security_gap', findingSeverity: 'critical', autoFixable: false, requiresApproval: true }),
      'proj_test',
    )
    expect(result.outcome).toBe('skipped_flag_off')
  })

  test('result message mentions the flag', async () => {
    const result = await runFixPlan(makePlan(), 'proj_test')
    expect(result.message.toLowerCase()).toContain('enable_auto_fix_execution')
  })
})

// ─── processFixPlans — severity ordering, flag off ───────────────────────────

describe('processFixPlans — ordering and output shape', () => {
  const savedEnv = process.env.ENABLE_AUTO_FIX_EXECUTION

  beforeEach(() => { process.env.ENABLE_AUTO_FIX_EXECUTION = 'false' })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ENABLE_AUTO_FIX_EXECUTION
    else process.env.ENABLE_AUTO_FIX_EXECUTION = savedEnv
  })

  test('returns one result per input plan', async () => {
    const plans = [
      makePlan({ id: 'fix:a', findingId: 'a' }),
      makePlan({ id: 'fix:b', findingId: 'b' }),
      makePlan({ id: 'fix:c', findingId: 'c' }),
    ]
    const results = await processFixPlans(plans, 'proj_test')
    expect(results).toHaveLength(3)
  })

  test('processes critical plans before warning before info', async () => {
    const plans = [
      makePlan({ id: 'fix:info', findingId: 'info', findingSeverity: 'info' }),
      makePlan({ id: 'fix:critical', findingId: 'critical', findingSeverity: 'critical' }),
      makePlan({ id: 'fix:warning', findingId: 'warning', findingSeverity: 'warning' }),
    ]
    const results = await processFixPlans(plans, 'proj_test')
    expect(results[0].planId).toBe('fix:critical')
    expect(results[1].planId).toBe('fix:warning')
    expect(results[2].planId).toBe('fix:info')
  })

  test('each result has planId and findingId', async () => {
    const plans = [makePlan({ id: 'fix:rls', findingId: 'prev:rls' })]
    const results = await processFixPlans(plans, 'proj_test')
    expect(results[0].planId).toBe('fix:rls')
    expect(results[0].findingId).toBe('prev:rls')
  })

  test('empty plans returns empty results', async () => {
    expect(await processFixPlans([], 'proj_test')).toHaveLength(0)
  })

  test('does not mutate the original plans array order', async () => {
    const plans = [
      makePlan({ id: 'fix:info', findingSeverity: 'info' }),
      makePlan({ id: 'fix:critical', findingSeverity: 'critical' }),
    ]
    const originalOrder = plans.map(p => p.id)
    await processFixPlans(plans, 'proj_test')
    expect(plans.map(p => p.id)).toEqual(originalOrder)
  })
})
