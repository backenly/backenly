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
 * Billing: runBrain itself tracks model spend via `trackCompletionCost`
 * (per-completion → `UserAiUsage`) — so backend_chat over MCP is accounted
 * against the user's monthly AI-credit ledger same as dashboard chat. The
 * `mcpGuard` here additionally counts the request against `apiRequestCount`.
 *
 * Hard wall-clock cap at 90s so an MCP host never hangs forever.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'
import { assertAiAllowed } from '@/lib/platform/controls'
import { createApprovalRequest } from '@/lib/mcp/approvals'

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
        },
        (e) => events.push(e),
      ),
      timeoutPromise,
    ])

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

    const body = {
      ok: escalated ? true : result.success,
      /** Set only on escalation, so an agent can branch without parsing prose. */
      ...(escalated ? { status: 'awaiting_approval' as const } : {}),
      summary,
      needsUser: result.needsUser,
      approval,
      iterations: result.iterations,
      toolsRun: result.toolsRun,
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
    let anyFail = false
    for (const e of events) {
      if (e.type === 'tool_done' && e.tool && !NON_MUTATION.test(e.tool)) {
        applied.push(e.title || e.tool)
      }
      if (e.type === 'tool_fail') anyFail = true
    }

    if (timedOut && applied.length > 0 && !anyFail) {
      const summary =
        `Applied ${applied.length} change(s): ${applied.join('; ')}. ` +
        `The run then reached its time budget during final verification, so I'm ` +
        `reporting the applied changes directly — confirm with get_table_schema / ` +
        `get_backend_metadata. Do NOT blindly retry; the change is already in place.`
      recordMcpCall(
        { ...auth, endpoint: ENDPOINT, startedAt },
        { statusCode: 200, tool: 'backend_chat', mutation: true, summary },
      )
      return withCors(NextResponse.json({
        ok: true,
        summary,
        partial: true,
        applied,
        timing: { ms: Date.now() - startedAt },
        events: events.map(condense),
      }))
    }

    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: status, tool: 'backend_chat', error: msg },
    )
    return withCors(NextResponse.json(
      {
        ok: false,
        error: msg,
        code: timedOut ? 'BRAIN_TIMEOUT' : 'BRAIN_FAILED',
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
