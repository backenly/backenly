/**
 * OUTBOUND EGRESS GUARD — the network boundary for customer-authored code
 * =======================================================================
 *
 * Every other sandbox control in `lib/services/ai-functions/executor.ts` bounds
 * what generated code can do *inside* the process: a separate V8 isolate, no
 * `process.env`, static pattern analysis, a 64 MB heap cap, a hard timeout.
 * None of them bounds where it can send a packet.
 *
 * `ctx.http.get(url)` and `ctx.http.post(url, body)` are proxied from the worker
 * back to the PARENT and were executed as a bare `fetch(url)`. The parent is not
 * sandboxed. So the reachable set was: the cloud metadata endpoint
 * (169.254.169.254), anything else on the VPC, the loopback interface — the
 * PostgREST admin port on 3002, the runtime on 3001 — and every internal service
 * that trusts network position instead of a credential.
 *
 * "Fargate does not serve IMDSv1" is not a mitigation. It answers one address on
 * one platform and says nothing about loopback, the VPC, a self-hosted box, or
 * the next platform this runs on. The boundary has to be the code.
 *
 * ── The three failures this module is built around ──────────────────────────
 *
 *  1. **DNS rebinding.** Validating a hostname and then calling `fetch` is a
 *     time-of-check/time-of-use bug: the name resolves to a public address for
 *     the check and to 169.254.169.254 for the connection. Attacker-controlled
 *     DNS with a 0-second TTL makes that a reliable technique, not a race.
 *     So validation happens in the `lookup` callback the socket itself uses,
 *     and the address handed back is one this module just checked. There is no
 *     window between the check and the connect because they are the same act.
 *
 *  2. **Redirects.** `fetch` follows them silently. A public URL answering
 *     `302 Location: http://169.254.169.254/latest/meta-data/` defeats any
 *     check that only looked at the URL the caller passed. Redirects are
 *     therefore followed manually and every hop is re-validated.
 *
 *  3. **Credentials surviving a cross-origin redirect.** `Authorization` sent
 *     to `api.stripe.com` must not be replayed to whatever host `api.stripe.com`
 *     redirects to. Every browser and HTTP client learned this the hard way;
 *     `fetch`'s redirect following does strip it, and a hand-rolled loop that
 *     forgets to is strictly worse than the thing it replaced.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────
 *
 * It is not an allowlist. Customer functions legitimately call arbitrary public
 * APIs, and an allowlist of the public internet is not a control. It denies the
 * addresses that are dangerous *because of where this code runs* — private,
 * loopback, link-local, and the reserved ranges — and permits the rest.
 *
 * Read-only with respect to the platform: it opens sockets and returns bytes.
 */

import * as dns from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import { URL } from 'node:url'

/** Raised for any destination this module refuses to contact. */
export class BlockedOutboundError extends Error {
  readonly code = 'BLOCKED_OUTBOUND'
  constructor(message: string) {
    super(message)
    this.name = 'BlockedOutboundError'
  }
}

// ── Address classification ────────────────────────────────────────────────────

/**
 * IPv4 ranges that must never be reachable from customer code.
 *
 * 169.254.0.0/16 is the one that matters most — it carries the cloud metadata
 * service on every major provider, and a credential read from there is a
 * credential for the whole account, not for one tenant. The rest are here
 * because "internal" is a property of the address, not of the intent: 10/8 and
 * 172.16/12 are the VPC, 127/8 is every loopback-bound admin port this box runs,
 * and the reserved/benchmark ranges are blocked because there is no legitimate
 * reason for a customer function to reach them and unblocking them later is
 * cheaper than explaining an incident.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud metadata)'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation (TEST-NET-1)'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation (TEST-NET-2)'],
  ['203.0.113.0', 24, 'documentation (TEST-NET-3)'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
]

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    // Reject anything that is not a plain decimal octet. `010` and `0x7f` are
    // accepted by some parsers as 8 and 127 respectively, and a validator that
    // disagrees with the resolver about what an address means is not a
    // validator. Node's net.isIP already rejects these, but this function is
    // also reachable from the URL-literal path, so it re-checks.
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

function inV4Cidr(ip: number, base: string, bits: number): boolean {
  const b = v4ToInt(base)
  if (b === null) return false
  // A /0 would shift by 32, which is a no-op in JS and would match nothing.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ip & mask) === (b & mask)
}

/**
 * Expand an IPv6 address to its eight 16-bit groups.
 * Returns null for anything not parseable, which callers treat as blocked.
 */
