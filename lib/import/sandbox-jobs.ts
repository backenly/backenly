/**
 * IMPORT JOBS IN THE SANDBOX — the control plane's half of every look and
 * import whose source is read in a sandbox task (lib/import/sandbox.ts)
 * =========================================================================
 *
 * The records are lib/import/jobs.ts's (background_jobs rows), with the
 * sandbox's state in `payload.sandbox`:
 *
 *   a look     type `import_look`: launched by POST /api/import/inspect, read
 *              by GET /api/import/inspect/{lookId}; ends with the preview or a
 *              refusal, both kept in the row for the person who asked
 *   an import  type `import`: launched by POST /api/import, its start read by
 *              GET /api/import/{jobId}/start. The task checks the source, the
 *              control plane creates the project (stage `creating`), then the
 *              task moves the source in (stage `running`), reporting progress
 *
 * Every task call comes through lib/import/worker-api.ts, which proves the job
 * (its token) before anything here runs. A job ends exactly once: every end is
 * a write conditioned on the row still running, and it wipes the sealed
 * connection and the token's hash, so the task can do nothing more.
 *
 * The lease is lib/import/jobs.ts's: a running row's `timeoutAt` moves forward
 * with every task call; one that lapses belongs to a task that stopped, and is
 * closed (and its task stopped) the next time anyone reads it. Before its
 * first call a task has START_GRACE_MS to start.
 */

