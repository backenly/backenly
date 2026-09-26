/**
 * How a Backenly handler's JSON body becomes an MCP tools/call result.
 *
 * This is the rule the remote endpoint applies (lib/mcp/protocol/shared.ts and
 * lib/mcp/agent-response.ts in the Backenly repository). The package runs on
 * the user's machine and cannot import that code, so it carries the same rule,
 * and tests/unit/mcp-transport-parity.spec.ts runs both transports on
 * the same bodies and fails if their results differ.
 *
 * It used to be different. This package reduced a failure to one sentence of
 * prose and dropped the body, so `hint`, `applied` and the trail of what ran
 * reached an agent over the remote endpoint and not over stdio.
 */

/** A tools/call result: the same object as text, for older clients, and as structuredContent. */
export interface McpToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
  isError: boolean
}

/**
 * Trim a handler body to what an agent needs. Timing and raw event streams go
 * on success; on failure the event trail is kept, capped, as
 * `whatRanBeforeItFailed`, because it is the only record of what ran.
 */
export function leanForAgent(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return { value: body }
  const { timing: _timing, events, partialEvents, ...rest } = body as Record<string, unknown>

  if ((body as Record<string, unknown>).ok !== false) return rest

  const trail = Array.isArray(partialEvents) ? partialEvents : Array.isArray(events) ? events : null
  return trail && trail.length > 0 ? { ...rest, whatRanBeforeItFailed: trail.slice(-25) } : rest
}

/**
 * The body as text and as structuredContent. Nothing is added to it: a field
 * the handler did not send stays absent. A failure also gets a second text
 * block saying what its fields mean for the next step.
 */
export function shapeToolResult(body: unknown, ok: boolean): McpToolResult {
  const lean = leanForAgent(body)
  const guidance = ok ? null : failureGuidance(lean)
  return {
    content: [
      { type: 'text', text: JSON.stringify(lean, null, 2) },
      ...(guidance ? [{ type: 'text' as const, text: guidance }] : []),
    ],
    structuredContent: lean,
    isError: !ok,
  }
}

/**
 * What a failed result means for an agent's next step, read only from the
 * fields the handler sent. What already landed comes first: retrying a partly
 * applied run duplicates whatever succeeded.
 */
export function failureGuidance(lean: Record<string, unknown>): string | null {
  const parts: string[] = []

  const applied = Array.isArray(lean.applied) ? lean.applied : []
  const trail = Array.isArray(lean.whatRanBeforeItFailed) ? lean.whatRanBeforeItFailed : []
  const toolsRun = Array.isArray(lean.toolsRun) ? lean.toolsRun : []
  if (applied.length) {
    const named = applied.map((a) => (typeof a === 'string' ? a : (a as { summary?: string })?.summary ?? JSON.stringify(a)))
    parts.push(`ALREADY APPLIED, do not repeat: ${named.join('; ')}. Verify with read_backend_state and ask only for what is missing.`)
  } else if (lean.partial === false) {
    parts.push('Nothing was applied.')
  } else if (toolsRun.length || trail.length) {
    parts.push('Steps ran before it stopped, so some of this may already be applied: check with read_backend_state before retrying.')
  }

  if (lean.retryable === true) {
    const ms = typeof lean.retryAfterMs === 'number' ? lean.retryAfterMs : null
    parts.push(`This is transient: the same request is worth retrying after ${ms ? `${Math.round(ms / 1000)}s` : 'a moment'}.`)
  } else if (lean.retryable === false) {
    parts.push('Retrying the identical request will fail the same way; change the request.')
  }

  if (!lean.error && !lean.summary) {
    parts.push('The server reported a failure without a reason, which is itself a bug worth reporting.')
  }

  return parts.length ? parts.join(' ') : null
}
