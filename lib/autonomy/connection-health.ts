/**
 * CONNECTION HEALTH — the half of connection pressure a tenant can actually fix
 * =============================================================================
 *
 * `detectConnectionPressure` in lib/ai/infra-intelligence.ts counted every
 * connection to the database and filed the result as a per-project finding. On a
 * shared cluster that is one platform fact attributed to every tenant at once:
 * ten customers each told their backend is at 82% of max_connections, none of
 * them able to do anything about it, and the number moving for reasons that have
 * nothing to do with them. It is the `_email_verifications` false positive
 * again — a finding against something the owner neither created nor controls.
 *
 * ── What IS attributable ────────────────────────────────────────────────────
 *
 * Direct database access (lib/services/direct-access.ts) hands each project its
 * own PostgreSQL login roles — `bkn_ro_<hex>`, `bkn_rw_<hex>`, `bkn_own_<hex>` —
 * derived deterministically from the project id. Every session opened with one
 * of those is unambiguously that project's: a psql window, a migration tool, a
 * TablePlus connection, a script.
 *
 * So this probe asks a question the owner can answer: are YOUR connections
 * behaving? And the answer that matters is `idle in transaction`.
 *
 * ── Why idle-in-transaction and not raw connection count ────────────────────
 *
 * A session that has run BEGIN and then gone quiet is not idle. It is holding
 * every lock it took, blocking DDL on those tables, and pinning the vacuum
 * horizon so dead rows across the whole database cannot be reclaimed. It is one
 * of the few database problems where a single forgotten window degrades
 * everything else, and it is invisible from the application: no error, no slow
 * query, just a table that will not migrate and bloat that will not clear.
 *
 * A high connection COUNT, by contrast, is usually fine and is bounded by the
 * pool anyway. Counting it produced a number; this produces a cause.
 *
 * ── The evidence gate ───────────────────────────────────────────────────────
 *
 * Duration, not presence. Every transaction is briefly idle-in-transaction
 * between statements, so an instantaneous sample flags healthy work — and this
 * probe runs every minute, which would make that a permanent flapping finding.
 * IDLE_TX_MIN_SECONDS is the line where it stops being a transaction and starts
 * being a leak.
 *
 * Read-only. Never terminates a backend: killing someone's session mid-
 * transaction rolls back work they may care about, and the platform does not
 * know what that work is.
 */

import { Pool } from 'pg'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import type { RawFinding } from '@/lib/core/types'

/**
 * How long a session must sit inside an open transaction before it counts.
 *
 * Five minutes. Long enough that no normal request-scoped transaction survives
 * it — the platform's own pooled work is measured in milliseconds — and short
 * enough that the owner hears about a forgotten psql window in the same working
 * session rather than the next morning.
 */
export const IDLE_TX_MIN_SECONDS = 300

/**
 * Connections one project's own roles are holding open, and for how long.
 *
 * Deliberately NOT a count of all connections: see the module header.
 */
export const IDLE_TX_QUERY = `
  SELECT usename,
         count(*)::int                                                   AS sessions,
         max(EXTRACT(EPOCH FROM (now() - state_change)))::int            AS max_idle_seconds,
         max(EXTRACT(EPOCH FROM (now() - xact_start)))::int              AS max_txn_seconds
    FROM pg_stat_activity
   WHERE datname = current_database()
     AND state = 'idle in transaction'
     AND usename = ANY($1::text[])
     AND EXTRACT(EPOCH FROM (now() - state_change)) >= $2
   GROUP BY usename`

let pool: Pool | null = null
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return pool
}

function fmtDuration(seconds: number): string {
  if (seconds >= 7200) return `${Math.floor(seconds / 3600)} hours`
  if (seconds >= 3600) return '1 hour'
  if (seconds >= 120) return `${Math.floor(seconds / 60)} minutes`
  return `${seconds} seconds`
}

export async function detectIdleInTransaction(projectId: string): Promise<RawFinding[]> {
  const roles = directAccessRoleNames(projectId)
  const roleList = [roles.ro, roles.rw, roles.owner]

  let rows: Array<{
    usename: string
    sessions: number
    max_idle_seconds: number
    max_txn_seconds: number | null
  }>
  try {
    const res = await getPool().query(IDLE_TX_QUERY, [roleList, IDLE_TX_MIN_SECONDS])
    rows = res.rows as typeof rows
  } catch (err: any) {
    // Same contract as every probe in this catalogue: an empty result must never
    // stand in for "could not check". computeDesiredStateDiff isolates the throw
    // and marks the invariant unsatisfied rather than silently healthy.
    throw new Error(`[detectIdleInTransaction] probe failed: ${err?.message ?? String(err)}`)
  }

  if (rows.length === 0) return []

  const sessions = rows.reduce((n, r) => n + r.sessions, 0)
  const worstIdle = Math.max(...rows.map(r => r.max_idle_seconds))
  const worstTxn = Math.max(...rows.map(r => r.max_txn_seconds ?? 0))

  // ONE finding, not one per role. The owner has a single problem — a client of
  // theirs is holding a transaction open — and splitting it by internal role
  // name would make them read the same sentence twice.
  return [{
    type: 'idle_in_transaction',
    severity: worstIdle >= 3600 ? 'critical' : 'warning',
    autoFixable: false,
    details: {
      location: 'direct-connection',
      sessions,
      maxIdleSeconds: worstIdle,
      maxTransactionSeconds: worstTxn,
      roles: rows.map(r => r.usename),
      reason:
        `${sessions} direct database connection${sessions === 1 ? ' has' : 's have'} been sitting ` +
        `inside an open transaction for ${fmtDuration(worstIdle)}. Until ${sessions === 1 ? 'it commits' : 'they commit'} ` +
        `or ${sessions === 1 ? 'disconnects' : 'disconnect'}, every lock ${sessions === 1 ? 'it took is' : 'they took are'} ` +
        `still held — schema changes on those tables will block, and dead rows across the whole ` +
        `database cannot be vacuumed away. This is usually a psql window, a notebook, or a ` +
        `migration tool that ran BEGIN and stopped.`,
    },
  }]
}
