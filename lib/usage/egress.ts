/**
 * Egress measured inside Backenly's own servers (`source: 'app'`).
 *
 * Counts the bytes of response BODIES a project's API sends: everything under
 * /api/v1/{project} and /api/v2/{project}, including the responses the runtime
 * serves behind Next (lib/runtime/forward-to-runtime.ts streams them back
 * through recordedV1), realtime event streams, and file downloads served by the
 * app. Each byte is counted exactly once, by the process at the edge:
 *
 *   AWS / compose  Next is the edge. The runtime sees every request with the
 *                  internal-traffic marker the forwarder adds, and skips it.
 *   single box     Express is the edge (nginx sends /api/v1 to it). Requests it
 *                  hands to Next carry the same marker in the other direction.
 *
 * What this is NOT: bytes on the wire. It is measured before HTTP compression
 * and excludes response headers, so for compressible JSON it can overstate
 * what the network carried. That is why Cloud bills app-path egress from
 * load balancer access logs (`alb`) instead, and the monthly close refuses to
 * bill `app` and `alb` together (lib/usage/close.ts). A self-hosted install
 * has only this number, and it is a truthful upper bound.
 *
 * Backenly's own synthetic requests (INTERNAL_TRAFFIC_HEADER) are never counted.
 */
import { recordUsage } from '@/lib/usage/ledger'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function recordEgress(projectId: string, bytes: number, billingAccountId?: string | null): void {
  if (bytes > 0) recordUsage({ projectId, axis: 'egress_bytes', quantity: bytes, source: 'app', billingAccountId })
}

function nodeChunkBytes(chunk: unknown, encoding: unknown): number {
  if (chunk == null || typeof chunk === 'function') return 0
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
  if (chunk instanceof Uint8Array) return chunk.byteLength
  return 0
}

/**
 * Meter a Node/Express response: every chunk passed to write() and end() is
 * counted as it is written. For the single-box layout, where Express is the
 * edge; see the file header for why the two processes never both count.
 */
export function meterNodeResponse(
  res: { write: (...args: any[]) => any; end: (...args: any[]) => any },
  projectId: string,
): void {
  if (!UUID_RE.test(projectId)) return
  const write = res.write
  const end = res.end
  res.write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
    recordEgress(projectId, nodeChunkBytes(chunk, rest[0]))
    return write.call(this, chunk, ...rest)
  }
  res.end = function (this: unknown, chunk?: unknown, ...rest: unknown[]) {
    recordEgress(projectId, nodeChunkBytes(chunk, rest[0]))
    return end.call(this, chunk, ...rest)
  }
}

/**
 * Return the same response with its body counted as it streams. Recorded per
 * chunk, so a long-lived realtime stream is metered as it flows and an aborted
 * stream still counts what was actually sent. Status and headers (including
 * Content-Length and Set-Cookie) pass through untouched.
 */
let warnedUnpipeable = false

export function meterResponseBody<T extends Response>(response: T, projectId: string): T {
  if (!response.body || !UUID_RE.test(projectId)) return response
  if (typeof (response.body as { pipeThrough?: unknown }).pipeThrough !== 'function') {
    // Never true of Node's own Response. Metering must not break a response,
    // but a body it cannot see is said out loud, once, not skipped silently.
    if (!warnedUnpipeable) {
      warnedUnpipeable = true
      console.warn('[UsageEgress] a response body cannot be piped; its bytes are not metered')
    }
    return response
  }
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      recordEgress(projectId, chunk.byteLength)
      controller.enqueue(chunk)
    },
  })
  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }) as T
}
