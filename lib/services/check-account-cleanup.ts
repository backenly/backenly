/**
 * Removing the end users Backenly's own checks sign up (lib/services/
 * check-accounts.ts) from a project's users table, every time.
 *
 * Each check removes its account in a `finally` (purgeSyntheticAuthArtifacts,
 * by address). Accounts were still left behind: an old project's users table
 * held 3 rows its Auth page did not show, and the Database tab and the app's
 * own queries counted them (production QA re-test, 2026-11-16, #20).
 *
 *   - A sign-up a check gave up waiting for (8 to 10 s) can still complete on
 *     the server after the `finally` has run, and nothing removed it. When the
 *     sign-ups of 9 November averaged 2 s with a p95 of 8.5 s, that was a
 *     regular event.
 *   - A process stopped mid-check (a deploy, a crash) never runs its `finally`.
 *
 * So a check whose sign-up did not answer purges its address again a little
 * later (purgeAgainLater), and each project is swept, at most once an hour per
 * process, for check accounts older than STALE_CHECK_ACCOUNT_MINUTES, which no
 * check still in progress can own (sweepStaleCheckAccounts).
 * scripts/report-check-accounts.ts lists the ones already left, and removes
 * them with --apply.
 */

import { CHECK_ACCOUNT_SQL } from '@/lib/services/check-accounts'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'

/** A check account older than this belongs to no check still in progress. */
export const STALE_CHECK_ACCOUNT_MINUTES = 15

/** How long after a check gave up on a sign-up its address is purged again. */
export const PURGE_AGAIN_AFTER_MS = 2 * 60_000

const SWEEP_EVERY_MS = 60 * 60_000
const lastSwept = new Map<string, number>()

async function purge(projectId: string, opts: { email?: string; olderThanMinutes?: number }) {
  const { purgeSyntheticAuthArtifacts } = await import('@/lib/services/end-user-auth-table')
  return purgeSyntheticAuthArtifacts(projectId, opts)
}

/**
 * Purge `email` again after `delayMs`: for a sign-up whose answer a check did
 * not wait for, which may complete after the check's own purge. Never throws,
 * and never keeps the process alive.
 */
export function purgeAgainLater(projectId: string, email: string, delayMs: number = PURGE_AGAIN_AFTER_MS): void {
  const timer = setTimeout(() => {
    purge(projectId, { email }).catch(() => {})
  }, delayMs)
  timer.unref?.()
}

/**
 * Remove the project's check accounts older than STALE_CHECK_ACCOUNT_MINUTES,
 * at most once an hour per process. Returns how many accounts were removed.
 * Never throws.
 */
export async function sweepStaleCheckAccounts(projectId: string, now: number = Date.now()): Promise<number> {
  const last = lastSwept.get(projectId)
  if (last !== undefined && now - last < SWEEP_EVERY_MS) return 0
  lastSwept.set(projectId, now)
  try {
    const removed = await purge(projectId, { olderThanMinutes: STALE_CHECK_ACCOUNT_MINUTES })
    return removed.find((r) => r.table === 'users')?.deleted ?? 0
  } catch {
    return 0
  }
}

/** Forget when projects were last swept (tests). */
export function resetCheckAccountSweeps(): void {
  lastSwept.clear()
}

export interface CheckAccountReport {
  /** Check accounts in the project's users table, of any age. */
  found: number
  /** Of those, older than STALE_CHECK_ACCOUNT_MINUTES: the ones --apply removes. */
  stale: number
  /** Removed by this run (always 0 without apply). */
  removed: number
  /** Why stale accounts could not be removed, when they could not. */
  failure: string | null
}

/**
 * Count the project's check accounts, and with `apply` remove the stale ones
 * and their side rows (email verifications, magic links, password resets).
 * Unlike the sweep, a failure is reported, not swallowed: the reason one could
 * not be removed (a foreign key from another table, say) is what an operator
 * needs to know.
 */
export async function reportCheckAccounts(projectId: string, apply: boolean): Promise<CheckAccountReport> {
  const { introspectAuthUsersTable } = await import('@/lib/services/end-user-auth-table')
  const { executeWithUserContext } = await import('@/lib/services/workspace-rls')
  const schema = await introspectAuthUsersTable(projectId)
  const report: CheckAccountReport = { found: 0, stale: 0, removed: 0, failure: null }
  if (schema.columns.size === 0 || !schema.columns.has('email')) return report

  const users = `"${schema.schemaName}"."users"`
  const created = schema.createdAtColumn
  const stale = created
    ? `${CHECK_ACCOUNT_SQL} AND "${created}" < now() - make_interval(mins => ${STALE_CHECK_ACCOUNT_MINUTES})`
    : null
  const counts = await executeWithUserContext<{ found: number; stale: number }>(
    projectId, '', true,
    `SELECT count(*)::int AS found, ${stale ? `count(*) FILTER (WHERE ${stale})::int` : '0'} AS stale
       FROM ${users} WHERE ${CHECK_ACCOUNT_SQL}`,
  )
  report.found = counts[0]?.found ?? 0
  report.stale = counts[0]?.stale ?? 0
  if (!apply || report.stale === 0 || !stale) return report

  try {
    const removed = await executeWithUserContext<{ x: number }>(
      projectId, '', true, `DELETE FROM ${users} WHERE ${stale} RETURNING 1 AS x`,
    )
    report.removed = removed.length
  } catch (err) {
    report.failure = sanitizeDiagnostic(err)
    return report
  }
  await purge(projectId, { olderThanMinutes: STALE_CHECK_ACCOUNT_MINUTES }).catch(() => {})
  return report
}
