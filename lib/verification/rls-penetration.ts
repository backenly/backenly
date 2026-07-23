/**
 * RLS PENETRATION PLANNER — Phase 7 (DRY-RUN ONLY)
 * ================================================
 * Specialised companion to verification-planner.ts that focuses on cross-user
 * row-level-security tests. The planner walks the BusinessRulesReport,
 * picks every rule whose enforcement is `rls_policy`, and emits a structured
 * "penetration test plan" describing how a hostile second user would attempt
 * to read or write the protected rows.
 *
 * STRICT SHADOW MODE in Phase 7:
 *   • This module makes no DB calls and runs no SQL.
 *   • It produces a planning artifact only.
 *
 * Phase 8 will execute these plans against a sandbox workspace.
 */

import type { ProductUnderstanding } from '../../lib/ai/understanding/types'
import type {
  BusinessRule,
  BusinessRulesReport,
} from '../../lib/ai/planning/types'

export type RlsAttackVector =
  | 'direct_row_id_guess'
  | 'cross_user_write'
  | 'storage_url_enumeration'
  | 'forged_jwt_role'
  | 'admin_role_escalation'

export interface RlsPenetrationCase {
  /** Stable id, e.g. 'rls_pen:private_asset_owner_access:direct_row_id_guess' */
  id: string
  ruleId: string
  table: string
  vector: RlsAttackVector
  /** One-sentence summary of the attack */
  description: string
  /** Pre-conditions that must hold before the attack can be staged */
  preconditions: string[]
  /** What it means in business terms if this attack succeeds */
  failureMeaning: string
  /** Concrete how-to-stage guidance */
  attackHint: string
  /** Always true in Phase 7 */
  shadowMode: true
}

export interface RlsPenetrationReport {
  cases: RlsPenetrationCase[]
  /** Tables we'd attack — duplicated for the dashboard convenience */
  tablesUnderTest: string[]
  /** Aggregated warnings */
  warnings: string[]
  /** Always true in Phase 7 */
  shadowMode: true
}

export interface RlsPenetrationInput {
  understanding: ProductUnderstanding
  rules: BusinessRulesReport
}

const VECTORS_BY_CATEGORY: Record<string, RlsAttackVector[]> = {
  authorization: ['direct_row_id_guess', 'cross_user_write', 'forged_jwt_role'],
  storage: ['direct_row_id_guess', 'storage_url_enumeration'],
  admin: ['forged_jwt_role', 'admin_role_escalation'],
  security: ['direct_row_id_guess', 'forged_jwt_role'],
}

function describeVector(rule: BusinessRule, table: string, vector: RlsAttackVector): string {
  switch (vector) {
    case 'direct_row_id_guess':
      return `User B requests ${table} rows owned by user A by guessing or enumerating IDs.`
    case 'cross_user_write':
      return `User B issues an INSERT/UPDATE on ${table} with user_id=A in the body.`
    case 'storage_url_enumeration':
      return `Attacker enumerates object keys under ${table}'s storage prefix to bypass signed URLs.`
    case 'forged_jwt_role':
      return `Attacker mints a JWT with claim role="admin" and calls a protected endpoint.`
    case 'admin_role_escalation':
      return `Regular user calls an /admin/* endpoint expecting the gateway to defer to JWT claims only.`
  }
}

function attackHint(vector: RlsAttackVector): string {
  switch (vector) {
    case 'direct_row_id_guess':
      return 'GET /<table>/<id> with the auth token of user B; assert 403/404. RLS USING clause must filter by owner_id.'
    case 'cross_user_write':
      return 'POST /<table> with body { user_id: A } as user B; RLS WITH CHECK clause must reject the row.'
    case 'storage_url_enumeration':
      return 'Issue an unsigned GET to the object-store path; signed-URL middleware must require a valid signature scoped to the caller.'
    case 'forged_jwt_role':
      return 'Sign a JWT claim role="admin" with a different key; the server must re-read role from the DB and reject.'
    case 'admin_role_escalation':
      return 'Call any /admin/* path with a regular-user JWT; expect 403 from the adminAuth middleware.'
  }
}

function preconditions(vector: RlsAttackVector, table: string): string[] {
  switch (vector) {
    case 'direct_row_id_guess':
      return [`row in ${table} owned by user A exists`, 'user B has a valid auth token']
    case 'cross_user_write':
      return [`${table} table has user_id column`, 'RLS WITH CHECK clause defined']
    case 'storage_url_enumeration':
      return ['storage object exists for user A', 'object key uses owner-prefixed path']
    case 'forged_jwt_role':
      return ['protected endpoint exists', 'admin role exists in users.role enum']
    case 'admin_role_escalation':
      return ['admin endpoint mounted', 'regular user account exists']
  }
}

function failureMeaning(rule: BusinessRule, vector: RlsAttackVector): string {
  if (vector === 'storage_url_enumeration') {
    return 'Private storage objects are downloadable by anyone who guesses an object key — direct PII / asset leak.'
  }
  if (vector === 'forged_jwt_role' || vector === 'admin_role_escalation') {
    return 'JWT claim is trusted blindly — anyone can assume admin and execute privileged operations.'
  }
  if (vector === 'cross_user_write') {
    return 'Adversary can write rows in another user\'s name — data integrity collapse.'
  }
  // direct_row_id_guess
  return rule.severity === 'critical'
    ? 'Cross-tenant read — adversary can enumerate other users\' protected data.'
    : 'Information disclosure: adversaries learn that another user\'s row exists.'
}

export function planRlsPenetration(input: RlsPenetrationInput): RlsPenetrationReport {
  const cases: RlsPenetrationCase[] = []
  const tables = new Set<string>()
  const warnings: string[] = []

  const rules = input.rules.rules ?? []
  if (rules.length === 0) {
    warnings.push('No business rules supplied — cannot plan RLS penetration tests.')
    return { cases: [], tablesUnderTest: [], warnings, shadowMode: true }
  }

  for (const rule of rules) {
    const isRls = rule.enforcement === 'rls_policy'
    const isAdmin = rule.enforcement === 'audit_log' && rule.category === 'admin'
    const isAdminMw = rule.enforcement === 'api_middleware' && rule.category === 'admin'
    if (!isRls && !isAdmin && !isAdminMw) continue

    const vectors = new Set<RlsAttackVector>(VECTORS_BY_CATEGORY[rule.category] ?? [])
    if (vectors.size === 0) vectors.add('direct_row_id_guess')

    const ruleTables = (rule.appliesTo.tables ?? []).filter(Boolean)
    if (ruleTables.length === 0) ruleTables.push('<unknown_table>')

    for (const table of ruleTables) {
      tables.add(table)
      for (const vector of vectors) {
        cases.push({
          id: `rls_pen:${rule.id}:${vector}:${table}`,
          ruleId: rule.id,
          table,
          vector,
          description: describeVector(rule, table, vector),
          preconditions: preconditions(vector, table),
          failureMeaning: failureMeaning(rule, vector),
          attackHint: attackHint(vector),
          shadowMode: true,
        })
      }
    }
  }

  if (cases.length === 0) {
    warnings.push('No RLS / admin rules detected — no penetration cases planned.')
  }

  return {
    cases,
    tablesUnderTest: [...tables],
    warnings,
    shadowMode: true,
  }
}
