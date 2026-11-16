/**
 * The console's side of the import API, typed by the wire contract
 * (./contract.ts), and the readings of a job that the screens share.
 *
 *   inspectImport  POST /api/import/inspect      what would move; reads the source only
 *   startImport    POST /api/import              creates the new project and starts the job
 *   readImport     GET  /api/import/{jobId}      the job, polled every second while it runs
 *   cancelImport   POST /api/import/{jobId}/cancel
 *   listImports    GET  /api/import?orgId=       running imports and those finished in the last 24 h
 *
 * Credentials pass through inspect and start and nowhere else: never logged,
 * cached or put in a URL, and the server never sends them back.
 *
 * Every call resolves, never throws: a refused or failed call comes back as
 * `{ ok: false, refusal }` with the server's own words when it gave some (a
 * 4xx `{ error, field? }`), so a screen can put the sentence under the field
 * it names.
 */

import type {
  ImportInspectRequest,
  ImportPhase,
  ImportPreview,
  ImportProgress,
  ImportProgressTable,
  ImportSourceId,
  ImportStartRequest,
} from './contract'

export const IMPORT_SOURCES: readonly ImportSourceId[] = ['supabase', 'firebase', 'postgres']

export function isImportSource(value: unknown): value is ImportSourceId {
  return typeof value === 'string' && (IMPORT_SOURCES as readonly string[]).includes(value)
}

/** Where the import flow is, for a source to start from or a job to watch. */
export function importPath(orgId: string, at: { source?: ImportSourceId; job?: string } = {}): string {
  const base = `/app/org/${encodeURIComponent(orgId)}/import`
  if (at.job) return `${base}?job=${encodeURIComponent(at.job)}`
  if (at.source) return `${base}?source=${at.source}`
  return base
}

// ─── Calls ───────────────────────────────────────────────────────────────────

/** A call that did not succeed: what to say, and where. */
export interface ImportRefusal {
  /** The HTTP status; 0 when no answer came back at all. */
  status: number
  /** The server's sentence for a 4xx, else ours. */
  error: string
  /** The field the sentence belongs under, when the server named one. */
  field?: string
  /** A machine code the server added (PLAN_LIMIT_EXCEEDED from project creation). */
  code?: string
}

// Both sides name both fields, so a caller reads `refusal` after checking `ok`
// whether or not the compiler narrows (this repo builds without strict).
export type ImportResult<T> =
  | { ok: true; data: T; refusal?: undefined }
  | { ok: false; data?: undefined; refusal: ImportRefusal }

const NETWORK = 'Could not reach Backenly. Check your connection and try again.'
const UNREADABLE = 'Backenly sent an answer this page could not read. Try again.'

function fallbackFor(status: number): string {
  if (status === 401) return 'Your session ended. Sign in again.'
  if (status === 403) return 'Only owners and admins can import into this organization.'
  if (status === 404) return 'Importing is not available here yet.'
  if (status === 429) return 'Too many tries in a row. Wait a minute, then try again.'
  return 'Something went wrong on our side. Try again.'
}

type Body = Record<string, unknown> | null

async function call<T>(path: string, init: RequestInit | undefined, read: (body: Body) => T | null): Promise<ImportResult<T>> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'include', cache: 'no-store', ...init })
  } catch {
    return { ok: false, refusal: { status: 0, error: NETWORK } }
  }
  const body = (await res.json().catch(() => null)) as Body
  if (res.ok) {
    const data = read(body)
    return data === null ? { ok: false, refusal: { status: res.status, error: UNREADABLE } } : { ok: true, data }
  }
  // A 4xx is the server's sentence for the person (the source's own words for
  // a refused connection); anything else is ours, never an internal message.
  const said = res.status < 500 && typeof body?.error === 'string' && body.error.trim() ? body.error : null
  return {
    ok: false,
    refusal: {
      status: res.status,
      error: said ?? fallbackFor(res.status),
      field: typeof body?.field === 'string' ? body.field : undefined,
      code: typeof body?.code === 'string' ? body.code : undefined,
    },
  }
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function isProgress(value: unknown): value is ImportProgress {
  const p = value as ImportProgress | null
  return !!p && typeof p.jobId === 'string' && typeof p.status === 'string' && Array.isArray(p.tables)
}

function isPreview(value: unknown): value is ImportPreview {
  const p = value as ImportPreview | null
  return !!p && typeof p.source === 'string' && Array.isArray(p.tables) && Array.isArray(p.rules) && Array.isArray(p.warnings)
}

