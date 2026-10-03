/**
 * The browser-detection rule, proved without a server.
 *
 * This decides whether a request is refused, so both directions of a wrong
 * answer are expensive and they are expensive in opposite ways:
 *
 *   false NEGATIVE — a browser call slips through and the service-role key
 *                    serves every row of every table to whoever asked.
 *   false POSITIVE — correct backend code starts getting 403s from a key that
 *                    is being used exactly as intended.
 *
 * The rule is therefore built on `Sec-Fetch-*`, which are forbidden header
 * names: browsers set them on every fetch and page JavaScript cannot forge or
 * strip them, while no server-side HTTP client sends them at all. The tests
 * below pin BOTH directions — the server-client cases matter as much as the
 * browser ones, because that half is what a nervous change would break first.
 */

import {
  detectBrowserOrigin,
  serviceRoleRefusalMessage,
} from '@/lib/security/service-role-exposure'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

describe('detectBrowserOrigin — browsers are refused', () => {
  it('detects a same-origin fetch from a page', () => {
    const v = detectBrowserOrigin({
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      origin: 'https://app.example.com',
      'user-agent': CHROME_UA,
    })
    expect(v.isBrowser).toBe(true)
    expect(v.signal).toBe('sec_fetch')
    expect(v.origin).toBe('https://app.example.com')
  })

  it('detects a cross-site fetch, which is the shape a leaked key produces', () => {
    const v = detectBrowserOrigin({
      'sec-fetch-site': 'cross-site',
      origin: 'https://someone-elses-site.com',
      'user-agent': CHROME_UA,
    })
    expect(v.isBrowser).toBe(true)
    expect(v.origin).toBe('https://someone-elses-site.com')
  })

  it('refuses a real browser that sends Sec-Fetch-Mode and a browser UA', () => {
    // The pairing that makes the fix above safe. Mode alone is now ambiguous,
    // so it needs corroboration from a header page JavaScript also cannot set —
    // and a browser always sends both. Without this test, "Node is allowed"
    // could be satisfied by a guard that had stopped detecting anything.
    const v = detectBrowserOrigin({
      'sec-fetch-mode': 'cors',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    })
    expect(v.isBrowser).toBe(true)
    expect(v.signal).toBe('sec_fetch')
  })

  it('refuses a real browser on Sec-Fetch-Site alone, whatever its UA', () => {
    // Site and Dest are sent by every browser and by no Node client, so they
    // stay sufficient on their own.
    expect(detectBrowserOrigin({ 'sec-fetch-site': 'cross-site' }).isBrowser).toBe(true)
  })

  it('detects a browser that sent only Sec-Fetch-Dest', () => {
    // Not every request carries Site or Mode; any member of the family is proof.
    const v = detectBrowserOrigin({ 'sec-fetch-dest': 'empty' })
    expect(v.isBrowser).toBe(true)
    expect(v.signal).toBe('sec_fetch')
  })

  it('falls back to Origin + a browser UA for pre-Sec-Fetch browsers', () => {
    const v = detectBrowserOrigin({
      origin: 'https://legacy.example.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 6.1; rv:52.0) Gecko/20100101 Firefox/52.0',
    })
    expect(v.isBrowser).toBe(true)
    expect(v.signal).toBe('origin_with_browser_ua')
  })

  it('recovers the origin from Referer when Origin is absent', () => {
    const v = detectBrowserOrigin({
      'sec-fetch-site': 'same-origin',
      referer: 'https://app.example.com/dashboard/settings?tab=keys',
    })
    expect(v.isBrowser).toBe(true)
    // The origin only — a Referer path routinely carries identifiers that are
    // themselves user data, and this value is persisted to the audit ledger.
    expect(v.origin).toBe('https://app.example.com')
  })
})

describe('detectBrowserOrigin — servers are not refused', () => {
  it('allows a bare server-to-server call', () => {
    expect(detectBrowserOrigin({}).isBrowser).toBe(false)
  })

  it('allows Node’s built-in fetch, which DOES send Sec-Fetch-Mode', () => {
    // The exact headers Node 20 puts on the wire, measured against a real
    // server rather than assumed:
    //
    //   content-type, x-api-key, accept, accept-language,
    //   sec-fetch-mode: cors, user-agent: node, accept-encoding
    //
    // The previous version of this test was called "sends a UA but no
    // Sec-Fetch" and supplied only a user-agent, so it passed against a fixture
    // that does not exist. The guard accepted ANY Sec-Fetch-* member, so every
    // service-role call from a Next.js API route, a server component or any
    // Node 18+ backend was refused and told to move the key to a server it was
    // already on. Found by the final qualification, which could not write
    // through /db/* with a service-role key.
    const v = detectBrowserOrigin({
      'content-type': 'application/json',
      accept: '*/*',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
      'user-agent': 'node',
      'accept-encoding': 'gzip, deflate',
    })
    expect(v.isBrowser).toBe(false)
    expect(v.signal).toBeNull()
  })

  it('allows a Node client that sets a browser-ish Origin but is not one', () => {
    const v = detectBrowserOrigin({
      'sec-fetch-mode': 'cors',
      'user-agent': 'node',
      origin: 'https://app.example.com',
    })
    expect(v.isBrowser).toBe(false)
  })

  it('allows curl', () => {
    expect(detectBrowserOrigin({ 'user-agent': 'curl/8.4.0' }).isBrowser).toBe(false)
  })

  it('allows a server client that sets Origin for its own reasons', () => {
    // This is the false positive that would break working backends: Origin is
    // NOT proof on its own, precisely because a server may legitimately send it.
    const v = detectBrowserOrigin({
      origin: 'https://api.example.com',
      'user-agent': 'my-backend/1.2.3',
    })
    expect(v.isBrowser).toBe(false)
    expect(v.signal).toBeNull()
  })

  it('allows a Backenly function calling its own project', () => {
    const v = detectBrowserOrigin({
      'user-agent': 'Backenly-Function/1.0',
      'x-forwarded-for': '10.0.0.4',
    })
    expect(v.isBrowser).toBe(false)
  })

  it('survives a malformed Referer without throwing', () => {
    const v = detectBrowserOrigin({ referer: 'not a url', 'user-agent': CHROME_UA })
    expect(v.isBrowser).toBe(false)
    expect(v.origin).toBeNull()
  })

  it('reads header values case-insensitively and through arrays', () => {
    // Node lower-cases incoming header names, but this function is also called
    // with plain objects in tests and from the Next runtime, and `set-cookie`
    // style array values are representable on the same bag type.
    const v = detectBrowserOrigin({ 'Sec-Fetch-Site': ['same-site'] as unknown as string })
    expect(v.isBrowser).toBe(true)
  })
})

describe('the refusal message', () => {
  it('names the key, the cause, and both halves of the fix', () => {
    const msg = serviceRoleRefusalMessage('prod backend')
    expect(msg).toContain('prod backend')
    expect(msg).toMatch(/row-level security/i)
    // It must point at the replacement, not just the problem — this is read by a
    // developer at the moment they can act on it.
    expect(msg).toMatch(/client key/i)
  })

  it('still reads correctly for an unnamed key', () => {
    expect(serviceRoleRefusalMessage(null)).toMatch(/^This key/)
  })
})
