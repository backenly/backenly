/**
 * WHERE A PROJECT'S TABLES ARE
 * ============================
 *
 * A project's workspace schema lives in its own region's database
 * (lib/data-plane/regional.ts); `prisma` is the home platform database, in
 * every process and every region. Postgres accepts a schema missing from the
 * search path without complaint, so a statement sent to the wrong one does not
 * fail: a catalog read answers "no such table", a sample reads no rows.
 *
 * So nothing in structural evolution takes a bare schema name for work on a
 * project's tables. It takes this handle, resolved once per operation from the
 * project's own region, and every catalog read, sample, statistic, statement
 * and transaction about the project's tables goes through `db`. Platform
 * records (consent, ledger, findings, architecture memory, request logs) stay
 * on `prisma`, at home, where they always were.
 *
 * Where the tables are also decides what those records may say about them: for
 * a project kept outside the home region, never its SQL, a definition, a row's
 * value or the database's own words (./residency.ts). The handle carries that
 * as `quote`, so whatever holds it writes its words accordingly at the source.
 */

import type { WorkspaceRawClient } from '@/lib/data-plane/regional'

export interface WorkspaceAt {
  /** Empty for a schema this process reaches directly with no project behind it (tests). */
  readonly projectId: string
  readonly schema: string
  /** The project's own region's database. */
  readonly db: WorkspaceRawClient
  /**
   * May the platform's records at home quote this workspace: its statements,
   * definitions, row values and the database's words? Only for a project kept
   * in the home region, and never when that cannot be told.
   */
  readonly quote: boolean
}

/**
 * The project's workspace, in its own region. Throws when the region cannot be
 * reached from this process (RegionNotConfiguredError, UnknownRegionError):
 * an operation that cannot see the project's tables must not answer as if it
 * had looked.
 */
export async function workspaceAt(projectId: string): Promise<WorkspaceAt> {
  const [{ workspaceRawClient }, { resolveWorkspaceSchema }, { quotesKeptHere }] = await Promise.all([
    import('@/lib/data-plane/regional'),
    import('@/lib/services/workspace-pool'),
    import('@/lib/data-plane/residency'),
  ])
  const [db, schema, quote] = await Promise.all([
    workspaceRawClient(projectId),
    resolveWorkspaceSchema(projectId),
    quotesKeptHere(projectId),
  ])
  return { projectId, schema, db, quote }
}

/**
 * A schema on a client this process already holds: tests, and scratch schemas
 * on a known connection. In the home database unless told otherwise.
 */
export function workspaceOn(db: WorkspaceRawClient, schema: string, projectId = '', quote = true): WorkspaceAt {
  return { projectId, schema, db, quote }
}
