/**
 * HTTP client for backenly.com.
 *
 * Uses native `fetch` (Node 18+). Adds `x-api-key` + `x-correlation-id` on
 * every request. Retries idempotent failures (HTTP 5xx, network) with
 * exponential backoff. Surfaces typed errors so the MCP host can show them
 * usefully to the LLM.
 *
 * Retry strategy:
 *   - GET requests retry on network errors and any 5xx.
 *   - POST requests retry only on 502 / 503 / 504 (the gateway / overload
 *     responses), NOT on 5xx-with-body — those probably did partial work
 *     and replaying would double-execute.
 *   - 3 attempts max, 250ms / 1s / 3s delays (with jitter).
 */

import { randomUUID } from 'crypto'
import type { Config } from './config.js'

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [250, 1_000, 3_000]
const RETRY_STATUSES_POST = new Set([502, 503, 504])

/**
 * A failed request to backenly.com. Carries the HTTP `status` (undefined for a
 * network-layer failure) so callers can branch WITHOUT parsing the message —
 * the boot path needs to tell a definitively-wrong key (401/403, fatal) from a
 * transient outage (retry / degrade), and prose is the wrong thing to switch on.
 */
export class BackenlyHttpError extends Error {
  /** HTTP status, or undefined when the request never reached a response (DNS, TLS, reset). */
  readonly status?: number
  /** Machine code from the JSON body (`{ code }`), when the server sent one. */
  readonly code?: string
  /**
   * What the server managed to do before it failed — `partialEvents` from a
   * brain run, or any other diagnostic the body carried.
   *
   * This used to be dropped on the floor. The server sends a full account of a
   * failed brain run (which tools ran, which failed, how far it got) and the
   * client reduced the whole thing to one sentence, so an agent debugging a
   * failure had strictly less information than the server had already given it.
   */
  readonly detail?: unknown

  constructor(message: string, opts: { status?: number; code?: string; detail?: unknown } = {}) {
    super(message)
    this.name = 'BackenlyHttpError'
    this.status = opts.status
    this.code = opts.code
    this.detail = opts.detail
  }

