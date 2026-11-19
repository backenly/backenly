/**
 * The import sandbox's wire protocol: what lib/import/worker/main.ts (the
 * sandbox task) and lib/import/worker-api.ts (the control plane, behind
 * POST /api/import/worker/{action}) say to each other.
 *
 * The task authenticates every call with its job's token (Authorization:
 * Bearer), names its job (X-Backenly-Import-Job) and the ECS task it runs in
 * (X-Backenly-Import-Task, when it has one). Bodies are JSON, gzip-encoded
 * when large, except a file, which is its own bytes. The control plane answers
 * JSON: `{ ok: true, ... }`, or `{ error, code, field? }` with a status.
 *
 * Plain types and constants only, so both halves import it freely. A change
 * here changes both halves; PROTOCOL says which version a task speaks, and the
 * control plane refuses a task that speaks another (the web registers the
 * task's definition from its own image, lib/import/sandbox.ts, so the two only
 * differ across a deploy).
 */

import type { ImportConnection, ImportedFrom, ImportPreview, ImportSourceId } from '../contract'
import type { ImportLimits } from '../driver'

export const PROTOCOL = 1

export const HEADER_JOB = 'x-backenly-import-job'
export const HEADER_TASK = 'x-backenly-import-task'
export const HEADER_BUCKET = 'x-backenly-import-bucket'
export const HEADER_FILE_NAME = 'x-backenly-import-file-name'
export const HEADER_FILE_TYPE = 'x-backenly-import-file-type'

/** A look reads a source for the Review step; an import checks it, then moves it into the new project. */
export type WorkerKind = 'look' | 'import'

export type WorkerAction = 'spec' | 'preview' | 'checked' | 'next' | 'progress' | 'op' | 'file' | 'finish' | 'fail'

export const WORKER_ACTIONS: readonly WorkerAction[] = ['spec', 'preview', 'checked', 'next', 'progress', 'op', 'file', 'finish', 'fail']

/** What a task is given once, when it asks: everything it needs, and nothing of Backenly's. */
export interface WorkerSpec {
  protocol: number
  kind: WorkerKind
  jobId: string
  source: ImportSourceId
  connection: ImportConnection
  userId: string
  orgId: string
  limits: ImportLimits
  /** When the task must have finished; the control plane stops it then regardless. */
  deadlineAt: string
  /** How long the source read for a look, or the check before an import, may take. */
  readMs: number
  /** An import only: what moves besides the tables. */
  include?: { users: boolean; files: boolean }
}

/** Ops the task asks the control plane to run against its job's project (lib/import/destination.ts). */
export const PG_OPS = ['pg.createTables', 'pg.measure', 'pg.insertRows', 'pg.insertUsers', 'pg.countRows', 'pg.finishSchema', 'pg.recordRules'] as const
export const FIREBASE_OPS = [
  'fb.createTables',
  'fb.addExtraColumn',
  'fb.insertRows',
  'fb.countRows',
  'fb.measureRows',
  'fb.prepareUsers',
  'fb.insertUsers',
  'fb.countImportedUsers',
  'fb.prepareFilesBucket',
] as const
export type DestinationOp = (typeof PG_OPS)[number] | (typeof FIREBASE_OPS)[number]

/** Why a task stopped, as it reports it. */
export interface WorkerFailure {
  /** Said to the person, already redacted by the task; the control plane redacts again. */
  message: string
  /** The form field to fix, for a refusal the person can act on. */
  field?: string
  /** The task stopped because it was told to, or ran out of time. */
  aborted?: 'canceled' | 'timeout' | null
  /** The task's own words were a refusal the person can act on (ImportInputError). */
  input?: boolean
}

export interface WorkerFinish {
  importedFrom: ImportedFrom
  warnings: string[]
}

export interface WorkerPreview {
  preview: ImportPreview
}

/**
 * Size caps for what a task may send, checked by the control plane before
 * parsing. A row batch aims at 8 MB (lib/import/pg-engine.ts BATCH_TARGET_BYTES)
 * and JSON adds quoting, so an op may carry 24 MB once decompressed.
 */
export const BODY_LIMITS = {
  json: 1024 * 1024,
  preview: 4 * 1024 * 1024,
  op: 24 * 1024 * 1024,
} as const

/** Larger JSON bodies are sent gzip-encoded. */
export const GZIP_ABOVE_BYTES = 64 * 1024

/** The answer to a write the plan's room had no space for (lib/import/destination.ts ROOM_REFUSED). */
export const ROOM_STATUS = 409
