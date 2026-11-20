/**
 * WHERE AN IMPORT WRITES — the seam between reading a source and filling a project
 * ==============================================================================
 *
 * A driver reads its source and hands everything it would write to a
 * destination. Backenly Cloud runs the reading half in a sandbox task of its
 * own (lib/import/sandbox.ts, lib/import/worker/main.ts), which holds no
 * Backenly credential at all, and every write here happens in the control plane
 * (lib/import/local-destination.ts), behind lib/import/worker-api.ts, which
 * checks each call against the job's own project before running it. The same
 * drivers run in one process for the tests, with the local destination direct.
 *
 * So nothing a destination takes may be trusted for more than its shape: the
 * names go through the governed kernel (CREATE_TABLE refuses what it would not
 * write for an MCP agent, which is just as untrusted), rows go in as parameters,
 * and every write is counted against the plan's room by whoever runs it.
 */

import type { DeclaredForeignKey } from '@/lib/db/declared-foreign-key'
import type { FileUpload, FirebaseDestination, UploadOutcome } from './drivers/firebase-destination'
import type { PlannedColumn } from './pg-plan'
import type { AuthUserRow } from './pg-source'
import type { RuleProposal } from './rules'
import type { SupabaseBucket } from './supabase-storage'

export type { FileUpload, FirebaseDestination, UploadOutcome }

/** A table as CREATE_TABLE receives it: its Backenly name and declared columns, nothing about the source. */
export interface TableToCreate {
  name: string
  columns: PlannedColumn[]
}

/** The keys a table gets once its rows are in (pg-plan.ts DeferredForeignKey, without the why). */
export interface KeysToAdd {
  name: string
  deferredForeignKeys: Array<{ column: string; references: DeclaredForeignKey }>
}

/** A bucket made for the import: its id and the largest file it takes. */
export interface BucketTarget {
  id: string
  maxBytes: number
}

/** Where a Postgres or Supabase import writes. */
export interface PgDestination {
  /**
   * Every table, closed to all but the server key, as ONE governed change, with
   * the users table brought to the auth contract in the same change when the
   * users move too.
   */
  createTables(tables: TableToCreate[], opts: { title: string; usersTable: { social: boolean } | null }): Promise<void>
  /** Bytes the project's tables hold now (pg_total_relation_size, indexes and TOAST included): the room's measure. */
  measure(): Promise<number>
  /** One batch of rows, each value text or null, in `columns` order. How many arrived. */
  insertRows(table: string, columns: string[], rows: Array<Array<string | null>>): Promise<number>
  /** One batch of Supabase users. How many arrived. */
  insertUsers(users: AuthUserRow[]): Promise<number>
  /** Rows each table holds now. */
  countRows(tables: string[]): Promise<Map<string, number>>
  /**
   * The closing change: keys rows could not satisfy while arriving, and the
   * buckets files go into. Warnings for keys that could not be added.
   */
  finishSchema(input: {
    title: string
    keys: KeysToAdd[]
    buckets: SupabaseBucket[] | null
  }): Promise<{ warnings: string[]; targets: Map<string, BucketTarget> | null }>
  /** One file into one of the import's buckets. */
  uploadFile(bucketId: string, file: FileUpload): Promise<UploadOutcome>
  /** The source's access rules, held for a person's approval. How many wait. */
  recordRules(proposals: RuleProposal[], opts: { sourceLabel: string }): Promise<number>
}

/** Both kinds a driver may ask for; each is made once per run. */
export interface ImportDestinations {
  pg(): PgDestination
  firebase(): FirebaseDestination
}

/**
 * The room ran out where the destination counted it (lib/import/worker-api.ts),
 * said in the room's own words. A driver stops on it as on the room's own refusal.
 */
export const ROOM_REFUSED = 'IMPORT_ROOM'
