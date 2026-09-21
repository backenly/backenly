/**
 * THE FAULT BANK MUST ITSELF BE CORRECT
 * =====================================
 *
 * `lab-scenario-bank.spec.ts` makes this argument for the scenarios and it
 * applies with more force here: the Phase 0 baseline scores the autonomy system
 * against these faults, so a fault that does not break what it claims to break
 * produces a confident number about a backend that was never broken.
 *
 * The first baseline run proved that is not hypothetical. Two of seven faults
 * did nothing:
 *
 *   - `unindexed-fk` dropped an index the scenario bank never created.
 *   - `fk-dropped` removed a constraint the fingerprint did not record, so the
 *     harness could not see the difference.
 *
 * Both were caught by the runtime non-vacuity check rather than by a reviewer,
 * which is the argument for keeping that check and for this suite.
 *
 * This asserts the STATIC properties — ids, wiring, declared invariants. The
 * dynamic property (that applying a fault actually changes the database) is
 * enforced by the harness at run time, because it needs a live PostgreSQL and
 * belongs to the measurement rather than to CI.
 */

import { FAULTS, UNIMPLEMENTED_FAULTS, fault } from '../lab/faults'
import { SCENARIOS } from '../lab/scenarios'
import { INVARIANTS } from '@/lib/autonomy/desired-state'

describe('the fault bank is internally consistent', () => {
  it('every fault id is unique', () => {
    const ids = FAULTS.map(f => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every fault targets a scenario that exists in the bank', () => {
    const known = new Set(SCENARIOS.map(s => s.id))
    for (const f of FAULTS) {
      expect(known.has(f.scenario)).toBe(true)
    }
  })

  it('fault() throws for an unknown id rather than returning undefined', () => {
    expect(() => fault('no-such-fault')).toThrow(/No such fault/)
    expect(fault('unindexed-fk').id).toBe('unindexed-fk')
  })
})

describe('declared expectations are well formed', () => {
  it('every detector invariant names a real invariant', () => {
    // A typo here would silently make a fault undetectable: the harness would
    // look for an invariant that can never fire and score a false negative
    // against the system every run.
    const known = new Set(INVARIANTS.map(i => i.id))
    for (const f of FAULTS) {
      for (const id of f.expected.detectorInvariants) {
        expect(known.has(id)).toBe(true)
      }
    }
  })

  it('backend faults name at least one detector invariant', () => {
    // Empty means "any finding counts", which is only correct where there is
    // nothing specific to detect. For a backend fault it would let unrelated
    // advisory noise score as a true positive — the exact bug the first
    // baseline run had.
    for (const f of FAULTS.filter(x => x.family === 'backend')) {
      expect(f.expected.detectorInvariants.length).toBeGreaterThan(0)
    }
  })

  it('observer and control faults expect no repair', () => {
    for (const f of FAULTS.filter(x => x.family !== 'backend')) {
      expect(f.expected.detected).toBe(false)
      expect(f.expected.actionClass).toBeNull()
      expect(f.expected.converges).toBe(false)
    }
  })

  it('every fault states why its expectation is right', () => {
    // The rationale is what a reviewer disputes when they disagree with a
    // baseline number. A fault without one is an unfalsifiable assertion.
    for (const f of FAULTS) {
      expect(f.expected.rationale.length).toBeGreaterThan(40)
    }
  })
})

describe('the bank covers the families the baseline reports on', () => {
  it('has backend, observer and control faults', () => {
    const families = new Set(FAULTS.map(f => f.family))
    expect(families).toEqual(new Set(['backend', 'observer', 'control']))
  })

  it('records the faults that cannot yet be expressed, rather than dropping them', () => {
    // `catalog-permission-revoked` is unimplementable while the lab has one
    // database role that owns every schema. Keeping it visible is the
    // difference between a known gap and a silently narrower bank.
    expect(UNIMPLEMENTED_FAULTS.length).toBeGreaterThan(0)
    for (const u of UNIMPLEMENTED_FAULTS) {
      expect(u.blockedBy.length).toBeGreaterThan(20)
      expect(FAULTS.some(f => f.id === u.id)).toBe(false)
    }
  })
})
