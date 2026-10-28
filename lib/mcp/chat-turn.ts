/**
 * One backend_chat turn, run to the end: the brain, its credits, the approvals
 * it parks, and the body an agent reads.
 *
 * It lives here rather than in app/api/mcp/chat/route.ts because a turn is now
 * a run that outlives its call (lib/ai/brain/runs.ts): the route starts it and
 * waits a while, and whatever is still running when the call answers finishes
 * here, in the background, and is recorded for the call that collects it.
 *
 * Billing — two separate ledgers, do not confuse them:
 *   1. PLATFORM COST. Every model call the brain makes goes through the AI
 *      gateway (lib/ai/llm), which reserves it against the deployment's monthly
 *      AI limits and writes `ai_usage` (model, tokens, cost, endpoint). That is
 *      our model spend, for our own accounting. It charges the user nothing.
 *   2. USER CREDITS. `enforceAiCredits` gates the turn (in the route), each
 *      model call holds its worst case against the credits before it is sent,
 *      and `closeCreditTurn` debits the tokens the turn actually burned
 *      (`result.tokensUsed`), then stops the holds counting. A run is charged
 *      when it ends, whether or not anyone waited for it: a turn used to keep
 *      running past the call's 90 s cap and was billed only what it had spent
 *      by then.
 */

import { runBrain, type BrainEvent, type BrainResult } from '@/lib/ai/brain/agent'
import { closeCreditTurn } from '@/lib/entitlements/credit-holds'
import { createTokenScope, runInTokenScope } from '@/lib/ai/token-meter'
import { createApprovalRequest, RestoreRequestRefusedError } from '@/lib/mcp/approvals'
import { recordMcpCall } from '@/lib/mcp/guard'
import { STATUS_NEXT } from '@/lib/ai/brain/next-call'
import {
  finishRun,
  RUN_LIMITS,
  touchRun,
  type Run,
  type RunHandle,
  type RunOutcome,
  type RunProgress,
} from '@/lib/ai/brain/runs'

export const CHAT_ENDPOINT = '/api/mcp/chat'

export interface ChatCaller {
  keyId: string
  projectId: string
  userId: string
}

/** Tools whose completion changes nothing, for telling what a turn applied from its events. */
const NON_MUTATION = /^(read_backend_state|get_|list_|run_test|finish|answer_question|propose_plan|ask_user)/

/**
 * Run one turn to the end and record its answer on its run. `handle` is null
 * when the run could not be recorded: the turn still runs, and its answer goes
 * only to a call still waiting for it.
 */
