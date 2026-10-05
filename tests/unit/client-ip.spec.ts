/**
 * The client address is the rightmost X-Forwarded-For entry that is not a proxy
 * we trust, never the leftmost, which is whatever the client sent.
 *
 * Every per-address control read the FIRST entry. The AWS load balancer appends
 * to the header, so `X-Forwarded-For: <anything>` from a client arrived as
 * `<anything>, <real address>`, and each made-up value was a fresh rate-limit
 * budget. Each case below is a real hop sequence one of the supported
 * deployments produces (lib/security/client-ip.ts).
 */
import fs from 'fs'
import path from 'path'

import {
  assertTrustedProxiesParse,
  clientIpFromHeaders,
  clientIpFromNodeRequest,
  normaliseAddress,
  resolveClientIp,
  TrustedProxiesMisconfigured,
} from '@/lib/security/client-ip'
import { clientIp } from '@/lib/security/auth-rate-limit'

const REAL = '203.0.113.9'
const env = (trusted?: string) => ({ ...process.env, BACKENLY_TRUSTED_PROXIES: trusted ?? '' })

/** A Fetch-style request, as a Next route handler sees one. */
const fetchRequest = (headers: Record<string, string>) => ({
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
})

describe('AWS: client, load balancer, web task (a Next route handler, no socket)', () => {
  it('takes the address the load balancer appended', () => {
    expect(clientIpFromHeaders(fetchRequest({ 'x-forwarded-for': REAL }))).toBe(REAL)
  })

  it('ignores what the client wrote in front of it', () => {
    for (const spoofed of ['1.2.3.4', '10.0.0.5', '1.2.3.4, 5.6.7.8', 'garbage', '::1']) {
      expect(clientIpFromHeaders(fetchRequest({ 'x-forwarded-for': `${spoofed}, ${REAL}` }))).toBe(REAL)
    }
  })

  it('so rotating made-up values no longer rotate the rate-limit key', () => {
    const keys = new Set(
      Array.from({ length: 20 }, (_, i) =>
        clientIp(fetchRequest({ 'x-forwarded-for': `198.18.0.${i}, ${REAL}` })),
      ),
    )
    expect([...keys]).toEqual([REAL])
  })
})

describe('AWS: the web task forwards to the runtime inside the VPC', () => {
  it('skips the web task, a private address, to reach the client', () => {
    expect(clientIpFromNodeRequest({
      headers: { 'x-forwarded-for': `1.2.3.4, ${REAL}` },
      socket: { remoteAddress: '10.20.3.4' },
    })).toBe(REAL)
  })
})

describe('single box: client, nginx, runtime (and runtime to Next)', () => {
  it('skips nginx on loopback, including the IPv4-mapped form Node reports', () => {
    for (const loopback of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
      expect(clientIpFromNodeRequest({
        headers: { 'x-forwarded-for': `1.2.3.4, ${REAL}` },
        socket: { remoteAddress: loopback },
      })).toBe(REAL)
    }
  })

  it('skips the loopback hop the runtime appends when it forwards to Next', () => {
    // server/routes/next-proxy.ts appends its own peer before handing over.
    expect(clientIpFromHeaders(fetchRequest({ 'x-forwarded-for': `1.2.3.4, ${REAL}, 127.0.0.1` }))).toBe(REAL)
  })
})

describe('a runtime reached directly, with nothing in front', () => {
  it('believes the socket over any header the client sends', () => {
    expect(clientIpFromNodeRequest({
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
      socket: { remoteAddress: REAL },
    })).toBe(REAL)
  })
})

describe('a private network, where every hop is trusted', () => {
  it('takes the leftmost, the address the proxy saw', () => {
    expect(clientIpFromNodeRequest({
      headers: { 'x-forwarded-for': '192.168.1.50' },
      socket: { remoteAddress: '127.0.0.1' },
    })).toBe('192.168.1.50')
  })
})

