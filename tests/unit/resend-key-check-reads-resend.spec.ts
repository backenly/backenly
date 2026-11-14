/**
 * RESEND'S KEY CHECK READS WHAT RESEND SAYS (#608)
 * ===============================================
 * Connecting Resend asks GET https://api.resend.com/domains. Resend's error
 * reference (https://resend.com/docs/api-reference/errors) gives two of its
 * answers the opposite meaning of their status alone:
 *
 *   401 restricted_api_key  a real key with Sending access, Resend's
 *                           least-privilege option: it was refused.
 *   400 validation_error    "API key is invalid", a key that does not exist
 *                           or was deleted: it was stored as confirmed.
 *
 * The second was any provider's: every 4xx but 401, 403 and 429 read as
 * `verified`. Resend's answers are its documented bodies, stubbed at fetch, so
 * the suite never calls a provider. They are the runtime's real Response, as
 * production gets from fetch, not jest.setup.js's stand-in.
 */
import '../helpers/real-web-standard'
import { blocksStorage, verifyIntegrationKey } from '@/lib/integrations/key-verification'

// Visibly synthetic keys, built at runtime so no key-shaped literal sits in the
// repository.
const resendKey = () => `re_${'k608'.repeat(6)}`
const stripeKey = () => ['sk', 'live', 'k608'.repeat(6)].join('_')

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
/** An error exactly as Resend writes one. */
const resendError = (statusCode: number, name: string, message: string) => json(statusCode, { statusCode, message, name })

let calls: Array<{ url: string; authorization: string }> = []
const realFetch = global.fetch

/** Every request gets `make()`; what was asked is kept in `calls`. */
function answerWith(make: () => Response) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(input), authorization: sent.Authorization ?? '' })
    return make()
  }) as typeof fetch
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  global.fetch = realFetch
})

describe("Resend's answers to GET /domains, as its error reference gives them", () => {
  it('a key with Sending access, answered 401 restricted_api_key, is a real key that can send', async () => {
    answerWith(() => resendError(401, 'restricted_api_key', 'This API key is restricted to only send emails'))
    const result = await verifyIntegrationKey('resend', resendKey())
    expect(result.status).toBe('verified')
    expect(blocksStorage(result)).toBe(false)
    expect(result.detail).toBe(
      'Resend accepted this key. It has Sending access, which is what sending email needs; ' +
        "Resend's other endpoints, called with ctx.integrations.resend.request(), need a key with Full access.",
    )
    expect(calls).toEqual([{ url: 'https://api.resend.com/domains', authorization: `Bearer ${resendKey()}` }])
  })

  it('a key that does not exist or was deleted, answered 400 "API key is invalid", is refused', async () => {
    answerWith(() => resendError(400, 'validation_error', 'API key is invalid'))
    const result = await verifyIntegrationKey('resend', resendKey())
    expect(result.status).toBe('rejected')
    expect(blocksStorage(result)).toBe(true)
    expect(result.detail).toBe(
      'Resend says this API key is invalid (HTTP 400): no such key exists, or it was deleted. ' +
        'Create a key at resend.com/api-keys and use that one.',
    )
  })

  it('a key that is not active, or is suspended, is refused, saying which', async () => {
    answerWith(() => resendError(403, 'restricted_api_key', 'API key is not active'))
    const inactive = await verifyIntegrationKey('resend', resendKey())
    expect(inactive.status).toBe('rejected')
    expect(inactive.detail).toMatch(/^Resend says this API key is not active \(HTTP 403\)\./)

    answerWith(() => resendError(403, 'suspended_api_key', 'This API key is suspended'))
    const suspended = await verifyIntegrationKey('resend', resendKey())
    expect(suspended.status).toBe('rejected')
    expect(suspended.detail).toMatch(/^Resend says this API key is suspended \(HTTP 403\)\./)
  })

  it("a key with Full access, answered 200, is verified, and the account's domain list is not read", async () => {
    const domains = json(200, { object: 'list', has_more: false, data: [] })
    answerWith(() => domains)
    const result = await verifyIntegrationKey('resend', resendKey())
    expect(result).toEqual({ status: 'verified', detail: 'Resend accepted this key.' })
    expect(domains.bodyUsed).toBe(false)
  })

  it("Resend's other answers keep their meaning: a missing key is refused; 429 and 5xx could not be checked", async () => {
    answerWith(() => resendError(401, 'missing_api_key', 'Missing API Key'))
    expect(await verifyIntegrationKey('resend', resendKey())).toEqual({
      status: 'rejected',
      detail: 'Resend rejected this key (HTTP 401) — it is not a valid credential for that account.',
    })

    for (const [status, name] of [[429, 'rate_limit_exceeded'], [500, 'application_error'], [503, 'service_unavailable']] as const) {
      answerWith(() => resendError(status, name, 'not about the key'))
      expect((await verifyIntegrationKey('resend', resendKey())).status).toBe('unreachable')
    }
  })

  it('an answer without Resend\'s JSON is read by its status, and a 400 is never "verified"', async () => {
    answerWith(() => new Response('<html>Bad gateway</html>', { status: 401, headers: { 'content-type': 'text/html' } }))
    expect((await verifyIntegrationKey('resend', resendKey())).status).toBe('rejected')

    answerWith(() => new Response('<html>Bad request</html>', { status: 400, headers: { 'content-type': 'text/html' } }))
    const unread = await verifyIntegrationKey('resend', resendKey())
    expect(unread.status).toBe('unreachable')
    expect(unread.detail).toBe(
      'Resend answered HTTP 400, which says neither that the key works nor that it does not; the key could not be checked.',
    )
  })

  it('a 400 about something other than the key, or a 404, is not a confirmation', async () => {
    answerWith(() => resendError(400, 'validation_error', 'An error was found with one or more fields in the request.'))
    expect((await verifyIntegrationKey('resend', resendKey())).status).toBe('unreachable')

    answerWith(() => resendError(404, 'not_found', 'The requested endpoint does not exist.'))
    expect((await verifyIntegrationKey('resend', resendKey())).status).toBe('unreachable')
  })
})

describe('every provider: only a 2xx accepts a key', () => {
  it.each([400, 402, 404, 405, 409, 410, 422])('Stripe answering HTTP %i stores the key unconfirmed, not verified', async (status) => {
    answerWith(() => json(status, { error: { message: 'not about the key' } }))
    const result = await verifyIntegrationKey('stripe', stripeKey())
    expect(result.status).toBe('unreachable')
    expect(blocksStorage(result)).toBe(false)
    expect(result.detail).toContain(`Stripe answered HTTP ${status}`)
  })

  it("Stripe's acceptance and refusal keep their wording", async () => {
    answerWith(() => json(200, { id: 'acct_1' }))
    expect(await verifyIntegrationKey('stripe', stripeKey())).toEqual({ status: 'verified', detail: 'Stripe accepted this key.' })

    answerWith(() => json(401, { error: { message: 'Invalid API Key provided' } }))
    expect(await verifyIntegrationKey('stripe', stripeKey())).toEqual({
      status: 'rejected',
      detail: 'Stripe rejected this key (HTTP 401) — it is not a valid credential for that account.',
    })
  })

  it('a network failure is still "could not be checked"', async () => {
    global.fetch = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    }) as typeof fetch
    const result = await verifyIntegrationKey('resend', resendKey())
    expect(result.status).toBe('unreachable')
    expect(result.detail).toContain('timed out')
  })
})