import { randomUUID } from 'crypto'
import type { BackgroundJob, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { CloudRegionId } from '@/lib/regions'
import type { ImportConnection, ImportedFrom, ImportPhase, ImportPreview, ImportProgress, ImportSourceId } from './contract'
import { ImportInputError, type ImportLimits } from './driver'
import {
  IMPORT_ERRORS,
  IMPORT_JOB_TYPE,
  IMPORT_LIMITS,
  ImportRefusedError,
  JOB_STATUS,
  auditImport,
  failureMessage,
  normalizeImportedFrom,
  recordProjectSize,
} from './jobs'
import { initialProgress, mergeProgress, type ProgressPatch } from './progress'
import { redact, redactedMessage, secretsOf } from './redact'
import { sourceName } from './registry'
import { newJobToken, sandboxLauncher, sealConnection, unsealConnection, type SealedConnection } from './sandbox'
import { PROTOCOL, type WorkerFailure, type WorkerKind, type WorkerSpec } from './worker/protocol'

export const LOOK_JOB_TYPE = 'import_look'

/** How long a task may take to start and make its first call. */
export const START_GRACE_MS = 4 * 60_000

/** At most this many tasks at once: everywhere, per organization, and per person whatever their organizations. */
export const SANDBOX_CAPS = { looks: 10, imports: 6, looksPerOrg: 3, importsPerOrg: 1, looksPerUser: 3, importsPerUser: 1 }

export type SandboxStage = 'launching' | 'reading' | 'checking' | 'creating' | 'running' | 'ended'

/** What a task may do once per job. */
export type OnceStep = 'tables' | 'schema' | 'rules' | 'users' | 'bucket'

export interface SandboxState {
  kind: WorkerKind
  /** SHA-256 of the job's token; null once the job ended. */
  tokenHash: string | null
  /** The source's connection, sealed; null once the job ended. */
  sealed: SealedConnection | null
  /** The connection was handed to the task (it is handed once). */
  handed: boolean
  taskArn: string | null
  stage: SandboxStage
  /** When the task must have finished. */
  deadlineAt: string
  limits: ImportLimits
  /** Steps a task may take once, taken. */
  once?: Partial<Record<OnceStep, boolean>>
}

/** A refusal kept for the person who asked, said as the routes say one (lib/import/http.ts errorResponse). */
export interface StoredRefusal {
  status: number
  error: string
  field?: string
  code?: string
  extra?: Record<string, unknown>
}

interface LookPayload {
  orgId: string
  userId: string
  source: ImportSourceId
  sandbox: SandboxState
  preview: ImportPreview | null
  refusal: StoredRefusal | null
}

export interface ImportPayload {
  orgId: string
  userId: string
  source: ImportSourceId
  include: { users: boolean; files: boolean }
  progress: ImportProgress
  /** The new project's name and region, and whose it is: created once the source passes its check. */
  name: string
  region: string
  owner: { ownerId: string; organizationId: string | null }
  sandbox: SandboxState
  refusal: StoredRefusal | null
}

export type SandboxPayload = LookPayload | ImportPayload

export function sandboxOf(row: Pick<BackgroundJob, 'payload'>): SandboxState | null {
  const s = (row.payload as any)?.sandbox
  return s && typeof s === 'object' ? (s as SandboxState) : null
}

const SAID = {
  busy: 'Backenly is reading other sources right now. Try again in a minute; nothing was read or created.',
  unavailable: 'Backenly could not start reading the source. Try again in a minute; nothing was read or created.',
  stopped: 'Reading the source stopped before it finished. Try again; nothing was created.',
  generic: 'Something went wrong on our side. Try again in a minute.',
}

// ── Room ──────────────────────────────────────────────────────────────────────

type JobCounter = Pick<typeof prisma, 'backgroundJob'>

/** Whether the sandbox is full for a new task of this kind: everywhere, for this organization, or for this person. */
async function sandboxFull(db: JobCounter, kind: WorkerKind, orgId: string, userId: string): Promise<boolean> {
  const type = kind === 'look' ? LOOK_JOB_TYPE : IMPORT_JOB_TYPE
  // Every job still running counts until it is closed (sweepImportSandbox closes a lapsed one within a minute),
  // so a task that stops reporting keeps its place, its organization's and its person's, until its task is stopped.
  const live = { type, status: JOB_STATUS.running }
  const [all, org, user] = await Promise.all([
    db.backgroundJob.count({ where: live }),
    db.backgroundJob.count({ where: { ...live, payload: { path: ['orgId'], equals: orgId } } }),
    db.backgroundJob.count({ where: { ...live, payload: { path: ['userId'], equals: userId } } }),
  ])
  return kind === 'look'
    ? all >= SANDBOX_CAPS.looks || org >= SANDBOX_CAPS.looksPerOrg || user >= SANDBOX_CAPS.looksPerUser
    : all >= SANDBOX_CAPS.imports || org >= SANDBOX_CAPS.importsPerOrg || user >= SANDBOX_CAPS.importsPerUser
}

function sandboxBusy(kind: WorkerKind): ImportRefusedError {
  return new ImportRefusedError(
    503,
    kind === 'look' ? SAID.busy : 'Backenly is moving other projects in right now. Try again in a few minutes; nothing was created.',
    'IMPORT_BUSY',
    {},
    { 'Retry-After': kind === 'look' ? '60' : '120' },
  )
}

/** Refuse a new task when the sandbox is full, everywhere, for this organization or for this person. */
export async function assertSandboxRoom(kind: WorkerKind, orgId: string, userId: string): Promise<void> {
  if (await sandboxFull(prisma, kind, orgId, userId)) throw sandboxBusy(kind)
}

/**
 * Create a sandbox job only while there is room: counted and created under one
 * lock, so starts sent together cannot pass the caps together.
 */
async function createWithinRoom(kind: WorkerKind, orgId: string, userId: string, data: Prisma.BackgroundJobUncheckedCreateInput): Promise<void> {
  let full: boolean
  try {
    full = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('backenly:import-sandbox-room'))`
        if (await sandboxFull(tx, kind, orgId, userId)) return true
        await tx.backgroundJob.create({ data })
        return false
      },
      { maxWait: 10_000, timeout: 15_000 },
    )
  } catch (err) {
    // Starts queued behind the lock past its wait: as busy as a full sandbox, and nothing was created.
    if ((err as { code?: string })?.code === 'P2028') throw sandboxBusy(kind)
    throw err
  }
  if (full) throw sandboxBusy(kind)
}

// ── Starting ──────────────────────────────────────────────────────────────────

async function launch(jobId: string, kind: WorkerKind, token: string): Promise<void> {
  const launcher = sandboxLauncher()
  if (!launcher) throw new ImportRefusedError(503, SAID.unavailable, 'IMPORT_UNAVAILABLE', {}, { 'Retry-After': '300' })
  try {
    const { taskArn } = await launcher.launch({ jobId, kind, token })
    if (taskArn) await setSandbox(jobId, ['taskArn'], taskArn)
  } catch (err) {
    console.error(`[Import] job ${jobId}: the sandbox task did not start:`, redactedMessage(err, [], 300))
    await endJob(jobId, { refusal: { status: 503, error: SAID.unavailable, code: 'IMPORT_UNAVAILABLE' }, error: IMPORT_ERRORS.failed })
    throw new ImportRefusedError(503, SAID.unavailable, 'IMPORT_UNAVAILABLE', {}, { 'Retry-After': '300' })
  }
}

function newSandbox(kind: WorkerKind, hash: string, sealed: SealedConnection, deadline: Date, limits: ImportLimits): SandboxState {
  return { kind, tokenHash: hash, sealed, handed: false, taskArn: null, stage: 'launching', deadlineAt: deadline.toISOString(), limits }
}

/** The Review step's read, in a task of its own. The person polls readLook for the answer. */
export async function startLook(input: {
  userId: string
  orgId: string
  connection: ImportConnection
  limits: ImportLimits
}): Promise<{ lookId: string }> {
  await assertSandboxRoom('look', input.orgId, input.userId)
  const lookId = randomUUID()
  const { token, hash } = newJobToken(lookId)
  const now = new Date()
  const deadline = new Date(now.getTime() + START_GRACE_MS + IMPORT_LIMITS.inspectMs)
  const payload: LookPayload = {
    orgId: input.orgId,
    userId: input.userId,
    source: input.connection.source,
    sandbox: newSandbox('look', hash, await sealConnection(input.connection), deadline, input.limits),
    preview: null,
    refusal: null,
  }
  await createWithinRoom('look', input.orgId, input.userId, {
    id: lookId,
    type: LOOK_JOB_TYPE,
    status: JOB_STATUS.running,
    payload: payload as unknown as Prisma.InputJsonValue,
    attempts: 1,
    maxAttempts: 1,
    runAt: now,
    startedAt: now,
    timeoutAt: new Date(now.getTime() + START_GRACE_MS),
  })
  await launch(lookId, 'look', token)
  return { lookId }
}

export type LookAnswer = { state: 'reading' } | { state: 'done'; preview: ImportPreview } | { state: 'refused'; refusal: StoredRefusal }

/** A look, for the person who asked for it; null for anyone else or no such look. */
export async function readLook(lookId: string, userId: string): Promise<LookAnswer | null> {
  if (!/^[0-9a-f-]{36}$/i.test(lookId)) return null
  let row = await prisma.backgroundJob.findFirst({ where: { id: lookId, type: LOOK_JOB_TYPE } })
  if (!row || (row.payload as any)?.userId !== userId) return null
  if (row.status === JOB_STATUS.running) {
    if (!lapsed(row)) return { state: 'reading' }
    await closeLapsed(row)
    row = (await prisma.backgroundJob.findUnique({ where: { id: lookId } })) ?? row
  }
  const p = row.payload as unknown as LookPayload
  if (p.preview) return { state: 'done', preview: p.preview }
  return { state: 'refused', refusal: p.refusal ?? { status: 500, error: SAID.generic } }
}

/** An import, in a task of its own: the task checks the source before the project exists. */
export async function startSandboxImport(input: {
  userId: string
  orgId: string
  connection: ImportConnection
  include: { users: boolean; files: boolean }
  name: string
  region: string
  owner: { ownerId: string; organizationId: string | null }
  limits: ImportLimits
  spendBudget?: () => Promise<void>
}): Promise<{ jobId: string }> {
  await assertSandboxRoom('import', input.orgId, input.userId)
  const jobId = randomUUID()
  const { token, hash } = newJobToken(jobId)
  const now = new Date()
  const deadline = new Date(now.getTime() + START_GRACE_MS + IMPORT_LIMITS.checkMs + IMPORT_LIMITS.maxMs)
  const source = input.connection.source
  const payload: ImportPayload = {
    orgId: input.orgId,
    userId: input.userId,
    source,
    include: input.include,
    progress: initialProgress({
      jobId,
      projectId: '',
      projectName: input.name,
      region: input.region,
      orgId: input.orgId,
      source,
      startedAt: now,
      phase: 'creating_project',
      status: 'queued',
    }),
    name: input.name,
    region: input.region,
    owner: input.owner,
    sandbox: newSandbox('import', hash, await sealConnection(input.connection), deadline, input.limits),
    refusal: null,
  }
  await createWithinRoom('import', input.orgId, input.userId, {
    id: jobId,
    type: IMPORT_JOB_TYPE,
    status: JOB_STATUS.running,
    payload: payload as unknown as Prisma.InputJsonValue,
    attempts: 1,
    maxAttempts: 1,
    runAt: now,
    startedAt: now,
    timeoutAt: new Date(now.getTime() + START_GRACE_MS),
  })
  // Spent once the task's place is held: a start turned away as busy spends none of the organization's starts.
  try {
    await input.spendBudget?.()
  } catch (err) {
    await prisma.backgroundJob.delete({ where: { id: jobId } }).catch(() => {})
    throw err
  }
  await launch(jobId, 'import', token)
  return { jobId }
}

export type StartAnswer = { state: 'checking' } | { state: 'started'; projectId: string } | { state: 'refused'; refusal: StoredRefusal }

/** Where an import's start is, for the person who started it; null for anyone else or no such import. */
export async function readImportStart(jobId: string, userId: string): Promise<StartAnswer | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null
  let row = await prisma.backgroundJob.findFirst({ where: { id: jobId, type: IMPORT_JOB_TYPE } })
  if (!row || (row.payload as any)?.userId !== userId || !sandboxOf(row)) return null
  if (row.projectId) return { state: 'started', projectId: row.projectId }
  if (row.status === JOB_STATUS.running) {
    if (!lapsed(row)) return { state: 'checking' }
    await closeLapsed(row)
    row = (await prisma.backgroundJob.findUnique({ where: { id: jobId } })) ?? row
    if (row.projectId) return { state: 'started', projectId: row.projectId }
  }
  const refusal = (row.payload as unknown as ImportPayload).refusal
  return { state: 'refused', refusal: refusal ?? { status: 500, error: SAID.generic } }
}

// ── Ending ────────────────────────────────────────────────────────────────────

/** A running sandbox row whose lease lapsed or whose deadline passed. */
export function lapsed(row: Pick<BackgroundJob, 'status' | 'timeoutAt' | 'payload'>, now = new Date()): boolean {
  if (row.status !== JOB_STATUS.running) return false
  if (!row.timeoutAt || row.timeoutAt <= now) return true
  const s = sandboxOf(row)
  return !!s && Date.parse(s.deadlineAt) <= now.getTime()
}

/**
 * End a running row once: its final payload (the sandbox wiped), status and
 * error. False when it had already ended. Stops its task whatever the outcome.
 */
async function endJob(
  jobId: string,
  end: {
    refusal?: StoredRefusal
    progress?: ImportProgress
    result?: ImportedFrom
    preview?: ImportPreview
    error: string | null
    done?: boolean
  },
): Promise<boolean> {
  const row = await prisma.backgroundJob.findUnique({ where: { id: jobId } })
  if (!row || row.status !== JOB_STATUS.running) return false
  const payload = { ...(row.payload as Record<string, unknown>) }
  const sandbox = sandboxOf(row)
  if (sandbox) payload.sandbox = { ...sandbox, sealed: null, tokenHash: null, stage: 'ended', stopped: !sandbox.taskArn }
  if (end.refusal) payload.refusal = end.refusal
  if (end.progress) payload.progress = end.progress
  if (end.preview) payload.preview = end.preview
  const { count } = await prisma.backgroundJob.updateMany({
    where: { id: jobId, status: JOB_STATUS.running },
    data: {
      status: end.done ? JOB_STATUS.done : JOB_STATUS.broken,
      error: end.error,
      completedAt: new Date(),
      timeoutAt: null,
      payload: payload as unknown as Prisma.InputJsonValue,
      ...(end.result ? { result: end.result as unknown as Prisma.InputJsonValue } : {}),
    },
  })
  if (count === 1 && sandbox?.taskArn) await stopTask(jobId, sandbox.taskArn, end.done ? 'import finished' : 'import ended')
  return count === 1
}

/** Stop a job's task and say so in its row; a stop that failed is tried again by the sweeper. */
async function stopTask(jobId: string, taskArn: string, reason: string): Promise<void> {
  const stopped = (await sandboxLauncher()?.stop(taskArn, reason)) === true
  if (stopped) {
    await prisma.$executeRaw`UPDATE background_jobs SET payload = jsonb_set(payload, '{sandbox,stopped}', 'true'::jsonb, true) WHERE id = ${jobId}`.catch(() => {})
  }
}

/**
 * Every minute, on the home region's scheduler leader (instrumentation.ts):
 *   - close every look and import whose task stopped reporting or ran past its
 *     deadline (closeLapsed), which stops its task;
 *   - stop again any task of a job that ended in the last three hours whose
 *     stop did not go through, so no task outlives its job for long;
 *   - forget looks after a day: a preview names the source's tables.
 */
export async function sweepImportSandbox(now = new Date()): Promise<{ closed: number; stopped: number; forgotten: number }> {
  let closed = 0
  let stopped = 0
  const running = await prisma.backgroundJob.findMany({
    where: { type: { in: [IMPORT_JOB_TYPE, LOOK_JOB_TYPE] }, status: JOB_STATUS.running },
    take: 500,
  })
  for (const row of running) {
    if (!sandboxOf(row) || !lapsed(row, now)) continue
    await closeLapsed(row).catch((err) => console.warn('[Import] could not close a lapsed job:', redactedMessage(err, [], 200)))
    closed++
  }
  const ended = await prisma.backgroundJob.findMany({
    where: {
      type: { in: [IMPORT_JOB_TYPE, LOOK_JOB_TYPE] },
      status: { in: [JOB_STATUS.done, JOB_STATUS.broken] },
      completedAt: { gte: new Date(now.getTime() - 3 * 3_600_000) },
    },
    take: 500,
  })
  for (const row of ended) {
    const s = sandboxOf(row) as (SandboxState & { stopped?: boolean }) | null
    if (!s?.taskArn || s.stopped === true) continue
    await stopTask(row.id, s.taskArn, 'import ended')
    stopped++
  }
  const { count: forgotten } = await prisma.backgroundJob.deleteMany({
    where: { type: LOOK_JOB_TYPE, status: { not: JOB_STATUS.running }, createdAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } },
  })
  return { closed, stopped, forgotten }
}

/** Close a row whose task stopped reporting or ran past its deadline; the task is stopped too. */
export async function closeLapsed(row: BackgroundJob): Promise<ImportProgress | null> {
  const s = sandboxOf(row)
  const payload = row.payload as any
  const timedOut = !!s && Date.parse(s.deadlineAt) <= Date.now()
  if (row.type === LOOK_JOB_TYPE || !row.projectId) {
    await endJob(row.id, { refusal: { status: 503, error: SAID.stopped, code: 'IMPORT_STOPPED' }, error: IMPORT_ERRORS.interrupted })
    return null
  }
  const error = timedOut
    ? `The import ran for ${Math.round(IMPORT_LIMITS.maxMs / 3_600_000)} hours and was stopped. Nothing in ${sourceName(payload.source)} changed.`
    : `The import stopped before it finished. Start it again; nothing in ${sourceName(payload.source)} changed.`
  const progress: ImportProgress = { ...payload.progress, status: 'failed', finishedAt: new Date().toISOString(), error }
  if (await endJob(row.id, { progress, error: timedOut ? IMPORT_ERRORS.failed : IMPORT_ERRORS.interrupted })) {
    await auditImport(row.projectId, payload.userId, 'IMPORT_FAILED', { jobId: row.id, source: payload.source, sentence: error })
    await recordProjectSize(row.projectId)
  }
  return progress
}

/** A person canceled a sandbox import: the task hears it at its next report; if it never reports again, it is stopped. */
export async function cancelSandboxJob(row: BackgroundJob): Promise<void> {
  await prisma.backgroundJob.updateMany({
    where: { id: row.id, status: JOB_STATUS.running },
    data: { error: IMPORT_ERRORS.cancelRequested },
  })
  // The task reports at least every ten seconds; past that, it is not listening.
  setTimeout(() => {
    void (async () => {
      const fresh = await prisma.backgroundJob.findUnique({ where: { id: row.id } })
      if (fresh?.status !== JOB_STATUS.running) return
      if (!fresh.projectId) {
        await endJob(row.id, { refusal: { status: 409, error: 'The import was canceled before it started; nothing was created.', code: 'IMPORT_CANCELED' }, error: IMPORT_ERRORS.canceled })
        return
      }
      const p = fresh.payload as any
      const message = `Canceled. Nothing in ${sourceName(p.source)} changed; what arrived stays in the new project, which you can delete.`
      const progress: ImportProgress = { ...p.progress, status: 'canceled', finishedAt: new Date().toISOString(), error: message }
      if (await endJob(row.id, { progress, error: IMPORT_ERRORS.canceled })) {
        await auditImport(fresh.projectId, p.userId, 'IMPORT_CANCELED', { jobId: row.id, source: p.source, sentence: `Canceled moving in from ${sourceName(p.source)}` })
        await recordProjectSize(fresh.projectId)
      }
    })().catch((err) => console.warn('[Import] cancel fallback failed:', redactedMessage(err, [], 200)))
  }, 15_000).unref?.()
}

// ── The task's calls (lib/import/worker-api.ts proves the job first) ─────────

/** Move one key of the sandbox state, only while the row runs (and, if given, only at `stage`). */
export async function setSandbox(jobId: string, path: string[], value: unknown, whenStage?: SandboxStage): Promise<boolean> {
  // The path is this module's own keys, never input; checked anyway, and sent as one text[] literal.
  if (!path.every((k) => /^[a-zA-Z]+$/.test(k))) throw new Error(`Not a sandbox key: ${path.join('.')}`)
  const full = `{sandbox,${path.join(',')}}`
  const n = whenStage
    ? await prisma.$executeRaw`UPDATE background_jobs SET payload = jsonb_set(payload, ${full}::text[], ${JSON.stringify(value)}::jsonb, true), "updatedAt" = now()
         WHERE id = ${jobId} AND status = ${JOB_STATUS.running} AND payload->'sandbox'->>'stage' = ${whenStage}`
    : await prisma.$executeRaw`UPDATE background_jobs SET payload = jsonb_set(payload, ${full}::text[], ${JSON.stringify(value)}::jsonb, true), "updatedAt" = now()
         WHERE id = ${jobId} AND status = ${JOB_STATUS.running}`
  return n === 1
}

/** The lease moves forward with every call a task makes. */
export async function extendLease(jobId: string): Promise<void> {
  await prisma.backgroundJob.updateMany({
    where: { id: jobId, status: JOB_STATUS.running },
    data: { timeoutAt: new Date(Date.now() + IMPORT_LIMITS.staleMs) },
  })
}

/** Take a step a task may take once; false when it was taken already. */
export async function takeOnce(jobId: string, step: OnceStep): Promise<boolean> {
  const n = await prisma.$executeRaw`UPDATE background_jobs
       SET payload = jsonb_set(payload, '{sandbox,once}', COALESCE(payload->'sandbox'->'once', '{}'::jsonb) || jsonb_build_object(${step}::text, true), true),
           "updatedAt" = now()
     WHERE id = ${jobId} AND status = ${JOB_STATUS.running}
       AND COALESCE((payload->'sandbox'->'once'->>${step}::text)::boolean, false) = false`
  return n === 1
}

/** Every string in `value` with the secrets taken out. */
function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value
  const walk = (v: unknown): unknown =>
    typeof v === 'string'
      ? redact(v, secrets)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
          : v
  return walk(value) as T
}

/** The job's spec, handed to its task once. */
export async function workerSpec(row: BackgroundJob): Promise<WorkerSpec> {
  const s = sandboxOf(row)!
  if (s.handed || !s.sealed) throw new ImportRefusedError(409, 'This job was already handed to a task.', 'IMPORT_HANDED')
  if (!(await setSandbox(row.id, ['handed'], true, 'launching'))) {
    throw new ImportRefusedError(409, 'This job was already handed to a task.', 'IMPORT_HANDED')
  }
  await setSandbox(row.id, ['stage'], s.kind === 'look' ? 'reading' : 'checking')
  await extendLease(row.id)
  const p = row.payload as any
  return {
    protocol: PROTOCOL,
    kind: s.kind,
    jobId: row.id,
    source: p.source,
    connection: await unsealConnection(s.sealed),
    userId: p.userId,
    orgId: p.orgId,
    limits: s.limits,
    deadlineAt: s.deadlineAt,
    readMs: s.kind === 'look' ? IMPORT_LIMITS.inspectMs : IMPORT_LIMITS.checkMs,
    ...(s.kind === 'import' ? { include: p.include } : {}),
  }
}

/** The source's secrets, for redacting what a task says: the sealed connection while the job runs. */
export async function secretsOfJob(row: BackgroundJob): Promise<string[]> {
  const s = sandboxOf(row)
  if (!s?.sealed) return []
  try {
    return secretsOf(await unsealConnection(s.sealed))
  } catch {
    return []
  }
}

export async function workerPreview(row: BackgroundJob, preview: ImportPreview): Promise<void> {
  // A preview is shown to the person; nothing in it may carry the source's credentials.
  const safe = redactDeep(preview, await secretsOfJob(row))
  await endJob(row.id, { preview: safe, error: null, done: true })
}

/**
 * The task's check passed: create the project now, through the normal creation
 * path. Answers the project's id, or null while another call is creating it.
 */
export async function workerChecked(row: BackgroundJob): Promise<string | null> {
  if (row.projectId) {
    // Asked again after the project was made (a retried call): the move goes on.
    await setSandbox(row.id, ['stage'], 'running')
    await extendLease(row.id)
    return row.projectId
  }
  const p = row.payload as unknown as ImportPayload
  if (!(await setSandbox(row.id, ['stage'], 'creating', 'checking'))) return null
  await extendLease(row.id)
  // Creating a project can take longer than the lease: keep it alive meanwhile.
  const heartbeat = setInterval(() => void extendLease(row.id).catch(() => {}), 15_000)
  let project: { id: string; name: string; region?: string | null }
  try {
    const { getProjectLifecycle } = await import('@/lib/edition')
    ;({ project } = await getProjectLifecycle().create({
      name: p.name,
      description: `Moved in from ${sourceName(p.source)}`,
      userId: p.userId,
      organizationId: p.owner.organizationId,
      region: p.region as CloudRegionId,
    }))
  } catch (err: any) {
    const refusal: StoredRefusal =
      err instanceof ImportRefusedError
        ? { status: err.status, error: err.message, ...(err.code ? { code: err.code } : {}), extra: err.extra }
        : typeof err?.status === 'number' && err.status < 500 && typeof err?.message === 'string'
          ? { status: err.status, error: err.message, ...(err.code ? { code: err.code } : {}) }
          : { status: 500, error: SAID.generic }
    console.error(`[Import] job ${row.id}: the project was not created:`, redactedMessage(err, [], 300))
    await endJob(row.id, { refusal, error: IMPORT_ERRORS.failed })
    throw new ImportRefusedError(409, 'The project was not created.', 'IMPORT_ENDED')
  } finally {
    clearInterval(heartbeat)
  }
  const now = new Date()
  const progress: ImportProgress = {
    ...p.progress,
    projectId: project.id,
    projectName: project.name,
    region: project.region ?? p.region,
    status: 'running',
    phase: 'tables',
    startedAt: now.toISOString(),
  }
  const recorded = await prisma.$executeRaw`UPDATE background_jobs
       SET "projectId" = ${project.id},
           payload = jsonb_set(jsonb_set(payload, '{progress}', ${JSON.stringify(progress)}::jsonb, true), '{sandbox,stage}', '"running"'::jsonb, true),
           "timeoutAt" = ${new Date(now.getTime() + IMPORT_LIMITS.staleMs)}, "updatedAt" = now()
     WHERE id = ${row.id} AND status = ${JOB_STATUS.running}`
  if (recorded !== 1) {
    // The job ended while the project was made (canceled, or closed): the empty project stays, the person's to delete.
    console.warn(`[Import] job ${row.id} ended while its project ${project.id} was created; nothing moved into it`)
    throw new ImportRefusedError(409, 'The import ended before it began.', 'IMPORT_ENDED')
  }
  await auditImport(project.id, p.userId, 'IMPORT_STARTED', { jobId: row.id, source: p.source, sentence: `Started moving in from ${sourceName(p.source)}` })
  const recordProduct = await import('@/lib/platform-signals').then((m) => m.recordProductEvent).catch(() => null)
  recordProduct?.({ type: 'project_created', userId: p.userId, projectId: project.id, metadata: { name: project.name, importedFrom: p.source } })
  return project.id
}

/** The phases an import moves through (lib/import/contract.ts ImportPhase). */
const PHASES: readonly ImportPhase[] = ['creating_project', 'tables', 'rows', 'users', 'files', 'verifying', 'finished']

/** The longest progress a task may keep: the import's table cap, each name a PostgreSQL name. */
const MAX_PROGRESS_TABLES = 1_000

/** When this process last wrote each job's progress (workerProgress keeps to one write a second per job). */
const progressWritten = new Map<string, number>()

/** Merge a task's progress; answers whether a person canceled the import. */
export async function workerProgress(row: BackgroundJob, patch: ProgressPatch): Promise<{ cancel: boolean }> {
  const p = row.payload as unknown as ImportPayload
  const clean: ProgressPatch = { ...patch }
  // The task may move what it counts, never who or where the job is.
  for (const k of ['jobId', 'projectId', 'projectName', 'region', 'orgId', 'source', 'status', 'startedAt', 'finishedAt', 'error'] as const) {
    delete (clean as any)[k]
  }
  if (Array.isArray(clean.tables)) {
    clean.tables = clean.tables.filter((t) => t && typeof t.name === 'string' && t.name.length <= 63).slice(0, MAX_PROGRESS_TABLES)
  } else delete (clean as any).tables
  // Warnings arrive once, with the finish (workerFinish); a phase is one of the import's own.
  delete (clean as any).warnings
  if (clean.phase !== undefined && !PHASES.includes(clean.phase as ImportPhase)) delete (clean as any).phase
  const cancel = row.error === IMPORT_ERRORS.cancelRequested
  // At most one write a second per job in this process, whatever the task sends: the job's row is
  // rewritten whole each time. A call in between still keeps the lease.
  const now = Date.now()
  if (now - (progressWritten.get(row.id) ?? 0) < 900) {
    await extendLease(row.id)
    return { cancel }
  }
  progressWritten.set(row.id, now)
  if (progressWritten.size > 500) {
    for (const [id, at] of progressWritten) if (now - at > 3_600_000) progressWritten.delete(id)
  }
  let progress = mergeProgress(p.progress, clean)
  if (progress.tables.length > MAX_PROGRESS_TABLES) progress = { ...progress, tables: progress.tables.slice(0, MAX_PROGRESS_TABLES) }
  await prisma.$executeRaw`UPDATE background_jobs
       SET payload = jsonb_set(payload, '{progress}', ${JSON.stringify(progress)}::jsonb, true),
           "timeoutAt" = ${new Date(Date.now() + IMPORT_LIMITS.staleMs)}, "updatedAt" = now()
     WHERE id = ${row.id} AND status = ${JOB_STATUS.running}`
  return { cancel }
}

export async function workerFinish(row: BackgroundJob, raw: { importedFrom: ImportedFrom; warnings: string[] }): Promise<void> {
  const p = row.payload as unknown as ImportPayload
  const projectId = row.projectId!
  const secrets = await secretsOfJob(row)
  const importedFrom = { ...normalizeImportedFrom(raw.importedFrom, p.source), source: p.source, at: new Date().toISOString() }
  const warnings = (Array.isArray(raw.warnings) ? raw.warnings : []).slice(0, 50).map((w) => redactedMessage(w, secrets, 600))
  const finished = mergeProgress(p.progress, { phase: 'finished', warnings, rulesPending: importedFrom.rulesPending })
  const progress: ImportProgress = { ...finished, status: 'done', finishedAt: new Date().toISOString(), error: null }
  await prisma.project.update({ where: { id: projectId }, data: { importedFrom: importedFrom as unknown as Prisma.InputJsonValue } })
  if (!(await endJob(row.id, { progress, result: importedFrom, error: null, done: true }))) return
  await auditImport(projectId, p.userId, 'IMPORT_FINISHED', {
    jobId: row.id,
    source: p.source,
    tables: importedFrom.tables,
    rows: importedFrom.rows,
    users: importedFrom.users ?? null,
    files: importedFrom.files ?? null,
    rulesPending: importedFrom.rulesPending,
    sentence: `Moved in from ${sourceName(p.source)}: ${importedFrom.tables} table${importedFrom.tables === 1 ? '' : 's'}, ${importedFrom.rows.toLocaleString('en-US')} row${importedFrom.rows === 1 ? '' : 's'}`,
  })
  await recordProjectSize(projectId)
}

/** The task stopped: a look's or a check's refusal, or a run's failure, said once. */
export async function workerFail(row: BackgroundJob, failure: WorkerFailure): Promise<void> {
  const secrets = await secretsOfJob(row)
  const message = redactedMessage(String(failure?.message ?? ''), secrets, 400)
  const field = typeof failure?.field === 'string' && failure.field.length <= 40 ? failure.field : undefined
  const s = sandboxOf(row)!
  if (s.kind === 'look' || !row.projectId) {
    const refusal: StoredRefusal = failure?.input
      ? { status: 422, error: message || 'The source could not be read.', ...(field ? { field } : {}) }
      : { status: 500, error: SAID.generic }
    if (!failure?.input) console.error(`[Import] job ${row.id}: the source could not be read:`, message)
    await endJob(row.id, { refusal, error: IMPORT_ERRORS.failed })
    return
  }
  const p = row.payload as unknown as ImportPayload
  const canceled = failure?.aborted === 'canceled'
  const said = canceled
    ? `Canceled. Nothing in ${sourceName(p.source)} changed; what arrived stays in the new project, which you can delete.`
    : failure?.aborted === 'timeout'
      ? `The import ran for ${Math.round(IMPORT_LIMITS.maxMs / 3_600_000)} hours and was stopped. Nothing in ${sourceName(p.source)} changed.`
      : failureMessage(failure?.input ? new ImportInputError(message) : new Error(message), secrets)
  const progress: ImportProgress = { ...p.progress, status: canceled ? 'canceled' : 'failed', finishedAt: new Date().toISOString(), error: said }
  if (!(await endJob(row.id, { progress, error: canceled ? IMPORT_ERRORS.canceled : IMPORT_ERRORS.failed }))) return
  await auditImport(row.projectId, p.userId, canceled ? 'IMPORT_CANCELED' : 'IMPORT_FAILED', {
    jobId: row.id,
    source: p.source,
    sentence: canceled ? `Canceled moving in from ${sourceName(p.source)}` : `Moving in from ${sourceName(p.source)} stopped: ${said}`,
  })
  await recordProjectSize(row.projectId)
}
