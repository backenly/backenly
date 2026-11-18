/**
 * IMPORT JOBS — moving a backend into a new project, as a job that outlives
 * the request that starts it
 * ========================================================================
 *
 * POST /api/import creates the NEW project through the normal creation path
 * (the organization's owner/admin, its plan limit, an open region) and starts
 * the driver in this process; the console polls GET /api/import/{jobId}.
 *
 * ── The record ────────────────────────────────────────────────────────────────
 * A background_jobs row of type `import`, so nothing needs a migration and the
 * generic queue never sees it: while it runs its status is `import_running`,
 * which no queue sweep selects (the rule PURGE_STATUS in lib/queue/index.ts
 * relies on), and it ends `completed` or `failed`, which the pruner collects
 * after seven days. The ImportProgress the console reads lives in its payload,
 * beside the org, the person and what to include. NEVER the connection: the
 * credentials are held in this process's memory for the job's life and are
 * gone when it ends (lib/import/redact.ts keeps them out of every message).
 *
 * `timeoutAt` is a lease, as in lib/ai/brain/runs.ts: the process running the
 * job pushes it forward with every write (at most one a second while the
 * import moves, one every ten seconds while it waits), so a row whose lease
 * lapsed belongs to a process that stopped (a deploy, a crash). It is closed
 * as failed with the restart sentence the spec gives, the next time anyone
 * reads it. The half-filled project stays; the person can delete it.
 *
 * Cancelling: the process running the job aborts it at once; any other
 * process marks the row (`error = IMPORT_CANCEL_REQUESTED`) and the running
 * process sees the mark at its next write.
 *
 * ── History ──────────────────────────────────────────────────────────────────
 * Everything the import changes is attributed to source `import`, grouped
 * `import:<jobId>` (lib/changes/attribution.ts): the opening change creates
 * the tables, the closing one adds keys and buckets. The start and the finish
 * are also audit rows (IMPORT_STARTED / IMPORT_FINISHED / IMPORT_FAILED /
 * IMPORT_CANCELED) for the activity feed.
 */

import { randomUUID } from 'crypto'
import type { BackgroundJob, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { ImportConnection, ImportedFrom, ImportProgress, ImportSourceId, ImportStartRequest } from './contract'
import { ImportInputError, type ImportDriver, type ImportLimits, type RunContext } from './driver'
import { initialProgress, mergeProgress, type ProgressPatch } from './progress'
import { redactedMessage, secretsOf } from './redact'
import { driverFor, sourceName } from './registry'
import { ImportAborted } from './pg-engine'
import { IMPORT_GATE, LOOK_GATE, withSlot } from './gate'

export const IMPORT_JOB_TYPE = 'import'
/** While it runs: a status no queue sweep selects. */
const RUNNING = 'import_running'
const DONE = 'completed'
const BROKEN = 'failed'

export const IMPORT_ERRORS = {
  failed: 'IMPORT_FAILED',
  canceled: 'IMPORT_CANCELED',
  interrupted: 'IMPORT_INTERRUPTED',
  cancelRequested: 'IMPORT_CANCEL_REQUESTED',
} as const

const DEFAULT_LIMITS = {
  /** The longest an import may run. */
  maxMs: 2 * 60 * 60_000,
  /** At most one progress write this often. */
  flushMs: 1_000,
  /** A write at least this often while nothing moves, so the lease stays fresh. */
  heartbeatMs: 10_000,
  /** A job not heard from for this long belongs to a process that stopped. */
  staleMs: 60_000,
  /** How long the quick check before creating the project may take. */
  checkMs: 60_000,
  /** How long a look at a source (the preview, the check) waits for its slot before it is refused. */
  lookWaitMs: 30_000,
}

export const IMPORT_LIMITS = { ...DEFAULT_LIMITS }

export function setImportLimitsForTests(limits: Partial<typeof DEFAULT_LIMITS> | null): void {
  Object.assign(IMPORT_LIMITS, DEFAULT_LIMITS, limits ?? {})
}

/** The sentence a job whose process stopped is closed with. */
export function restartMessage(source: ImportSourceId): string {
  return `The import stopped when the server restarted. Start it again; nothing in ${sourceName(source)} changed.`
}

interface JobPayload {
  orgId: string
  userId: string
  source: ImportSourceId
  include: { users: boolean; files: boolean }
  progress: ImportProgress
}

/** A refusal to create the project, said the way POST /api/projects says it. */
export class ImportRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly extra: Record<string, unknown> = {},
    /** Response headers the refusal carries (Retry-After for a spent budget). */
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'ImportRefusedError'
  }
}

