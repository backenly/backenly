/**
 * The RLS session contract — one definition, both dialects.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Backenly has two engines that talk to the same tables:
 *
 *   legacy runtime (Express)  sets  app.current_user_id / app.is_service_role
 *   PostgREST                 sets  request.jwt.claims
 *
 * A policy reads ONE of those. So the moment a project's policies are migrated
 * to the PostgREST form, every query issued by the legacy runtime stops
 * matching — and the failure is silent. Reads return an empty list, which is
 * indistinguishable from "no data", and writes fail with a bare RLS violation.
 *
 * This is not hypothetical. Project ce18214a was migrated without its engine
 * being flipped, and `/auth/signup` returned 500 for TWO MONTHS
 * (`row-level security blocked this operation`, 247 occurrences, first on
 * 2026-05-14) while every end-user read came back empty. Nobody noticed,
 * because an empty list and a broken backend look identical from outside.
 *
 * Crucially the cutover does NOT fix that on its own: `/auth/*` runs on the
 * Express runtime as the schema owner and never passes through PostgREST, so
 * the auth path keeps speaking the old dialect no matter which engine serves
 * `/db/*`.
 *
 * So every session setter now emits BOTH. Policies on either contract are
 * satisfied, the two engines can coexist during a staged migration, and a
 * half-migrated project is no longer a silent outage.
 *
 * Setting both is safe: `request.jwt.claims` is only read by the
 * `backenly_jwt_claim()` helper, and `app.*` only by the legacy predicates.
 * Neither engine is confused by the presence of the other's GUC.
 */

/** PostgREST's role vocabulary. Anonymous is a real value, not an absence. */
export type ClaimRole = 'service_role' | 'authenticated' | 'anon'

export interface RlsIdentity {
  /** End-user id, or null/empty for service-role and anonymous callers. */
  userId?: string | null
  isServiceRole?: boolean
  /** Application-level role (e.g. 'admin'), used by admin_read_all policies. */
  userRole?: string | null
}

export function claimRoleFor(identity: RlsIdentity): ClaimRole {
  if (identity.isServiceRole) return 'service_role'
  return identity.userId ? 'authenticated' : 'anon'
}

/**
 * The `request.jwt.claims` payload.
 *
 * `sub` is omitted rather than set to '' when there is no user: the claim
 * reader returns NULL for a missing key, and own-rows predicates compare
 * `owner::text = claim('sub')`. An empty string would make that comparison
 * FALSE-but-defined instead of NULL, which reads the same here but stops
 * matching the semantics PostgREST itself produces for an anonymous request.
 */
export function jwtClaimsJson(identity: RlsIdentity): string {
  const claims: Record<string, string> = { role: claimRoleFor(identity) }
  if (identity.userId) claims.sub = identity.userId
  if (identity.userRole) claims.user_role = identity.userRole
  return JSON.stringify(claims)
}

/**
 * SQL setting the whole session contract, with placeholders starting at $`from`.
 *
 * Bind with `rlsSessionParams` — the two are written together so the parameter
 * order cannot drift apart. Always `is_local = true` (third argument), so the
 * settings revert at transaction end and never leak onto a pooled connection.
 */
export function rlsSessionSql(from = 1): string {
  return (
    `SELECT set_config('app.current_user_id', $${from},     true),\n` +
    `       set_config('app.is_service_role',  $${from + 1}, true),\n` +
    `       set_config('app.user_role',        $${from + 2}, true),\n` +
    `       set_config('request.jwt.claims',   $${from + 3}, true)`
  )
}

/** Parameters for `rlsSessionSql`, in the same order. */
export function rlsSessionParams(identity: RlsIdentity): [string, string, string, string] {
  return [
    identity.userId ?? '',
    identity.isServiceRole ? 'true' : 'false',
    identity.userRole ?? 'user',
    jwtClaimsJson(identity),
  ]
}
