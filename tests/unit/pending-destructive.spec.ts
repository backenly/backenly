/**
 * Guards the destructive-confirmation window.
 *
 * Observed incident: a bare `confirm` sent over the stateless MCP door resolved
 * a destructive cast parked by a DIFFERENT session — the caller approved one
 * operation and executed another. A bare affirmative carries no information
 * about what it approves, the store holds one pending item per project, and MCP
 * has no session identity to bind to, so freshness is the only available signal
 * that the confirmer actually saw the thing they are confirming.
 *
 * Rule under test: a bare "yes" resolves only a RECENT ask. Confirmations that
 * name the target stay valid for the full TTL, because naming it proves the
 * confirmer knows what it is.
 */

import {
  isDestructiveConfirmation,
  isBareAffirmative,
  describePendingDestructive,
  type PendingDestructive,
} from '@/lib/ai/brain/pending-destructive'

const MINUTE = 60 * 1000
const NOW = Date.parse('2026-07-20T12:00:00Z')

function pending(over: Partial<PendingDestructive> = {}): PendingDestructive {
  const createdAt = over.createdAt ?? new Date(NOW).toISOString()
  // A malformed createdAt is a case under test, so derive expiresAt defensively
  // rather than letting the fixture itself throw on `new Date(NaN)`.
  const createdMs = Date.parse(createdAt)
  const expiresAt = new Date(
    (Number.isFinite(createdMs) ? createdMs : NOW) + 15 * MINUTE,
  ).toISOString()
  return {
    calls: [{ tool: 'drop_table', args: { tableName: 'followers' }, target: 'the `followers` table' }],
    originalMessage: 'drop the followers table',
    createdAt,
    expiresAt,
    ...over,
  }
}

/** A pending item created `mins` ago relative to NOW. */
const agedBy = (mins: number) => pending({ createdAt: new Date(NOW - mins * MINUTE).toISOString() })

describe('bare affirmatives require a fresh ask', () => {
  for (const word of ['yes', 'confirm', 'ok', 'do it', 'go ahead', 'proceed', 'approve']) {
    it(`accepts "${word}" immediately after the ask`, () => {
      expect(isDestructiveConfirmation(word, agedBy(0), NOW)).toBe(true)
    })
  }

  it('accepts a bare affirmative just inside the window', () => {
    expect(isDestructiveConfirmation('confirm', agedBy(1), NOW)).toBe(true)
  })

  it('REJECTS a bare affirmative once the ask is stale — the incident', () => {
    // Same project, same pending row, hours later, different session.
    expect(isDestructiveConfirmation('confirm', agedBy(300), NOW)).toBe(false)
    expect(isDestructiveConfirmation('yes', agedBy(10), NOW)).toBe(false)
  })

  it('rejects a bare affirmative when the age cannot be determined', () => {
    // An unknown age must never widen what a bare "yes" may execute.
    expect(isDestructiveConfirmation('yes', pending({ createdAt: 'not-a-date' }), NOW)).toBe(false)
    expect(isDestructiveConfirmation('yes', pending({ createdAt: '' }), NOW)).toBe(false)
  })

  it('rejects a bare affirmative dated in the future', () => {
    expect(isDestructiveConfirmation('yes', agedBy(-30), NOW)).toBe(false)
  })
})

describe('confirmations that name the target stay valid for the full TTL', () => {
  it('accepts the danger card phrase when stale', () => {
    expect(isDestructiveConfirmation('Confirm — drop the followers table', agedBy(300), NOW)).toBe(true)
  })

  it('accepts a re-stated imperative naming the same target when stale', () => {
    expect(isDestructiveConfirmation('drop the followers table', agedBy(300), NOW)).toBe(true)
  })

  it('does NOT accept a destructive imperative naming a DIFFERENT target', () => {
    // This is a new request, not a confirmation of the parked one.
    expect(isDestructiveConfirmation('drop the sessions table', agedBy(0), NOW)).toBe(false)
  })
})

describe('non-confirmations', () => {
  for (const msg of ['', '   ', 'what does this table do?', 'add a column called bio', 'no', 'wait']) {
    it(`rejects ${JSON.stringify(msg)}`, () => {
      expect(isDestructiveConfirmation(msg, agedBy(0), NOW)).toBe(false)
    })
  }
})

describe('isBareAffirmative', () => {
  it('separates "you said yes too late" from "you changed the subject"', () => {
    expect(isBareAffirmative('yes')).toBe(true)
    expect(isBareAffirmative('confirm')).toBe(true)
    expect(isBareAffirmative('drop the followers table')).toBe(false)
    expect(isBareAffirmative('add a bio column')).toBe(false)
  })
})

describe('describePendingDestructive', () => {
  it('names the target so the caller learns what they nearly approved', () => {
    expect(describePendingDestructive(pending())).toContain('followers')
  })

  it('falls back to the original request in replay mode', () => {
    expect(describePendingDestructive(pending({ calls: [] }))).toBe('drop the followers table')
  })

  it('never returns an empty description', () => {
    expect(describePendingDestructive(pending({ calls: [], originalMessage: '' })).length)
      .toBeGreaterThan(0)
  })
})