describe('a public proxy in front (a CDN), declared in BACKENLY_TRUSTED_PROXIES', () => {
  const cdnHop = `${REAL}, 198.51.100.20`

  it('is skipped once declared, by CIDR or single address', () => {
    expect(resolveClientIp({ forwardedFor: cdnHop }, env('198.51.100.0/24'))).toBe(REAL)
    expect(resolveClientIp({ forwardedFor: cdnHop }, env('198.51.100.20'))).toBe(REAL)
    expect(resolveClientIp({ forwardedFor: `2001:db8::7, 2001:db8:ffff::1` }, env('2001:db8:ffff::/48'))).toBe('2001:db8::7')
  })

  it('CONTROL: undeclared, every client would appear as the proxy', () => {
    expect(resolveClientIp({ forwardedFor: cdnHop }, env())).toBe('198.51.100.20')
  })

  it('refuses an entry it cannot parse, loudly, at startup', () => {
    for (const bad of ['not-an-address', '10.0.0.0/33', '2001:db8::/129', '1.2.3.4/x']) {
      expect(() => assertTrustedProxiesParse(env(bad))).toThrow(TrustedProxiesMisconfigured)
    }
    expect(() => assertTrustedProxiesParse(env('10.0.0.0/8, 2001:db8::/32, 198.51.100.20'))).not.toThrow()
  })
})

describe('X-Real-IP', () => {
  it('is used only when there is no X-Forwarded-For', () => {
    expect(clientIpFromHeaders(fetchRequest({ 'x-real-ip': REAL }))).toBe(REAL)
    expect(clientIpFromHeaders(fetchRequest({ 'x-real-ip': '5.6.7.8', 'x-forwarded-for': REAL }))).toBe(REAL)
  })

  it('is believed from a trusted proxy and not from a direct client', () => {
    expect(clientIpFromNodeRequest({ headers: { 'x-real-ip': REAL }, socket: { remoteAddress: '127.0.0.1' } })).toBe(REAL)
    expect(clientIpFromNodeRequest({ headers: { 'x-real-ip': '5.6.7.8' }, socket: { remoteAddress: REAL } })).toBe(REAL)
  })
})

describe('the forms an address arrives in', () => {
  it.each([
    { raw: '203.0.113.9', want: '203.0.113.9' },
    { raw: ' 203.0.113.9 ', want: '203.0.113.9' },
    { raw: '203.0.113.9:51234', want: '203.0.113.9' },
    { raw: '::ffff:203.0.113.9', want: '203.0.113.9' },
    { raw: '2001:DB8::1', want: '2001:db8::1' },
    { raw: '[2001:db8::1]', want: '2001:db8::1' },
    { raw: '[2001:db8::1]:443', want: '2001:db8::1' },
    { raw: 'unknown', want: null },
    { raw: '', want: null },
    { raw: '999.1.1.1', want: null },
  ])('$raw', ({ raw, want }) => {
    expect(normaliseAddress(raw)).toBe(want)
  })

  it('reads every value of a repeated header', () => {
    expect(resolveClientIp({ forwardedFor: ['1.2.3.4', REAL] })).toBe(REAL)
  })

  it('has no answer when nothing names an address', () => {
    expect(resolveClientIp({})).toBeNull()
    expect(clientIp(fetchRequest({}))).toBe('unknown')
  })
})

describe('one authority for the client address', () => {
  // Every reader used to parse the header itself, and every one took the first
  // entry. A new one that does the same reopens the bypass for its surface.
  const ROOTS = ['app', 'lib', 'server', 'middleware.ts']
  // The resolver, and the runtime's forwarder, which APPENDS its peer to the
  // header as a proxy must.
  const ALLOWED = new Set([
    path.join('lib', 'security', 'client-ip.ts'),
    path.join('server', 'routes', 'next-proxy.ts'),
  ])

  function sources(entry: string): string[] {
    if (!fs.existsSync(entry)) return []
    if (fs.statSync(entry).isFile()) return /\.(ts|tsx)$/.test(entry) ? [entry] : []
    return fs.readdirSync(entry).flatMap(name =>
      name === 'node_modules' ? [] : sources(path.join(entry, name)),
    )
  }

  it('reads X-Forwarded-For and X-Real-IP only in lib/security/client-ip.ts', () => {
    const readers = ROOTS.flatMap(sources).filter(file => {
      if (ALLOWED.has(path.normalize(file))) return false
      return /['"`]x-(forwarded-for|real-ip)['"`]/i.test(fs.readFileSync(file, 'utf8'))
    })
    expect(readers).toEqual([])
  })
})
