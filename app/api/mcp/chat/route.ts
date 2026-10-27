export const dynamic = 'force-dynamic'

/**
 * POST /api/mcp/chat — the Tier-1 mega-tool. Forwards a natural-language
 *                      request through `runBrain`. Same agent that powers
 *                      backenly.com.
 * OPTIONS            — CORS preflight.
 *
 * A request is a run (lib/ai/brain/runs.ts): it starts here and keeps going in
 * this process after the call has answered. The call waits up to
 * RUN_LIMITS.syncWaitMs and answers with the result when the run is done by
 * then, as most requests are. One that is not answers `status: "running"` with
 * its id and what has landed so far, and the agent collects the result by
 * calling again: a message sent while a run is going joins it rather than
 * starting a second turn on the same schema, and "status" returns the newest
 * run's answer once it is done. This replaced a 90 s wall clock that a whole
 * backend did not fit in: a build stopped after two or three tables.
 *
 * The turn itself, its credits and the body it answers with are in
 * lib/mcp/chat-turn.ts, which finishes a run whether or not a call still waits.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall, refuseIfReadOnly } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { assertAiAllowed } from '@/lib/platform-controls'
import { enforceAiCredits } from '@/lib/entitlements/policy'
import { creditAccountOf } from '@/lib/usage/account'
import {
  activeRun,
  getRun,
  isStatusCheck,
  latestRun,
  markDelivered,
  outcomeOf,
  RUN_LIMITS,
  startRun,
  trackLocally,
  waitForRun,
  type Run,
  type RunOutcome,
  type StartedRun,
} from '@/lib/ai/brain/runs'
import { CHAT_ENDPOINT as ENDPOINT, deliveredBody, executeRun, runningBody, type ChatCaller } from '@/lib/mcp/chat-turn'

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
  const caller: ChatCaller = { keyId: auth.keyId, projectId: auth.projectId, userId: auth.userId }

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

  // Parsed before the gates below: a call that collects a running request's
  // result is answered even when they would refuse a new request.
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

  // ── A request already running on this project answers this call ───────────
  const active = await activeRun(auth.projectId).catch(() => null)
  if (active) return withCors(await join(active, parsed.message, caller, startedAt))

  // ── "status" with nothing running: the newest run's answer ────────────────
  if (isStatusCheck(parsed.message)) return withCors(await lastAnswer(caller, startedAt))

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
  // wedge a paying user's agent.
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

  // A run that finished while nobody waited carries what this call's agent
  // still needs to hear: approvals it parked, what it could not do. Read now,
  // before this call's run is the newest; marked heard once that run started.
  const last = await latestRun(auth.projectId).catch(() => null)

  // ── Start the run ─────────────────────────────────────────────────────────
  // A run that cannot be recorded still runs: it answers this call if it is
  // done in time, and otherwise cannot be followed up, which the answer says.
  let started: StartedRun | null = null
  try {
    started = await startRun({ projectId: auth.projectId, userId: auth.userId, keyId: auth.keyId, request: parsed.message })
  } catch (err) {
    console.error('[MCP Chat] could not record a run, so it runs unrecorded:', err)
  }
  if (started && !started.started) return withCors(await join(started.run, parsed.message, caller, startedAt))
  const previous = last && last.state !== 'running' && !last.delivered ? await heard(last) : null

  const execution = executeRun(started?.started ? started.handle : null, {
    caller,
    message: parsed.message,
    creditAccount,
    startedAt,
  })
  if (started?.started) trackLocally(started.handle.id, execution)

  const done = await within(execution, RUN_LIMITS.syncWaitMs)
  if (done) {
    if (!started?.started) return withCors(NextResponse.json(withPrevious(done.body, previous), { status: done.statusCode }))
    await markDelivered(started.handle.id)
    const finished = (await getRun(auth.projectId, started.handle.id).catch(() => null)) ?? started.run
    return withCors(NextResponse.json(withPrevious(deliveredBody(finished, done), previous), { status: done.statusCode }))
  }
  if (!started?.started) return withCors(NextResponse.json(withPrevious(UNRECORDED_RUNNING, previous)))
  const now = (await getRun(auth.projectId, started.handle.id).catch(() => null)) ?? started.run
  return withCors(NextResponse.json(withPrevious(runningBody(now), previous)))
}

/**
 * Answer a call made while a run is going: wait for it, up to the same window a
 * new request gets, and return its result, or where it has got to. A message
 * that was a request of its own was not run, and the answer says so.
 */