function v6Groups(ip: string): number[] | null {
  let s = ip.trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  // Drop a zone index (fe80::1%eth0) before parsing.
  const pct = s.indexOf('%')
  if (pct !== -1) s = s.slice(0, pct)

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4m) {
    const n = v4ToInt(v4m[1])
    if (n === null) return null
    const hi = (n >>> 16) & 0xffff
    const lo = n & 0xffff
    s = s.slice(0, v4m.index) + hi.toString(16) + ':' + lo.toString(16)
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) =>
    part === '' ? [] : part.split(':').map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))

  const head = parse(halves[0] ?? '')
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : []
  if ([...head, ...tail].some(Number.isNaN)) return null

  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    return [...head, ...Array(fill).fill(0), ...tail]
  }
  return head.length === 8 ? head : null
}

/**
 * Why this address must not be contacted, or null if it is fine.
 *
 * Exported because the tests assert range-by-range, and because a future
 * caller that needs to classify an address without making a request should use
 * this rather than growing a second copy of the table.
 */
export function blockedAddressReason(address: string): string | null {
  const fam = net.isIP(address)

  if (fam === 4) {
    const n = v4ToInt(address)
    if (n === null) return 'unparseable IPv4 address'
    for (const [base, bits, why] of BLOCKED_V4) {
      if (inV4Cidr(n, base, bits)) return `${why} address (${address})`
    }
    return null
  }

  if (fam === 6) {
    const g = v6Groups(address)
    if (!g) return 'unparseable IPv6 address'

    // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) carry a real IPv4
    // destination. Checking the v6 form alone would miss ::ffff:169.254.169.254
    // entirely, which is the whole point of the encoding for an attacker.
    const isMapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff
    const isNat64 = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0
    if (isMapped || isNat64) {
      const v4 = [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff].join('.')
      const reason = blockedAddressReason(v4)
      return reason ? `${reason} via IPv6-embedded IPv4` : null
    }

    if (g.every(x => x === 0)) return `unspecified address (${address})`
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return `loopback address (${address})`
    if ((g[0] & 0xfe00) === 0xfc00) return `unique-local address (${address})`
    if ((g[0] & 0xffc0) === 0xfe80) return `link-local address (${address})`
    if ((g[0] & 0xff00) === 0xff00) return `multicast address (${address})`
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return `discard-only address (${address})`
    if (g[0] === 0x2001 && g[1] === 0x0db8) return `documentation address (${address})`
    return null
  }

  return `not an IP address (${address})`
}

/**
 * Escape hatch for self-hosted installs where the function runtime and the
 * service it calls genuinely share a host.
 *
 * Off by default and deliberately awkward to turn on. On Backenly Cloud this
 * must never be set: the private ranges it unblocks are other tenants' traffic
 * and the platform's own control plane.
 */
function privateEgressAllowed(): boolean {
  return process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE === 'true'
}

/**
 * Ranges the escape hatch does NOT unblock.
 *
 * A self-hoster setting `ALLOW_PRIVATE` is saying "my functions may call my own
 * services on this box or this LAN". They are not saying "my functions may read
 * the cloud metadata service", and no deployment has a legitimate reason to let
 * customer code do that — a self-hosted install on EC2 has an IMDS endpoint too,
 * and its credentials are the whole account's.
 *
 * This mattered immediately: the first version applied the hatch uniformly, so
 * a redirect chain starting at an allowed private host and ending at
 * 169.254.169.254 was followed. The hatch has to be about the developer's
 * intended destination, never about a `Location` header an attacker controls.
 */
