/**
 * Express → Next.js reverse proxy for v1 surfaces that live in the Next app.
 *
 * nginx sends ALL /api/v1/* traffic to this Express runtime. Routes that only
 * exist as Next.js handlers (app/api/v1/[projectId]/…) were therefore
 * unreachable in production — the dynamic catch-all intercepted them and
 * treated the first path segment as a table name (e.g. POST /storage/upload
 * became a CRUD lookup for a table called "storage").
 *
 * Rather than hand-porting every handler (and re-creating the drift that
 * caused the outage), we forward the raw request to the Next server on the
 * same box. Every proxied Next route performs its own auth via
 * v1ApiMiddleware (x-api-key / Bearer), plus permission, capability and quota
 * checks — nothing is bypassed by the hop.
 *
 * MUST be mounted BEFORE express.json()/urlencoded() so multipart uploads and
 * large bodies stream through untouched, and BEFORE the dynamic catch-all.
 */

import http from 'http'
import https from 'https'
import type { Request, Response, NextFunction } from 'express'

// v1 sections owned by Next.js. Everything else (auth, oauth, database, db
// CRUD, realtime, presence, broadcast, triggers, logs, bootstrap, fn) is
// served natively by this Express runtime and must NOT be forwarded.
const NEXT_OWNED_SECTIONS = new Set([
  'storage',
  'orgs',
  'stats',
  'cart',
  'checkout',
  'stripe',
  'ai',
  'telemetry',
  'healthz',
  'functions',
  // Inbound integration webhooks (Stripe/Resend/Twilio → on_webhook functions).
  // The receiver validates provider signatures against the RAW body, which is
  // exactly why this proxy streams before any body parsing.
  'webhooks',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Hop-by-hop headers must not be blindly copied between hops (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function nextOrigin(): URL {
  // Next.js listens on PORT (3000 in prod via PM2, `next dev` default locally).
  const raw = process.env.NEXT_INTERNAL_ORIGIN || 'http://127.0.0.1:3000'
  return new URL(raw)
}

/**
 * Returns true when the request path is a v1 route that only exists in the
 * Next app: /:projectId/{section}/… or /:projectId/db/:table/vector-search.
 */
function isNextOwnedPath(segments: string[]): boolean {
  if (segments.length === 0 || !UUID_RE.test(segments[0])) return false
  // Bare GET /api/v1/:projectId — the friendly project API info page lives in
  // Next only. Without this, the dynamic catch-all misreads the UUID as a
  // table name and returns an auth error instead of the info document.
  if (segments.length === 1) return true
  const section = segments[1].toLowerCase()
  if (NEXT_OWNED_SECTIONS.has(section)) return true
  // Vector search hangs off the db CRUD prefix but has no Express handler.
  if (section === 'db' && segments[3]?.toLowerCase() === 'vector-search') return true
  return false
}

export function nextProxy(req: Request, res: Response, next: NextFunction) {
  // req.path here is relative to the mount point (/api/v1).
  const segments = req.path.split('/').filter(Boolean)
  if (!isNextOwnedPath(segments)) return next()

  const origin = nextOrigin()
  const isTls = origin.protocol === 'https:'

  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key)) continue
    headers[key] = value
  }
  headers['host'] = origin.host
  const remote = req.socket.remoteAddress ?? ''
  const priorFwd = req.headers['x-forwarded-for']
  headers['x-forwarded-for'] = priorFwd ? `${priorFwd}, ${remote}` : remote
  headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string) || req.protocol

  const upstream = (isTls ? https : http).request(
    {
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port || (isTls ? 443 : 80),
      method: req.method,
      // originalUrl preserves the full /api/v1/… path and query string.
      path: req.originalUrl,
      headers,
      // Generous ceiling — /storage/upload accepts large files.
      timeout: 120_000,
    },
    (proxied) => {
      const outHeaders: Record<string, string | string[]> = {}
      for (const [key, value] of Object.entries(proxied.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key)) continue
        outHeaders[key] = value
      }
      res.writeHead(proxied.statusCode ?? 502, outHeaders)
      proxied.pipe(res)
    },
  )

  upstream.on('timeout', () => {
    upstream.destroy(new Error('Upstream timeout'))
  })

  upstream.on('error', (err) => {
    console.error(`[Next Proxy] ${req.method} ${req.originalUrl} failed:`, err.message)
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Upstream service unavailable',
        code: 'UPSTREAM_UNAVAILABLE',
      })
    } else {
      res.destroy()
    }
  })

  // Abort the upstream request if the client disconnects mid-transfer.
  res.on('close', () => {
    if (!upstream.destroyed) upstream.destroy()
  })

  // Body parsers are mounted AFTER this middleware, so the request stream is
  // untouched — multipart uploads pipe straight through.
  req.pipe(upstream)
}
