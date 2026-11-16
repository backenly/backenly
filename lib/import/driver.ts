/**
 * The seam every import source plugs into (Supabase, any Postgres, Firebase).
 *
 * The job runner (lib/import/jobs.ts) owns the lifecycle: it validates the
 * request, creates the NEW destination project through the normal creation
 * path, holds the connection in memory only, calls `inspect` / `run`, records
 * progress for GET /api/import/{jobId}, writes `importedFrom` on success, and
 * records the start and finish in History. A driver only reads its source and
 * writes the project it is handed.
 *
 * Wire types (what the console sees) live in ./contract.ts.
 */

import type {
  ImportConnection,
  ImportPreview,
  ImportProgress,
  ImportSourceId,
  ImportedFrom,
} from './contract'

export interface DriverContext {
  /** The person running the import (platform user id). */
  userId: string
  orgId: string
  /** Aborted when the person cancels or the job times out; check it between batches. */
  signal: AbortSignal
  /**
   * The v1 limits for this organization's plan (lib/import/limits.ts), set by
   * the runner. A source over one is refused with `ImportPreview.refusal` (in
   * inspect) or an ImportInputError (in check / run), saying the number.
   */
  limits?: ImportLimits
}

/** What one import may move. Bytes, as the source reports them. */
export interface ImportLimits {
  /** Rows, summed over every table (the smaller of 5 GB and the plan's database storage). */
  maxRowBytes: number
  /** Files, summed over every bucket (the plan's file storage), or null for no limit. */
  maxFileBytes: number | null
  /** Said in a refusal: "Your plan's database storage is 500 MB". */
  planName: string
}

export interface RunContext extends DriverContext {
  /** The new, empty Backenly project this import fills. */
  projectId: string
  /** The job's id, for records that say which import made them (e.g. rules held for approval). */
  jobId?: string
  include: { users: boolean; files: boolean }
  /**
   * Report progress. Merge semantics: tables are keyed by name; counts only go
   * up. Call it at least once per batch so the console's ledger moves.
   */
  progress: (patch: Partial<Omit<ImportProgress, 'jobId' | 'projectId' | 'projectName' | 'region' | 'orgId' | 'source' | 'status' | 'startedAt' | 'finishedAt'>>) => void
}

export interface RunResult {
  importedFrom: ImportedFrom
  warnings: string[]
}

export interface ImportDriver<S extends ImportSourceId = ImportSourceId> {
  source: S
  /** Read-only: what would move. Must not write anything anywhere. */
  inspect(connection: Extract<ImportConnection, { source: S }>, ctx: DriverContext): Promise<ImportPreview>
  /** Copy the source into ctx.projectId. Read-only on the source. */
  run(connection: Extract<ImportConnection, { source: S }>, ctx: RunContext): Promise<RunResult>
  /**
   * Optional, fast and read-only: refuse BEFORE the new project is created
   * (credentials that do not work, a source over a limit), so a bad start
   * leaves no empty project behind. POST /api/import awaits it; throw an
   * ImportInputError to refuse. A driver without one is checked by `run`.
   */
  check?(connection: Extract<ImportConnection, { source: S }>, ctx: DriverContext): Promise<void>
}

/** A refusal the person can act on, shown under the named field. */
export class ImportInputError extends Error {
  constructor(
    message: string,
    readonly field?: 'connectionString' | 'projectUrl' | 'serviceRoleKey' | 'serviceAccountJson' | 'name' | 'region' | 'schemas',
  ) {
    super(message)
    this.name = 'ImportInputError'
  }
}
