/**
 * The mismatch detector guards a failure that returns 200 with an empty array.
 * Its own logic therefore has to be right by inspection, because there is no
 * downstream alarm that would catch it being wrong.
 *
 * Rewritten for the single-engine data plane. The probe no longer compares a
 * per-project engine flag against the policy dialect — both executors were
 * deleted on 2026-07-21 and everything is served by PostgREST — so there is one
 * correct dialect and a legacy-GUC policy is unconditionally broken rather than
 * conditionally mismatched.
 */

import { compareEngineToPolicies } from '@/lib/autonomy/engine-conformance'
import { summariseFinding } from '@/lib/core/finding-summaries'

describe('compareEngineToPolicies', () => {
  it('flags legacy GUC policies', () => {
    // PostgREST sets request.jwt.claims and never app.current_user_id, so these
    // policies evaluate against NULL and match nothing.
    const r = compareEngineToPolicies(16, 0)
    expect(r.mismatched).toBe(true)
  })

  it('flags a partially migrated project', () => {
    // The worst real case: some tables work and some silently do not, so the
    // symptom looks like a data problem rather than a configuration one. This
    // is the shape workspace_ce18214a was actually in — 32 legacy policies
    // sitting alongside 32 claim-form ones.
    expect(compareEngineToPolicies(3, 13).mismatched).toBe(true)
  })

  it('accepts a fully migrated project', () => {
    expect(compareEngineToPolicies(0, 16).mismatched).toBe(false)
  })

  it('does not flag a project with no policies at all', () => {
    // Nothing reads either identity, so the project is served correctly.
    // Flagging these would bury the real cases under every project that has
    // not enabled RLS.
    expect(compareEngineToPolicies(0, 0).mismatched).toBe(false)
  })

  it('reports the counts it based the decision on', () => {
    const r = compareEngineToPolicies(5, 11)
    expect(r.totalPolicies).toBe(16)
    expect(r.legacyPolicies).toBe(5)
    expect(r.jwtPolicies).toBe(11)
  })
})

describe('runtime_engine_mismatch summary', () => {
  it('leads with the symptom the reader is already looking at', () => {
    const s = summariseFinding('runtime_engine_mismatch', {})
    expect(s).toMatch(/no rows/i)
  })

  it('names the cause without requiring the reader to know the engine history', () => {
    const s = summariseFinding('runtime_engine_mismatch', {})
    expect(s).toMatch(/identity setting/i)
  })
})