/**
 * Reading a source to preview or check it takes one of this process's look
 * slots (lib/import/gate.ts LOOK_GATE), so previews cannot pile up beside a
 * running import, each holding a source's answers in memory. Refused like a
 * full import line when no slot frees up in time; nothing was read.
 */
function lookAtSource<T>(fn: () => Promise<T>): Promise<T> {
  return withSlot(
    LOOK_GATE,
    {
      waitMs: IMPORT_LIMITS.lookWaitMs,
      busy: () =>
        new ImportRefusedError(
          503,
          'Backenly is reading other sources right now. Try again in a minute; nothing was read or created.',
          'IMPORT_BUSY',
          {},
          { 'Retry-After': '60' },
        ),
    },
    fn,
  )
}

// ── Jobs this process runs ────────────────────────────────────────────────────

interface LocalJob {
  controller: AbortController
  progress: () => ImportProgress
  done: Promise<void>
}

const LOCAL = new Map<string, LocalJob>()

// ── Starting ──────────────────────────────────────────────────────────────────

/**
 * Check the source, create the new project, record the job and start it here.
 * Throws ImportInputError (a field to fix) or ImportRefusedError (the plan,
 * the organization, the region) before anything is created.
 */
export async function startImport(
  input: ImportStartRequest & { userId: string },
  opts: {
    /**
     * Spend the organization's start budget. Called once the caller is known
     * to be allowed to create a project there, so someone who may not start
     * an import cannot use up the budget of the people who may.
     */
    spendBudget?: () => Promise<void>
  } = {},
): Promise<{ jobId: string; projectId: string }> {
  const source = input.connection.source
  const driver = await driverFor(source)
  if (!driver) throw new ImportRefusedError(400, `Moving from ${source} is not available.`, 'IMPORT_SOURCE_UNAVAILABLE')

  const { checkRequestedRegion } = await import('@/lib/regions')
  const region = checkRequestedRegion(input.region, process.env, input.userId)
  if (region.ok === false) throw new ImportInputError(region.message, 'region')

  const account = await creationAccountFor(input.userId, input.orgId, { initialize: true })
  // One import runs at a time in this process and a few more wait their turn
  // (lib/import/gate.ts). With the line full, refuse now, before the budget is
  // spent or anything is created.
  if (!IMPORT_GATE.hasRoom() || (driver.check && !LOOK_GATE.hasRoom())) {
    throw new ImportRefusedError(
      503,
      'Backenly is moving other projects in right now. Try again in a few minutes; nothing was created.',
      'IMPORT_BUSY',
      {},
      { 'Retry-After': '120' },
    )
  }
  await opts.spendBudget?.()
  const limits = await limitsForAccount(account)

  const check = driver.check
  if (check) {
    await lookAtSource(() => {
      const signal = AbortSignal.timeout(IMPORT_LIMITS.checkMs)
      return check.call(driver, input.connection as any, { userId: input.userId, orgId: input.orgId, signal, limits })
    })
  }

  // The normal creation path: the organization's owner owns it, its plan counts it, its region holds it.
  const { getProjectLifecycle } = await import('@/lib/edition')
  const { project } = await getProjectLifecycle().create({
    name: input.name,
    description: `Moved in from ${sourceName(source)}`,
    userId: input.userId,
    organizationId: account.organizationId,
    region: region.region,
  })

  const jobId = randomUUID()
  const now = new Date()
  const progress = initialProgress({
    jobId,
    projectId: project.id,
    projectName: project.name,
    region: project.region ?? region.region,
    orgId: input.orgId,
    source,
    startedAt: now,
    phase: 'tables',
    status: 'queued',
  })
  const payload: JobPayload = { orgId: input.orgId, userId: input.userId, source, include: input.include, progress }
  await prisma.backgroundJob.create({
    data: {
      id: jobId,
      type: IMPORT_JOB_TYPE,
      status: RUNNING,
      projectId: project.id,
      payload: payload as unknown as Prisma.InputJsonValue,
      attempts: 1,
      maxAttempts: 1,
      runAt: now,
      startedAt: now,
      timeoutAt: new Date(now.getTime() + IMPORT_LIMITS.staleMs),
    },
  })
  await audit(project.id, input.userId, 'IMPORT_STARTED', { jobId, source, sentence: `Started moving in from ${sourceName(source)}` })

  const recordProduct = await import('@/lib/platform-signals').then((m) => m.recordProductEvent).catch(() => null)
  recordProduct?.({ type: 'project_created', userId: input.userId, projectId: project.id, metadata: { name: project.name, importedFrom: source } })

  runInThisProcess({
    jobId,
    projectId: project.id,
    payload,
    driver,
    connection: input.connection,
    limits,
  })
  return { jobId, projectId: project.id }
}

