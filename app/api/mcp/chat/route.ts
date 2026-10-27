export const dynamic = 'force-dynamic'

/**
 * POST /api/mcp/chat — the Tier-1 mega-tool. Forwards a natural-language
 *                      request through `runBrain`. Same agent that powers
 *                      backenly.com.
 * OPTIONS            — CORS preflight.
 *
 * Non-streaming: collects brain events into an array, returns one JSON body
 * when the brain finishes. MCP's tool-call response model is request/response.
 * A wait of 5-30s for a multi-step build is fine — MCP hosts block on the
 * tool call.
 *
 * Billing — two separate ledgers, do not confuse them:
 *   1. PLATFORM COST. Every model call the brain makes goes through the AI
 *      gateway (lib/ai/llm), which reserves it against the deployment's monthly
 *      AI limits and writes `ai_usage` (model, tokens, cost, endpoint). That is
 *      our model spend, for our own accounting. It charges the user nothing.
 *   2. USER CREDITS. `enforceAiCredits` gates the turn, each model call holds
 *      its worst case against the credits before it is sent, and
 *      `closeCreditTurn` debits the tokens the turn actually burned
 *      (`result.tokensUsed`), then stops the holds counting.
 *
 * (2) was written but never called — for a long time `backend_chat` ran a full
 * multi-step model loop on our key with no user-facing cap at all, on any plan.
 * The header here previously claimed the ledger was charged "same as dashboard
 * chat"; it was not, and the claim is what hid the hole. Both halves are wired
 * now: the pre-gate below, and the charge after the brain returns.
 *
 * Hard wall-clock cap at 90s so an MCP host never hangs forever.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall, refuseIfReadOnly } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'
import { GO_AHEAD_LATER } from '@/lib/ai/brain/next-call'
import { assertAiAllowed } from '@/lib/platform-controls'
import { createApprovalRequest, RestoreRequestRefusedError } from '@/lib/mcp/approvals'
import { enforceAiCredits } from '@/lib/entitlements/policy'
import { closeCreditTurn } from '@/lib/entitlements/credit-holds'
import { createTokenScope, runInTokenScope } from '@/lib/ai/token-meter'
import { creditAccountOf } from '@/lib/usage/account'

const MAX_BRAIN_MS = 90_000
const ENDPOINT = '/api/mcp/chat'

const RequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
})

export function OPTIONS() {
  return optionsResponse()
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()

  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  // The brain applies non-destructive changes (create_table and friends) without
  // ever reaching the destructive gate, so a read-only key cannot be allowed to
  // reach it at all. Refusing the whole door is the only honest read-only
  // guarantee — a "read-only brain" would be a promise about model behaviour.
  const ro = refuseIfReadOnly(auth, 'backend_chat')
  if (ro) {
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 403, tool: 'backend_chat', error: 'READ_ONLY_KEY' },
    )
    return withCors(ro)
  }

  // Founder kill switch still applies to MCP. Without this, an MCP host could
  // bypass aiFrozen / maintenanceMode that the dashboard chat respects.
  const aiGuard = await assertAiAllowed()
  if (!aiGuard.ok) {
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: aiGuard.status, tool: 'backend_chat', error: aiGuard.reason },
    )
    return withCors(NextResponse.json(
      { ok: false, error: aiGuard.reason, code: 'AI_DISABLED' },
      { status: aiGuard.status },
    ))
  }

  // Credit pre-gate. Read-only and FAIL-OPEN (see enforceAiCredits): only a
  // real, measured budget breach blocks, so a billing infra blip can never
  // wedge a paying user's agent. Placed before the body parse so an exhausted
  // user gets the same answer regardless of what they asked for.
  //
  // The credits are the project's billing account's (its organization on
  // Cloud), not the caller's: a teammate's agent spends the team's budget. An
  // account that cannot be read is not blocked, the same fail-open rule.
  const creditAccount = await creditAccountOf(auth.projectId)
  const credits = creditAccount ? await enforceAiCredits(creditAccount) : true
  if (credits !== true) {
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 402, tool: 'backend_chat', error: 'AI_CREDITS_EXHAUSTED' },
    )
    return withCors(NextResponse.json(
      {
        ok: false,
        error: credits.message,
        code: 'AI_CREDITS_EXHAUSTED',
        // Structured so the calling agent can tell its human what to do rather
        // than retry into the same wall.
        currentPlan: credits.currentPlan,
        requiredPlan: credits.requiredPlan,
        upgradeRequired: true,
        // The typed tools are deterministic and cost us no model spend, so they
        // stay open. Only the natural-language door is gated.
        remedy:
          'Natural-language building is out of credits for this month. The typed tools ' +
          '(create_table, add_column, set_rls, generate_types, …) still work and are never ' +
          'metered — drive those directly. Credits reset on the 1st, or upgrade the plan.',
        retryable: false,
      },
      { status: 402 },
    ))
  }

  let parsed: z.infer<typeof RequestSchema>
  try {
    parsed = RequestSchema.parse(await request.json())
  } catch (err) {
    const issue = err instanceof z.ZodError ? err.issues[0]?.message : 'Body must be { message }.'
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 400, tool: 'backend_chat', error: 'BAD_BODY' },
    )
    return withCors(NextResponse.json(
      { ok: false, error: issue ?? 'Invalid body.', code: 'BAD_BODY' },
      { status: 400 },
    ))
  }

  const events: BrainEvent[] = []
  let timedOut = false

  // Accumulated as the brain spends them, so the timeout path can still bill.
  // `result.tokensUsed` is unreachable when the race below rejects, and a run
  // that burned 80s of model time before hitting the cap is precisely the one
  // worth charging for.
  let spentTokens = 0
  let charged = false
  // The turn's credit holds are taken inside this scope and closed with the
  // charge, after it is recorded (lib/entitlements/credit-holds.ts).
  const creditScope = createTokenScope()
  const chargeOnce = () => {
    if (charged) return
    charged = true
    closeCreditTurn(creditAccount, creditScope, spentTokens).catch(() => {})
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true
      reject(new Error(`Brain run exceeded ${MAX_BRAIN_MS}ms`))
    }, MAX_BRAIN_MS).unref?.()
  })

  try {
    const result = await Promise.race([
      runInTokenScope(creditScope, () => runBrain(
        {
          projectId: auth.projectId,
          userId: auth.userId,
          message: parsed.message,
          sessionToken: undefined,
          // Headless caller: a call that needs approval is stopped by the
          // brain's gate and queued for the Review Queue below, never confirmed
          // by message.
          door: 'mcp',
          // ── Verification is budgeted, not hoped for ─────────────────────────
          //
          // The brain now stops taking new steps while a verification reserve
          // remains and spends it proving what landed. Before this, the 90s cap
          // hit mid-verification every time — 4 of 4 RLS calls came back
          // "reached its time budget during final verification", i.e. the
          // operations that most needed proof were the only ones without any.
          deadlineAt: startedAt + MAX_BRAIN_MS,
          onTokens: (n) => { spentTokens += n },
        },
        (e) => events.push(e),
      )),
      timeoutPromise,
    ])

    // Charge what the turn actually burned. Measured, not estimated: the brain
    // reports `completion.usage.total_tokens` after every round trip. Prefer the
    // returned total (authoritative) but never charge less than we observed.
    // Fire-and-forget — a billing write must never turn a completed backend
    // change into an error response.
    spentTokens = Math.max(spentTokens, result.tokensUsed)
    chargeOnce()

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
          projectId: auth.projectId,
          userId: auth.userId,
          apiKeyId: auth.keyId,
          message: parsed.message,
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
      // A build stopped by the wall clock said "say continue" in its summary and
      // came back `ok: true, partial: true`, and agents took the two tables they
      // had as the build. `next` is the exact call that picks up the rest; it is
      // set only when that call will find something (lib/ai/brain/next-call.ts).
      ...(result.next ? { next: result.next } : {}),
      classification: {
        intent: result.classification.intent,
        confidence: result.classification.confidence,
      },
      timing: { ms: Date.now() - startedAt },
      events: events.map(condense),
    }

    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      {
        statusCode: 200,
        tool: 'backend_chat',
        mutation: result.toolsRun.some((t) => !['read_backend_state', 'finish', 'answer_question'].includes(t)),
        summary,
      },
    )

    return withCors(NextResponse.json(body))
  } catch (err) {
    // The turn burned model time before it timed out or threw. `onTokens` has
    // been accumulating it all along, so this path can finally bill it — it
    // used to be the single biggest uncharged leak, since a 90s run is the most
    // expensive shape a turn can have.
    chargeOnce()

    const msg = err instanceof Error ? err.message : 'Brain failed'
    const status = timedOut ? 504 : 500

    // Truthful timeout: the brain often APPLIES the requested change and then
    // over-runs the wall-clock cap during follow-up verification (generate_api →
    // read_backend_state → run_test → …). Returning a bare "exceeded 90000ms"
    // made the agent believe nothing happened and retry — creating duplicates or
    // no-ops. Scan the events for mutations that actually landed and report them,
    // so the agent can verify instead of blindly retrying.
    const NON_MUTATION = /^(read_backend_state|get_|list_|run_test|finish|answer_question|propose_plan|ask_user)/
    const applied: string[] = []
    // ── `toolsRun` and `iterations` are DERIVED, never defaulted ──────────────
    //
    // This branch used to omit both, and the stdio shim filled the holes with
    // `[]` and `0` — producing `{ applied: ["Securing profiles · custom RLS"],
    // toolsRun: [], iterations: 0 }`. A body that says a change was applied by
    // zero tools in zero iterations is unauditable, and it is a fabrication:
    // nobody measured those zeros, a `??` invented them. The event stream knows
    // exactly which tools ran, so read it.
    const toolsRun: string[] = []
    let anyFail = false
    for (const e of events) {
      if ((e.type === 'tool_done' || e.type === 'tool_fail') && e.tool) toolsRun.push(e.tool)
      if (e.type === 'tool_done' && e.tool && !NON_MUTATION.test(e.tool)) {
        applied.push(e.title || e.tool)
      }
      if (e.type === 'tool_fail') anyFail = true
    }
    // One iteration per assistant turn that called at least one tool. `tool_start`
    // is emitted once per dispatch, so a lower bound of "at least as many
    // iterations as distinct tool batches" is the honest number available here.
    const iterations = events.filter((e) => e.type === 'phase').length || (toolsRun.length ? 1 : 0)

    // ── A design still running is not a failure ───────────────────────────────
    //
    // The architect is one model call of up to three minutes, and this call
    // answers within 90 s. Reported as BRAIN_TIMEOUT, "Nothing was applied" and
    // retryable, it sent the agent back with the same request, and each one
    // started another design of the same backend while the first finished
    // unseen. The design carries on and saves its plan when it is done: "go
    // ahead" then builds it, and until then says it is still designing.
    if (timedOut && toolsRun.length === 0 && events.some((e) => e.type === 'phase' && e.phase === 'design')) {
      const summary =
        'Backenly is still designing this backend: one design takes one to three minutes, longer than one call. ' +
        'Nothing has been built yet. In about a minute, send backend_chat { "message": "go ahead" }: it builds the ' +
        'design once it is ready, and says so if it is still designing. Sending the build request again would only ' +
        'start a second design.'
      recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 200, tool: 'backend_chat', summary })
      return withCors(NextResponse.json({
        ok: true,
        status: 'designing',
        summary,
        next: GO_AHEAD_LATER,
        toolsRun,
        iterations,
        timing: { ms: Date.now() - startedAt },
        events: events.map(condense),
      }))
    }

    if (timedOut && applied.length > 0 && !anyFail) {
      const summary =
        `Applied ${applied.length} change(s): ${applied.join('; ')}. ` +
        `The run then hit the transport's hard wall clock, so these changes are ` +
        `reported UNVERIFIED — confirm with get_table_schema / read_backend_state. ` +
        `Do NOT blindly retry; the changes above are already in place.`
      recordMcpCall(
        { ...auth, endpoint: ENDPOINT, startedAt },
        { statusCode: 200, tool: 'backend_chat', mutation: true, summary },
      )
      return withCors(NextResponse.json({
        ok: true,
        summary,
        partial: true,
        // Stated plainly rather than implied by the prose: this path did NOT
        // verify. The brain's own budget reserve (see deadlineAt) is what makes
        // reaching here rare; when it happens the agent must know the difference.
        verified: false,
        // The exact tool that could not be confirmed, so "verify" is a specific
        // instruction rather than an invitation to audit the whole backend —
        // which is what the previous message amounted to (defect #16).
        applied,
        toolsRun,
        iterations,
        verifyWith: applied.map((a) => `get_table_schema / read_backend_state — confirm: ${a}`),
        timing: { ms: Date.now() - startedAt },
        events: events.map(condense),
      }))
    }

    // ── A failure that applied SOMETHING is not a clean failure ───────────────
    //
    // This branch used to require `!anyFail`, so a run that applied three changes
    // and then had one tool fail fell through to a bare error — and an agent
    // reading `ok:false` reasonably concluded nothing had happened and replayed
    // the whole request. `applied` and `partial` are now reported on every
    // failure path that changed something.
    const partial = applied.length > 0
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: status, tool: 'backend_chat', mutation: partial, error: msg },
    )
    return withCors(NextResponse.json(
      {
        ok: false,
        error: partial
          ? `${msg}. ${applied.length} change(s) DID take effect before this failed: ${applied.join('; ')}. ` +
            `Do NOT replay the whole request — verify current state with read_backend_state and ask only ` +
            `for what is missing.`
          : `${msg}. Nothing was applied.`,
        code: timedOut ? 'BRAIN_TIMEOUT' : 'BRAIN_FAILED',
        // A timeout is worth one retry; an unclassified brain failure is not
        // assumed to be.
        retryable: timedOut && !partial,
        ...(timedOut && !partial ? { retryAfterMs: 5_000 } : {}),
        partial,
        verified: false,
        ...(partial ? { applied } : {}),
        toolsRun,
        iterations,
        partialEvents: events.map(condense),
        timing: { ms: Date.now() - startedAt },
      },
      { status },
    ))
  }
}

function condense(e: BrainEvent): Partial<BrainEvent> & { type: string } {
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

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
