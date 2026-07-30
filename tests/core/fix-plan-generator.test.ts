/**
 * Phase 12 — Fix Plan Generator tests
 * -------------------------------------
 * Verifies that generateFixPlans() and generateFixPlansFromRawFindings()
 * produce correctly classified plans for every finding type.
 *
 * Strict unit-test mode — no DB, no HTTP, no LLM.
 */

import { describe, test, expect } from '@jest/globals'
import {
  generateFixPlans,
  generateFixPlansFromRawFindings,
  type FixPlan,
} from '@/lib/core/fix-plan-generator'
import type { HealthFindingPreview } from '@/lib/core/ai-report-to-health-findings'
import type { RawFinding } from '@/lib/core/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePreview(
  type: HealthFindingPreview['type'],
  severity: HealthFindingPreview['severity'] = 'warning',
  extra: Partial<HealthFindingPreview> = {},
): HealthFindingPreview {
  return {
    id: `prev:${type}`,
    source: 'product_understanding',
    type,
    severity,
    title: `Preview: ${type}`,
    message: `Missing ${type}`,
    recommendation: `Fix the ${type}`,
    autoFixable: false,
    requiresApproval: false,
    shadowMode: true,
    ...extra,
  }
}

function makeRaw(
  type: RawFinding['type'],
  severity: RawFinding['severity'] = 'warning',
  details: Record<string, unknown> = {},
): RawFinding {
  return { type, severity, details: { tableName: 'test_table', ...details }, autoFixable: false }
}

// ─── generateFixPlans — HealthFindingPreview ─────────────────────────────────

describe('generateFixPlans', () => {
  test('missing_integration → requiresApproval, connect_integration action', () => {
    const plans = generateFixPlans([makePreview('missing_integration', 'critical', {
      message: 'Missing stripe integration',
    })])
    expect(plans).toHaveLength(1)
    const p = plans[0]
    expect(p.action).toBe('connect_integration')
    expect(p.requiresApproval).toBe(true)
    expect(p.autoFixable).toBe(false)
    expect(p.notifyOnly).toBe(false)
    expect(p.target).toBe('stripe')
  })

  test('missing_runtime → autoFixable, provision_runtime action', () => {
    const plans = generateFixPlans([makePreview('missing_runtime', 'warning', {
      message: 'Missing queue runtime',
    })])
    const p = plans[0]
    expect(p.action).toBe('provision_runtime')
    expect(p.autoFixable).toBe(true)
    expect(p.requiresApproval).toBe(false)
    expect(p.notifyOnly).toBe(false)
    expect(p.target).toBe('queue')
  })

  test('missing_rls → autoFixable, apply_rls action', () => {
    const plans = generateFixPlans([makePreview('missing_rls')])
    const p = plans[0]
    expect(p.action).toBe('apply_rls')
    expect(p.autoFixable).toBe(true)
    expect(p.requiresApproval).toBe(false)
    expect(p.notifyOnly).toBe(false)
  })

  test('missing_endpoint → autoFixable, generate_api action', () => {
    const plans = generateFixPlans([makePreview('missing_endpoint', 'warning', {
      relatedApiIds: ['posts'],
    })])
    const p = plans[0]
    expect(p.action).toBe('generate_api')
    expect(p.autoFixable).toBe(true)
    expect(p.requiresApproval).toBe(false)
    expect(p.target).toBe('posts')
  })

  test('missing_auth warning → autoFixable, fix_auth action', () => {
    const plans = generateFixPlans([makePreview('missing_auth', 'warning')])
    const p = plans[0]
    expect(p.action).toBe('fix_auth')
    expect(p.autoFixable).toBe(true)
    expect(p.requiresApproval).toBe(false)
  })

  test('missing_auth critical → requiresApproval', () => {
    const plans = generateFixPlans([makePreview('missing_auth', 'critical')])
    const p = plans[0]
    expect(p.action).toBe('fix_auth')
    expect(p.requiresApproval).toBe(true)
    expect(p.autoFixable).toBe(false)
  })

  test('security_gap warning → autoFixable', () => {
    const plans = generateFixPlans([makePreview('security_gap', 'warning')])
    const p = plans[0]
    expect(p.action).toBe('close_security_gap')
    expect(p.autoFixable).toBe(true)
    expect(p.requiresApproval).toBe(false)
  })

  test('security_gap critical → requiresApproval', () => {
    const plans = generateFixPlans([makePreview('security_gap', 'critical')])
    const p = plans[0]
    expect(p.requiresApproval).toBe(true)
    expect(p.autoFixable).toBe(false)
  })

  test('missing_verification → notifyOnly', () => {
    const plans = generateFixPlans([makePreview('missing_verification')])
    const p = plans[0]
    expect(p.notifyOnly).toBe(true)
    expect(p.autoFixable).toBe(false)
    expect(p.requiresApproval).toBe(false)
  })

  test('missing_workflow → notifyOnly', () => {
    const plans = generateFixPlans([makePreview('missing_workflow')])
    expect(plans[0].notifyOnly).toBe(true)
    expect(plans[0].action).toBe('clarify_workflow')
  })

  test('missing_business_rule → notifyOnly', () => {
    const plans = generateFixPlans([makePreview('missing_business_rule')])
    expect(plans[0].notifyOnly).toBe(true)
    expect(plans[0].action).toBe('clarify_business_rule')
  })

  test('readiness_overclaim → notifyOnly, notify_only action', () => {
    const plans = generateFixPlans([makePreview('readiness_overclaim')])
    expect(plans[0].notifyOnly).toBe(true)
    expect(plans[0].action).toBe('notify_only')
  })

  test('each plan carries findingId from source preview', () => {
    const preview = makePreview('missing_rls')
    const plans = generateFixPlans([preview])
    expect(plans[0].findingId).toBe(preview.id)
  })

  test('each plan has a stable id in fix:<type>:<target> format', () => {
    const plans = generateFixPlans([makePreview('missing_rls')])
    expect(plans[0].id).toMatch(/^fix:missing_rls:/)
  })

  test('each plan has at least one step', () => {
    const allTypes: HealthFindingPreview['type'][] = [
      'missing_integration', 'missing_runtime', 'missing_rls', 'missing_endpoint',
      'missing_auth', 'security_gap', 'missing_verification', 'missing_workflow',
      'missing_business_rule', 'readiness_overclaim',
    ]
    for (const type of allTypes) {
      const plans = generateFixPlans([makePreview(type)])
      expect(plans[0].steps.length).toBeGreaterThanOrEqual(1)
    }
  })

  test('empty input returns empty output', () => {
    expect(generateFixPlans([])).toHaveLength(0)
  })

  test('multiple findings produce one plan each', () => {
    const plans = generateFixPlans([
      makePreview('missing_integration', 'critical', { message: 'Need stripe' }),
      makePreview('missing_runtime', 'warning', { message: 'Need queue' }),
      makePreview('missing_rls'),
    ])
    expect(plans).toHaveLength(3)
  })
})

