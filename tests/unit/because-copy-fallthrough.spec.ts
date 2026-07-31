/**
 * The activity feed must never render the generic neglect clause for a finding
 * type the product actually knows.
 *
 * The reported failure, straight off a live dashboard:
 *
 *     Backenly fixed missing api on "connections" because it would have caused
 *     silent damage from going unnoticed.
 *
 * A humanised type where the WHAT belongs, the catch-all clause where the WHY
 * belongs. The cause was not a missing branch — `missing_api_definition` has
 * had one for as long as the module has existed. It was that because-copy ran
 * its own private alias vocabulary: detectors emit `missing_api`, the registry
 * has aliased that to `missing_api_definition` since forever, and the switch
 * matched only on strings spelled exactly as its `case` labels. Every alias in
 * PREFIX_MAP, and every suffixed multi-agent type, silently lost its sentence.
 *
 * These are cheap because the failure mode is invisible: nothing throws, no
 * test goes red, the feed just quietly gets worse — on the one surface whose
 * entire job is convincing a user the loop knows what it did.
 */

import { explainAutonomyEvent } from '@/lib/autonomy/because-copy'

/** The catch-all WHY. Its presence means the type missed every branch. */
const NEGLECT_CLAUSE = /silent damage from going unnoticed/

describe('because-copy resolves aliased finding types', () => {
  it('gives `missing_api` the REST-API sentence, not the catch-all', () => {
    const s = explainAutonomyEvent({ findingType: 'missing_api', tableName: 'connections' })

    expect(s.full).not.toMatch(NEGLECT_CLAUSE)
    expect(s.what).toBe('Backenly regenerated the REST API for "connections"')
    expect(s.why).toMatch(/out of sync with the live schema/)
  })

  // The multi-agent path emits `${type}_${location}` and frequently carries no
  // table field at all, which is how a sentence about one table reads "a table".
  it('recovers the table from a suffixed type when details carry none', () => {
    const s = explainAutonomyEvent({ findingType: 'missing_rls_orders' })

    expect(s.full).not.toMatch(NEGLECT_CLAUSE)
    expect(s.what).toBe('Backenly enabled row-level security on "orders"')
  })

  // The registry maps these onto a base so the FIX ENGINE picks the right
  // repair. That is a different question from what the sentence should say, and
  // borrowing the base's copy here would describe the wrong event.
  describe('keeps the alias sentence where the canonical base would misdescribe', () => {
    it('unbounded_pagination is a pagination cap, not a rate limit', () => {
      const s = explainAutonomyEvent({ findingType: 'unbounded_pagination', location: 'orders' })

      expect(s.what).toMatch(/bounded pagination/)
      expect(s.what).not.toMatch(/rate limit/)
    })

    it('arch_migration is a migration Backenly applied, not a change behind its back', () => {
      const s = explainAutonomyEvent({ findingType: 'arch_migration', title: 'split addresses out of users' })

      expect(s.full).not.toMatch(NEGLECT_CLAUSE)
      expect(s.what).toMatch(/split addresses out of users/)
      // shadow_mutation's WHY — "a column was added outside the AI flow" — is
      // the opposite story and must not leak in here.
      expect(s.why).not.toMatch(/outside the AI flow/)
    })

    it('missing_index keeps hot-path wording rather than foreign-key wording', () => {
      const s = explainAutonomyEvent({ findingType: 'missing_index', tableName: 'events', column: 'created_at' })

      expect(s.what).toBe('Backenly added an index on "events.created_at"')
      expect(s.why).toMatch(/hot read path/)
    })
  })

  it('still falls back to a sentence for a type nothing knows', () => {
    const s = explainAutonomyEvent({ findingType: 'some_unknown_future_type', tableName: 'widgets' })

    expect(s.full).toMatch(NEGLECT_CLAUSE)
    expect(s.what).not.toMatch(/_/) // never leaks the raw snake_case type
  })
})
