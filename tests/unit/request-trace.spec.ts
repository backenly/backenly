/**
 * Layer attribution, proved without a running backend.
 *
 * The value of this module is entirely in getting the ATTRIBUTION right. A
 * diagnosis that names the wrong layer is worse than no diagnosis: it sends a
 * developer to read RLS policies when the problem is a missing token, or to
 * their own code when the data plane is down. So each rule is pinned here, and
 * so is the ordering between them, because several conditions produce the same
 * status code and a coarser check running first would shadow the precise one.
 */

import {
  classifyRequestOutcome,
  resolveRequestId,
  type RequestFacts,
} from '@/lib/observability/request-trace'

/** An ordinary authenticated read, so each test varies one fact. */
function facts(over: Partial<RequestFacts> = {}): RequestFacts {
  return {
    status: 200,
    rowCount: 3,
    endUserIdentityPresent: true,
    serviceRole: false,
    tableHasRls: true,
    table: 'orders',
    ...over,
  }
}

describe('the silent failure — 200 with an empty array', () => {
  it('blames the auth layer when no end-user token was sent', () => {
    // The case the whole module exists for. Every instrument says healthy; the
    // developer sees no data and starts debugging the database, which is fine.
    const o = classifyRequestOutcome(
      facts({ rowCount: 0, endUserIdentityPresent: false }),
    )
    expect(o.silentFailure).toBe(true)
    expect(o.layer).toBe('auth')
    expect(o.explanation).toMatch(/X-User-Token/)
  })

  it('stays quiet when the caller IS authenticated and simply has no rows', () => {
    // A warning that fires on every genuinely empty table is worse than none.
    const o = classifyRequestOutcome(facts({ rowCount: 0, endUserIdentityPresent: true }))
    expect(o.silentFailure).toBe(false)
  })

  it('stays quiet for a service-role caller, which bypasses RLS', () => {
    // No identity is EXPECTED here, so an empty result means empty.
    const o = classifyRequestOutcome(
      facts({ rowCount: 0, endUserIdentityPresent: false, serviceRole: true }),
    )
    expect(o.silentFailure).toBe(false)
  })

  it('stays quiet when the table has no RLS at all', () => {
    // Without RLS an absent identity cannot be why the rows are missing.
    const o = classifyRequestOutcome(
      facts({ rowCount: 0, endUserIdentityPresent: false, tableHasRls: false }),
    )
    expect(o.silentFailure).toBe(false)
  })

  it('stays quiet on a non-empty result', () => {
    expect(classifyRequestOutcome(facts({ rowCount: 5, endUserIdentityPresent: false })).silentFailure)
      .toBe(false)
  })
})

describe('platform faults are named as ours, not the developer\'s', () => {
  it('attributes an unreachable data plane to the platform', () => {
    const o = classifyRequestOutcome(facts({ status: 502, upstreamUnreachable: true }))
    expect(o.layer).toBe('platform')
    expect(o.explanation).toMatch(/not your code/i)
  })

  it('attributes PGRST106 to the platform, not to a missing table', () => {
    // This one presented as "your table does not exist" for months and cost a
    // user their entire data layer. It must never be attributed to the caller.
    const o = classifyRequestOutcome(facts({ status: 404, upstreamCode: 'PGRST106' }))
    expect(o.layer).toBe('platform')
    expect(o.explanation).toMatch(/not a missing table/i)
  })

  it('attributes a stale schema cache to the platform', () => {
    const o = classifyRequestOutcome(facts({ status: 404, upstreamCode: 'PGRST205' }))
    expect(o.layer).toBe('platform')
    expect(o.explanation).toMatch(/cache is stale/i)
  })

  it('checks upstream codes BEFORE the generic 404 rule', () => {
    // Ordering is the property. A plain 404 is an API-layer answer; the same
    // status with PGRST106 is a platform outage. If the coarse rule ran first
    // the developer would be told their table does not exist.
    expect(classifyRequestOutcome(facts({ status: 404 })).layer).toBe('api')
    expect(classifyRequestOutcome(facts({ status: 404, upstreamCode: 'PGRST106' })).layer)
      .toBe('platform')
  })

  it('attributes a 500 to the platform', () => {
    expect(classifyRequestOutcome(facts({ status: 500 })).layer).toBe('platform')
  })
})