// ─── generateFixPlansFromRawFindings ─────────────────────────────────────────

describe('generateFixPlansFromRawFindings', () => {
  test('missing_rls → autoFixable, apply_rls', () => {
    const plans = generateFixPlansFromRawFindings([makeRaw('missing_rls')])
    expect(plans[0].action).toBe('apply_rls')
    expect(plans[0].autoFixable).toBe(true)
    expect(plans[0].requiresApproval).toBe(false)
  })

  test('integration_key_invalid → requiresApproval, connect_integration', () => {
    const plans = generateFixPlansFromRawFindings([makeRaw('integration_key_invalid')])
    expect(plans[0].action).toBe('connect_integration')
    expect(plans[0].requiresApproval).toBe(true)
    expect(plans[0].autoFixable).toBe(false)
  })

  // Updated 2026-07-30. orphan_table became auto-safe on 2026-07-18: the repair
  // is the ADOPT path (REGISTER_TABLE) which adds metadata, an API and RLS
  // around data that already exists and never drops anything. Dropping remains a
  // manual action in the Database section. The test predated that change.
  test('orphan_table → auto-safe (ADOPT path never drops data)', () => {
    const plans = generateFixPlansFromRawFindings([makeRaw('orphan_table')])
    expect(plans[0].requiresApproval).toBe(false)
    expect(plans[0].autoFixable).toBe(true)
  })

  test('auth_spike → requiresApproval', () => {
    const plans = generateFixPlansFromRawFindings([makeRaw('auth_spike', 'critical')])
    expect(plans[0].requiresApproval).toBe(true)
  })

  test('api_drift → autoFixable (generate_api)', () => {
    const plans = generateFixPlansFromRawFindings([makeRaw('api_drift')])
    expect(plans[0].action).toBe('generate_api')
    expect(plans[0].autoFixable).toBe(true)
  })

  // Updated 2026-07-30. This asserted autoFixable=true, which contradicts the
  // classifier's safety floor: auth mutations are never auto-executed, because
  // restoring or rotating a JWT secret invalidates every end-user session at
  // once. fix-classifier puts auth_jwt_missing in NEEDS_APPROVAL with that exact
  // reason and a risk note. The code is right and the test was stale; asserting
  // the old behaviour would have pressured someone into weakening the floor.
  test('auth_jwt_missing → fix_auth, gated on approval (auth safety floor)', () => {
    const plans = generateFixPlansFromRawFindings([makeRaw('auth_jwt_missing')])
    expect(plans[0].action).toBe('fix_auth')
    expect(plans[0].autoFixable).toBe(false)
    expect(plans[0].requiresApproval).toBe(true)
  })

  test('uses tableName from finding.details as target', () => {
    const plans = generateFixPlansFromRawFindings([
      makeRaw('missing_rls', 'warning', { tableName: 'orders' }),
    ])
    expect(plans[0].target).toBe('orders')
  })

  test('empty input returns empty output', () => {
    expect(generateFixPlansFromRawFindings([])).toHaveLength(0)
  })
})
