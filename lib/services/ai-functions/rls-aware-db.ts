/**
 * The database handle generated route modules receive as `@/lib/db`.
 *
 * ── The bug this exists to make impossible ──────────────────────────────────
 *
 * Generated functions were handed the raw Prisma client. That client holds a
 * pooled connection on which `request.jwt.claims` is never set — so
 * `backenly_jwt_claim('sub')` returns NULL inside every policy the function's
 * queries touch.
 *
 * Workspace tables are RLS-FORCED, which means the owner role is subject to
 * policies too. The result, on a table with the standard own-rows policy:
 *
 *   backenly_jwt_claim('role') = 'service_role'
 *     OR user_id::text = backenly_jwt_claim('sub')
 *
 *   READS   → NULL = NULL is not true → zero rows → HTTP 200 {"orders":[]}
 *   WRITES  → 42501 new row violates row-level security policy
 *
 * The write failure is loud. The read failure is not, and that is the serious
 * one: "you have no orders" is a plausible answer.
 *
 * ── Why the fix is not in the prompt ────────────────────────────────────────
 *
 * Telling the generator to set the claims makes correctness depend on a
 * language model reproducing a boilerplate incantation in every function it
 * ever writes, and a function that omits it fails SILENTLY. So the claims are
 * attached to the CONNECTION instead: every raw query a generated function
 * issues runs inside a transaction that sets the caller's identity first, and
 * a function's own $transaction gets that once, at the top.
 *
 * ── Where it runs ───────────────────────────────────────────────────────────
 *
 * In the function's runner process (isolation/function-runner.cjs,
 * makeDatabase), on the project's own function login (function-db-role.ts),
 * whose grants cover the project's schema and nothing else, with `search_path`
 * pinned there so an unqualified name means the project's table. This module
 * holds what the app decides and the runner only applies: the statement that
 * opens each transaction, and the claims it binds.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 *
 * Resolved by the app from the real request (`x-user-token` verified against
 * the PROJECT's jwtSecret, or `x-admin-key`), never from anything the function
 * body passes in. A function cannot elevate itself by asking, and its own login
 * is the boundary of what it can reach whatever claims it sets.
 */

import { rlsSessionSql, rlsSessionParams, type RlsIdentity } from '@/lib/services/rls-session'

/**
 * The subset of the Prisma client a route module is allowed to reach, with
 * every raw-SQL entry point wrapped.
 *
 * Model accessors (`prisma.user`, `prisma.post`) are deliberately absent: those
 * address the PLATFORM's public schema — users, projects, API keys — which a
 * tenant's function must never touch. The generator already tells the model
 * they do not exist; this makes that true rather than advisory.
 */
export interface RlsAwarePrisma {
  $queryRaw(...args: any[]): Promise<any>
  $queryRawUnsafe(sql: string, ...values: any[]): Promise<any>
  $executeRaw(...args: any[]): Promise<any>
  $executeRawUnsafe(sql: string, ...values: any[]): Promise<any>
  $transaction(fn: (tx: RlsAwarePrisma) => Promise<any>): Promise<any>
}

/**
 * The statement that opens every transaction of a function's SQL. `$1` is the
 * search path, `$2`.. the claims (functionDbClaims). `is_local = true` scopes
 * all of it to the transaction, so it reverts on commit and never leaks onto
 * the next borrower of a pooled connection.
 */
export const FUNCTION_DB_SESSION_SQL = `${rlsSessionSql(2)},\n       set_config('search_path', $1, true)`

/** The search path a function's SQL runs with: the project's schema first. */
export function functionSearchPath(schema: string): string {
  return `"${schema}", public`
}

/**
 * The claims a run's SQL binds for its caller (rlsSessionParams). Fixed for the
 * life of the run: rebuilding it per query would open a window where a function
 * could change its own identity mid-request.
 */
export function functionDbClaims(identity: RlsIdentity): string[] {
  return [...rlsSessionParams(identity)]
}

/** The claims of asService blocks: the service role. */
export const SERVICE_DB_CLAIMS: readonly string[] = Object.freeze([...rlsSessionParams({ userId: null, isServiceRole: true })])