async function join(run: Run, message: string, caller: ChatCaller, startedAt: number): Promise<NextResponse> {
  const asked = isStatusCheck(message) ? null : message
  const now = run.state === 'running' ? ((await waitForRun(caller.projectId, run.id, RUN_LIMITS.syncWaitMs)) ?? run) : run
  recordStatusCall(caller, startedAt, now)
  if (now.state === 'running') return NextResponse.json(runningBody(now, { notRun: asked }))
  const outcome = await outcomeOf(now)
  await markDelivered(now.id)
  return NextResponse.json(deliveredBody(now, outcome!, { notRun: asked }), { status: outcome!.statusCode })
}

/** "status" with nothing running: the newest run's answer, or that there is none. */
async function lastAnswer(caller: ChatCaller, startedAt: number): Promise<NextResponse> {
  const last = await latestRun(caller.projectId).catch(() => null)
  if (last?.state === 'running') return join(last, 'status', caller, startedAt)
  recordStatusCall(caller, startedAt, last)
  if (!last) {
    return NextResponse.json({
      ok: true,
      status: 'idle',
      summary: 'Nothing is running on this project, and no request has run through backend_chat here yet.',
      needsUser: false,
    })
  }
  const outcome = await outcomeOf(last)
  await markDelivered(last.id)
  return NextResponse.json(deliveredBody(last, outcome!), { status: outcome!.statusCode })
}

/** A finished run no call has returned, in brief, marked as heard. */
async function heard(last: Run): Promise<Record<string, unknown> | null> {
  const outcome = await outcomeOf(last).catch(() => null)
  if (!outcome) return null
  await markDelivered(last.id)
  const summary = typeof outcome.body.summary === 'string' ? outcome.body.summary : typeof outcome.body.error === 'string' ? outcome.body.error : ''
  return {
    id: last.id,
    status: last.state,
    ok: outcome.body.ok !== false,
    summary: summary.length > 600 ? `${summary.slice(0, 600)}…` : summary,
    ...(outcome.body.approval ? { approval: outcome.body.approval } : {}),
    ...(outcome.body.next ? { next: outcome.body.next } : {}),
  }
}

function withPrevious(body: Record<string, unknown>, previous: Record<string, unknown> | null): Record<string, unknown> {
  return previous ? { ...body, previousRun: previous } : body
}

/**
 * A call that only collected a run is a read, under its own tool name: the
 * admin ledger counts a 2xx `backend_chat` row as work applied, and the run's
 * own row (written when it ends) already stands for that work.
 */
function recordStatusCall(caller: ChatCaller, startedAt: number, run: Run | null): void {
  recordMcpCall(
    { ...caller, endpoint: ENDPOINT, startedAt },
    { statusCode: 200, tool: 'backend_chat.status', mutation: false, summary: run ? `run ${run.id.slice(0, 8)} ${run.state}` : 'no run' },
  )
}

/** The answer for a run still going that could not be recorded, so cannot be followed up. */
const UNRECORDED_RUNNING: Record<string, unknown> = {
  ok: true,
  status: 'running',
  summary:
    'Backenly is still working on this request and keeps going on its own, but could not record it, so this ' +
    'call cannot be followed up. read_backend_state in a few minutes shows what it built.',
  next: {
    tool: 'read_backend_state',
    arguments: {},
    why: 'The request keeps running unrecorded; the live state is where its result shows.',
    afterMs: 60_000,
  },
  needsUser: false,
}

/** The run's outcome if it finishes within `ms`, otherwise null. */
function within(execution: Promise<RunOutcome>, ms: number): Promise<RunOutcome | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
    execution.then(
      (outcome) => {
        clearTimeout(timer)
        resolve(outcome)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
