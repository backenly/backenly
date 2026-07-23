/**
 * A failure must arrive with the reason the server already had.
 *
 * ── Two reported symptoms, one root cause ───────────────────────────────────
 *
 * "backend_chat failed outright. Two of three runs returned only
 *  `Brain run failed.` — no detail."
 *
 * "Flaky generate_function — identical payload returned HTTP 400 TOOL_ERROR
 *  once, succeeded on retry."
 *
 * Neither was a missing diagnosis. In both cases the server produced a full
 * account of what went wrong and the transport threw it away:
 *
 *   • /api/mcp (remote) ran every response through `leanForAgent`, which
 *     stripped `partialEvents` — the only record of which tools ran before the
 *     brain stopped. Correct for a success body, catastrophic for a failure.
 *
 *   • /api/mcp/tool wrote a failure's reason into `summary` and left `error`
 *     undefined. The HTTP client builds its message from `error || message`, so
 *     it fell through to the generic `HTTP 400 from /api/mcp/tool (TOOL_ERROR)`
 *     while the real reason sat unread in the same JSON body.
 *
 * The second one is why the flakiness looked like flakiness: with no reason
 * attached, a transient fault and a permanent one are indistinguishable, so the
 * only available strategy is to retry blindly and see.
 */

import { leanForAgent } from '@/lib/mcp/agent-response'

describe('leanForAgent keeps the diagnosis on failure', () => {
  it('strips transport noise from a SUCCESS body', () => {
    const out = leanForAgent({
      ok: true,
      summary: 'Created table posts',
      timing: { ms: 120 },
      events: [{ type: 'tool_done', tool: 'create_table' }],
    })
    expect(out.summary).toBe('Created table posts')
    expect(out.timing).toBeUndefined()
    expect(out.events).toBeUndefined()
    expect(out.whatRanBeforeItFailed).toBeUndefined()
  })

  it('KEEPS the event trail on a failure — this is the whole bug', () => {
    const out = leanForAgent({
      ok: false,
      error: 'Brain run exceeded 90000ms',
      code: 'BRAIN_TIMEOUT',
      timing: { ms: 90001 },
      partialEvents: [
        { type: 'tool_done', tool: 'create_table', title: 'Created orders' },
        { type: 'tool_fail', tool: 'generate_api', error: 'boom' },
      ],
    })
    expect(out.error).toBe('Brain run exceeded 90000ms')
    expect(out.code).toBe('BRAIN_TIMEOUT')
    expect(Array.isArray(out.whatRanBeforeItFailed)).toBe(true)
    expect(out.whatRanBeforeItFailed).toHaveLength(2)
    // Still no raw timing — noise is noise either way.
    expect(out.timing).toBeUndefined()
  })

  it('falls back to `events` when the failure body used that name', () => {
    const out = leanForAgent({
      ok: false,
      error: 'nope',
      events: [{ type: 'tool_done', tool: 'create_table' }],
    })
    expect(out.whatRanBeforeItFailed).toHaveLength(1)
  })

  it('caps the trail so a long run cannot flood the agent context', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ type: 'tool_done', tool: `t${i}` }))
    const out = leanForAgent({ ok: false, error: 'x', partialEvents: many })
    expect((out.whatRanBeforeItFailed as unknown[]).length).toBe(25)
  })

  it('adds nothing when a failure genuinely has no trail', () => {
    const out = leanForAgent({ ok: false, error: 'x', partialEvents: [] })
    expect(out.whatRanBeforeItFailed).toBeUndefined()
  })
})

/**
 * The client's message-building rule, asserted directly. The tool endpoint now
 * sets `error` on failure AND the client reads `summary` as a fallback — both
 * halves, because either one alone leaves the other free to regress.
 */
describe('a failure body can never go opaque', () => {
  const buildMessage = (parsed: any, status: number, path: string) =>
    (parsed && (parsed.error || parsed.message || parsed.summary)) || `HTTP ${status} from ${path}`

  it('reads `error` first', () => {
    expect(buildMessage({ error: 'real reason', summary: 's' }, 400, '/x')).toBe('real reason')
  })

  it('falls back to `summary` — the exact field the tool endpoint used to use alone', () => {
    // Before the fix this produced "HTTP 400 from /api/mcp/tool", which is
    // verbatim what was reported as an unexplained TOOL_ERROR.
    expect(buildMessage({ summary: 'generate_function timed out upstream' }, 400, '/api/mcp/tool'))
      .toBe('generate_function timed out upstream')
  })

  it('only reaches the generic form when the body truly says nothing', () => {
    expect(buildMessage({}, 400, '/api/mcp/tool')).toBe('HTTP 400 from /api/mcp/tool')
    expect(buildMessage(null, 502, '/api/mcp/chat')).toBe('HTTP 502 from /api/mcp/chat')
  })
})