export function inspectImport(request: ImportInspectRequest): Promise<ImportResult<ImportPreview>> {
  return call('/api/import/inspect', post(request), (b) => (isPreview(b?.preview) ? b.preview : null))
}

export function startImport(request: ImportStartRequest): Promise<ImportResult<{ jobId: string; projectId: string }>> {
  return call('/api/import', post(request), (b) =>
    typeof b?.jobId === 'string' && typeof b?.projectId === 'string' ? { jobId: b.jobId, projectId: b.projectId } : null,
  )
}

export function readImport(jobId: string): Promise<ImportResult<ImportProgress>> {
  return call(`/api/import/${encodeURIComponent(jobId)}`, undefined, (b) => (isProgress(b?.progress) ? b.progress : null))
}

export function cancelImport(jobId: string): Promise<ImportResult<ImportProgress>> {
  return call(`/api/import/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }, (b) =>
    isProgress(b?.progress) ? b.progress : null,
  )
}

export function listImports(orgId: string): Promise<ImportResult<ImportProgress[]>> {
  return call(`/api/import?orgId=${encodeURIComponent(orgId)}`, undefined, (b) =>
    Array.isArray(b?.jobs) ? (b.jobs as unknown[]).filter(isProgress) : null,
  )
}

// ─── Readings ────────────────────────────────────────────────────────────────

export function isRunning(job: Pick<ImportProgress, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running'
}

/** The job ended without finishing: failed, or stopped by a person. */
export function isStopped(job: Pick<ImportProgress, 'status'>): boolean {
  return job.status === 'failed' || job.status === 'canceled'
}

const PHASES: ImportPhase[] = ['creating_project', 'tables', 'rows', 'users', 'files', 'verifying', 'finished']

/** Whether the job has moved past a phase. */
function past(job: ImportProgress, phase: ImportPhase): boolean {
  return job.status === 'done' || PHASES.indexOf(job.phase) > PHASES.indexOf(phase)
}

/**
 * A ledger row's state, drawn as a glyph: waiting (hollow dot), copying or
 * checking (spinner), matched (check), stopped (hollow dot, "Not copied").
 */
export type LedgerPhase = 'waiting' | 'copying' | 'checking' | 'matched' | 'stopped'

/** A table is matched only once the server has counted both sides (`verified`). */
export function tablePhase(table: ImportProgressTable, job: ImportProgress): LedgerPhase {
  if (table.verified) return 'matched'
  const full = table.copiedRows >= table.sourceRows
  if (job.status === 'done') return full ? 'matched' : 'stopped'
  if (isStopped(job)) return 'stopped'
  if (full && table.sourceRows > 0) return 'checking'
  if (table.copiedRows > 0) return 'copying'
  return 'waiting'
}

/** Users and files: counted, with no per-row check, so "matched" once their phase is over and every one arrived. */
export function countPhase(copied: number, total: number, job: ImportProgress, phase: 'users' | 'files'): LedgerPhase {
  const full = copied >= total
  if (past(job, phase)) return full ? 'matched' : 'stopped'
  if (isStopped(job)) return 'stopped'
  if (job.phase === phase) return full ? 'checking' : 'copying'
  return copied > 0 ? 'copying' : 'waiting'
}

/** How far the job is, 0 to 1, by what moves: rows, users and files. */
export function fractionOf(job: ImportProgress): number {
  if (job.status === 'done') return 1
  let total = 0
  let done = 0
  for (const t of job.tables) {
    total += t.sourceRows
    done += Math.min(t.copiedRows, t.sourceRows)
  }
  if (job.users) {
    total += job.users.total
    done += Math.min(job.users.copied, job.users.total)
  }
  if (job.files) {
    total += job.files.total
    done += Math.min(job.files.copied, job.files.total)
  }
  return total > 0 ? done / total : 0
}

/** What arrived, for the Done step's facts. */
export function movedTotals(job: ImportProgress) {
  return {
    tables: job.tables.length,
    rows: job.tables.reduce((sum, t) => sum + t.copiedRows, 0),
    users: job.users ? job.users.copied : null,
    files: job.files ? job.files.copied : null,
    bytes: job.files ? job.files.copiedBytes : null,
  }
}

/** Milliseconds from the job's start to its end, or to `now` while it runs. */
export function elapsedOf(job: Pick<ImportProgress, 'startedAt' | 'finishedAt'>, now: number): number {
  const start = new Date(job.startedAt).getTime()
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}
