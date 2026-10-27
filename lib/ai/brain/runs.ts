/**
 * BUILD RUNS — a backend_chat turn that outlives its call
 * =======================================================
 * A turn used to run inside one HTTP request with a 90 s wall clock, and a
 * whole backend does not fit in 90 s: the agent loop stopped after two or three
 * tables, an architect's design alone can take three minutes, and an MCP client
 * that gives a tool call 60 s cut it sooner. A turn is now a run. It starts in
 * the call that asks for it and keeps going in that process after the call has
 * answered, for up to RUN_LIMITS.maxMs. The call waits RUN_LIMITS.syncWaitMs;
 * a run that is not done by then answers `status: "running"` with its id, and
 * the agent collects the result with backend_chat { "message": "status" } or
 * check_approval { "id" }.
 *
 * ── The record ────────────────────────────────────────────────────────────────
 * A background_jobs row of type `brain_run`, so nothing needs a migration and
 * the generic queue never sees it. While it runs its status is `brain_running`,
 * which no queue sweep selects (the rule PURGE_STATUS in lib/queue/index.ts
 * relies on); it ends `completed` or `failed`, which the pruner collects after
 * seven days. `timeoutAt` is its heartbeat: the process running it pushes it
 * forward every RUN_LIMITS.heartbeatMs, so a row whose heartbeat lapsed belongs
 * to a process that stopped (a deploy, a crash). That run is closed as
 * interrupted, and its request is saved as a resume point "continue" picks up.
 *
 * One run per project, decided under a lock: a second call while one runs joins
 * it rather than starting a second turn on the same schema.
 *
 * ── Words ─────────────────────────────────────────────────────────────────────
 * The request, the changes that landed and the answer are the project's words.
 * A project kept in another region keeps them there (regional bodies, kind
 * `brain_run`), written before the row; its row holds ids, status, counts and
 * codes only.
 */

