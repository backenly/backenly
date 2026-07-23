/**
 * Detect row-security policies written against an identity nothing sets.
 *
 * Every other probe in this system looks for something that is failing. This one
 * looks for something that is SUCCEEDING INCORRECTLY, which is why it exists
 * separately.
 *
 * PostgREST authenticates the request itself and exposes the claims as
 * `request.jwt.claims`. It does NOT set the `app.*` GUCs that this platform used
 * to set by hand before running a query. So a policy written as
 *
 *   current_setting('app.current_user_id', true)
 *
 * evaluates against NULL under PostgREST, matches nothing, and the request
 * returns `200 {"data": []}`.
 *
 * Nothing errors. No log line appears. Monitoring sees healthy 200s and normal
 * latency. The only observable symptom is that a user's data appears to be gone
 * — the single worst way for a backend to fail, because the first person to
 * notice is the customer and their first conclusion is data loss.
 *
 * That is what makes this worth a dedicated probe: the failure is invisible to
 * every instrument that already exists, precisely because it is not an error.
 *
 * ── Why this probe survived the single-engine cutover ───────────────────────
 *
 * It used to compare a per-project engine flag against the policy dialect, and
 * could report a mismatch in either direction. Both data-plane executors were
 * deleted on 2026-07-21 and /api/v1 and /api/v2 now run on PostgREST
 * unconditionally, so "which engine is this project on" is no longer a question.
 *
 * The probe is STRONGER for it, not obsolete. With one engine there is exactly
 * one correct dialect, so a legacy-GUC policy is no longer a conditional
 * mismatch — it is unconditionally broken. This is the only automated guard
 * against that, and it is not hypothetical: lib/services/workspace-rls.ts, the
 * emitter behind every new table, was still writing GUC-form policies after the
 * executors were deleted, which left 32 dead policies in a live project.
 *
 * Read-only. Never repairs on its own — see the note on autoFixable below.
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { usesLegacyGucs } from '@/lib/postgrest/rls-translation'

export interface ConformanceResult {
  totalPolicies: number
  legacyPolicies: number
  jwtPolicies: number
  /** True when policies read an identity the running engine never sets. */
  mismatched: boolean
}

/**
 * Pure comparison, separated from the queries so the decision itself is
 * testable without a database.
 *
 * A project with NO policies is not mismatched: nothing depends on the identity
 * contract. Reporting those would bury the real cases under noise from every
 * project that has not enabled RLS.
 */
export function compareEngineToPolicies(
  legacyPolicies: number,
  jwtPolicies: number,
): ConformanceResult {
  const totalPolicies = legacyPolicies + jwtPolicies
  return {
    totalPolicies,
    legacyPolicies,
    jwtPolicies,
    mismatched: totalPolicies > 0 && legacyPolicies > 0,
  }
}

export async function detectRuntimeEngineMismatch(projectId: string): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`

  // No try/catch swallowing here. A probe that returns [] when it could not run
  // reports "healthy" for a project it never examined, and this system has been
  // bitten by exactly that before.
  const policies = await prisma.$queryRawUnsafe<Array<{ qual: string | null; with_check: string | null }>>(
    `SELECT qual, with_check FROM pg_policies WHERE schemaname = $1`,
    schema,
  )

  let legacyPolicies = 0
  let jwtPolicies = 0
  for (const p of policies) {
    if (usesLegacyGucs(p.qual) || usesLegacyGucs(p.with_check)) legacyPolicies++
    else jwtPolicies++
  }

  const result = compareEngineToPolicies(legacyPolicies, jwtPolicies)
  if (!result.mismatched) return []

  return [
    {
      // Finding type kept stable across the single-engine cutover on purpose:
      // renaming it would orphan the health_findings rows already written under
      // this key, and the failure it names — policies reading an identity that
      // is never set — is unchanged.
      type: 'runtime_engine_mismatch',
      severity: 'critical',
      details: {
        reason:
          `${result.legacyPolicies} of this project's ${result.totalPolicies} row-security ` +
          `policies still read the legacy app.current_user_id setting. The data plane is ` +
          `PostgREST, which sets request.jwt.claims and never sets that GUC, so those ` +
          `tables return no rows instead of returning an error.`,
        schema,
        totalPolicies: result.totalPolicies,
        legacyPolicies: result.legacyPolicies,
        jwtPolicies: result.jwtPolicies,
        remediation: `npx tsx scripts/migrate-rls-to-postgrest.ts --project ${projectId} --apply`,
      },
      // Deliberately NOT auto-fixable, though the reason has changed. It used to
      // be ambiguity: with two engines, migrating forward and rolling back were
      // both defensible and the probe could not know which was intended. With
      // one engine the direction is unambiguous — translate to claim form.
      //
      // It stays manual because rewriting a row-security policy is an
      // authorization change, and the safety floor is that auth-touching
      // mutations wait for a human regardless of how confident the machine is.
      // A mistranslation does not fail loudly; it silently widens a policy, and
      // a widened own-rows policy is cross-tenant exposure.
      autoFixable: false,
    },
  ]
}
