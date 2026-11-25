/**
 * The destination that writes: the project's own database, buckets and
 * findings, through Backenly's own code paths. It runs in the control plane,
 * either directly (an import run in one process, which only the tests do) or
 * for an import's sandbox, behind lib/import/worker-api.ts, which checks every
 * call before it reaches here. See lib/import/destination.ts.
 */

import type { BucketTarget, ImportDestinations, PgDestination } from './destination'
import { backenlyDestination, uploadImportFile, type FirebaseDestination } from './drivers/firebase-destination'
import { addDeferredKeys, createTables, destinationCounts, destinationError, insertBatch, measureProjectRows } from './pg-engine'
import { recordRulesForApproval } from './rules'
import { insertAuthUsers, prepareUsersTable } from './supabase-auth'
import { createBuckets } from './supabase-storage'

export interface LocalDestinationInput {
  projectId: string
  /** The person running the import: the console uploader its files are recorded under. */
  userId: string
  /** The import's job, named on the rules it holds for approval. */
  jobId?: string
  /** Stops schema work between tables when the import is canceled (one-process runs). */
  signal?: AbortSignal
}

export function localDestinations(input: LocalDestinationInput): ImportDestinations {
  let pg: PgDestination | undefined
  let firebase: FirebaseDestination | undefined
  return {
    pg: () => (pg ??= localPgDestination(input)),
    firebase: () => (firebase ??= backenlyDestination({ projectId: input.projectId, userId: input.userId })),
  }
}

export function localPgDestination(input: LocalDestinationInput): PgDestination {
  const { projectId, userId } = input
  const signal = input.signal ?? new AbortController().signal

  return {
    async createTables(tables, opts) {
      await createTables(projectId, tables, {
        title: opts.title,
        signal,
        extra: opts.usersTable ? () => prepareUsersTable(projectId, opts.usersTable!) : undefined,
      })
    },

    measure: () => measureProjectRows(projectId),

    async insertRows(table, columns, rows) {
      const { projectPool } = await import('@/lib/data-plane/regional')
      const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
      const pool = await projectPool(projectId, 'import', { max: 4 })
      try {
        return await insertBatch(pool, workspaceSchemaName(projectId), table, columns, rows)
      } catch (err) {
        throw destinationError(table, err)
      }
    },

    insertUsers: (users) => insertAuthUsers(projectId, users),

    countRows: (tables) => destinationCounts(projectId, tables),

    async finishSchema({ title, keys, buckets }) {
      const deferred = keys.reduce((n, t) => n + t.deferredForeignKeys.length, 0)
      const warnings: string[] = []
      let targets: Map<string, BucketTarget> | null = null
      if (deferred === 0 && !buckets?.length) return { warnings, targets }
      const { withGovernedChange } = await import('@/lib/changes/ledger')
      await withGovernedChange({ projectId, title }, async () => {
        if (deferred) warnings.push(...(await addDeferredKeys(projectId, keys, signal)))
        if (buckets?.length) targets = await createBuckets(projectId, buckets)
      })
      return { warnings, targets }
    },

    uploadFile: (bucketId, file) => uploadImportFile({ projectId, userId }, bucketId, file),

    recordRules: (proposals, opts) => recordRulesForApproval(projectId, proposals, { sourceLabel: opts.sourceLabel, jobId: input.jobId ?? '' }),
  }
}