import { randomUUID } from 'crypto'
import type { BackgroundJob, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { ERROR_CODE, quotesKeptHere } from '@/lib/data-plane/residency'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'
import { recordMcpCall } from '@/lib/mcp/guard'
import { saveLoopResume } from './loop-resume'
import { saveTurn } from './memory'
import { CONTINUE } from './next-call'

export const RUN_JOB_TYPE = 'brain_run'
/** While it runs: a status no queue sweep selects. */
const RUNNING = 'brain_running'
/** A turn that returned, whatever it answered. */
const DONE = 'completed'
/** A run that threw, or whose process stopped. */
const BROKEN = 'failed'
/** The error a run whose heartbeat lapsed is closed with. */
export const INTERRUPTED = 'RUN_INTERRUPTED'
/** The error a run whose turn threw is closed with. */
export const CRASHED = 'RUN_FAILED'

const DEFAULT_LIMITS = {
  /** How long a call waits for its run: under the 60 s many MCP clients give a tool call. */
  syncWaitMs: 45_000,
  /** The longest a run may take: the brain's own deadline. */
  maxMs: 10 * 60_000,
  /** How often a running process says its run is alive. */
  heartbeatMs: 15_000,
  /** A run not heard from for this long belongs to a process that stopped. */
  staleMs: 60_000,
  /** How often a call waiting on a run in another process reads it again. */
  pollMs: 1_000,
}

export const RUN_LIMITS = { ...DEFAULT_LIMITS }

export function setRunLimitsForTests(limits: Partial<typeof DEFAULT_LIMITS> | null): void {
  Object.assign(RUN_LIMITS, DEFAULT_LIMITS, limits ?? {})
}

export type RunState = 'running' | 'completed' | 'failed' | 'interrupted'

/** A run's answer: the body backend_chat answers with, and its HTTP status. */
export interface RunOutcome {
  statusCode: number
  body: Record<string, unknown>
}

export interface Run {
  id: string
  projectId: string
  state: RunState
  startedAt: Date
  completedAt: Date | null
  /** Titles of the changes that landed. Empty when the words stay in the project's region. */
  applied: string[]
  appliedCount: number
  /** What it is doing now. Null when the words stay in the project's region. */
  step: string | null
  /** Its answer has reached an agent. */
  delivered: boolean
  keptInRegion: boolean
}

interface RunPayload {
  userId: string
  keyId: string
  request?: string
  applied?: string[]
  appliedCount: number
  step?: string
  delivered: boolean
  keptInRegion?: true
}

/** What a run in another region keeps there. */
interface RunWords {
  request: string
  applied: string[]
  outcome?: RunOutcome
}

/** Progress as the running process reports it. */
export interface RunProgress {
  applied: string[]
  step?: string
}

/** What the process running a run holds, to report on it. */
export interface RunHandle {
  id: string
  projectId: string
  request: string
  keptInRegion: boolean
  payload: RunPayload
}

// ── Starting ──────────────────────────────────────────────────────────────────

export type StartedRun = { started: true; run: Run; handle: RunHandle } | { started: false; run: Run }

/**
 * Start a run for this project, or find the one already running. A run whose
 * heartbeat lapsed is closed as interrupted first, and its resume point saved.
 */
export async function startRun(input: { projectId: string; userId: string; keyId: string; request: string }): Promise<StartedRun> {
  const id = randomUUID()
  const keptInRegion = !(await quotesKeptHere(input.projectId))
  const bodies = keptInRegion ? await regionalBodiesFor(input.projectId) : null
  if (bodies) await bodies.set('brain_run', id, { payload: { request: input.request, applied: [] } satisfies RunWords })

  const payload: RunPayload = {
    userId: input.userId,
    keyId: input.keyId,
    ...(keptInRegion ? { keptInRegion: true as const } : { request: input.request, applied: [] }),
    appliedCount: 0,
    delivered: false,
  }
  const now = new Date()
  const { existing, created, lapsed } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brain_run:${input.projectId}`}))`
    const current = await tx.backgroundJob.findFirst({
      where: { type: RUN_JOB_TYPE, projectId: input.projectId, status: RUNNING },
      orderBy: { startedAt: 'desc' },
    })
    if (current && !lapsedAt(current, now)) return { existing: current, created: null, lapsed: null }
    const row = await tx.backgroundJob.create({
      data: {
        id,
        type: RUN_JOB_TYPE,
        status: RUNNING,
        projectId: input.projectId,
        payload: payload as unknown as Prisma.InputJsonValue,
        attempts: 1,
        maxAttempts: 1,
        runAt: now,
        startedAt: now,
        timeoutAt: new Date(now.getTime() + RUN_LIMITS.staleMs),
      },
    })
    return { existing: null, created: row, lapsed: current }
  })

  if (lapsed) await closeLapsed(lapsed)
  if (existing) {
    await bodies?.remove('brain_run', [id]).catch(() => {})
    return { started: false, run: toRun(existing) }
  }
  return {
    started: true,
    run: toRun(created!),
    handle: { id, projectId: input.projectId, request: input.request, keptInRegion, payload },
  }
}

// ── Reporting from the process running it ─────────────────────────────────────

/** Say the run is alive, with what has landed so far. Never revives a run already closed. */
export async function touchRun(handle: RunHandle, progress: RunProgress): Promise<void> {
  if (handle.keptInRegion) {
    const bodies = await regionalBodiesFor(handle.projectId)
    await bodies.set('brain_run', handle.id, { payload: { request: handle.request, applied: progress.applied } satisfies RunWords })
  }
  await prisma.backgroundJob.updateMany({
    where: { id: handle.id, status: RUNNING },
    data: {
      timeoutAt: new Date(Date.now() + RUN_LIMITS.staleMs),
      payload: payloadWith(handle, progress) as unknown as Prisma.InputJsonValue,
    },
  })
}

/**
 * Record a run's answer. `crashed` is a turn that threw rather than returned.
 * Written whatever the row says now: the answer is what happened.
 */
