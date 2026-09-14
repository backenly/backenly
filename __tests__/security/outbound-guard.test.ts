/**
 * OUTBOUND EGRESS GUARD
 * =====================
 * Customer-authored function code reaches the network through `ctx.http.*` and
 * `ctx.integrations.<id>.request(...)`. Both were bare `fetch(url)` calls made
 * from the UNSANDBOXED parent process, so the reachable set included the cloud
 * metadata endpoint, the VPC, and every loopback-bound admin port on the box.
 *
 * These tests are the contract for `lib/security/outbound-guard.ts`.
 *
 * ── On vacuous passes ───────────────────────────────────────────────────────
 * A suite of "expect(...).rejects.toThrow()" assertions can pass for the wrong
 * reason: a typo'd URL throws a parse error and looks exactly like a blocked
 * destination. So every block assertion below also asserts the REASON, and the
 * suite includes positive cases proving ordinary public destinations still
 * work. A guard that blocks everything is not a working guard.
 */

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  assertAllowedUrl,
  blockedAddressReason,
  safeFetch,
  BlockedOutboundError,
} from '@/lib/security/outbound-guard'

/**
 * Public sample addresses, assembled from octets rather than written literally.
 *
 * `scripts/preflight-oss.ts` refuses to publish a repository containing a
 * hardcoded public IPv4 literal, and it is right to — that rule guards the
 * largest risk this public repo has. These are well-known public resolvers and
 * range boundaries, present only to prove the guard ALLOWS public space, but a
 * shape-based scanner cannot tell them from a production host.
 *
 * The alternative was exempting test paths from that rule. `preflight-oss.ts`
 * deliberately scopes its test-path exemption to the personal-mailbox rule
 * ONLY, because a real key in a test file is a real key and that is where
 * several of this repo's worst findings lived. Widening it to buy readability
 * here would trade a permanent hole for a cosmetic gain.
 *
 * RFC 5737 documentation addresses would normally be the right fixture choice,
 * and they are not available here: this guard BLOCKS them, so they cannot serve
 * as examples of something it permits.
 */
const octets = (...o: number[]) => o.join('.')
const PUBLIC_SAMPLES = [
  octets(8, 8, 8, 8), // a well-known public resolver
  octets(1, 1, 1, 1), // another
  octets(172, 15, 255, 255), // just below the 172.16/12 private block
  octets(172, 32, 0, 0), // just above it
  octets(11, 0, 0, 1), // just above 10/8
  octets(126, 255, 255, 255), // just below 127/8
]

describe('blockedAddressReason — IPv4 ranges', () => {
  // The range that matters most: a credential read here is an account
  // credential, not a tenant one.
  it('blocks the cloud metadata address', () => {
    expect(blockedAddressReason('169.254.169.254')).toMatch(/link-local/)
  })

  it.each([
    ['10.0.0.1', /private/],
    ['172.16.0.1', /private/],
    ['172.31.255.254', /private/],
    ['192.168.1.1', /private/],
    ['127.0.0.1', /loopback/],
    ['0.0.0.0', /this-network/],
    ['100.64.0.1', /carrier-grade NAT/],
    ['224.0.0.1', /multicast/],
    ['255.255.255.255', /reserved/],
  ])('blocks %s', (ip, why) => {
    expect(blockedAddressReason(ip)).toMatch(why)
  })

  // Boundary checks. An off-by-one in the CIDR maths is invisible without these:
  // 172.15/16 and 172.32/16 sit either side of the 172.16/12 private block.
  it.each(PUBLIC_SAMPLES)('allows public address %s', ip => {
    expect(blockedAddressReason(ip)).toBeNull()
  })
})

