/**
 * MCP reliability harness — HTTP client.
 *
 * Speaks to the same surfaces a real MCP host speaks to (/api/mcp/tool and
 * /api/mcp/db/*), so what the harness measures is what an agent experiences.
 *
 * Every call is recorded. Two things a benchmark actually scores are derived
 * from that record and cannot be reconstructed later:
 *
 *   turns          — how many calls a task took. An agent that needs 12 tries
 *                    to insert a row scores far worse than one that needs 1,
 *                    even though both eventually "succeed".
 *   error quality  — whether a failure told the agent enough to fix itself.
 *                    On 2026-07-19 every failed insert returned
 *                    "Type mismatch — a value has the wrong type for its
 *                    column." with no column name and no expected type, and the
 *                    agent burned ~12 blind retries before giving up and
 *                    corrupting the schema instead. Blind errors are counted
 *                    here as a first-class defect, not as incidental text.
 */

export interface CallRecord {
  surface: string
  ok: boolean
  ms: number
  error?: string
  /** Failure that named neither the offending column nor the expected type. */
  blind?: boolean
}

export interface ToolResult<T = any> {
  ok: boolean
  summary?: string
  data?: T
  error?: string
  code?: string
  /** Full parsed response body — lets cases assert the structured error fields. */
  body?: any
}

/**
 * Prose-only check: does the message alone identify what to change?
 * Kept for cases that assert on wording.
 */
export function isBlindError(message: string | undefined): boolean {
  if (!message) return true
  const m = message.toLowerCase()
  const namesColumn = /column\s+"?[a-z_][a-z0-9_]*"?/.test(m) || /\bcolumn\b.*\bis of type\b/.test(m)
  const namesExpectation = /expected|must be|is of type|allowed values|use one of/.test(m)
  return !(namesColumn && namesExpectation)
}

/**
 * Whole-response check, and the one the score uses.
 *
 * The metric exists to answer "can an agent recover from this in one turn",
 * and after Phase 1 the answer lives in structured fields rather than in
 * wording. A 42703 that says only `Column "x" does not exist` reads blind to a
 * prose matcher, yet ships `available: [...]` listing every real column — which
 * is the single most actionable thing an unknown-column error can carry.
 * Scoring that as blind would have pushed us to pad the sentence instead of
 * improving the contract, i.e. optimise the measurement rather than the product.
 */
export function isBlindResponse(body: any, message: string | undefined): boolean {
  if (body) {
    if (body.example || Array.isArray(body.available)) return false
    if (body.column && body.expected) return false
    // A SPECIFIC failure code lets an agent branch deterministically without
    // parsing prose, which is the property that prevents retry loops. A
    // deliberate refusal (DESTRUCTIVE_NEEDS_APPROVAL, VALIDATION_ERROR) is a
    // clear terminal instruction, not a dead end. Generic buckets below carry
    // no such signal and still count as blind — otherwise every failure could
    // be laundered into "actionable" by attaching a code, and the metric would
    // measure nothing.
    if (typeof body.code === 'string' && body.code && !GENERIC_ERROR_CODES.has(body.code)) {
      return false
    }
  }
  return isBlindError(message)
}

/** Codes that identify no cause — the agent still has to guess. */
const GENERIC_ERROR_CODES = new Set([
  'DB_ERROR', 'DB_OP_FAILED', 'INSERT_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED',
  'QUERY_FAILED', 'TOOL_ERROR', 'DISPATCH_FAILED', 'INTERNAL_ERROR', 'UNKNOWN',
])

export class HarnessClient {
  readonly calls: CallRecord[] = []
  /** Resolved from the project overview at start-up; used for runtime API paths. */
  projectId = ''

  constructor(
    private endpoint: string,
    private apiKey: string,
  ) {}

  /** Calls since the marker — used to score turns per case. */
  mark(): number {
    return this.calls.length
  }
  since(marker: number): CallRecord[] {
    return this.calls.slice(marker)
  }

  private async post<T>(path: string, body: unknown): Promise<ToolResult<T>> {
    const started = Date.now()
    let res: Response
    try {
      res = await fetch(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.calls.push({ surface: path, ok: false, ms: Date.now() - started, error, blind: true })
      return { ok: false, error }
    }

    const text = await res.text()
    let parsed: any = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }

    const ok = res.ok && parsed?.ok !== false
    const error = ok ? undefined : (parsed?.error ?? `HTTP ${res.status}`)
    this.calls.push({
      surface: path,
      ok,
      ms: Date.now() - started,
      error,
      blind: ok ? undefined : isBlindResponse(parsed, error),
    })

    return ok
      ? { ok: true, summary: parsed?.summary, data: parsed?.data ?? parsed, body: parsed }
      : { ok: false, error, code: parsed?.code, body: parsed }
  }

  tool<T = any>(name: string, args: Record<string, unknown> = {}) {
    return this.post<T>('/api/mcp/tool', { tool: name, args })
  }

  dbInsert(table: string, row: Record<string, unknown>) {
    return this.post('/api/mcp/db/insert', { table, row })
  }
  dbQuery(table: string, opts: Record<string, unknown> = {}) {
    return this.post<{ rows: any[]; count: number }>('/api/mcp/db/query', { table, ...opts })
  }
  dbUpdate(table: string, filter: Record<string, unknown>, patch: Record<string, unknown>) {
    return this.post('/api/mcp/db/update', { table, filter, patch })
  }
  dbDelete(table: string, filter: Record<string, unknown>) {
    return this.post('/api/mcp/db/delete', { table, filter })
  }

  /** Tool catalogue exactly as an MCP host would receive it. */
  async manifest(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: any }> }> {
    const started = Date.now()
    const res = await fetch(`${this.endpoint}/api/mcp/manifest`, {
      headers: { 'x-api-key': this.apiKey },
    })
    const body = await res.json().catch(() => ({}))
    this.calls.push({ surface: '/api/mcp/manifest', ok: res.ok, ms: Date.now() - started })
    return { tools: (body as any)?.tools ?? [] }
  }

  /**
   * Call the end-user runtime API — a different surface with a different
   * credential (sk_live runtime key, not the mcp_live tool key). Needed to
   * verify the runtime contract get_instructions publishes to agents.
   */
  async runtime(
    method: 'GET' | 'POST',
    path: string,
    runtimeKey: string,
    opts: { body?: unknown; userToken?: string } = {},
  ): Promise<{ status: number; ok: boolean; body: any }> {
    const started = Date.now()
    const headers: Record<string, string> = {
      'x-api-key': runtimeKey,
      'content-type': 'application/json',
    }
    if (opts.userToken) headers['X-User-Token'] = opts.userToken

    const res = await fetch(`${this.endpoint}/api/v1/${this.projectId}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
    const body = await res.json().catch(() => null)
    this.calls.push({ surface: `runtime ${path}`, ok: res.ok, ms: Date.now() - started })
    return { status: res.status, ok: res.ok, body }
  }

  /** Column name → PostgreSQL data_type, read back from the live catalog. */
  async columnTypes(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
    const r = await this.tool('get_table_schema', { tableName: table })
    const out = new Map<string, { type: string; nullable: boolean }>()
    if (!r.ok) return out
    for (const c of r.data?.columns ?? []) {
      out.set(c.name, { type: String(c.type), nullable: !!c.nullable })
    }
    return out
  }

  async foreignKeys(table: string): Promise<any[]> {
    const r = await this.tool('get_table_schema', { tableName: table })
    return r.ok ? (r.data?.foreignKeys ?? []) : []
  }
}
