/**
 * AN INVARIANT COUNTS ONLY IF SOMETHING CAN ESTABLISH IT
 * =======================================================
 *
 * `invariantCount` was `INVARIANTS.length`, and the product said "29
 * guarantees". Three of those could not fire, for three different reasons
 * that were all hiding behind one number:
 *
 *   every_table_has_an_api        held by PostgREST by construction. Its
 *                                 detector returns [] because a probe would
 *                                 flag every table on every healthy project.
 *                                 A real promise; nothing is watching it.
 *   api_coverage_is_complete      detector returns [], no structural
 *                                 guarantee behind it. A name.
 *   repairs_in_one_area_are_holding
 *                                 a real, implemented probe whose first line
 *                                 is a flag check that is off by default.
 *
 * Only the middle one was fake. Deleting all three would have thrown away a
 * genuine guarantee and a working detector, and keeping all three counted
 * protection nobody was providing.
 *
 * The rule: an invariant counts as watched only when a probe can actually
 * establish its truth or violation in THIS deployment.
 */

import { INVARIANTS } from '@/lib/autonomy/desired-state'

const byId = (id: string) => INVARIANTS.find(i => i.id === id)

describe('the catalogue says how each guarantee is held', () => {
  it('no longer advertises the one with neither a probe nor a guarantee', () => {
    // `api_coverage_is_complete` had a detector that returned [] and no
    // structural reason for it to be true. Its own retirement comment says
    // anything re-added must read the catalog and grants rather than a
    // projection; nobody has.
    expect(byId('api_coverage_is_complete')).toBeUndefined()
  })

  it('keeps the one PostgREST actually guarantees, marked as such', () => {
    const inv = byId('every_table_has_an_api')
    expect(inv).toBeDefined()
    // Kept deliberately: "every table is reachable" is a real promise worth
    // stating. It is simply held by the engine rather than watched.
    expect(inv!.assurance).toBe('by_construction')
  })

  it('declares the deployment flag the recurrence probe hides behind', () => {
    const inv = byId('repairs_in_one_area_are_holding')
    expect(inv).toBeDefined()
    // Without this the probe returns [] when gated, which is indistinguishable
    // from looking and finding nothing - the exact shape that let
    // detectMissingRls read green while it was dead.
    expect(typeof inv!.enabled).toBe('function')
  })

  it('every other invariant is observed, with a real probe', () => {
    // Anti-vacuous: if `assurance` were quietly applied everywhere, the count
    // below would be honest and meaningless.
    const observed = INVARIANTS.filter(i => i.assurance !== 'by_construction')
    expect(observed.length).toBeGreaterThan(20)
    for (const i of observed) {
      expect(typeof i.probe).toBe('function')
    }
  })
})

describe('the count reports what is actually watched', () => {
  const trust = () => require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'lib/autonomy/trust-report.ts'),
    'utf8',
  ) as string

  it('is no longer the raw length of the catalogue', () => {
    expect(trust()).not.toContain('invariantCount: INVARIANTS.length')
  })

  it('excludes by-construction and deployment-gated members', () => {
    const src = trust()
    expect(src).toContain("i.assurance !== 'by_construction'")
    expect(src).toContain('!(i.enabled && !i.enabled())')
  })

  it('reports the excluded ones rather than hiding them', () => {
    // Dropping them from the count without saying so would trade one
    // inaccuracy for another: a user comparing "26" against yesterday's "29"
    // deserves to see where the three went.
    const src = trust()
    expect(src).toContain('guaranteedByConstruction')
    expect(src).toContain('uncheckedHere')
  })
})
