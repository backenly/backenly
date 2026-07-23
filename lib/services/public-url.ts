/**
 * CANONICAL PUBLIC URL RESOLUTION
 * ───────────────────────────────
 * The single source of truth for "what URL can a *browser on the public
 * internet* use to reach this Backenly deployment?"
 *
 * Why this exists:
 *   In production Backenly runs as a Next.js standalone server bound to
 *   `0.0.0.0:3000` behind nginx. Inside a route handler, `req.nextUrl.origin`
 *   (and often the `Host` header) reflect that *internal* bind address, not
 *   the public `https://backenly.com`. Anything we hand to a remote browser
 *   built from `req.nextUrl.origin` (SDK CDN URLs, API base URLs) therefore
 *   points at `0.0.0.0:3000` — which no browser can reach.
 *
 *   This bit the Connect-Frontend manifest: the SDK module URL came back as
 *   `https://0.0.0.0:3000/backenly-sdk.esm.js` and every Lovable/Bolt/v0
 *   frontend failed with "Failed to fetch dynamically imported module".
 *
 * Resolution order (first reachable wins):
 *   1. NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_URL env — the operator's declared
 *      canonical origin. Authoritative when set to a real public URL.
 *   2. X-Forwarded-Proto + X-Forwarded-Host — what nginx says the public
 *      request actually arrived as.
 *   3. The `Host` header.
 *   4. req.nextUrl.origin.
 *   5. Hardcoded fallback: https://backenly.com in production,
 *      http://localhost:3000 in development.
 *
 * A candidate is *rejected* (treated as unreachable) when its hostname is a
 * bind-all / loopback address. In production, `localhost`/`127.0.0.1`/`::1`
 * are also rejected — a manifest served to a remote browser can never use
 * them — so a stale `NEXT_PUBLIC_APP_URL=http://localhost:3000` left on the
 * server can't poison the manifest.
 */

const PRODUCTION_CANONICAL = 'https://backenly.com'
const DEV_FALLBACK = 'http://localhost:3000'

function isProd(): boolean {
  return process.env.NODE_ENV === 'production'
}

/**
 * A hostname that a public browser can never reach. `0.0.0.0` and `::` are
 * bind-all addresses and are *always* invalid as a reachable host. Loopback
 * hosts are valid in local dev but never in a manifest served from prod.
 */
function isUnreachableHost(hostname: string): boolean {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '' || h === '0.0.0.0' || h === '::' || h === '0:0:0:0:0:0:0:0') return true
  if (isProd() && (h === 'localhost' || h === '127.0.0.1' || h === '::1')) return true
  return false
}

/**
 * Parse a candidate origin string into a normalized `https://host[:port]`
 * (no trailing slash, no path). Returns null if unparseable or unreachable.
 */
function normalizeCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null
  let value = raw.trim()
  if (!value) return null
  // Accept bare hosts ("backenly.com", "0.0.0.0:3000") by assuming a scheme.
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (isUnreachableHost(url.hostname)) return null
  return `${url.protocol}//${url.host}`
}

/**
 * Build a candidate from forwarded headers (X-Forwarded-Host + Proto). nginx
 * sets these to the public-facing values when configured with
 * `proxy_set_header X-Forwarded-Host $host;` etc.
 */
function fromForwardedHeaders(headers: Headers): string | null {
  const fwdHost = headers.get('x-forwarded-host')
  if (!fwdHost) return null
  // X-Forwarded-Host may be a comma-separated list (closest proxy last/first
  // depending on config) — take the first entry.
  const host = fwdHost.split(',')[0]?.trim()
  if (!host) return null
  const proto = (headers.get('x-forwarded-proto')?.split(',')[0]?.trim()) || 'https'
  return normalizeCandidate(`${proto}://${host}`)
}

export interface RequestLike {
  headers: Headers
  nextUrl?: { origin?: string }
  url?: string
}

/**
 * Resolve the canonical public base origin (scheme + host, no trailing slash)
 * for a deployment, given the incoming request.
 */
export function resolvePublicBaseUrl(req: RequestLike): string {
  // 1. Operator-declared canonical origin.
  const envCandidate =
    normalizeCandidate(process.env.NEXT_PUBLIC_APP_URL) ||
    normalizeCandidate(process.env.NEXT_PUBLIC_URL)
  if (envCandidate) return envCandidate

  // 2. Forwarded headers from the reverse proxy.
  const fwd = fromForwardedHeaders(req.headers)
  if (fwd) return fwd

  // 3. The Host header.
  const hostCandidate = normalizeCandidate(req.headers.get('host'))
  if (hostCandidate) return hostCandidate

  // 4. The framework-derived origin.
  let originCandidate: string | null = null
  if (req.nextUrl?.origin) {
    originCandidate = normalizeCandidate(req.nextUrl.origin)
  } else if (req.url) {
    try {
      originCandidate = normalizeCandidate(new URL(req.url).origin)
    } catch {
      originCandidate = null
    }
  }
  if (originCandidate) return originCandidate

  // 5. Hardcoded fallback by environment.
  return isProd() ? PRODUCTION_CANONICAL : DEV_FALLBACK
}