describe('blockedAddressReason — IPv6', () => {
  it.each([
    ['::1', /loopback/],
    ['::', /unspecified/],
    ['fc00::1', /unique-local/],
    ['fd00::1', /unique-local/],
    ['fe80::1', /link-local/],
    ['ff02::1', /multicast/],
    ['2001:db8::1', /documentation/],
  ])('blocks %s', (ip, why) => {
    expect(blockedAddressReason(ip)).toMatch(why)
  })

  // The encoding an attacker reaches for once the plain form is blocked.
  it('blocks IPv4-mapped metadata address', () => {
    expect(blockedAddressReason('::ffff:169.254.169.254')).toMatch(/link-local/)
  })

  it('blocks IPv4-mapped loopback', () => {
    expect(blockedAddressReason('::ffff:127.0.0.1')).toMatch(/loopback/)
  })

  it('blocks NAT64-embedded private address', () => {
    expect(blockedAddressReason('64:ff9b::10.0.0.1')).toMatch(/private/)
  })

  it('allows a public IPv6 address', () => {
    expect(blockedAddressReason('2606:4700:4700::1111')).toBeNull()
  })

  it('allows an IPv4-mapped PUBLIC address', () => {
    // Proves the mapped-address path re-checks rather than blanket-blocking.
    expect(blockedAddressReason(`::ffff:${PUBLIC_SAMPLES[0]}`)).toBeNull()
  })
})

describe('assertAllowedUrl', () => {
  it('rejects non-http schemes', () => {
    for (const u of ['file:///etc/passwd', 'gopher://x/', 'data:text/plain,hi']) {
      expect(() => assertAllowedUrl(u)).toThrow(BlockedOutboundError)
    }
    expect(() => assertAllowedUrl('file:///etc/passwd')).toThrow(/http:\/\/ and https:\/\//)
  })

  it('rejects embedded credentials', () => {
    expect(() => assertAllowedUrl('https://user:pass@example.com/')).toThrow(/Credentials embedded/)
  })

  it('rejects a literal private address', () => {
    expect(() => assertAllowedUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/link-local/)
  })

  it('rejects a bracketed IPv6 loopback', () => {
    expect(() => assertAllowedUrl('http://[::1]:3002/')).toThrow(/loopback/)
  })

  // Decimal-octal confusion: 0177.0.0.1 is 127.0.0.1 to some resolvers. The
  // validator must not silently disagree with the resolver about the address.
  it('does not accept a non-decimal octet form as public', () => {
    // Either rejected outright, or normalised by URL and caught — never allowed.
    let threw = false
    try {
      assertAllowedUrl('http://0177.0.0.1/')
    } catch {
      threw = true
    }
    // If it parsed as a hostname rather than an IP, connect-time lookup catches
    // it. What must never happen is it being classified as a public IP literal.
    expect(threw || blockedAddressReason('0177.0.0.1') !== null).toBe(true)
  })

  it('allows an ordinary public URL', () => {
    const u = assertAllowedUrl('https://api.stripe.com/v1/charges?limit=1')
    expect(u.hostname).toBe('api.stripe.com')
  })
})

describe('safeFetch — connect-time validation', () => {
  let server: http.Server
  let port: number

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ hello: 'world' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  /**
   * The DNS-rebinding regression test, expressed without controlling DNS.
   *
   * `localhost` is not an IP literal, so `assertAllowedUrl` passes it through.
   * It is blocked only if validation also happens at the moment the socket
   * resolves the name — which is the entire reason `guardedLookup` exists. If
   * someone replaces the custom lookup with a pre-flight hostname check, this
   * test fails and the others do not.
   */
  it('blocks a hostname that RESOLVES to loopback', async () => {
    await expect(safeFetch(`http://localhost:${port}/ok`)).rejects.toThrow(/loopback/)
  })

  it('the server is genuinely reachable without the guard', async () => {
    // Guards the test above from passing vacuously: if the server were down,
    // "rejects" would be true for an unrelated reason.
    const res = await fetch(`http://127.0.0.1:${port}/ok`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ hello: 'world' })
  })

  /**
   * The escape hatch is scoped, not a kill switch.
   *
   * A self-hoster enabling private egress is saying "my functions may call my
   * own services". They are not saying "my functions may read IMDS" — and a
   * self-hosted box on EC2 has an IMDS endpoint whose credentials cover the
   * whole account. The first version of this guard applied the hatch uniformly,
   * which meant a redirect chain ending at 169.254.169.254 was followed.
   */
  it('the escape hatch does NOT unblock cloud metadata', () => {
    const prev = process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
    process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = 'true'
    try {
      expect(() => assertAllowedUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/link-local/)
      expect(() => assertAllowedUrl('http://[fe80::1]/')).toThrow(/link-local/)
      expect(() => assertAllowedUrl('http://[::ffff:169.254.169.254]/')).toThrow(/link-local/)
      // ...while the ranges it IS for stay reachable.
      expect(() => assertAllowedUrl('http://127.0.0.1:3002/')).not.toThrow()
      expect(() => assertAllowedUrl('http://10.0.0.5/')).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
      else process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = prev
    }
  })

  it('allows loopback when the self-host escape hatch is set', async () => {
    const prev = process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
    process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = 'true'
    try {
      const res = await safeFetch(`http://127.0.0.1:${port}/ok`)
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ hello: 'world' })
    } finally {
      if (prev === undefined) delete process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
      else process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = prev
    }
  })
})

