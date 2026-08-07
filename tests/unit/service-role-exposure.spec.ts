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

  it('allows Node/undici, which sends a UA but no Sec-Fetch and no Origin', () => {
    const v = detectBrowserOrigin({ 'user-agent': 'node' })
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