export async function executeRun(
  handle: RunHandle | null,
  ctx: { caller: ChatCaller; message: string; creditAccount: string | null; startedAt: number },
): Promise<RunOutcome> {
  const events: BrainEvent[] = []
  // Accumulated as the brain spends them, so a turn that throws can still be
  // billed what it burned before it did.
  let spentTokens = 0
  // The turn's credit holds are taken inside this scope and closed with the
  // charge, after it is recorded (lib/entitlements/credit-holds.ts).
  const creditScope = createTokenScope()

  // ── The heartbeat ───────────────────────────────────────────────────────────
  // On a timer, and soon after something lands, so a call waiting in another
  // process sees progress; never two writes at once, nor more than one every 2 s.
  let writing: Promise<void> | null = null
  let lastWrite = 0
  const report = () => {
    if (!handle || writing) return
    writing = touchRun(handle, progressOf(events))
      .catch((err) => console.error('[MCP Chat] run heartbeat failed:', err instanceof Error ? err.message : err))
      .finally(() => {
        writing = null
        lastWrite = Date.now()
      })
  }
  const heartbeat = handle ? setInterval(report, RUN_LIMITS.heartbeatMs) : null
  heartbeat?.unref?.()
  const emit = (e: BrainEvent) => {
    events.push(e)
    if ((e.type === 'tool_done' || e.type === 'phase') && Date.now() - lastWrite > 2_000) report()
  }

  let outcome: RunOutcome
  let mutation: boolean
  let crashed = false
  let note: { summary?: string; error?: string }
  try {
    const result = await runInTokenScope(creditScope, () => runBrain(
      {
        projectId: ctx.caller.projectId,
        userId: ctx.caller.userId,
        message: ctx.message,
        sessionToken: undefined,
        // Headless caller: a call that needs approval is stopped by the
        // brain's gate and queued for the Review Queue below, never confirmed
        // by message.
        door: 'mcp',
        // ── Verification is budgeted, not hoped for ─────────────────────────
        //
        // The brain stops taking new steps while a verification reserve remains
        // and spends it proving what landed. The deadline is the run's own,
        // not the call's: a call answers within RUN_LIMITS.syncWaitMs, and the
        // turn keeps going after it has.
        deadlineAt: ctx.startedAt + RUN_LIMITS.maxMs,
        onTokens: (n) => { spentTokens += n },
      },
      emit,
    ))
    // Charge what the turn actually burned. Measured, not estimated: the brain
    // reports `completion.usage.total_tokens` after every round trip. Prefer the
    // returned total (authoritative) but never charge less than we observed.
    // A billing write must never turn a completed backend change into an error.
    spentTokens = Math.max(spentTokens, result.tokensUsed)
    await closeCreditTurn(ctx.creditAccount, creditScope, spentTokens).catch(() => {})
    const turn = await turnBody(result, events, ctx)
    outcome = turn.outcome
    mutation = turn.mutation
    note = { summary: turn.summary }
  } catch (err) {
    await closeCreditTurn(ctx.creditAccount, creditScope, spentTokens).catch(() => {})
    const turn = crashedBody(err, events, ctx.startedAt)
    outcome = turn.outcome
    mutation = turn.mutation
    crashed = true
    note = { error: turn.error }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    await writing
  }

  // One usage row per run, written when it ends: a call that answered "running"
  // records nothing of its own (lib/mcp/guard.ts, the admin agent-ops ledger
  // counts a 2xx backend_chat row as work applied).
  recordMcpCall(
    { ...ctx.caller, endpoint: CHAT_ENDPOINT, startedAt: ctx.startedAt },
    { statusCode: outcome.statusCode, tool: 'backend_chat', mutation, ...note },
  )
  if (handle) {
    await finishRun(handle, outcome, { progress: progressOf(events), delivered: false, crashed })
      .catch((err) => console.error('[MCP Chat] could not record a run’s answer:', err))
  }
  return outcome
}

/**
 * The body for a turn that returned: approvals queued for what its gate
 * stopped, then everything an agent needs to act on what happened.
 */