export async function finishRun(
  handle: RunHandle,
  outcome: RunOutcome,
  opts: { progress: RunProgress; delivered: boolean; crashed?: boolean },
): Promise<void> {
  const payload = { ...payloadWith(handle, opts.progress), delivered: opts.delivered }
  let result: Record<string, unknown> = { ...outcome }
  if (handle.keptInRegion) {
    const bodies = await regionalBodiesFor(handle.projectId)
    await bodies.set('brain_run', handle.id, {
      payload: { request: handle.request, applied: opts.progress.applied, outcome } satisfies RunWords,
    })
    // The row keeps what an agent can branch on, never the words.
    const code = typeof outcome.body.code === 'string' && ERROR_CODE.test(outcome.body.code) ? outcome.body.code : undefined
    result = { statusCode: outcome.statusCode, ok: outcome.body.ok, ...(code ? { code } : {}), keptInRegion: true }
  }
  await prisma.backgroundJob.update({
    where: { id: handle.id },
    data: {
      status: opts.crashed ? BROKEN : DONE,
      error: opts.crashed ? CRASHED : null,
      completedAt: new Date(),
      timeoutAt: null,
      payload: payload as unknown as Prisma.InputJsonValue,
      result: result as Prisma.InputJsonValue,
    },
  })
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** One run of this project, closing it as interrupted when its heartbeat lapsed. */
export async function getRun(projectId: string, id: string): Promise<Run | null> {
  const row = await prisma.backgroundJob.findFirst({ where: { id, projectId, type: RUN_JOB_TYPE } }).catch(() => null)
  if (!row) return null
  return row.status === RUNNING && lapsedAt(row, new Date()) ? closeLapsed(row) : toRun(row)
}

/** The run in progress on this project, if one is. */
export async function activeRun(projectId: string): Promise<Run | null> {
  const row = await prisma.backgroundJob.findFirst({
    where: { type: RUN_JOB_TYPE, projectId, status: RUNNING },
    orderBy: { startedAt: 'desc' },
  })
  if (!row) return null
  if (lapsedAt(row, new Date())) {
    await closeLapsed(row)
    return null
  }
  return toRun(row)
}

/** The newest run of this project, finished or not. */
export async function latestRun(projectId: string): Promise<Run | null> {
  const row = await prisma.backgroundJob.findFirst({
    where: { type: RUN_JOB_TYPE, projectId },
    orderBy: { startedAt: 'desc' },
  })
  if (!row) return null
  return row.status === RUNNING && lapsedAt(row, new Date()) ? closeLapsed(row) : toRun(row)
}

/**
 * A finished run's answer: as recorded, or, for a run whose process stopped,
 * what landed and the call that finishes it. Null while it runs.
 */
export async function outcomeOf(run: Run): Promise<RunOutcome | null> {
  if (run.state === 'running') return null
  const words = run.keptInRegion ? await wordsOf(run) : null
  if (run.state === 'interrupted') return interruptedOutcome(run, words?.applied ?? run.applied)
  if (words?.outcome) return words.outcome
  const row = await prisma.backgroundJob.findUnique({ where: { id: run.id }, select: { result: true } })
  const recorded = row?.result as unknown as RunOutcome | null
  if (recorded && typeof recorded.statusCode === 'number' && recorded.body && typeof recorded.body === 'object') return recorded
  // Kept in a region that did not answer: say what the row can.
  return {
    statusCode: 503,
    body: {
      ok: false,
      code: 'RUN_RESULT_UNAVAILABLE',
      error:
        `Run ${run.id} finished, but its result is kept in this project's region, which did not answer. ` +
        'read_backend_state shows what it built.',
      retryable: true,
      retryAfterMs: 5_000,
    },
  }
}

/** Mark that a run's answer reached an agent, so "status" stops repeating it. */
export async function markDelivered(id: string): Promise<void> {
  const row = await prisma.backgroundJob.findUnique({ where: { id }, select: { payload: true } }).catch(() => null)
  if (!row) return
  await prisma.backgroundJob
    .update({ where: { id }, data: { payload: { ...(row.payload as object), delivered: true } as Prisma.InputJsonValue } })
    .catch(() => {})
}

// ── Waiting ───────────────────────────────────────────────────────────────────

/** Runs this process is executing, so a call here waits on the promise rather than the table. */
const LOCAL = new Map<string, Promise<unknown>>()

export function trackLocally(id: string, execution: Promise<unknown>): void {
  LOCAL.set(id, execution)
  execution.finally(() => LOCAL.delete(id)).catch(() => {})
}

/** Wait up to `maxWaitMs` for a run to finish, wherever it is running, and return it as it then is. */
export async function waitForRun(projectId: string, id: string, maxWaitMs: number): Promise<Run | null> {
  const deadline = Date.now() + maxWaitMs
  const local = LOCAL.get(id)
  if (local) {
    await Promise.race([local.catch(() => {}), sleep(maxWaitMs)])
    return getRun(projectId, id)
  }
  for (;;) {
    const run = await getRun(projectId, id)
    const left = deadline - Date.now()
    if (!run || run.state !== 'running' || left <= 0) return run
    await sleep(Math.min(RUN_LIMITS.pollMs, left))
  }
}

/** A message that only asks how a run is doing, and is never a request of its own. */
export function isStatusCheck(message: string): boolean {
  return /^\s*(status|check|check status|progress|poll|wait|done|is it done|is it ready|is it finished|any updates?)\s*[.!?]*\s*$/i.test(message)
}

// ── Internals ─────────────────────────────────────────────────────────────────

function lapsedAt(row: Pick<BackgroundJob, 'timeoutAt'>, now: Date): boolean {
  return !row.timeoutAt || row.timeoutAt <= now
}

function payloadWith(handle: RunHandle, progress: RunProgress): RunPayload {
  return {
    ...handle.payload,
    appliedCount: progress.applied.length,
    ...(handle.keptInRegion ? {} : { applied: progress.applied, ...(progress.step ? { step: progress.step } : {}) }),
  }
}

function toRun(row: BackgroundJob): Run {
  const p = (row.payload ?? {}) as Partial<RunPayload>
  const state: RunState =
    row.status === RUNNING ? 'running' : row.status === DONE ? 'completed' : row.error === INTERRUPTED ? 'interrupted' : 'failed'
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    state,
    startedAt: row.startedAt ?? row.createdAt,
    completedAt: row.completedAt,
    applied: Array.isArray(p.applied) ? p.applied : [],
    appliedCount: typeof p.appliedCount === 'number' ? p.appliedCount : 0,
    step: typeof p.step === 'string' ? p.step : null,
    delivered: p.delivered === true,
    keptInRegion: p.keptInRegion === true,
  }
}

