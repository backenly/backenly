/**
 * THE IMPORT SANDBOX TASK
 * =======================
 *
 * Every step of an import that reads a source runs here, in a task of its own
 * (lib/import/sandbox.ts launches one per look and one per import), never in
 * the website: a source is someone else's server, and what it sends is parsed
 * by code that can be made to hold memory, hold threads or hang. Here the worst
 * it can do is end this task, which ends its own import.
 *
 * The task holds nothing of Backenly's. No database URL, no storage key, no
 * role: only its job's id, a token for that job, and the public origin to call
 * back. It asks the control plane for its job (the source's connection is
 * handed over once), runs the driver, and hands every write to the control
 * plane (lib/import/worker/remote.ts), which checks it against the job's own
 * project and runs it with Backenly's own code (lib/import/worker-api.ts).
 *
 *   look    the Review step: driver.inspect, then the preview, then exit
 *   import  driver.check; the control plane then creates the project; then
 *           driver.run, with progress about once a second, until it finishes,
 *           fails, is canceled, or reaches its deadline
 */

import type { ImportConnection } from '../contract'
import { ImportInputError, type RunContext } from '../driver'
import { ImportAborted } from '../pg-engine'
import type { ProgressPatch } from '../progress'
import { redactedMessage, secretsOf } from '../redact'
import { driverFor } from '../registry'
import { PROTOCOL, type WorkerFailure, type WorkerSpec } from './protocol'
import { ControlPlane, ControlPlaneError, remoteDestinations } from './remote'

export interface WorkerEnv {
  origin: string
  jobId: string
  token: string
}

/** The task's three settings, checked: it runs with nothing else. */
export function workerEnv(env: Readonly<Record<string, string | undefined>> = process.env): WorkerEnv {
  const origin = env.IMPORT_ORIGIN?.trim() ?? ''
  const jobId = env.IMPORT_JOB_ID?.trim() ?? ''
  const token = env.IMPORT_JOB_TOKEN?.trim() ?? ''
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error('IMPORT_ORIGIN must be an origin such as https://backenly.com.')
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('IMPORT_JOB_ID must be the job id.')
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) throw new Error('IMPORT_JOB_TOKEN must be the job token.')
  return { origin, jobId, token }
}

/** The ECS task this runs in, from the task metadata endpoint; null anywhere else. */
export async function taskArnFromMetadata(env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | null> {
  const base = env.ECS_CONTAINER_METADATA_URI_V4
  if (!base) return null
  try {
    const r = await fetch(`${base}/task`, { signal: AbortSignal.timeout(2_000) })
    const j = (await r.json()) as { TaskARN?: unknown }
    return typeof j.TaskARN === 'string' ? j.TaskARN : null
  } catch {
    return null
  }
}

/** Why this task stopped, in words safe to show: the source's credentials never among them. */
export function failureOf(err: unknown, secrets: readonly string[]): WorkerFailure {
  if (err instanceof ImportAborted) {
    return { message: err.message, aborted: err.reason === 'timeout' ? 'timeout' : 'canceled' }
  }
  if (err instanceof ImportInputError) return { message: redactedMessage(err, secrets), ...(err.field ? { field: err.field } : {}), input: true }
  if ((err as Error | null)?.name === 'TimeoutError' || (err as Error | null)?.name === 'AbortError') {
    return { message: 'Reading the source took too long. Try again, or move a smaller part of it.', input: true }
  }
  if (err instanceof ControlPlaneError) return { message: `The import lost its place at Backenly: ${err.message}` }
  return { message: redactedMessage(err, secrets) || 'The source could not be read.' }
}

/** Two progress patches as one: tables by name, in the order first met; anything else the later one's. */
export function mergePatches(a: ProgressPatch, b: ProgressPatch): ProgressPatch {
  const out: ProgressPatch = { ...a, ...b }
  if (a.tables || b.tables) {
    const byName = new Map<string, NonNullable<ProgressPatch['tables']>[number]>()
    for (const t of a.tables ?? []) byName.set(t.name, t)
    for (const t of b.tables ?? []) byName.set(t.name, { ...byName.get(t.name), ...t })
    out.tables = [...byName.values()]
  }
  return out
}

/**
 * Progress to the control plane: at most one call a second while the import
 * moves, and one every ten seconds while it waits, so the job's lease stays
 * fresh (lib/import/jobs.ts). The answer says whether a person canceled it.
 */
class ProgressSender {
  private pending: ProgressPatch | null = null
  private sending = false
  private lastSent = 0
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly api: ControlPlane,
    private readonly controller: AbortController,
  ) {
    this.timer = setInterval(() => void this.flush(false), 1_000)
  }

  add(patch: ProgressPatch): void {
    this.pending = this.pending ? mergePatches(this.pending, patch) : patch
  }

  async flush(force: boolean): Promise<void> {
    if (this.sending) return
    const now = Date.now()
    if (!force && !this.pending && now - this.lastSent < 10_000) return
    const patch = this.pending ?? {}
    this.pending = null
    this.sending = true
    this.lastSent = now
    try {
      const r = await this.api.call<{ cancel?: boolean }>('progress', { patch })
      if (r.cancel && !this.controller.signal.aborted) this.controller.abort(new ImportAborted('canceled'))
    } catch (err) {
      this.pending = this.pending ? mergePatches(patch, this.pending) : patch
      // The job ended at Backenly (canceled, timed out, closed): nothing more to do here.
      if (err instanceof ControlPlaneError && err.code === 'IMPORT_ENDED' && !this.controller.signal.aborted) {
        this.controller.abort(new ImportAborted('stopped'))
      }
    } finally {
      this.sending = false
    }
  }

  stop(): void {
    clearInterval(this.timer)
  }
}

