/**
 * A refusal by row-level security or grants answers with the code its status
 * says (lib/postgrest/translate.ts).
 *
 * PostgreSQL refuses with 42501, and PostgREST answers that 401 when the
 * caller had no signed-in user and 403 when it had one. Backenly kept the
 * status and always set the code FORBIDDEN, so an anonymous insert came back
 * 401 FORBIDDEN (production QA re-test, 2026-11-16, N15).
 *
 *   v1 (/db): 401 UNAUTHORIZED, saying to send the user's session token;
 *             403 FORBIDDEN, as before.
 *   v2:       PostgREST's own 42501, with PostgREST's 401 or 403, which is
 *             what postgrest-js and supabase-js clients check.
 * Neither repeats PostgreSQL's words, which can name a table.
 */
import { ANONYMOUS_REFUSAL, stripUpstreamError, toApiError } from '@/lib/postgrest/translate'

const anonymous = { code: '42501', message: 'permission denied for table reviews' }
const signedIn = { code: '42501', message: 'new row violates row-level security policy for table "reviews"' }

describe('v1', () => {
  it("answers an anonymous refusal 401 UNAUTHORIZED, saying to send the user's token", () => {
    expect(toApiError(401, anonymous)).toEqual({
      status: 401,
      body: {
        error: "The table's row-level security or grants do not allow this without a signed-in user. Send the user's session token in X-User-Token.",
        code: 'UNAUTHORIZED',
      },
    })
  })

  it('CONTROL: answers a signed-in refusal 403 FORBIDDEN', () => {
    expect(toApiError(403, signedIn)).toEqual({
      status: 403,
      body: { error: 'Not authorized to perform this operation', code: 'FORBIDDEN' },
    })
  })
})

describe('v2', () => {
  it("answers an anonymous refusal with PostgREST's 42501 and 401", () => {
    expect(stripUpstreamError(401, anonymous)).toEqual({
      status: 401,
      body: { code: '42501', message: 'Not authorized to perform this operation', details: null, hint: ANONYMOUS_REFUSAL },
    })
  })

  it("answers a signed-in refusal with PostgREST's 42501 and 403", () => {
    expect(stripUpstreamError(403, signedIn)).toEqual({
      status: 403,
      body: { code: '42501', message: 'Not authorized to perform this operation', details: null, hint: null },
    })
  })
})

it('CONTROL: never repeats words that name a table', () => {
  for (const out of [toApiError(401, anonymous), toApiError(403, signedIn), stripUpstreamError(401, anonymous), stripUpstreamError(403, signedIn)]) {
    expect(JSON.stringify(out.body)).not.toMatch(/reviews|permission denied|policy for table/)
  }
})