async function wordsOf(run: Run): Promise<RunWords | null> {
  const bodies = await regionalBodiesFor(run.projectId).catch(() => null)
  const body = await bodies?.get('brain_run', run.id).catch(() => null)
  return (body?.payload as RunWords | undefined) ?? null
}

/**
 * Close a run whose process stopped. Only the call that closes it saves the
 * resume point, writes the turn into the conversation (where a resumed turn
 * reads the request, in the project's region) and records the outcome.
 */
async function closeLapsed(row: BackgroundJob): Promise<Run> {
  const now = new Date()
  const { count } = await prisma.backgroundJob.updateMany({
    where: { id: row.id, status: RUNNING },
    data: { status: BROKEN, error: INTERRUPTED, completedAt: now, timeoutAt: null },
  })
  const run = toRun({ ...row, status: BROKEN, error: INTERRUPTED, completedAt: now })
  if (count === 1) {
    try {
      const payload = (row.payload ?? {}) as Partial<RunPayload>
      const words = run.keptInRegion ? await wordsOf(run) : { request: payload.request ?? '', applied: run.applied }
      const request = words?.request ?? ''
      const applied = words?.applied ?? []
      if (request) {
        await saveLoopResume(run.projectId, request, applied, 'interrupted')
        await saveTurn(run.projectId, request, interruptedSummary(applied))
      }
      if (payload.keyId && payload.userId) {
        recordMcpCall(
          { keyId: payload.keyId, projectId: run.projectId, userId: payload.userId, endpoint: '/api/mcp/chat', startedAt: run.startedAt.getTime() },
          { statusCode: 500, tool: 'backend_chat', mutation: run.appliedCount > 0, error: INTERRUPTED },
        )
      }
    } catch (err) {
      console.error('[BrainRuns] could not save what an interrupted run left:', err)
    }
  }
  return run
}

function interruptedSummary(applied: string[]): string {
  return (
    `This request stopped when Backenly restarted while it was running` +
    (applied.length ? `, after ${applied.length} change${applied.length === 1 ? '' : 's'}: ${applied.join('; ')}.` : ', before it changed anything.') +
    ` What landed stays in place. Say "continue" to finish it.`
  )
}

function interruptedOutcome(run: Run, applied: string[]): RunOutcome {
  return {
    statusCode: 200,
    body: {
      ok: false,
      code: INTERRUPTED,
      retryable: false,
      summary: interruptedSummary(applied),
      ...(applied.length ? { applied, partial: true } : { partial: false }),
      next: CONTINUE,
      run: { id: run.id, status: 'interrupted' },
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
