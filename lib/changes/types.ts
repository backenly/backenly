/**
 * Shapes shared by the change lifecycle, recovery planning and the routes.
 * docs/CHANGE_RECOVERY.md describes how they fit together.
 */

import type { CatalogSnapshot } from './catalog'

/**
 * change    something someone asked for.
 * recovery  Backenly or a person restoring the state before another change. It
 *           is recorded like any change, with its own checkpoint, so the state
 *           it replaced is protected the same way.
 */
export type ChangeKind = 'change' | 'recovery'

/**
 * Where a change came from. Recorded so the history can say who did what:
 * "Claude Code via MCP" is not the same claim as "you, in the dashboard".
 */
export type ChangeSource =
  | 'mcp' // a coding agent's typed call or apply_migration
  | 'agent_chat' // backend_chat: the brain planned and ran it
  | 'approval' // a person approved what an agent (or Backenly) asked for
  | 'dashboard' // a person, in the console
  | 'branch_merge' // a preview branch replayed onto production
  | 'autonomy' // the self-healing loop
  | 'system' // Backenly itself: an automatic recovery

/** Sources that carry a person's explicit decision for this exact change. */
export const HUMAN_DECIDED_SOURCES: ReadonlySet<string> = new Set(['dashboard', 'approval'])

/**
 * The lifecycle, moved only by lib/changes/lifecycle.ts.
 *
 *   applying                    checkpoint taken, mutation running
 *   verifying                   applied; protected verification running
 *   healthy                     applied and verified
 *   unverified                  applied; a check could not run, so it is neither
 *                               verified nor failed (never recovered automatically)
 *   failed                      failed before changing anything
 *   partially_applied           failed part-way; what it applied is still in effect
 *   verification_failed         applied, and protected verification contradicted it
 *   awaiting_approval           recovery needed, not provably safe: a person decides
 *   recovering                  a recovery owns it (compare-and-set, with a lease)
 *   recovered                   Backenly restored the previous state and verified it
 *   restored                    a person restored the state before it
 *   recovery_failed             a recovery ran and did not produce a verified state
 *   manual_intervention_required  automation stopped; evidence kept; a person decides
 *   kept                        a person decided to keep it as it is after it
 *                               failed its checks; in effect, restorable later
 */
export type ChangeStatus =
  | 'applying'
  | 'verifying'
  | 'healthy'
  | 'unverified'
  | 'failed'
  | 'partially_applied'
  | 'verification_failed'
  | 'awaiting_approval'
  | 'recovering'
  | 'recovered'
  | 'restored'
  | 'recovery_failed'
  | 'manual_intervention_required'
  | 'kept'

/** In effect, nothing pending: the states a person can restore from. */
export const IN_EFFECT: ReadonlySet<string> = new Set(['healthy', 'unverified', 'kept'])

/** States in which the change failed and its recovery is still owed. */
export const RECOVERY_OWED: ReadonlySet<string> = new Set([
  'partially_applied',
  'verification_failed',
  'awaiting_approval',
  'recovery_failed',
  'manual_intervention_required',
])

/**
 * How much protection a change needs, decided from what it does:
 *
 *   additive      creates things; undone by removing them
 *   transforming  renames, retypes, nullability, defaults
 *   destructive   removes a table or a column: its data goes to the vault
 *   data_rewrite  rewrites existing rows: pre- and post-images are kept
 */
export type RiskClass = 'additive' | 'transforming' | 'destructive' | 'data_rewrite'

/** Data a change moved into its vault instead of destroying. */
export type PreservedEntry =
  | {
      kind: 'table'
      /** The table's name when it was moved. */
      table: string
      vault: string
      vaultTable: string
      rows: number | null
      /** Order-independent content checksum, taken when it was filled. */
      checksum?: string | null
    }
  | {
      kind: 'column'
      table: string
      column: string
      /**
       * Why the values were kept: the column was dropped, retyped by a cast that
       * may not round-trip, or its values were rewritten by a data migration.
       */
      reason: 'dropped' | 'retyped' | 'rewritten'
      /** Primary-key columns the values are keyed by; empty when the table had none. */
      keyColumns: string[]
      vault: string
      vaultTable: string
      rows: number | null
      checksum?: string | null
      /**
       * For a retype or a rewrite: the column in `vaultTable` holding the value
       * the change produced, so a restore can tell a row changed since (keep it)
       * from one the change left as it was (put the original back).
       */
      afterColumn?: string
      /** For a rewrite: the vault table holding the values from before it. */
      beforeTable?: string
    }

export interface ChangePreservation {
  vault: string
  entries: PreservedEntry[]
  /** Set when retention dropped the vault. */
  purgedAt?: string
}

/** What a footprint entry describes. Absent means a table. */
export type ObjectKind = 'table' | 'view' | 'materialized_view' | 'function' | 'type'

/** One object a change touched. Names index into the checkpoint / resultState. */
export interface TableChange {
  kind: 'added' | 'removed' | 'modified' | 'replaced'
  /** Absent for a table, which is what most entries are. */
  object?: Exclude<ObjectKind, 'table'>
  /** The name (or a function's signature) before the change; null when it created it. */
  before: string | null
  /** As the change left it; null when it removed it. */
  after: string | null
  /** What changed, one line each: "+ column likes integer". */
  details: string[]
}

export interface ChangeStep {
  /** The statement or tool call, as asked for. */
  statement: string
  tool?: string
  summary?: string
  ok: boolean
}

/** The resources a checkpoint covers. Only `database` is captured today. */
export interface Checkpoint {
  database: CatalogSnapshot & { platform?: unknown }
}

/** What the ledger stores for a change, typed. */
export interface ChangeRecordState {
  checkpoint: Checkpoint
  resultState: CatalogSnapshot | null
  footprint: TableChange[]
  preserved: ChangePreservation | null
}