function alwaysBlocked(address: string): string | null {
  const fam = net.isIP(address)
  if (fam === 4) {
    const n = v4ToInt(address)
    if (n !== null && inV4Cidr(n, '169.254.0.0', 16)) {
      return `link-local (cloud metadata) address (${address})`
    }
    return null
  }
  if (fam === 6) {
    const g = v6Groups(address)
    if (!g) return null
    const isMapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff
    const isNat64 = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0
    if (isMapped || isNat64) {
      const v4 = [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff].join('.')
      const r = alwaysBlocked(v4)
      return r ? `${r} via IPv6-embedded IPv4` : null
    }
    // fe80::/10 is the IPv6 link-local range; IMDS is reachable there too.
    if ((g[0] & 0xffc0) === 0xfe80) return `link-local address (${address})`
  }
  return null
}

// ── URL validation ────────────────────────────────────────────────────────────

/**
 * Parse and statically validate a destination URL.
 *
 * This catches the cheap cases — a `file://` scheme, an embedded credential, a
 * literal private address. It is NOT sufficient on its own: a hostname that
 * resolves to a private address passes here and is caught at connect time by
 * `guardedLookup`. Both layers are required and neither is redundant.
 */
export function assertAllowedUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedOutboundError(`Not a valid absolute URL: ${String(raw).slice(0, 200)}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedOutboundError(
      `Only http:// and https:// are allowed (got ${url.protocol}). ` +
        'file:, gopher:, data: and similar schemes are never reachable from function code.',
    )
  }

  // `https://user:pass@host/` is how a request gets a credential attached
  // without the caller noticing, and how some parsers are confused about which
  // part is the host. Neither is a thing customer functions need.
  if (url.username || url.password) {
    throw new BlockedOutboundError('Credentials embedded in the URL are not allowed.')
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) {
    const reason = addressRefusal(host)
    if (reason) throw new BlockedOutboundError(`Refusing to contact ${reason}.`)
  }

  return url
}

/**
 * The single decision point: why this address is refused, or null.
 *
 * Both the URL-literal path and the connect-time lookup route through here so
 * the two layers cannot drift into disagreeing about what is reachable.
 */
function addressRefusal(address: string): string | null {
  const hard = alwaysBlocked(address)
  if (hard) return hard
  if (privateEgressAllowed()) return null
  return blockedAddressReason(address)
}

// ── Connect-time validation ───────────────────────────────────────────────────

/**
 * A `lookup` implementation for net.connect that refuses to hand back an
 * address this module would not allow.
 *
 * This is the load-bearing half of the guard. The socket connects to exactly
 * the address validated here, so there is no interval during which DNS can
 * change the answer.
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | number,
  callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void,
): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)

    const list = (Array.isArray(addresses) ? addresses : [addresses]) as dns.LookupAddress[]
    if (list.length === 0) {
      return callback(new BlockedOutboundError(`${hostname} did not resolve.`) as any, '', 0)
    }

    // EVERY resolved address must be acceptable, not merely the first. A name
    // that answers with one public and one link-local address would otherwise
    // be reachable on a retry, an IPv6 preference flip, or a second connection.
    for (const a of list) {
      const reason = addressRefusal(a.address)
      if (reason) {
        return callback(
          new BlockedOutboundError(`${hostname} resolves to a ${reason}.`) as any,
          '',
          0,
        )
      }
    }

    const wantsAll = typeof options === 'object' && options !== null && (options as dns.LookupAllOptions).all
    if (wantsAll) return callback(null, list as any)
    callback(null, list[0].address, list[0].family)
  })
}

// ── The guarded request ───────────────────────────────────────────────────────

export interface SafeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Total budget across every redirect hop. */
  timeoutMs?: number
  /** Bytes after which the response is abandoned. */
  maxBytes?: number
  maxRedirects?: number
}

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3