/** Who the new project would belong to, refusing like POST /api/projects. */
async function creationAccountFor(userId: string, orgId: string, opts: { initialize: boolean }) {
  const { projectCreationVerdict } = await import('@/lib/projects/creation-verdict')
  const verdict = await projectCreationVerdict(userId, orgId, opts)
  if (verdict.allowed === false) {
    const refused = verdict as Extract<typeof verdict, { allowed: false }>
    // An account with no entitlements yet gets them when it creates; asking is not refused for it.
    if (!opts.initialize) {
      const { noEntitlements } = await import('@/lib/entitlements/policy')
      if (refused.currentPlan === noEntitlements().currentPlan) return { ownerId: userId, organizationId: orgId }
    }
    const { status, error, code, ...extra } = refused as any
    delete extra.allowed
    throw new ImportRefusedError(status, error, code, extra)
  }
  const allowed = verdict as Extract<typeof verdict, { allowed: true }>
  return { ownerId: allowed.ownerId, organizationId: allowed.organizationId }
}

async function limitsForAccount(account: { ownerId: string; organizationId: string | null }): Promise<ImportLimits> {
  const { limitsFor } = await import('./limits')
  return limitsFor(account.organizationId ?? account.ownerId)
}

/**
 * The Review step: who may move a backend into this organization (its owners
 * and admins, as for creating any project), then the driver's own read-only look.
 */
export async function inspectImport(input: { userId: string; orgId: string; connection: ImportConnection }) {
  const source = input.connection.source
  const driver = await driverFor(source)
  if (!driver) throw new ImportRefusedError(400, `Moving from ${source} is not available.`, 'IMPORT_SOURCE_UNAVAILABLE')
  const account = await creationAccountFor(input.userId, input.orgId, { initialize: false })
  const limits = await limitsForAccount(account)
  try {
    return await lookAtSource(() => {
      // Five minutes of reading, from when the slot is held.
      const signal = AbortSignal.timeout(5 * 60_000)
      return driver.inspect(input.connection as any, { userId: input.userId, orgId: input.orgId, signal, limits })
    })
  } catch (err) {
    throw sayable(err, input.connection)
  }
}

/** An error safe to answer with: an ImportInputError keeps its field; anything else says only redacted words. */
export function sayable(err: unknown, connection: ImportConnection | null): Error {
  const secrets = secretsOf(connection)
  if (err instanceof ImportInputError) return new ImportInputError(redactedMessage(err, secrets), err.field)
  if (err instanceof ImportRefusedError) return err
  if ((err as any)?.name === 'TimeoutError' || (err as any)?.name === 'AbortError') {
    return new ImportInputError('Reading the source took too long. Try again, or move a smaller part of it.')
  }
  return new Error(redactedMessage(err, secrets) || 'The source could not be read.')
}

