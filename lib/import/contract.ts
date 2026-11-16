/**
 * The import feature's wire contract, shared by the console (onboarding modal,
 * New project, the import flow at /app/org/[orgId]/import) and the server
 * (/api/import/*). Spec: the founder-approved flow of 2026-11-16 — Supabase,
 * Firebase and any Postgres, moved into a NEW Backenly project.
 *
 * Plain types only (no runtime code), so both sides import it freely. Change a
 * field here and both sides must change with it.
 */

export type ImportSourceId = 'supabase' | 'firebase' | 'postgres'

/** What the person supplies for each source. Never stored, logged or echoed back. */
export type ImportConnection =
  | {
      source: 'supabase'
      /** postgresql://postgres:…@db.<ref>.supabase.co:5432/postgres (direct, not the pooler). */
      connectionString: string
      /** https://<ref>.supabase.co — needed only to move Storage files. */
      projectUrl?: string
      /** The service_role key — needed only to move Storage files. */
      serviceRoleKey?: string
    }
  | {
      source: 'firebase'
      /** The service account key file's JSON text. */
      serviceAccountJson: string
    }
  | {
      source: 'postgres'
      connectionString: string
      /** Schemas to move; defaults to ["public"]. */
      schemas?: string[]
    }

/** A table as it will arrive. */
export interface ImportPreviewTable {
  /** The source's name (collection path for Firestore). */
  sourceName: string
  /** The Backenly table name; differs when a rename was needed. */
  name: string
  rows: number
  columns: number
  /** Short notes for this table: types that degrade, ids that were kept, etc. */
  notes: string[]
}

export interface ImportPreviewBucket {
  sourceName: string
  name: string
  files: number
  bytes: number
  public: boolean
}

export interface ImportPreviewRule {
  table: string
  /** A plain-words summary, e.g. "Owners can update their own rows". */
  summary: string
  /** The source's own definition (SQL USING/WITH CHECK, or the Firestore rule text when known). */
  definition: string | null
}

/** The Review step: what will move, read from the source without changing it. */
export interface ImportPreview {
  source: ImportSourceId
  /** The source project's own name or ref, to prefill the new project's name. */
  sourceLabel: string
  tables: ImportPreviewTable[]
  users: { total: number; withPassword: number; providerOnly: number; skipped: number } | null
  buckets: ImportPreviewBucket[] | null
  /** Access rules that will wait for the person's approval. */
  rules: ImportPreviewRule[]
  /** Things that do not move or change shape, in plain words. */
  warnings: string[]
  /** Set when the source is over a v1 limit; the flow cannot continue. */
  refusal: string | null
}

export type ImportJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export type ImportPhase = 'creating_project' | 'tables' | 'rows' | 'users' | 'files' | 'verifying' | 'finished'

export interface ImportProgressTable {
  name: string
  sourceRows: number
  copiedRows: number
  verified: boolean
}

/** The Move and Done steps: polled from GET /api/import/{jobId}. */
export interface ImportProgress {
  jobId: string
  projectId: string
  /** The new project's name and region, so the import page needs no second read. */
  projectName: string
  region: string
  orgId: string
  source: ImportSourceId
  status: ImportJobStatus
  phase: ImportPhase
  startedAt: string
  finishedAt: string | null
  tables: ImportProgressTable[]
  users: { total: number; copied: number } | null
  files: { total: number; copied: number; bytes: number; copiedBytes: number } | null
  /** Access rules recorded for approval. */
  rulesPending: number
  warnings: string[]
  /** In the source's or Backenly's own words; set when status is failed. */
  error: string | null
}

/** Recorded on the project once an import finishes (the Projects page's "Moved in from …"). */
export interface ImportedFrom {
  source: ImportSourceId
  at: string
  tables: number
  rows: number
  users?: number
  files?: number
  rulesPending: number
}

/** Request bodies. */
export interface ImportInspectRequest {
  orgId: string
  connection: ImportConnection
}

export interface ImportStartRequest {
  orgId: string
  connection: ImportConnection
  name: string
  region: string
  include: { users: boolean; files: boolean }
}

/**
 * GET /api/import?orgId= — the organization's running imports and those that
 * finished in the last 24 hours, newest first. The Projects page uses it to
 * show "◐ Importing" on a project until its import is done.
 */
export interface ImportJobsResponse {
  jobs: ImportProgress[]
}
