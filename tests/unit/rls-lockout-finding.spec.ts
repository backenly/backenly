/**
 * `rls_denies_everything` must be a FIRST-CLASS finding, not just a new string.
 *
 * The reported failure: a table with RLS enabled (FORCED) and zero policies
 * survived a failed approval and an entire release. PostgreSQL denies by
 * default, so it returned no rows to every request while the API answered 200
 * and health stayed green. `detectMissingRls` could not see it — its query is
 * `NOT pc.relrowsecurity`, which looks for RLS switched OFF.
 *
 * Adding a detector is only half the fix. A finding type that is not registered
 * in the classifier, the fix-action map and the normalizer dead-ends at
 * "No fix action mapped" — detected, never repaired, and the queue teaches its
 * reader to ignore it. These assert every hop.
 */

import { classifyFix } from '@/lib/core/fix-classifier'
import { normalizeFindingType } from '@/lib/core/types'
import { buildFixAction } from '@/lib/core/auto-fix-engine'
import { detectRlsDeniesEverything } from '@/lib/services/workspace-observer'
import { explainAutonomyEvent } from '@/lib/autonomy/because-copy'

const TYPE = 'rls_denies_everything' as const

describe('rls_denies_everything is wired end to end', () => {
  it('survives finding-type normalization as itself', () => {
    expect(normalizeFindingType(TYPE).base).toBe(TYPE)
    expect(normalizeFindingType(TYPE).wasAliased).toBe(false)
  })

  // Installing a policy on a default-deny table RESTORES service. It is additive
  // in the only sense that matters — nothing that worked before stops working —
  // so gating it behind a human would leave the outage running.
  it('is classified auto-safe, so the loop repairs it without a human', () => {
    const c = classifyFix(TYPE, { tableName: 'connections' })
    expect(c.decision).toBe('auto')
    expect(c.suggestedAction).toMatch(/SET_PERMISSION/)
  })

  it('maps to SET_PERMISSION with the schema-inferred template', () => {
    const action = buildFixAction(TYPE, { tableName: 'connections', rlsTemplate: 'party_rows' })
    expect(action).toMatchObject({
      action: 'SET_PERMISSION',
      params: { tableName: 'connections', template: 'party_rows' },
    })
  })

  it('falls back to auto inference when the detector could not decide a template', () => {
    const action = buildFixAction(TYPE, { tableName: 'connections' })
    expect(action).toMatchObject({ action: 'SET_PERMISSION', params: { template: 'auto' } })
  })

  // The narrative must NOT borrow missing_rls's copy. This table was not
  // "readable across accounts" — it was readable by nobody. Describing an
  // exposure the user never had is how a queue loses its reader's trust.
  it('has its own explanation naming the outage, not an exposure', () => {
    const copy = explainAutonomyEvent({ findingType: TYPE, tableName: 'connections' } as never)
    expect(copy.full).toMatch(/denies by default/i)
    expect(copy.full).toMatch(/dead to your app rather than protected/i)
    expect(copy.full).not.toMatch(/readable across accounts/i)
  })

  it('is exported as a detector the observer can run', () => {
    expect(typeof detectRlsDeniesEverything).toBe('function')
  })
})
