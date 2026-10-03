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
 *
 * ── Reach ───────────────────────────────────────────────────────────────────
 *
 * Claims decide which ROWS a policy admits; they never stopped a statement
 * naming another schema. The transaction ran on the app's connection, whose
 * role owns the platform tables and every workspace schema, so
 * `SELECT ... FROM public.users` or `workspace_<another project>.orders` simply
 * worked. It now runs on a client that logs in as the project's function role
 * (function-db-role.ts), whose grants cover its own workspace schema and
 * nothing else, with `search_path` pinned there so an unqualified name means
 * the project's table.
 */

import { rlsSessionSql, rlsSessionParams, type RlsIdentity } from '@/lib/services/rls-session'
import type { FunctionDbHandle } from './function-db-role'

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

/** Supplies the project's function login; `refresh` re-derives it after a refused login. */
export type FunctionDbConnector = (opts?: { refresh?: boolean }) => Promise<FunctionDbHandle>

/** Prisma's code for a login the server refused. Nothing has run yet when it fires. */
function isLoginRefused(err: unknown): boolean {
  const e = err as { errorCode?: string; code?: string } | null
  return e?.errorCode === 'P1000' || e?.code === 'P1000'
}

/**
 * Build the claims-scoped client for one invocation.
 *
 * `identity` is fixed for the life of the call. Rebuilding it per query would
 * open a window where a function could mutate its own identity mid-request.
 *
 * `connect` is asked on the first query, not when the module loads, so a
 * handler that never touches the database never opens a connection.
 */
export function makeRlsAwarePrisma(identity: RlsIdentity, connect: FunctionDbConnector): RlsAwarePrisma {
  let handle: Promise<FunctionDbHandle> | null = null

  /**
   * Run `body` on a connection that already carries the caller's identity.
   *
   * `is_local = true` scopes the settings to this transaction, so they revert
   * on commit and can never leak onto the next borrower of a pooled
   * connection — the failure mode that would turn a silent-empty bug into a
   * cross-user data leak. `search_path` is pinned here rather than trusted from
   * the role, because Prisma sets its own on every connection it opens.
   */
  const run = <T>(h: FunctionDbHandle, body: (tx: any) => Promise<T>): Promise<T> =>
    h.client.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(
        `${rlsSessionSql(2)},\n       set_config('search_path', $1, true)`,
        `"${h.schema}", public`,
        ...rlsSessionParams(identity),
      )
      return body(tx)
    })

  const withClaims = async <T>(body: (tx: any) => Promise<T>): Promise<T> => {
    handle ??= connect()
    try {
      return await run(await handle, body)
    } catch (err) {
      if (!isLoginRefused(err)) throw err
      handle = connect({ refresh: true })
      return run(await handle, body)
    }
  }

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

/**
 * A client every query of which is refused. Validation evaluates a module
 * without calling its handler, but a module's top level can still start a
 * query, and nothing being validated has a project to scope it to.
 */
export function refusingPrisma(reason: string): RlsAwarePrisma {
  const refuse = () => Promise.reject(new Error(reason))
  return {
    $queryRaw: refuse,
    $queryRawUnsafe: refuse,
    $executeRaw: refuse,
    $executeRawUnsafe: refuse,
    $transaction: refuse,
  }
}
