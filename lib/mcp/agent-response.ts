/**
 * What an agent actually needs out of a tool response.
 *
 * Lives here rather than inside app/api/mcp/route.ts because a Next.js route
 * module may only export its HTTP handlers — an extra export fails the build's
 * route type-check. Behaviour this load-bearing needs to be directly testable,
 * so it moves to a library and the route imports it.
 */

/**
 * Trim a REST tool response to what an agent needs in its context.
 *
 * ── Success and failure want opposite things ────────────────────────────────
 *
 * On SUCCESS the transport-level noise (timing, raw event streams) costs tokens
 * on every single call and helps the model not at all — so it goes.
 *
 * On FAILURE the opposite is true, and stripping it was the bug. `partialEvents`
 * is the ONLY record of what the brain actually did before it stopped: which
 * tools ran, which one failed, how far it got. Removing it left an agent holding
 * `{ ok: false, error: "..." }` and nothing else — which is what "backend_chat
 * failed outright, two of three runs returned only 'Brain run failed.' — no
 * detail" looked like from the outside.
 *
 * The trail is also what tells an agent NOT to retry. A run that created three
 * tables and then timed out is not a run to repeat; withholding that turns a
 * partial success into a duplicate-creating retry loop. That is a worse outcome
 * than the original failure.
 */
export function leanForAgent(body: any): Record<string, unknown> {
  if (!body || typeof body !== 'object') return { value: body }
  const { timing, events, partialEvents, ...rest } = body as Record<string, unknown>

  if ((body as Record<string, unknown>).ok !== false) return rest

  // Whichever event stream this body used, capped — an agent needs the shape of
  // what happened, not a full transcript.
  const trail = Array.isArray(partialEvents)
    ? partialEvents
    : Array.isArray(events)
      ? events
      : null

  return trail && trail.length > 0
    ? { ...rest, whatRanBeforeItFailed: trail.slice(-25) }
    : rest
}