export interface RunWorkerOptions {
  fetchImpl?: typeof fetch
  /** Undefined: read it from the task metadata. */
  taskArn?: string | null
}

/** Run the task's job to its end. Resolves the exit code; never throws once the job is known. */
export async function runWorker(env: WorkerEnv, opts: RunWorkerOptions = {}): Promise<number> {
  const taskArn = opts.taskArn !== undefined ? opts.taskArn : await taskArnFromMetadata()
  const api = new ControlPlane({ ...env, taskArn, fetchImpl: opts.fetchImpl })
  const { spec } = await api.call<{ spec: WorkerSpec }>('spec', { protocol: PROTOCOL })
  if (!spec || spec.protocol !== PROTOCOL) throw new Error(`The control plane speaks protocol ${spec?.protocol}, this task ${PROTOCOL}.`)
  const secrets = secretsOf(spec.connection)
  const report = async (err: unknown) => {
    await api.call('fail', failureOf(err, secrets)).catch((e) => console.error('[ImportWorker] could not report the failure:', redactedMessage(e, secrets, 200)))
  }
  const driver = await driverFor(spec.source)
  if (!driver) {
    await report(new ImportInputError(`Moving from ${spec.source} is not available.`))
    return 2
  }
  const base = { userId: spec.userId, orgId: spec.orgId, limits: spec.limits }
  const connection = spec.connection as ImportConnection & Record<string, unknown>

  if (spec.kind === 'look') {
    try {
      const preview = await driver.inspect(connection as any, { ...base, signal: AbortSignal.timeout(spec.readMs) })
      await api.call('preview', { preview })
      return 0
    } catch (err) {
      await report(err)
      return 1
    }
  }

  // The check before the project exists: a source that cannot move leaves nothing behind.
  if (driver.check) {
    try {
      await driver.check(connection as any, { ...base, signal: AbortSignal.timeout(spec.readMs) })
    } catch (err) {
      await report(err)
      return 1
    }
  }

  const controller = new AbortController()
  const msLeft = Math.max(0, Date.parse(spec.deadlineAt) - Date.now())
  const deadline = setTimeout(() => controller.abort(new ImportAborted('timeout')), msLeft)
  const progress = new ProgressSender(api, controller)
  try {
    // The control plane creates the project now; a moment later it is there.
    let projectId = (await api.call<{ projectId?: string }>('checked', {})).projectId
    while (!projectId) {
      if (controller.signal.aborted) throw controller.signal.reason
      await new Promise((r) => setTimeout(r, 2_000))
      projectId = (await api.call<{ projectId?: string }>('next', {})).projectId
    }
    const ctx: RunContext = {
      ...base,
      signal: controller.signal,
      projectId,
      jobId: spec.jobId,
      include: spec.include ?? { users: false, files: false },
      destinations: remoteDestinations(api),
      progress: (patch) => progress.add(patch),
    }
    const result = await driver.run(connection as any, ctx)
    progress.stop()
    await progress.flush(true)
    await api.call('finish', {
      importedFrom: result.importedFrom,
      warnings: result.warnings.map((w) => redactedMessage(w, secrets, 600)),
    })
    return 0
  } catch (err) {
    progress.stop()
    await progress.flush(true).catch(() => {})
    const reason = controller.signal.reason
    await report(err instanceof ImportAborted ? err : reason instanceof ImportAborted ? reason : err)
    return 1
  } finally {
    clearTimeout(deadline)
    progress.stop()
  }
}