/** Headers that must not survive a redirect to a different origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

function oneRequest(
  url: URL,
  opts: Required<Pick<SafeFetchOptions, 'method' | 'headers' | 'maxBytes'>> & {
    body?: string
    deadline: number
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const remaining = opts.deadline - Date.now()
    if (remaining <= 0) return reject(new BlockedOutboundError('Outbound request timed out.'))

    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: opts.headers,
        lookup: guardedLookup as any,
        timeout: remaining,
      },
      res => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (c: Buffer) => {
          total += c.length
          if (total > opts.maxBytes) {
            res.destroy()
            reject(new BlockedOutboundError(`Response exceeded ${opts.maxBytes} bytes.`))
            return
          }
          chunks.push(c)
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        )
        res.on('error', reject)
      },
    )

    req.on('timeout', () => {
      req.destroy(new BlockedOutboundError('Outbound request timed out.'))
    })
    req.on('error', err => reject(err))
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

/**
 * The subset of `Response` that every call site actually uses.
 *
 * ── Why this is not the global `Response` ───────────────────────────────────
 *
 * Returning the ambient `Response` makes this module's contract depend on
 * whatever the runtime happens to define, and those differ: `jest.setup.js`
 * replaces `global.Response` with a stub that has no `text()` at all and whose
 * `json()` is `JSON.parse(this.body)`. A guard that works in production and
 * throws in tests — or worse, passes in one test file and fails when the same
 * file runs alongside another — is a guard nobody will trust or keep.
 *
 * So the shape is declared here and constructed here. Deterministic in every
 * environment, and the call sites still read `res.ok` / `res.status` /
 * `res.text()` / `res.json()` exactly as they did with `fetch`.
 */
export interface SafeResponse {
  ok: boolean
  status: number
  headers: Map<string, string>
  text(): Promise<string>
  json(): Promise<any>
  arrayBuffer(): Promise<ArrayBuffer>
}

function toSafeResponse(
  status: number,
  rawHeaders: http.IncomingHttpHeaders,
  body: Buffer,
): SafeResponse {
  const headers = new Map<string, string>()
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === undefined) continue
    headers.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v))
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    async text() {
      return body.toString('utf8')
    },
    async json() {
      return JSON.parse(body.toString('utf8'))
    },
    async arrayBuffer() {
      const out = new ArrayBuffer(body.byteLength)
      new Uint8Array(out).set(body)
      return out
    },
  }
}

/**
 * Make an outbound HTTP request on behalf of customer code.
 *
 * Swapping `fetch` for `safeFetch` is a one-word edit at every call site, which
 * is the only way a guard like this gets adopted everywhere instead of on the
 * two paths someone remembered.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const deadline = Date.now() + timeoutMs

  let url = assertAllowedUrl(rawUrl)
  let method = (options.method ?? 'GET').toUpperCase()
  let body = options.body
  let headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (body !== undefined && headers['content-length'] === undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(body))
  }

  for (let hop = 0; ; hop++) {
    const res = await oneRequest(url, { method, headers, body, maxBytes, deadline })

    const location = res.headers.location
    const isRedirect = res.status >= 300 && res.status < 400 && typeof location === 'string'
    if (!isRedirect) return toSafeResponse(res.status, res.headers, res.body)

    if (hop >= maxRedirects) {
      throw new BlockedOutboundError(`Too many redirects (limit ${maxRedirects}).`)
    }

    const next = assertAllowedUrl(new URL(location, url).toString())

    // Cross-origin: drop anything that authenticates the caller. Without this
    // the guard would turn one redirect into a credential disclosure, which is
    // a worse bug than the SSRF it was written to stop.
    if (next.origin !== url.origin) {
      headers = Object.fromEntries(
        Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.includes(k.toLowerCase())),
      )
    }

    // 303, and 301/302 on a POST, become a bodyless GET — the behaviour every
    // HTTP client converged on.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
      delete headers['Content-Length']
      delete headers['content-length']
    }

    url = next
  }
}