  /** True when the server authenticated us and said no — a bad or wrong-scope key. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403
  }
}

export class BackenlyClient {
  constructor(private cfg: Config) {}

  private async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.cfg.endpoint}${path}`
    const correlationId = randomUUID()

    let lastError: Error | null = null

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const init: RequestInit = {
        method,
        headers: {
          'x-api-key': this.cfg.apiKey,
          'x-correlation-id': correlationId,
          'content-type': 'application/json',
          'user-agent': `@backenly/mcp-server (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }

      let response: Response
      try {
        response = await fetch(url, init)
      } catch (err) {
        // Network-layer error — retryable. No status: the request never got a
        // response, so callers must treat this as transient, not auth-fatal.
        lastError = new BackenlyHttpError(
          `Could not reach Backenly at ${this.cfg.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
          { code: 'NETWORK' },
        )
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(jitter(RETRY_DELAYS_MS[attempt]))
          continue
        }
        throw lastError
      }

      const text = await response.text()
      let parsed: any = null
      try { parsed = text ? JSON.parse(text) : null } catch { /* keep parsed=null */ }

      if (response.ok) {
        return (parsed ?? {}) as T
      }

      // Decide whether to retry. GET → any 5xx is fair game. POST → only the
      // gateway-flavor 5xx, never a 500-from-app since the request may have
      // mutated state already.
      const retryable =
        attempt < MAX_ATTEMPTS - 1 &&
        ((method === 'GET' && response.status >= 500 && response.status < 600) ||
          (method === 'POST' && RETRY_STATUSES_POST.has(response.status)))

      // `summary` is read too. The tool endpoint used to report a failure's
      // reason ONLY in `summary`, so reading just error/message produced
      // "HTTP 400 from /api/mcp/tool (TOOL_ERROR)" while the actual reason sat
      // unread in the same body. Both ends are fixed; this half also protects
      // against any future handler that picks a different field.
      const errorMsg = (parsed && (parsed.error || parsed.message || parsed.summary)) ||
        `HTTP ${response.status} from ${path}`
      const codeSuffix = parsed?.code ? ` (${parsed.code})` : ''
      // Carry the server's own account of the failure through instead of
      // reducing it to one sentence — see BackenlyHttpError.detail.
      const trail = parsed?.partialEvents ?? parsed?.events ?? parsed?.applied ?? null
      lastError = new BackenlyHttpError(`${errorMsg}${codeSuffix}`, {
        status: response.status,
        code: typeof parsed?.code === 'string' ? parsed.code : undefined,
        detail: Array.isArray(trail) && trail.length > 0 ? trail.slice(-25) : undefined,
      })

      if (retryable) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
        const delay = retryAfter ?? jitter(RETRY_DELAYS_MS[attempt])
        await sleep(delay)
        continue
      }

      throw lastError
    }

    throw lastError ?? new Error('Request failed after retries.')
  }

  // ── Endpoints ────────────────────────────────────────────────────────────
  health() {
    return this.request<{ ok: boolean; projectId: string; project: { id: string; name: string } | null; toolCount: number }>(
      'GET',
      '/api/mcp/health',
    )
  }

  manifest() {
    return this.request<{
      ok: boolean
      server: { name: string; version: string; projectId: string }
      tools: Array<{ name: string; tier: string; description: string; inputSchema: any }>
    }>('GET', '/api/mcp/manifest')
  }

  callTool(tool: string, args: Record<string, unknown>) {
    return this.request<{
      ok: boolean
      summary?: string
      data?: unknown
      error?: string
      needsUser?: boolean
    }>('POST', '/api/mcp/tool', { tool, args })
  }

  chat(message: string) {
    return this.request<{
      ok: boolean
      summary?: string
      needsUser?: boolean
      iterations?: number
      toolsRun?: string[]
      events?: Array<{ type: string; [k: string]: any }>
      error?: string
      /**
       * Fields the route sends that this type used to omit — so they were dropped
       * before `dispatch` could forward them, and the escalation id survived only
       * as prose inside `summary`.
       *
       *   status       'awaiting_approval' when the request was parked for human review
       *   approval     { id, status, poll, note } — the id to poll with check_approval
       *   code         stable failure slug (RATE_LIMITED, BRAIN_TIMEOUT, …)
       *   retryable    whether an identical retry is worth making
       *   applied      mutations that DID land, even on failure
       */
      status?: string
      approval?: { id: string; status: string; poll: string; note: string } | null
      code?: string
      retryable?: boolean
      retryAfterMs?: number
      partial?: boolean
      applied?: string[]
    }>('POST', '/api/mcp/chat', { message })
  }

  dbQuery(args: Record<string, unknown>)  { return this.request<{ ok: boolean; rows?: any[]; count?: number; error?: string }>('POST', '/api/mcp/db/query', args) }
  dbInsert(args: Record<string, unknown>) { return this.request<{ ok: boolean; row?: any; error?: string }>('POST', '/api/mcp/db/insert', args) }
  dbUpdate(args: Record<string, unknown>) { return this.request<{ ok: boolean; updated?: number; rows?: any[]; error?: string }>('POST', '/api/mcp/db/update', args) }
  dbDelete(args: Record<string, unknown>) { return this.request<{ ok: boolean; deleted?: number; error?: string }>('POST', '/api/mcp/db/delete', args) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Add ±30% jitter so retries from many clients don't synchronise.
function jitter(ms: number): number {
  return Math.round(ms * (0.7 + Math.random() * 0.6))
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const asNum = Number(header)
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(asNum * 1000, 30_000)
  const asDate = Date.parse(header)
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now()
    return delta > 0 ? Math.min(delta, 30_000) : 0
  }
  return null
}