// ── Running ───────────────────────────────────────────────────────────────────

function runInThisProcess(input: {
  jobId: string
  projectId: string
  payload: JobPayload
  driver: ImportDriver
  connection: ImportConnection
  limits: ImportLimits
}): void {
  const controller = new AbortController()
  let progress = input.payload.progress
  const done = execute(input, controller, {
    get: () => progress,
    set: (p) => {
      progress = p
    },
  })
    .catch((err) => console.error(`[Import] job ${input.jobId} could not record its end:`, redactedMessage(err, secretsOf(input.connection))))
    .finally(() => LOCAL.delete(input.jobId))
  LOCAL.set(input.jobId, { controller, progress: () => progress, done })
}

async function execute(
  input: { jobId: string; projectId: string; payload: JobPayload; driver: ImportDriver; connection: ImportConnection; limits: ImportLimits },
  controller: AbortController,
  state: { get: () => ImportProgress; set: (p: ImportProgress) => void },
): Promise<void> {
  const { jobId, projectId, payload, driver, connection } = input
  const secrets = secretsOf(connection)
  let deadline: ReturnType<typeof setTimeout> | undefined
  let release: (() => void) | undefined

  let dirty = true
  let lastWrite = 0
  let writing = false
  const write = async (force: boolean) => {
    if (writing) return
    const now = Date.now()
    if (!force && !dirty && now - lastWrite < IMPORT_LIMITS.heartbeatMs) return
    if (!force && now - lastWrite < IMPORT_LIMITS.flushMs) return
    writing = true
    dirty = false
    lastWrite = now
    try {
      await prisma.backgroundJob.updateMany({
        where: { id: jobId, status: RUNNING },
        data: {
          payload: { ...payload, progress: state.get() } as unknown as Prisma.InputJsonValue,
          timeoutAt: new Date(Date.now() + IMPORT_LIMITS.staleMs),
        },
      })
      const row = await prisma.backgroundJob.findUnique({ where: { id: jobId }, select: { error: true } })
      if (row?.error === IMPORT_ERRORS.cancelRequested && !controller.signal.aborted) controller.abort(new ImportAborted('canceled'))
    } catch (err) {
      dirty = true
      console.warn(`[Import] job ${jobId}: progress not written:`, redactedMessage(err, secrets, 200))
    } finally {
      writing = false
    }
  }
  const ticker = setInterval(() => void write(false), Math.min(IMPORT_LIMITS.flushMs, 1_000))

  const ctx: RunContext = {
    userId: payload.userId,
    orgId: payload.orgId,
    signal: controller.signal,
    limits: input.limits,
    projectId,
    jobId,
    include: payload.include,
    progress: (patch: ProgressPatch) => {
      state.set(mergeProgress(state.get(), patch))
      dirty = true
    },
  }

  const { withChangeAttribution } = await import('@/lib/changes/attribution')
  try {
    // Wait for this process's import slot (lib/import/gate.ts); the place in
    // line is on the progress the console polls. The two hours start now.
    release = await IMPORT_GATE.acquire(jobId, controller.signal, (place) => {
      state.set({ ...state.get(), status: 'queued', queuePosition: place })
      dirty = true
    })
    // The clock starts with the move: "Took 2 s" means the move, not the wait in line.
    state.set({ ...state.get(), status: 'running', queuePosition: null, startedAt: new Date().toISOString() })
    dirty = true
    deadline = setTimeout(() => controller.abort(new ImportAborted('timeout')), IMPORT_LIMITS.maxMs)
    const result = await withChangeAttribution(
      { source: 'import', actorUserId: payload.userId, apiKeyId: null, groupId: `import:${jobId}` },
      () => driver.run(connection as any, ctx),
    )
    const importedFrom = normalizeImportedFrom(result.importedFrom, payload.source)
    const finished = mergeProgress(state.get(), { phase: 'finished', warnings: result.warnings.map((w) => redactedMessage(w, secrets, 600)), rulesPending: importedFrom.rulesPending })
    state.set({ ...finished, status: 'done', finishedAt: new Date().toISOString(), error: null })
    // Where it came from, on the project the Projects page lists.
    await prisma.project.update({ where: { id: projectId }, data: { importedFrom: importedFrom as unknown as Prisma.InputJsonValue } })
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: DONE,
        error: null,
        completedAt: new Date(),
        timeoutAt: null,
        payload: { ...payload, progress: state.get() } as unknown as Prisma.InputJsonValue,
        result: importedFrom as unknown as Prisma.InputJsonValue,
      },
    })
    await audit(projectId, payload.userId, 'IMPORT_FINISHED', {
      jobId,
      source: payload.source,
      tables: importedFrom.tables,
      rows: importedFrom.rows,
      users: importedFrom.users ?? null,
      files: importedFrom.files ?? null,
      rulesPending: importedFrom.rulesPending,
      sentence: `Moved in from ${sourceName(payload.source)}: ${importedFrom.tables} table${importedFrom.tables === 1 ? '' : 's'}, ${importedFrom.rows.toLocaleString('en-US')} row${importedFrom.rows === 1 ? '' : 's'}`,
    })
  } catch (err) {
    const aborted = err instanceof ImportAborted ? err : controller.signal.reason instanceof ImportAborted ? controller.signal.reason : null
    const canceled = aborted?.reason === 'canceled'
    const message = canceled
      ? release
        ? `Canceled. Nothing in ${sourceName(payload.source)} changed; what arrived stays in the new project, which you can delete.`
        : `Canceled before it started. Nothing in ${sourceName(payload.source)} changed, and the new project is empty; you can delete it.`
      : aborted?.reason === 'timeout'
        ? `The import ran for ${Math.round(IMPORT_LIMITS.maxMs / 3_600_000)} hours and was stopped. Nothing in ${sourceName(payload.source)} changed.`
        : failureMessage(err, secrets)
    state.set({ ...state.get(), status: canceled ? 'canceled' : 'failed', finishedAt: new Date().toISOString(), error: message })
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: BROKEN,
        error: canceled ? IMPORT_ERRORS.canceled : IMPORT_ERRORS.failed,
        completedAt: new Date(),
        timeoutAt: null,
        payload: { ...payload, progress: state.get() } as unknown as Prisma.InputJsonValue,
      },
    })
    await audit(projectId, payload.userId, canceled ? 'IMPORT_CANCELED' : 'IMPORT_FAILED', {
      jobId,
      source: payload.source,
      sentence: canceled ? `Canceled moving in from ${sourceName(payload.source)}` : `Moving in from ${sourceName(payload.source)} stopped: ${message}`,
    })
  } finally {
    clearInterval(ticker)
    if (deadline) clearTimeout(deadline)
    release?.()
  }
}

