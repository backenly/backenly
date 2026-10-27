/**
 * NEXT CALL — what carries an unfinished request on
 * =================================================
 * A build stopped by backend_chat's wall clock used to say "say continue" in
 * its summary and nothing else, and the transport reported it `ok: true,
 * partial: true`. An agent reading that took the two tables it had as the
 * build and moved on. A turn that ends with work still waiting names the exact
 * call that picks it up, in the MCP body as `next`.
 *
 * A leaf module, so the chat route can name these calls without importing the
 * brain (several suites replace the brain module with a stub).
 */

/** One call for the agent to make next, as the MCP body carries it. */
export interface NextCall {
  tool: string
  arguments: Record<string, unknown>
  /** Why, in a sentence the agent can relay to its human. */
  why: string
  /** Wait at least this long first. */
  afterMs?: number
}

/** Picks up a turn that stopped with work left and saved where it was. */
export const CONTINUE: NextCall = {
  tool: 'backend_chat',
  arguments: { message: 'continue' },
  why: 'This request is not finished. What already landed stays in place; this carries on with the rest.',
}

/** Collects a design that is still running: "go ahead" builds it once it is ready. */
export const GO_AHEAD_LATER: NextCall = {
  tool: 'backend_chat',
  arguments: { message: 'go ahead' },
  why: 'Backenly is still designing this backend; this builds the design once it is ready.',
  afterMs: 60_000,
}
