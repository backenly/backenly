/**
 * BACKENLY'S OWN WORK ON A PROJECT'S TABLES, WITH EVERY ROW IN VIEW
 * =================================================================
 * Every workspace table has FORCE ROW LEVEL SECURITY, which binds the table's
 * owner too, and the role Backenly connects as owns the tables without
 * bypassing row-level security. A statement it sends with no claims is
 * answered as nobody: an owner-scoped policy matches no row, so `users` reads
 * as empty and a count reads 0.
 *
 * That is right for a request served for an end user, and wrong for a check,
 * a count or a key that has to be about the whole table. On production
 * (2026-11-16) it refused a merge ("reviews has rows whose user_id matches no
 * users.id") and failed an approved foreign key (23503) while every review
 * pointed at a user who existed, and left a merge card silent about the rows
 * its statements would change. PostgreSQL's one-query check of a key added to
 * existing rows (RI_Initial_Check, on ADD CONSTRAINT and VALIDATE) runs under
 * the tables' policies when the caller owns them, unlike its row-by-row checks.
 *
 * So that work runs here: one transaction that first takes the service-role
 * session every Backenly policy admits (lib/services/rls-session.ts), as a
 * restore (lib/changes/recovery.ts) and queryWorkspaceAsOwner
 * (lib/services/workspace-pool.ts) already do. The settings are
 * transaction-local and end with it, so nothing leaks onto a pooled
 * connection. Ask for it at the call site that needs every row; a path that
 * serves end users must never use it.
 */

import type { Prisma } from '@prisma/client'
import type { WorkspaceRawClient } from './regional'
import { rlsSessionParams, rlsSessionSql, type RlsIdentity } from '@/lib/services/rls-session'

/** Backenly itself, as its own policies admit it: the service role. */
export const PLATFORM_IDENTITY: RlsIdentity = { userId: '', isServiceRole: true, userRole: 'service' }

/** One check reads at most one row of a large table; a key added to one scans it. */
const DEFAULT_TIMEOUT_MS = 120_000

export type OwnerTx = Prisma.TransactionClient

/**
 * Run `fn` in one transaction on `db` with every row visible to it. A
 * statement that fails ends the transaction, so run one statement per call
 * when a later one must still run after an earlier one fails.
 */
export async function asWorkspaceOwner<T>(
  db: WorkspaceRawClient,
  fn: (tx: OwnerTx) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams(PLATFORM_IDENTITY))
      return fn(tx)
    },
    { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxWait: 10_000 },
  )
}