export async function turnBody(
  result: BrainResult,
  events: BrainEvent[],
  ctx: { caller: ChatCaller; message: string; startedAt: number },
): Promise<{ outcome: RunOutcome; mutation: boolean; summary: string }> {
  // Escalation instead of a dead end. Every call the brain's approval gate
  // stopped is queued for a human with its EXACT tool and arguments, one
  // request per call, and approval runs that call verbatim, so the operation
  // on the card is the operation that runs. A turn that only talked about a
  // destructive change, without attempting a call, queues nothing: there is
  // no exact operation to approve.
  let approval: { id: string; status: string; poll: string; note: string } | null = null
  const queued: Array<{ id: string; tool: string; target: string }> = []
  // Stopped calls whose request could not be created, for example because a
  // regional project's region could not keep it: nothing is waiting for them.
  // A restore that cannot happen carries the reason it was refused.
  const notQueued: Array<{ tool: string; target: string; reason?: string }> = []
  for (const blocked of result.blockedCalls ?? []) {
    try {
      // The model's arguments are the call it asked for. A restore's are
      // replaced by Backenly's measurement of it (createApprovalRequest).
      const row = await createApprovalRequest({
        projectId: ctx.caller.projectId,
        userId: ctx.caller.userId,
        apiKeyId: ctx.caller.keyId,
        message: ctx.message,
        danger: {
          tool: blocked.tool,
          target: blocked.target,
          rowCount: blocked.rowCount,
          reversible: blocked.reversible,
        },
        toolArgs: blocked.args,
      })
      queued.push({ id: row.id, tool: blocked.tool, target: blocked.target })
    } catch (e) {
      if (e instanceof RestoreRequestRefusedError) {
        notQueued.push({ tool: blocked.tool, target: blocked.target, reason: e.message })
        continue
      }
      console.error('[MCP Chat] Failed to create approval request:', e)
      notQueued.push({ tool: blocked.tool, target: blocked.target })
    }
  }
  if (queued.length > 0) {
    const first = queued[0]
    approval = {
      id: first.id,
      status: 'pending',
      poll: `check_approval with { "id": "${first.id}" }`,
      note:
        `This operation needs human approval and was not run. It is waiting in the project's ` +
        `Review Queue exactly as requested. Tell your human to approve or reject it in the Backenly ` +
        `dashboard, then poll check_approval until status is executed, rejected, or expired (24h).` +
        (queued.length > 1
          ? ` ${queued.length - 1} more operation(s) from this turn are queued separately: ` +
            queued.slice(1).map((q) => `${q.tool} on ${q.target} (id "${q.id}")`).join('; ') + '.'
          : ''),
    }
  }

  // ── An escalation is an OUTCOME, not a failure ────────────────────────────
  //
  // The brain returns success=false for a turn it deliberately blocked, which
  // is right for the dashboard (nothing was applied) and catastrophic here:
  // the MCP client throws on `ok:false` and never reads the body, so the
  // `approval` object it just built — id, poll instruction, Review-Queue note
  // — was discarded unread. Every destructive request over MCP therefore
  // surfaced to the agent as a bare `Brain run failed.`
  //
  // Observed consequence, reported verbatim: three attempts to disconnect an
  // integration, all "Brain run failed", concluding "no remove_integration
  // tool exists · integrations are a one-way door". The tool existed, the
  // gate worked, three approval requests were sitting in the queue. Only the
  // transport said otherwise.
  //
  // A parked operation is a successful call whose result is "waiting on a
  // human". Say that, and give the agent the id to poll.
  const escalated = approval !== null
  // ── A stopped call that could not be queued is waiting nowhere ─────────────
  //
  // The model wrote its summary after the gate told it every stopped call
  // would be queued, so the summary can say so for a call whose request could
  // not be created. Say plainly that it was not, and that it did not run. The
  // rest of the turn keeps its own answer, what it applied and any code the
  // brain gave it: only a turn that did nothing else is answered as this
  // failure, rather than as a success.
  // A refused restore says why: sending it again would change nothing.
  const refused = notQueued.filter((q) => q.reason)
  const failed = notQueued.filter((q) => !q.reason)
  const notQueuedNote = [
    refused.length
      ? `Refused, so not queued and not run: ${refused.map((q) => `${q.tool} on ${q.target} (${q.reason})`).join('; ')}.`
      : '',
    failed.length
      ? `Not queued, and not run: ${failed.map((q) => `${q.tool} on ${q.target}`).join('; ')}. ` +
        `${failed.length === 1 ? 'It needs' : 'They need'} a human's approval, but the request for ` +
        `${failed.length === 1 ? 'it' : 'them'} could not be created, so nothing is waiting in the ` +
        `Review Queue. Send the request again.`
      : '',
  ].filter(Boolean).join(' ')
  const onlyNotQueued = notQueued.length > 0 && !escalated && !result.applied?.length && !result.failureCode
  const summary =
    (escalated
      ? `${result.summary}\n\n⏸ This operation needs a human's approval, so Backenly did not run it. ` +
        `It is waiting, exactly as requested, in the project's Review Queue (Autonomy page). ` +
        `Poll \`check_approval\` with id "${approval!.id}" until the status is executed, rejected or expired. ` +
        `Nothing has changed yet.`
      : result.summary) + (notQueuedNote ? `\n\n${notQueuedNote}` : '')

  // ── A budget stop that VERIFIED is a partial success, not a failure ───────
  //
  // The brain reserved time, stopped early, and read the live catalog back. It
  // knows what landed and has proof. Reporting that as ok:false would send the
  // agent down the retry path for work that is already in place and confirmed —
  // the exact mistake the reserve exists to prevent.
  const budgetPartial = !!result.budgetStopped && (result.applied?.length ?? 0) > 0

  const body = {
    ok: onlyNotQueued ? false : escalated || budgetPartial ? true : result.success,
    /** Set only on escalation or a design still running, so an agent can branch without parsing prose. */
    ...(escalated ? { status: 'awaiting_approval' as const } : result.inProgress ? { status: result.inProgress } : {}),
    ...(budgetPartial
      ? {
          partial: true as const,
          verified: !!result.verified,
          verifyWith: `read_backend_state — the state in \`summary\` was read back at ${new Date().toISOString()}`,
        }
      : {}),
    summary,
    needsUser: result.needsUser,
    approval,
    /** Every operation queued this turn; `approval` is the first of them. */
    ...(queued.length > 1 ? { approvals: queued } : {}),
    /** Operations that need approval but could not be queued: nothing is waiting for them. */
    ...(notQueued.length ? { notQueued } : {}),
    iterations: result.iterations,
    toolsRun: result.toolsRun,
    // ── The failure classification, at the TOP LEVEL ─────────────────────────
    //
    // The brain has always known why it stopped. None of it reached the agent:
    // a rate-limited run returned a bare `Brain run failed.` with no code and
    // no retryable flag, so an agent could not tell a transient fault from a
    // real one and had no basis for backing off (defects #14 and #15).
    //
    // `code` is the stable slug, `retryable` says whether an identical retry is
    // worth making, and `applied` lists what DID land — the fact that decides
    // whether retrying is safe or duplicates work.
    // A turn that did nothing but stop calls it could not queue takes the code
    // the typed door gives the same failure.
    ...(onlyNotQueued
      ? { code: 'APPROVAL_FAILED', retryable: true }
      : escalated || budgetPartial || result.success ? {} : {
        code: result.failureCode ?? 'BRAIN_FAILED',
        retryable: !!result.retryable,
        ...(result.retryable
          ? { retryAfterMs: result.failureCode === 'RATE_LIMITED' ? 30_000 : 5_000 }
          : {}),
      }),
    ...(result.applied?.length ? { applied: result.applied } : {}),
    // ── What did NOT land, on a call that otherwise succeeded ───────────────
    //
    // Only `applied` was reported, so a request listing six additive changes
    // came back describing the four that worked and saying nothing at all
    // about the two that were refused. The turn looked complete. An agent has
    // no way to notice an omission it is never told about, so this is
    // reported alongside `applied` on every path rather than folded into an
    // error the success branch never reaches.
    ...(result.refused?.length ? { refused: result.refused } : {}),
    // ── What carries the request on, when this call did not finish it ───────
    //
    // A stopped build said "say continue" in its summary and came back
    // `ok: true, partial: true`, and agents took the two tables they had as the
    // build. `next` is the exact call that picks up the rest; it is set only
    // when that call will find something (lib/ai/brain/next-call.ts).
    ...(result.next ? { next: result.next } : {}),
    classification: {
      intent: result.classification.intent,
      confidence: result.classification.confidence,
    },
    timing: { ms: Date.now() - ctx.startedAt },
    events: events.map(condense),
  }

  return {
    outcome: { statusCode: 200, body },
    mutation: result.toolsRun.some((t) => !['read_backend_state', 'finish', 'answer_question'].includes(t)),
    summary,
  }
}

