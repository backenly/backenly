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
 *   1. PLATFORM COST. `runBrain` calls `trackCompletionCost` per completion,
 *      which writes `ai_usage` (model, tokens, cost, endpoint). That is our
 *      OpenAI spend, for our own accounting. It charges the user nothing.
 *   2. USER CREDITS. `enforceAiCredits` gates the turn and `chargeAiCredits`
 *      debits the tokens the turn actually burned (`result.tokensUsed`).
 *
 * (2) was written but never called — for a long time `backend_chat` ran a full
 * multi-step model loop on our key with no user-facing cap at all, on any plan.
 * The header here previously claimed the ledger was charged "same as dashboard
 * chat"; it was not, and the claim is what hid the hole. Both halves are wired
 * now: the pre-gate below, and the charge after the brain returns.
 *
 * `mcpGuard` additionally counts the request against `apiRequestCount`.
 *
 * Hard wall-clock cap at 90s so an MCP host never hangs forever.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall, refuseIfReadOnly } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'
import { assertAiAllowed } from '@/lib/platform/controls'
import { createApprovalRequest } from '@/lib/mcp/approvals'
import { enforceAiCredits, chargeAiCredits } from '@/lib/entitlements/policy'

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
  const credits = await enforceAiCredits(auth.userId)
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
  const chargeOnce = () => {
    if (charged || spentTokens <= 0) return
    charged = true
    chargeAiCredits(auth.userId, spentTokens).catch(() => {})
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true
      reject(new Error(`Brain run exceeded ${MAX_BRAIN_MS}ms`))
    }, MAX_BRAIN_MS).unref?.()
  })

  try {
    const result = await Promise.race([
      runBrain(
        {
          projectId: auth.projectId,
          userId: auth.userId,
          message: parsed.message,
          sessionToken: undefined,
          destructiveConfirmed: false,
          // Headless surface: there is no interactive human to type a
          // confirmation, so a destructive request must escalate to the Review
          // Queue rather than dead-end on a conversational "reply to confirm".
          surface: 'mcp',
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
      ),
      timeoutPromise,
    ])

    // Charge what the turn actually burned. Measured, not estimated: the brain
    // reports `completion.usage.total_tokens` after every round trip. Prefer the
    // returned total (authoritative) but never charge less than we observed.
    // Fire-and-forget — a billing write must never turn a completed backend
    // change into an error response.
    spentTokens = Math.max(spentTokens, result.tokensUsed)
    chargeOnce()

    // Escalation instead of a dead end. Two ways a destructive request surfaces:
    //   1. `danger` event — the brain actually attempted the destructive tool
    //      and hit the gate. Precise target/rowCount/reversible.
    //   2. No danger event, but the turn was classified DESTRUCTIVE and ended
    //      asking the user to confirm. Over MCP that ask can never be answered
    //      (destructiveConfirmed is always false here), so we escalate it too,
    //      with best-effort details parsed from the request.
    // Either way the human decides in the dashboard; approval replays the
    // ORIGINAL message with destructiveConfirmed=true, which does execute it.
    let approval: { id: string; status: string; poll: string; note: string } | null = null
    const danger = events.find((e) => e.type === 'danger') as
      | Extract<BrainEvent, { type: 'danger' }>
      | undefined
    const conversationalDestructive =
      !danger && result.classification.intent === 'DESTRUCTIVE' && result.needsUser

    if (danger || conversationalDestructive) {
      const dangerInfo = danger
        ? { tool: danger.tool, target: danger.target, rowCount: danger.rowCount, reversible: danger.reversible }
        : inferDestructive(parsed.message)
      try {
        const req2 = await createApprovalRequest({
          projectId: auth.projectId,
          userId: auth.userId,
          apiKeyId: auth.keyId,
          message: parsed.message,
          danger: dangerInfo,
        })
        approval = {
          id: req2.id,
          status: 'pending',
          poll: `check_approval with { "id": "${req2.id}" }`,
          note:
            `This operation is destructive and needs human approval. It is now waiting in the ` +
            `project's Review Queue. Tell your human to approve or reject it in the Backenly ` +
            `dashboard, then poll check_approval until status is executed, rejected, or expired (24h).`,
        }
      } catch (e) {
        console.error('[MCP Chat] Failed to create approval request:', e)
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
    const summary = escalated
      ? `${result.summary}\n\n⏸ This operation is destructive, so Backenly did not run it. ` +
        `It is waiting for human approval in the project's Review Queue (Autonomy page). ` +
        `Poll \`check_approval\` with id "${approval!.id}" until the status is executed, rejected or expired. ` +
        `Nothing has changed yet.`
      : result.summary

    // ── A budget stop that VERIFIED is a partial success, not a failure ───────
    //
    // The brain reserved time, stopped early, and read the live catalog back. It
    // knows what landed and has proof. Reporting that as ok:false would send the
    // agent down the retry path for work that is already in place and confirmed —
    // the exact mistake the reserve exists to prevent.
    const budgetPartial = !!result.budgetStopped && (result.applied?.length ?? 0) > 0

    const body = {
      ok: escalated || budgetPartial ? true : result.success,
      /** Set only on escalation, so an agent can branch without parsing prose. */
      ...(escalated ? { status: 'awaiting_approval' as const } : {}),
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
      ...(escalated || budgetPartial || result.success ? {} : {
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

/**
 * Best-effort danger details when the brain asked for confirmation
 * conversationally instead of tripping the tool gate. Cosmetic — the Review
 * Queue shows tool/target; the stored ORIGINAL message is what actually
 * replays on approval, so precision here isn't load-bearing.
 */
function inferDestructive(message: string): { tool: string; target: string; rowCount: number | null; reversible: boolean } {
  const m = message.toLowerCase()
  const nameMatch = message.match(/\b([a-z_][a-z0-9_]*)\b(?=\s+(?:table|bucket|column|file))|(?:table|bucket|column|file)\s+["'`]?([a-z_][a-z0-9_]*)/i)
  const target = (nameMatch?.[1] || nameMatch?.[2] || 'the requested resource').trim()

  // Covers every member of brain/tools#DESTRUCTIVE_TOOLS a user can phrase in
  // prose, not just the schema ones. It previously guessed `drop_table` for
  // anything it did not recognise, so a request to disconnect an integration
  // was queued as "drop the requested resource table" — a Review Queue entry
  // that describes an operation nobody asked for is worse than a vague one,
  // because the human approves it on the strength of the description.
  let tool = 'drop_table'
  if (/truncate|wipe|empty|clear all/.test(m)) tool = 'truncate_table'
  else if (/disconnect|remove|delete/.test(m) && /integration|stripe|resend|sendgrid|openai|anthropic|posthog|twilio|api key for/.test(m)) tool = 'remove_integration_key'
  else if (/revoke/.test(m) && /key/.test(m)) tool = 'revoke_api_key'
  else if (/rotate/.test(m) && /key/.test(m)) tool = 'rotate_api_key'
  else if (/(delete|remove)/.test(m) && /function/.test(m)) tool = 'delete_ai_function'
  else if (/(delete|remove)/.test(m) && /trigger/.test(m)) tool = 'delete_trigger'
  else if (/(delete|remove)/.test(m) && /(cron|scheduled job)/.test(m)) tool = 'delete_cron_job'
  else if (/(delete|remove|unset)/.test(m) && /(env|environment variable|secret)/.test(m)) tool = 'delete_env_var'
  else if (/(disable|turn off)/.test(m) && /realtime/.test(m)) tool = 'disable_realtime'
  else if (/(deploy|publish|ship|go live)/.test(m)) tool = 'trigger_deploy'
  else if (/roll ?back/.test(m)) tool = 'rollback_deploy'
  else if (/block/.test(m) && /user/.test(m)) tool = 'block_end_user'
  else if (/column/.test(m)) tool = 'drop_column'
  else if (/bucket/.test(m)) tool = 'delete_bucket'
  else if (/\bfile\b/.test(m)) tool = 'delete_file'

  const providerMatch = m.match(/\b(stripe|resend|sendgrid|openai|anthropic|posthog|twilio)\b/)
  const label =
    tool === 'drop_column' ? `column ${target}` :
    tool === 'delete_bucket' ? `${target} bucket` :
    tool === 'delete_file' ? `file ${target}` :
    tool === 'remove_integration_key' ? `the ${providerMatch?.[1] ?? target} integration` :
    tool === 'revoke_api_key' || tool === 'rotate_api_key' ? 'an API key' :
    tool === 'delete_ai_function' ? `function ${target}` :
    tool === 'delete_trigger' ? `trigger ${target}` :
    tool === 'delete_cron_job' ? `cron job ${target}` :
    tool === 'delete_env_var' ? `environment variable ${target}` :
    tool === 'disable_realtime' ? `realtime on ${target}` :
    tool === 'trigger_deploy' ? 'production' :
    tool === 'rollback_deploy' ? 'the live deployment' :
    tool === 'block_end_user' ? `end-user ${target}` :
    `${target} table`

  // Recreatable vs. genuinely lost. Credentials are NOT reversible — Backenly
  // holds only the encrypted value and cannot re-derive it once removed.
  const REVERSIBLE = new Set(['drop_table', 'drop_column', 'disable_realtime', 'block_end_user', 'rollback_deploy'])
  return { tool, target: label, rowCount: null, reversible: REVERSIBLE.has(tool) }
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
