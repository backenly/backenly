/**
 * WHO IS ON THE OTHER END OF THIS REQUEST
 * =======================================
 *
 * Every per-address control (the auth rate limits, the account lockout, the
 * blocklist, the security events) needs the client's address, and every one of
 * them used to read it as the FIRST entry of X-Forwarded-For.
 *
 * ── The first entry is the one the client wrote ─────────────────────────────
 *
 * A proxy appends what it sees to X-Forwarded-For; it does not replace what the
 * client sent. The AWS load balancer does exactly that, so a request arriving
 * with `X-Forwarded-For: 1.2.3.4` reaches the app as `1.2.3.4, <real address>`.
 * Reading the first entry read the attacker's chosen value, so a new made-up
 * address per request was a fresh budget per request: every per-IP limit on
 * the platform was bypassable with one header.
 *
 * ── Walk from the right, skip what we trust ─────────────────────────────────
 *
 * The entries a proxy we run appended are on the RIGHT, and the client's own
 * claims on the left. So the address is the rightmost one that is not a proxy
 * we trust, which is Rails' ActionDispatch::RemoteIp rule:
 *
 *   - the chain is the X-Forwarded-For entries in order, then the socket peer
 *     when the runtime can see one (Express can, a Next route handler cannot);
 *   - walking from the right, trusted proxies are skipped and the first other
 *     address is the client;
 *   - if every entry is trusted, the client is on a private network itself and
 *     the leftmost is the best answer there is.
 *
 * Trusted by default: loopback, link-local and the private ranges (RFC 1918,
 * IPv6 unique-local). That covers every hop Backenly runs: on AWS the load
 * balancer reaches the web task, and the web task the runtime, over VPC
 * addresses; on a single box nginx reaches both over loopback. A deployment
 * with a public proxy in front (Cloudflare, a CDN) adds its ranges in
 * BACKENLY_TRUSTED_PROXIES, comma-separated addresses or CIDRs, or every client
 * would appear as that proxy.
 *
 * X-Real-IP is read only when there is no X-Forwarded-For, and as the
 * leftmost link of the same chain, so a client that sends it straight to an
 * Express runtime it can reach directly is overruled by the socket.
 *
 * ── What no header can fix ──────────────────────────────────────────────────
 *
 * With nothing in front of Next, a route handler has no socket to check a
 * header against, so whatever the client sends is all there is. Both
 * deployment shapes Backenly supports put a proxy in front (the AWS load
 * balancer; the reverse proxy the self-hosting guide requires), and that proxy
 * is what makes this trustworthy.
 */

import { BlockList, isIP } from 'net'

const DEFAULT_TRUSTED: ReadonlyArray<[string, number, 'ipv4' | 'ipv6']> = [
  ['127.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
]

export class TrustedProxiesMisconfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrustedProxiesMisconfigured'
  }
}

let cached: { raw: string; list: BlockList } | null = null

/**
 * The trusted set: the defaults plus BACKENLY_TRUSTED_PROXIES. An entry that
 * does not parse throws rather than being skipped: a typo there means real
 * clients appear as the proxy, and that should fail loudly, not quietly
 * share one budget between all of them.
 */
function trustedProxies(env: NodeJS.ProcessEnv): BlockList {
  const raw = env.BACKENLY_TRUSTED_PROXIES?.trim() ?? ''
  if (cached && cached.raw === raw) return cached.list

  const list = new BlockList()
  for (const [address, prefix, type] of DEFAULT_TRUSTED) list.addSubnet(address, prefix, type)
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const [address, prefixText] = entry.split('/')
    const family = isIP(address)
    const prefix = prefixText === undefined ? (family === 6 ? 128 : 32) : Number(prefixText)
    const max = family === 6 ? 128 : 32
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new TrustedProxiesMisconfigured(
        `BACKENLY_TRUSTED_PROXIES has an entry that is not an address or CIDR: ${JSON.stringify(entry)}`,
      )
    }
    list.addSubnet(address, prefix, family === 6 ? 'ipv6' : 'ipv4')
  }
  cached = { raw, list }
  return list
}

/**
 * One header entry as a bare address, or null when it is not one. Strips the
 * forms proxies actually emit around an address: an IPv4 port, a bracketed
 * IPv6 with or without a port, and the IPv4-mapped IPv6 prefix Node puts on
 * socket addresses, so the same client is one key however it arrived.
 */
export function normaliseAddress(value: string | null | undefined): string | null {
  let v = String(value ?? '').trim()
  if (!v) return null
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v)
  if (bracketed) v = bracketed[1]
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'))
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v)
  if (mapped) v = mapped[1]
  return isIP(v) ? v.toLowerCase() : null
}

/**
 * Parse BACKENLY_TRUSTED_PROXIES now, so a bad entry stops the process at boot
 * instead of failing every request that needs a client address.
 */
export function assertTrustedProxiesParse(env: NodeJS.ProcessEnv = process.env): void {
  trustedProxies(env)
}

function headerValues(value: string | string[] | null | undefined): string[] {
  if (value == null) return []
  return (Array.isArray(value) ? value : [value]).flatMap(v => v.split(','))
}

export interface ClientAddressSources {
  /** Every X-Forwarded-For value, as the framework hands it over. */
  forwardedFor?: string | string[] | null
  /** X-Real-IP, consulted only when there is no X-Forwarded-For. */
  realIp?: string | string[] | null
  /** The TCP peer, when the runtime exposes it. */
  socketAddress?: string | null
}

/** The client's address, or null when nothing names one. */
export function resolveClientIp(
  sources: ClientAddressSources,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let chain = headerValues(sources.forwardedFor)
    .map(normaliseAddress)
    .filter((a): a is string => a !== null)
  if (chain.length === 0) {
    chain = headerValues(sources.realIp)
      .map(normaliseAddress)
      .filter((a): a is string => a !== null)
      .slice(0, 1)
  }
  const socket = normaliseAddress(sources.socketAddress)
  if (socket) chain.push(socket)
  if (chain.length === 0) return null

  const trusted = trustedProxies(env)
  for (let i = chain.length - 1; i >= 0; i--) {
    const address = chain[i]
    if (!trusted.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')) return address
  }
  return chain[0]
}

/** For a Fetch-style request (Next route handlers): headers only, no socket. */
export function clientIpFromHeaders(request: { headers: { get(name: string): string | null } }): string | null {
  return resolveClientIp({
    forwardedFor: request.headers.get('x-forwarded-for'),
    realIp: request.headers.get('x-real-ip'),
  })
}

/** For a Node request (the Express runtime): headers and the socket peer. */
export function clientIpFromNodeRequest(req: {
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | null } | null
}): string | null {
  return resolveClientIp({
    forwardedFor: req.headers['x-forwarded-for'],
    realIp: req.headers['x-real-ip'],
    socketAddress: req.socket?.remoteAddress ?? null,
  })
}