/** The body for a turn that threw: what its events say landed, and that nothing else did. */
export function crashedBody(
  err: unknown,
  events: BrainEvent[],
  startedAt: number,
): { outcome: RunOutcome; mutation: boolean; error: string } {
  const msg = err instanceof Error ? err.message : 'Brain failed'
  // ── `toolsRun` and `iterations` are DERIVED, never defaulted ──────────────
  //
  // This path used to omit both, and the stdio shim filled the holes with
  // `[]` and `0` — producing `{ applied: ["Securing profiles · custom RLS"],
  // toolsRun: [], iterations: 0 }`. A body that says a change was applied by
  // zero tools in zero iterations is unauditable, and it is a fabrication:
  // nobody measured those zeros, a `??` invented them. The event stream knows
  // exactly which tools ran, so read it.
  const toolsRun: string[] = []
  for (const e of events) {
    if ((e.type === 'tool_done' || e.type === 'tool_fail') && e.tool) toolsRun.push(e.tool)
  }
  const applied = progressOf(events).applied
  // One iteration per assistant turn that called at least one tool. `tool_start`
  // is emitted once per dispatch, so a lower bound of "at least as many
  // iterations as distinct tool batches" is the honest number available here.
  const iterations = events.filter((e) => e.type === 'phase').length || (toolsRun.length ? 1 : 0)

  // ── A failure that applied SOMETHING is not a clean failure ───────────────
  //
  // An agent reading `ok:false` reasonably concludes nothing happened and
  // replays the whole request. `applied` and `partial` are reported on every
  // failure path that changed something.
  const partial = applied.length > 0
  return {
    outcome: {
      statusCode: 500,
      body: {
        ok: false,
        error: partial
          ? `${msg}. ${applied.length} change(s) DID take effect before this failed: ${applied.join('; ')}. ` +
            `Do NOT replay the whole request — verify current state with read_backend_state and ask only ` +
            `for what is missing.`
          : `${msg}. Nothing was applied.`,
        code: 'BRAIN_FAILED',
        retryable: false,
        partial,
        verified: false,
        ...(partial ? { applied } : {}),
        toolsRun,
        iterations,
        partialEvents: events.map(condense),
        timing: { ms: Date.now() - startedAt },
      },
    },
    mutation: partial,
    error: msg,
  }
}