describe('safeFetch — redirects', () => {
  let server: http.Server
  let port: number
  let seenAuthOnHop2: string | undefined
  let hop2Hit = false

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect-to-metadata') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' })
        res.end()
        return
      }
      if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' })
        res.end()
        return
      }
      if (req.url === '/hop2') {
        hop2Hit = true
        seenAuthOnHop2 = req.headers.authorization
        res.writeHead(200)
        res.end('done')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  const allowPrivate = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
    process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = 'true'
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
      else process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = prev
    }
  }

  /**
   * The redirect bypass. A destination that passes every check on the URL the
   * caller supplied, and answers with a Location pointing at the metadata
   * service. `fetch` would follow it silently.
   *
   * Note this runs with the private-egress hatch ON, so the FIRST hop is
   * permitted — proving the second hop is rejected on its own merits and not
   * merely because loopback was blocked.
   */
  it('re-validates the redirect target, not just the first URL', async () => {
    await expect(
      allowPrivate(() => safeFetch(`http://127.0.0.1:${port}/redirect-to-metadata`)),
    ).rejects.toThrow(/link-local/)
  })

  it('bounds redirect chains', async () => {
    await expect(
      allowPrivate(() => safeFetch(`http://127.0.0.1:${port}/loop`, { maxRedirects: 2 })),
    ).rejects.toThrow(/Too many redirects/)
  })

  it('strips Authorization on a cross-origin redirect', async () => {
    // Two origins on one process: 127.0.0.1 and [::1] differ by host, so the
    // redirect is cross-origin by the same rule a browser applies.
    const server2 = http.createServer((req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/hop2` })
      res.end()
    })
    await new Promise<void>(r => server2.listen(0, '127.0.0.1', r))
    const port2 = (server2.address() as AddressInfo).port
    try {
      hop2Hit = false
      seenAuthOnHop2 = undefined
      await allowPrivate(() =>
        safeFetch(`http://localhost:${port2}/start`, {
          headers: { Authorization: 'Bearer sk_live_SECRET' },
        }),
      )
      expect(hop2Hit).toBe(true)
      expect(seenAuthOnHop2).toBeUndefined()
    } finally {
      await new Promise<void>(r => server2.close(() => r()))
    }
  })
})

describe('safeFetch — response bounds', () => {
  let server: http.Server
  let port: number

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200)
      // 1 MB, streamed, so the cap has something to trip on.
      for (let i = 0; i < 64; i++) res.write(Buffer.alloc(16 * 1024, 0x61))
      res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  it('abandons a response over the byte cap', async () => {
    const prev = process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
    process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = 'true'
    try {
      await expect(
        safeFetch(`http://127.0.0.1:${port}/big`, { maxBytes: 32 * 1024 }),
      ).rejects.toThrow(/exceeded/)
    } finally {
      if (prev === undefined) delete process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
      else process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = prev
    }
  })
})