function failureMessage(err: unknown, secrets: readonly string[]): string {
  const text = redactedMessage(err, secrets, 400)
  if (err instanceof ImportInputError) return text
  if (!text) return 'The import stopped.'
  return /^(Couldn't|Backenly|Copying|The |Supabase|Firebase|Reading|There )/.test(text) ? text : `The import stopped: ${text}`
}

function normalizeImportedFrom(raw: ImportedFrom, source: ImportSourceId): ImportedFrom {
  return {
    source: raw.source ?? source,
    at: raw.at ?? new Date().toISOString(),
    tables: Number(raw.tables) || 0,
    rows: Number(raw.rows) || 0,
    ...(raw.users !== undefined ? { users: Number(raw.users) || 0 } : {}),
    ...(raw.files !== undefined ? { files: Number(raw.files) || 0 } : {}),
    rulesPending: Number(raw.rulesPending) || 0,
  }
}

// ── Reading ───────────────────────────────────────────────────────────────────

function payloadOf(row: Pick<BackgroundJob, 'payload'>): JobPayload {
  return (row.payload ?? {}) as unknown as JobPayload
}

/** The job's progress as the console reads it, closing it first when its lease lapsed. */
async function progressOf(row: BackgroundJob): Promise<ImportProgress> {
  const local = LOCAL.get(row.id)
  if (local && row.status === RUNNING) return local.progress()
  if (row.status === RUNNING && (!row.timeoutAt || row.timeoutAt <= new Date())) return closeLapsed(row)
  const p = payloadOf(row).progress
  return { ...p, status: row.status === RUNNING ? 'running' : p.status }
}

/** Close a job whose process stopped. Only the call that closes it writes its end. */
async function closeLapsed(row: BackgroundJob): Promise<ImportProgress> {
  const payload = payloadOf(row)
  const now = new Date()
  const progress: ImportProgress = {
    ...payload.progress,
    status: 'failed',
    finishedAt: now.toISOString(),
    error: restartMessage(payload.source),
  }
  const { count } = await prisma.backgroundJob.updateMany({
    where: { id: row.id, status: RUNNING },
    data: {
      status: BROKEN,
      error: IMPORT_ERRORS.interrupted,
      completedAt: now,
      timeoutAt: null,
      payload: { ...payload, progress } as unknown as Prisma.InputJsonValue,
    },
  })
  if (count === 1 && row.projectId) {
    await audit(row.projectId, payload.userId, 'IMPORT_FAILED', { jobId: row.id, source: payload.source, sentence: progress.error })
  } else if (count === 0) {
    const fresh = await prisma.backgroundJob.findUnique({ where: { id: row.id } })
    if (fresh) return payloadOf(fresh).progress
  }
  return progress
}

/** One import job, or null when it does not exist or is not an import. */
export async function getImportJob(jobId: string): Promise<{ progress: ImportProgress; projectId: string | null; orgId: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null
  const row = await prisma.backgroundJob.findFirst({ where: { id: jobId, type: IMPORT_JOB_TYPE } })
  if (!row) return null
  return { progress: await progressOf(row), projectId: row.projectId, orgId: payloadOf(row).orgId }
}

/** The organization's running imports and those that ended in the last 24 hours, newest first. */
export async function listImportJobs(orgId: string): Promise<Array<{ progress: ImportProgress; projectId: string | null }>> {
  const since = new Date(Date.now() - 24 * 60 * 60_000)
  const rows = await prisma.backgroundJob.findMany({
    where: {
      type: IMPORT_JOB_TYPE,
      payload: { path: ['orgId'], equals: orgId },
      OR: [{ status: RUNNING }, { completedAt: { gte: since } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const out: Array<{ progress: ImportProgress; projectId: string | null }> = []
  for (const row of rows) out.push({ progress: await progressOf(row), projectId: row.projectId })
  return out
}

/**
 * Ask a running import to stop. Here: at once. Elsewhere: at that process's
 * next write. Returns the progress as it then is.
 */
export async function cancelImportJob(jobId: string): Promise<ImportProgress | null> {
  const local = LOCAL.get(jobId)
  if (local) {
    if (!local.controller.signal.aborted) local.controller.abort(new ImportAborted('canceled'))
    // The job ends at its next check between batches; give it a moment to say so.
    await Promise.race([local.done, new Promise((r) => setTimeout(r, 3_000))])
  } else {
    await prisma.backgroundJob.updateMany({
      where: { id: jobId, type: IMPORT_JOB_TYPE, status: RUNNING },
      data: { error: IMPORT_ERRORS.cancelRequested },
    })
  }
  return (await getImportJob(jobId))?.progress ?? null
}

/** For tests: wait for a job this process runs to end. */
export async function waitForImportJob(jobId: string): Promise<void> {
  await LOCAL.get(jobId)?.done
}

// ── Audit ─────────────────────────────────────────────────────────────────────

async function audit(projectId: string, userId: string, action: string, details: Record<string, unknown>): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        projectId,
        userId,
        action,
        type: 'import',
        details: JSON.stringify({ ...details, at: new Date().toISOString() }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})
}
