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
 * one: "you have no orders" is a plausible answer. A user who had just placed
 * an order caught it only because they knew what the answer should have been.
 * Anyone else ships a store whose order history is permanently empty and finds
 * out from a customer.
 *
 * This was not an oversight in one template — `lib/ai/function-generator.ts`
 * instructs the model to write `prisma.$queryRawUnsafe` against the workspace
 * schema directly, so EVERY generated route module that reads an RLS-protected
 * table had this bug.
 *
 * ── Why the fix is here and not in the prompt ───────────────────────────────
 *
 * The obvious repair is to tell the generator to set the claims. That makes
 * correctness depend on a language model reproducing a boilerplate incantation
 * in every function it ever writes, and a function that omits it fails SILENTLY.
 * A guarantee that degrades to a silent wrong answer when a prompt is not
 * followed is not a guarantee.
 *
 * So the claims are attached to the CONNECTION instead. Every raw query a
 * generated function issues runs inside a transaction that sets the caller's
 * identity first. Generated code cannot opt out, cannot forget, and does not
 * need to know this exists — `prisma.$queryRawUnsafe(...)` is simply correct
 * now, which is what the generator has always told it to write.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 *
 * Resolved by the runner from the real request (`x-user-token` verified against
 * the PROJECT's jwtSecret, or `x-admin-key`), never from anything the function
 * body passes in. A function cannot elevate itself by asking.
 */

import { prisma } from '@/lib/db'
import { rlsSessionSql, rlsSessionParams, type RlsIdentity } from '@/lib/services/rls-session'

/**
 * The subset of the Prisma client a route module is allowed to reach, with
 * every raw-SQL entry point wrapped.
 *
 * Model accessors (`prisma.user`, `prisma.post`) are deliberately NOT proxied
 * through: those address the PLATFORM's public schema — users, projects, API
 * keys — which a tenant's function must never touch. They were reachable
 * before. The generator already tells the model they do not exist
 * ("NEVER use prisma model accessors ... those models do not exist"); this
 * makes that true rather than advisory.
 */
export interface RlsAwarePrisma {
  $queryRaw(...args: any[]): Promise<any>
  $queryRawUnsafe(sql: string, ...values: any[]): Promise<any>
  $executeRaw(...args: any[]): Promise<any>
  $executeRawUnsafe(sql: string, ...values: any[]): Promise<any>
  $transaction(fn: (tx: RlsAwarePrisma) => Promise<any>): Promise<any>
}

/**
 * Build the claims-scoped client for one invocation.
 *
 * `identity` is fixed for the life of the call. Rebuilding it per query would
 * open a window where a function could mutate its own identity mid-request.
 */
export function makeRlsAwarePrisma(identity: RlsIdentity): RlsAwarePrisma {
  /**
   * Run `body` on a connection that already carries the caller's identity.
   *
   * `is_local = true` inside `rlsSessionSql` scopes the settings to this
   * transaction, so they revert on commit and can never leak onto the next
   * borrower of a pooled connection — the failure mode that would turn a
   * silent-empty bug into a cross-user data leak.
   */
  const withClaims = <T>(body: (tx: any) => Promise<T>): Promise<T> =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams(identity))
      return body(tx)
    })

  const wrap = (tx: any): RlsAwarePrisma => ({
    $queryRaw: (...args: any[]) => (tx.$queryRaw as any)(...args),
    $queryRawUnsafe: (sql: string, ...values: any[]) => tx.$queryRawUnsafe(sql, ...values),
    $executeRaw: (...args: any[]) => (tx.$executeRaw as any)(...args),
    $executeRawUnsafe: (sql: string, ...values: any[]) => tx.$executeRawUnsafe(sql, ...values),
    // Already inside a claims-carrying transaction — nesting another would
    // deadlock on the same connection. The callback gets this same handle.
    $transaction: (fn: (t: RlsAwarePrisma) => Promise<any>) => fn(wrap(tx)),
  })

  return {
    $queryRaw: (...args: any[]) => withClaims(tx => (tx.$queryRaw as any)(...args)),
    $queryRawUnsafe: (sql: string, ...values: any[]) =>
      withClaims(tx => tx.$queryRawUnsafe(sql, ...values)),
    $executeRaw: (...args: any[]) => withClaims(tx => (tx.$executeRaw as any)(...args)),
    $executeRawUnsafe: (sql: string, ...values: any[]) =>
      withClaims(tx => tx.$executeRawUnsafe(sql, ...values)),
    // A function that opens its own transaction gets the claims set once, at
    // the top, covering every statement inside it.
    $transaction: (fn: (tx: RlsAwarePrisma) => Promise<any>) => withClaims(tx => fn(wrap(tx))),
  }
}