describe('403 splits between the API gate and row security', () => {
  it('blames the database when the table has RLS', () => {
    const o = classifyRequestOutcome(facts({ status: 403, tableHasRls: true }))
    expect(o.layer).toBe('database')
    expect(o.explanation).toMatch(/policy declined/i)
  })

  it('blames the API gate when it does not', () => {
    const o = classifyRequestOutcome(facts({ status: 403, tableHasRls: false }))
    expect(o.layer).toBe('api')
  })
})

describe('the remaining layers', () => {
  it('401 is auth', () => {
    expect(classifyRequestOutcome(facts({ status: 401 })).layer).toBe('auth')
  })

  it('400 is the client', () => {
    expect(classifyRequestOutcome(facts({ status: 400 })).layer).toBe('client')
  })

  it('409 is the database, because a constraint decided it', () => {
    const o = classifyRequestOutcome(facts({ status: 409 }))
    expect(o.layer).toBe('database')
    expect(o.explanation).toMatch(/constraint/i)
  })

  it('429 is the API, and says nothing reached the database', () => {
    const o = classifyRequestOutcome(facts({ status: 429 }))
    expect(o.layer).toBe('api')
    expect(o.explanation).toMatch(/nothing reached the database/i)
  })
})

describe('resolveRequestId', () => {
  it('reuses a well-formed caller id so logs can be correlated', () => {
    expect(resolveRequestId('req-01HZY8K3QW9')).toBe('req-01HZY8K3QW9')
  })

  it('mints one when none was supplied', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects a value that would inject a header', () => {
    // This is echoed into a response header, so it is validated rather than
    // trusted, even though the id itself selects nothing and grants nothing.
    expect(resolveRequestId('abc\r\nX-Evil: 1')).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveRequestId('short')).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveRequestId('x'.repeat(200))).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveRequestId(12345)).toMatch(/^[0-9a-f-]{36}$/)
  })
})

/**
 * Production QA (2026-11-09): a policy that refused an insert was explained as
 * "Backenly's exposure rules refused this operation… The table is internal",
 * and the same refusal for an anonymous caller as "The credential was rejected…
 * Check the API key". Both were PostgreSQL's 42501 (insufficient_privilege):
 * row-level security or the table's grants declined the identity, with a valid
 * key. PostgREST answers it 401 for a caller with no end-user token and 403 for
 * one with, so the status alone never said which layer decided.
 */
describe('a refusal by the database itself (42501)', () => {
  it('blames row-level security or the grants for a signed-in user, never the API gate', () => {
    const o = classifyRequestOutcome(facts({ status: 403, upstreamCode: '42501', tableHasRls: undefined, table: 'reviews' }))
    expect(o.layer).toBe('database')
    expect(o.explanation).toBe(
      'Row-level security or the grants on "reviews" refused this for the signed-in user. ' +
        "The key is valid; the table's policy declined this user.",
    )
  })

  it('blames it for a caller with no end-user token too, where PostgREST answers 401, never the key', () => {
    const o = classifyRequestOutcome(
      facts({ status: 401, upstreamCode: '42501', endUserIdentityPresent: false, tableHasRls: undefined, table: 'reviews' }),
    )
    expect(o.layer).toBe('database')
    expect(o.explanation).toBe(
      'Row-level security or the grants on "reviews" refused this for a caller with no end-user token. ' +
        "The key is valid; send the signed-in user's token as X-User-Token, or, if this should work " +
        "without signing in, the table's policy has to allow it.",
    )
  })

  it('a 401 Backenly raised itself is still about the credential', () => {
    expect(classifyRequestOutcome(facts({ status: 401, upstreamCode: null })).layer).toBe('auth')
  })
})
