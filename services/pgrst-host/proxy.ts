/**
 * Forwarding one request to a child on 127.0.0.1, streaming both ways.
 *
 * The request reaches PostgREST as the runtime sent it: method, path, query
 * string, headers (profile headers included) and body, with the same
 * Authorization header, which PostgREST verifies again with its own `aud`.
 * Only the connection-level (hop-by-hop) headers are the host's own. A request
 * that names any other header as hop-by-hop in `Connection` is refused, so a
 * caller cannot have this hop drop a header the child relies on. Status and
 * headers of the child's answer are passed back unchanged, apart from its
 * hop-by-hop headers.
 */

import http from 'http'
import { pipeline } from 'stream'

/** RFC 9110 7.6.1 connection-specific fields, plus the obsolete Proxy-Connection. */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Connection options a client may send; anything else in Connection names a header. */
const CONNECTION_OPTIONS: ReadonlySet<string> = new Set(['keep-alive', 'close'])

export const PROXIED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** Why a request's connection headers are refused, or null when they are fine. */
export function connectionRefusal(headers: http.IncomingHttpHeaders): string | null {
  if (headers.upgrade !== undefined) return 'Protocol upgrades are not served.'
  const connection = headers.connection
  if (connection === undefined) return null
  for (const token of String(connection).split(',')) {
    const name = token.trim().toLowerCase()
    if (!name) continue
    if (name === 'upgrade') return 'Protocol upgrades are not served.'
    if (!CONNECTION_OPTIONS.has(name)) return `Connection names "${name}" as hop-by-hop; only keep-alive and close are accepted.`
  }
  return null
}

/** The headers sent to the child. */
export function upstreamHeaders(
  incoming: http.IncomingHttpHeaders,
  opts: { port: number; token: string },
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) || key === 'host' || key === 'expect' || key === 'authorization') continue
    out[key] = value
  }
  out.host = `127.0.0.1:${opts.port}`
  // The token this host verified, exactly as received.
  out.authorization = `Bearer ${opts.token}`
  return out
}

/** The child's response headers, as a raw list, without its hop-by-hop headers. */
export function downstreamHeaders(rawHeaders: string[]): string[] {
  const listed = new Set<string>()
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== 'connection') continue
    for (const token of rawHeaders[i + 1].split(',')) listed.add(token.trim().toLowerCase())
  }
  const out: string[] = []
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i].toLowerCase()
    if (HOP_BY_HOP.has(key) || listed.has(key)) continue
    out.push(rawHeaders[i], rawHeaders[i + 1])
  }
  return out
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || res.destroyed) {
    res.destroy()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

export interface ForwardOptions {
  port: number
  /** Path and query string on the child, starting with '/'. */
  path: string
  token: string
  maxBodyBytes: number
  timeoutMs: number
  /** Called once, when the exchange is over however it ended. */
  release(): void
}

/** Forward `req` to the child and stream its answer into `res`. */
export function forward(req: http.IncomingMessage, res: http.ServerResponse, opts: ForwardOptions): void {
  let released = false
  const release = () => {
    if (released) return
    released = true
    opts.release()
  }
  res.once('close', release)

  // A new loopback connection per request: no idle socket to the child can be
  // closed under a request that is about to reuse it.
  const upstream = http.request({
    host: '127.0.0.1',
    port: opts.port,
    method: req.method,
    path: opts.path,
    headers: upstreamHeaders(req.headers, opts),
    agent: false,
  })

  let refused = false
  const refuse = (status: number, code: string, message: string) => {
    if (refused) return
    refused = true
    upstream.destroy()
    // The client may still be sending: answer, then close the connection.
    sendJson(res, status, { code, message }, { connection: 'close' })
  }

  let received = 0
  req.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > opts.maxBodyBytes) {
      req.unpipe(upstream)
      req.resume()
      refuse(413, 'BODY_TOO_LARGE', `The request body is larger than ${opts.maxBodyBytes} bytes.`)
    }
  })
  req.pipe(upstream)

  upstream.setTimeout(opts.timeoutMs, () => {
    refuse(504, 'UPSTREAM_TIMEOUT', 'The project database server did not answer in time.')
  })
  upstream.on('error', () => {
    refuse(502, 'UPSTREAM_UNAVAILABLE', 'The project database server closed the connection.')
  })
  upstream.on('response', (answer) => {
    if (refused || res.headersSent) {
      answer.resume()
      return
    }
    res.writeHead(answer.statusCode ?? 502, answer.statusMessage, downstreamHeaders(answer.rawHeaders))
    pipeline(answer, res, (err) => {
      if (err) res.destroy()
    })
  })

  // The caller went away: stop the child's work on its behalf.
  res.once('close', () => {
    if (!res.writableFinished) upstream.destroy()
  })
}