/** What has landed so far and what the turn is doing now, from its events. */
export function progressOf(events: BrainEvent[]): RunProgress {
  const applied: string[] = []
  let step: string | undefined
  for (const e of events) {
    if (e.type === 'tool_done' && e.tool && !NON_MUTATION.test(e.tool)) applied.push(e.title || e.tool)
    if (e.type === 'tool_start') step = e.title
    else if (e.type === 'thinking' && e.text) step = e.text
  }
  return { applied, ...(step ? { step: step.slice(0, 160) } : {}) }
}

/**
 * The answer while a request is still running: what has landed, what it is
 * doing, and the call that waits for its result. `notRun` is a message that
 * arrived while it ran, which was not run.
 */
export function runningBody(run: Run, opts: { notRun?: string | null } = {}): Record<string, unknown> {
  const elapsed = Math.max(0, Math.round((Date.now() - run.startedAt.getTime()) / 1000))
  const sofar = run.appliedCount
    ? `${run.appliedCount} change${run.appliedCount === 1 ? '' : 's'} so far` +
      (run.applied.length ? ` (${run.applied.slice(-6).join('; ')})` : '')
    : 'nothing applied yet'
  return {
    ok: true,
    status: 'running',
    run: { id: run.id, startedAt: run.startedAt.toISOString(), elapsedMs: elapsed * 1000 },
    summary:
      `Backenly is still working on this request (${elapsed}s so far, ${sofar}` +
      (run.step ? `; now: ${run.step}` : '') +
      `). It keeps going on its own whether or not you wait. Send backend_chat { "message": "status" } to wait ` +
      `for it: each call waits up to ${Math.round(RUN_LIMITS.syncWaitMs / 1000)}s and returns the result once ` +
      `it is done.` +
      (opts.notRun ? ` ${notRunNote()}` : ''),
    progress: {
      appliedCount: run.appliedCount,
      ...(run.applied.length ? { applied: run.applied } : {}),
      ...(run.step ? { step: run.step } : {}),
    },
    ...(opts.notRun ? { notRun: { message: opts.notRun } } : {}),
    next: STATUS_NEXT,
    needsUser: false,
  }
}

/** A finished run's answer as a call that waited for it returns it. */
export function deliveredBody(run: Run, outcome: RunOutcome, opts: { notRun?: string | null } = {}): Record<string, unknown> {
  return {
    ...outcome.body,
    run: { id: run.id, status: run.state },
    ...(opts.notRun ? { notRun: { message: opts.notRun, note: notRunNote() } } : {}),
  }
}

function notRunNote(): string {
  return (
    'The message this call carried was not run: it arrived while another request was running on this ' +
    'project, and one runs at a time. Send it again once this one is done.'
  )
}

export function condense(e: BrainEvent): Partial<BrainEvent> & { type: string } {
  switch (e.type) {
    case 'tool_start':    return { type: e.type, tool: e.tool, title: e.title }
    case 'tool_done':     return { type: e.type, tool: e.tool, title: e.title, detail: e.detail }
    case 'tool_fail':     return { type: e.type, tool: e.tool, title: e.title, detail: e.detail }
    case 'final':         return { type: e.type, summary: e.summary, needsUser: e.needsUser }
    case 'classification': return { type: e.type, intent: e.intent, confidence: e.confidence }
    case 'phase':         return { type: e.type, phase: e.phase }
    case 'thinking':      return { type: e.type, text: e.text }
    case 'error':         return { type: e.type, message: e.message }
    default:              return { type: (e as any).type }
  }
}
