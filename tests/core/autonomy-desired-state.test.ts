/**
 * AUTONOMY — DESIRED-STATE TIER MODEL (pure, no DB)
 * -------------------------------------------------
 * Locks the bounded-autonomy contract:
 *
 *   • fix-classifier remains the single source of truth for risk. deriveTier
 *     may ONLY split the classifier's `auto` bucket into 0 (silent) vs 1
 *     (announced). It must never promote an `approval`/`notify` finding into
 *     an auto tier — that would be a safety regression.
 *   • Every notify_only finding is Tier 3 (never auto).
 *   • Every approval finding is Tier 2 (never auto).
 *   • summarizeDesiredState stays non-technical and never crashes on a clean
 *     or fully-broken report.
 */

import { describe, test, expect } from '@jest/globals'
import { deriveTier, summarizeDesiredState } from '@/lib/autonomy/desired-state'
import type { DesiredStateReport } from '@/lib/autonomy/desired-state'
import { classifyFix } from '@/lib/core/fix-classifier'
import type { FindingType } from '@/lib/core/types'

const ALL_FINDING_TYPES: FindingType[] = [
  'missing_rls', 'missing_fk', 'api_drift', 'broken_webhook', 'broken_auth',
  'orphan_table', 'auth_spike', 'deploy_failure', 'missing_fk_index',
  'missing_api_definition', 'shadow_mutation', 'auth_jwt_missing',
  'auth_users_table_missing', 'oauth_redirect_uri_missing',
  'rls_expression_invalid', 'unprotected_user_data', 'integration_key_invalid',
  'integration_webhook_failing', 'integration_smtp_unreachable',
  'oauth_config_invalid', 'workflow_broken', 'verification_failed',
  'missing_api_crud', 'dead_api_endpoint', 'missing_rate_limit', 'realtime_gap',
]

describe('deriveTier — fix-classifier is the single source of truth', () => {
  test.each(ALL_FINDING_TYPES)('%s maps to a tier consistent with classifyFix', (type) => {
    const tier = deriveTier(type)
    const { decision } = classifyFix(type, null)

    if (decision === 'notify_only') {
      expect(tier).toBe(3)
    } else if (decision === 'approval') {
      expect(tier).toBe(2)
    } else {
      // auto → 0 or 1 only; never silently promoted past approval/notify
      expect([0, 1]).toContain(tier)
    }
  })

  test('no approval/notify finding is ever placed in an auto tier', () => {
    for (const type of ALL_FINDING_TYPES) {
      const { decision } = classifyFix(type, null)
      const tier = deriveTier(type)
      if (decision !== 'auto') {
        expect(tier).toBeGreaterThanOrEqual(2)
      }
    }
  })

  test('silent Tier-0 fixes are genuinely invisible (index / api surface only)', () => {
    // missing_fk_index is the canonical invisible fix → Tier 0
    expect(deriveTier('missing_fk_index')).toBe(0)
    // turning on RLS is additive but user-visible → Tier 1, never 0
    if (classifyFix('missing_rls', null).decision === 'auto') {
      expect(deriveTier('missing_rls')).toBe(1)
    }
  })
})

describe('summarizeDesiredState — non-technical, crash-free', () => {
  test('clean report reads as healthy', () => {
    const report: DesiredStateReport = {
      projectId: 'p1',
      evaluatedAt: new Date().toISOString(),
      satisfied: true,
      invariants: [],
      violations: [],
      tierCounts: { 0: 0, 1: 0, 2: 0, 3: 0 },
      errors: [],
    }
    expect(summarizeDesiredState(report)).toMatch(/healthy/i)
  })

  test('mixed report names tiers without leaking jargon', () => {
    const report: DesiredStateReport = {
      projectId: 'p1',
      evaluatedAt: new Date().toISOString(),
      satisfied: false,
      invariants: [],
      violations: [
        { invariantId: 'a', type: 'missing_fk_index', severity: 'warning', tier: 0, details: {} },
        { invariantId: 'b', type: 'broken_auth', severity: 'critical', tier: 2, details: {} },
      ],
      tierCounts: { 0: 1, 1: 0, 2: 1, 3: 0 },
      errors: [],
    }
    const s = summarizeDesiredState(report)
    // Updated 2026-07-30: summarizeDesiredState was rewritten to speak plainly
    // for non-engineer founders ('2 issues found — ...'). The assertion still
    // pins the COUNT and the absence of jargon, which is what it was for.
    expect(s).toContain('2 issues found')
    expect(s).toMatch(/auto-repair/i)
    expect(s).toMatch(/approval/i)
    // no raw finding-type identifiers in the user-facing summary
    expect(s).not.toContain('missing_fk_index')
    expect(s).not.toContain('broken_auth')
  })
})
