/**
 * API SECURITY SCANNER — Phase 7 (DRY-RUN ONLY)
 * =============================================
 * Walks the DomainApiPlanReport (Phase 6) and emits a structured catalog of
 * API-level security checks Backenly should perform before claiming the
 * generated surface is safe to ship.
 *
 * STRICT SHADOW MODE in Phase 7:
 *   • This module makes no DB calls and runs no SQL.
 *   • It produces a planning artifact only.
 *
 * Phase 8 will execute these checks against a sandbox workspace.
 */

import type {
  DomainApiPlan,
  DomainApiPlanReport,
} from '../../lib/ai/planning/types'

export type ApiSecurityCheckType =
  | 'requires_auth'
  | 'requires_role'
  | 'requires_input_schema'
  | 'requires_pagination'
  | 'requires_rate_limit'
  | 'requires_idempotency'
  | 'requires_transaction'
  | 'admin_path_locks_role'

export interface ApiSecurityCheck {
  /** Stable id, e.g. 'sec:POST_/admin/jobs:requires_role' */
  id: string
  apiId: string
  method: DomainApiPlan['method']
  path: string
  type: ApiSecurityCheckType
  severity: 'critical' | 'high' | 'medium' | 'low'
  /** One-sentence problem statement when the check fails */
  message: string
  /** Concrete fix the implementer should make */
  recommendation: string
  /** Always true in Phase 7 */
  shadowMode: true
}

export interface ApiSecurityScanReport {
  checks: ApiSecurityCheck[]
  /** All apis the scanner inspected (echoed for the dashboard) */
  scannedApiCount: number
  /** Aggregated warnings — sparse plan, no Phase 6 output, etc. */
  warnings: string[]
  /** Always true in Phase 7 */
  shadowMode: true
}

export interface ApiSecurityScannerInput {
  apis: DomainApiPlanReport
}

function add(
  checks: ApiSecurityCheck[],
  api: DomainApiPlan,
  type: ApiSecurityCheckType,
  severity: ApiSecurityCheck['severity'],
  message: string,
  recommendation: string,
) {
  checks.push({
    id: `sec:${api.method}_${api.path}:${type}`,
    apiId: api.id,
    method: api.method,
    path: api.path,
    type,
    severity,
    message,
    recommendation,
    shadowMode: true,
  })
}

export function scanApiSecurity(input: ApiSecurityScannerInput): ApiSecurityScanReport {
  const checks: ApiSecurityCheck[] = []
  const warnings: string[] = []

  const apis = input.apis?.apis ?? []
  if (apis.length === 0) {
    warnings.push('No domain API plans supplied — Phase 6 may be off.')
    return { checks: [], scannedApiCount: 0, warnings, shadowMode: true }
  }

  for (const api of apis) {
    const mutating = api.method !== 'GET'

    if (mutating && !api.requiredAuth) {
      add(checks, api, 'requires_auth', 'critical',
        `Mutating endpoint ${api.method} ${api.path} does not require authentication.`,
        'Wrap the route with the auth middleware and reject unauthenticated requests with 401.')
    }
    if (api.path.includes('/admin/') && api.requiredRole !== 'admin') {
      add(checks, api, 'admin_path_locks_role', 'critical',
        `Admin endpoint ${api.method} ${api.path} does not require role=admin.`,
        'Add an adminAuth middleware that re-reads users.role from the DB on every admin request.')
    }
    if (api.requiredRole && !api.requiredAuth) {
      add(checks, api, 'requires_auth', 'critical',
        `Endpoint ${api.method} ${api.path} declares requiredRole but not requiredAuth.`,
        'requiredAuth must be true wherever requiredRole is set.')
    }
    if (mutating && !api.inputSchemaRequired) {
      add(checks, api, 'requires_input_schema', 'high',
        `Mutating endpoint ${api.method} ${api.path} has no input schema requirement.`,
        'Validate the body / query with Zod before any handler logic runs.')
    }
    if (api.method === 'GET' && api.paginationRequired === false) {
      // Heuristic: list endpoints look like /things (no :id segment).
      const isListPath = /^\/[a-z0-9_\-]+$/i.test(api.path)
      if (isListPath) {
        add(checks, api, 'requires_pagination', 'medium',
          `List endpoint ${api.path} should declare pagination.`,
          'Accept ?limit + ?cursor (or ?page) and clamp to a server-defined max.')
      }
    }
    if (mutating && !api.rateLimitRequired) {
      add(checks, api, 'requires_rate_limit', 'high',
        `Mutating endpoint ${api.method} ${api.path} should declare rate limiting.`,
        'Wrap with the rate-limit middleware (e.g. 60/min per user, 600/min per IP).')
    }
    if (api.category === 'webhook' && !api.idempotencyRequired) {
      add(checks, api, 'requires_idempotency', 'critical',
        `Webhook endpoint ${api.method} ${api.path} does not declare idempotency.`,
        'Persist event_id with UNIQUE constraint and short-circuit duplicates with 200 no-op.')
    }
    if ((api.category === 'billing' || api.category === 'admin' || api.category === 'business') &&
      mutating && !api.transactionRequired) {
      add(checks, api, 'requires_transaction', 'high',
        `Mutating endpoint ${api.method} ${api.path} should run inside a DB transaction.`,
        'Wrap side effects + audit writes + state transitions in a single BEGIN/COMMIT.')
    }
  }

  return {
    checks,
    scannedApiCount: apis.length,
    warnings,
    shadowMode: true,
  }
}
