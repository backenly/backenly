/**
 * FIX CLASSIFIER
 * ==============
 * Pillar 4.1 — Decides what to do with each HealthFinding.
 *
 * Three possible outcomes:
 *   auto        — system applies the fix immediately; purely additive, no data risk
 *   approval    — fix is risky; shown in dashboard for one-click human confirmation
 *   notify_only — no automated remediation exists; alert the developer
 *
 * Rules:
 *  - A fix is AUTO only when: it adds protection/data/indexes and cannot delete or corrupt.
 *  - A fix is APPROVAL when: it touches auth, removes endpoints, or changes external services.
 *  - Everything else is NOTIFY_ONLY.
 */

import { normalizeFindingType } from './types'
import type { FindingType } from './types'

export type FixDecision = 'auto' | 'approval' | 'notify_only'

export interface FixClassification {
  decision: FixDecision
  reason: string
  suggestedAction?: string
  riskNote?: string
}

// ── Purely additive — safe to apply without asking ───────────────────────────

const AUTO_SAFE = new Set<FindingType>([
  'missing_rls',            // Adding RLS protection is always safe
  'api_drift',              // Re-generating a missing API is additive
  'missing_fk',             // Adding a FK constraint (safe when data is consistent)
  'missing_fk_index',       // Adding an index — performance only, no data change
  'missing_api_definition', // Generating a missing API definition
  'missing_api_crud',       // Generating missing CRUD endpoints
  'missing_rate_limit',     // Applying rate limit — additive protection
  'unprotected_user_data',  // Applying RLS to protect user rows
  'rls_expression_invalid', // Replacing a broken RLS expression with a correct one
  'realtime_gap',           // Installing a missing NOTIFY trigger
  'external_schema_change', // Adopting observed external DDL — bookkeeping only, never DDL
  // Self-healing default (2026-07-18): every fix below is additive and
  // snapshot-protected — the loop heals without asking. Only auth, external
  // credentials and destructive/irreversible changes still gate on a human.
  'orphan_table',           // ADOPT path only (REGISTER_TABLE): metadata + API around existing data — never drops
  'shadow_mutation',        // FIX_API re-syncs the API layer to the observed schema — adopts, never reverts
  'workflow_broken',        // FIX_WORKFLOW adds the missing components — additive, snapshotted
  'verification_failed',    // FIX_WORKFLOW structural repair for the failing check — additive, snapshotted
  // Registering a workspace schema with PostgREST. Additive and idempotent: it
  // restores exactly the state a correctly-created project is already in, and
  // re-asserts the credential-table revocation on the way, so it cannot widen
  // access. Left un-auto-fixed it means one customer's entire /db/* plane stays
  // dead — which is what happened to five projects before anyone noticed.
  'schema_not_registered',
])

// ── Requires human confirmation before executing ─────────────────────────────

// The 1% that always gates on a human — auth, external credentials, and
// anything destructive/irreversible. This is the safety floor, not a dial.
const NEEDS_APPROVAL = new Set<FindingType>([
  'broken_webhook',               // Needs action in an external dashboard (e.g. Stripe)
  'broken_auth',                  // Auth changes risk locking all end-users out
  'integration_key_invalid',      // Replacing credentials needs explicit confirmation
  'integration_webhook_failing',  // External service — user must validate endpoint
  'integration_smtp_unreachable', // SMTP config change — user must supply working creds
  'oauth_config_invalid',         // OAuth reconfig can break existing sessions
  'oauth_redirect_uri_missing',   // Redirect URI change requires IdP confirmation
  'dead_api_endpoint',            // Removing an endpoint may break existing clients
  'deploy_failure',               // Deployment decisions belong to the project owner
  'auth_spike',                   // Anomalous auth traffic — needs human investigation
  // Auth mutations are never auto-executed — safety contract
  'auth_jwt_missing',             // Restoring a JWT secret changes auth for all end-users
  'auth_users_table_missing',     // Creating the users table bootstraps the auth subsystem
])

// ── Public API ────────────────────────────────────────────────────────────────

export function classifyFix(
  rawType: string,
  details?: Record<string, unknown> | null,
): FixClassification {
  // Normalize dynamic `${category}_${location}` types (e.g. missing_rls_users,
  // schema_drift, n_plus_one_risk_orders) to a canonical base before classifying.
  const norm = normalizeFindingType(rawType, details)
  const type = (norm?.base ?? rawType) as FindingType

  if (AUTO_SAFE.has(type)) {
    return {
      decision: 'auto',
      reason: 'This fix is purely additive and cannot cause data loss or break existing behaviour.',
      suggestedAction: AUTO_ACTION_MAP[type],
    }
  }

  if (NEEDS_APPROVAL.has(type)) {
    return {
      decision: 'approval',
      reason: APPROVAL_REASON_MAP[type] ?? 'This fix requires human review before execution.',
      riskNote: RISK_NOTE_MAP[type],
    }
  }

  return {
    decision: 'notify_only',
    reason: 'No automated remediation is available for this finding type.',
  }
}

// ── Detail maps ───────────────────────────────────────────────────────────────

const AUTO_ACTION_MAP: Partial<Record<FindingType, string>> = {
  missing_rls:              'SET_PERMISSION (own_rows template)',
  api_drift:                'FIX_API',
  missing_fk:               'ADD_CONSTRAINT',
  missing_fk_index:         'CREATE_INDEX',
  missing_api_definition:   'GENERATE_API',
  missing_api_crud:         'GENERATE_API',
  missing_rate_limit:       'SET_RATE_LIMIT',
  external_schema_change:   'ADOPT_EXTERNAL_SCHEMA',
  unprotected_user_data:    'SET_PERMISSION (own_rows)',
  rls_expression_invalid:   'SET_PERMISSION (own_rows)',
  realtime_gap:             'FIX_REALTIME',
  schema_not_registered:    'REGISTER_POSTGREST_SCHEMA',
}

const APPROVAL_REASON_MAP: Partial<Record<FindingType, string>> = {
  broken_webhook:               'Webhook repair requires action in an external dashboard (e.g. Stripe, GitHub).',
  broken_auth:                  'Auth configuration changes carry high risk of locking out all end-users.',
  integration_key_invalid:      'Replacing integration credentials requires explicit confirmation from the project owner.',
  integration_webhook_failing:  'The receiving endpoint is external — the user must validate that it is live.',
  integration_smtp_unreachable: 'SMTP configuration change requires working credentials supplied by the user.',
  oauth_config_invalid:         'OAuth reconfiguration can invalidate existing user sessions.',
  oauth_redirect_uri_missing:   'Changing redirect URIs requires confirmation from the identity provider.',
  dead_api_endpoint:            'Removing an endpoint may break existing client integrations.',
  deploy_failure:               'Deployment decisions should be made by the project owner.',
  auth_spike:                   'Anomalous authentication traffic requires human investigation before acting.',
  auth_jwt_missing:             'Restoring or rotating a JWT secret invalidates all existing end-user sessions — project owner must confirm.',
  auth_users_table_missing:     'Creating the users table bootstraps the entire auth subsystem — project owner must confirm before activation.',
}

const RISK_NOTE_MAP: Partial<Record<FindingType, string>> = {
  broken_auth:      'An incorrect fix could lock all end-users out of the application.',
  dead_api_endpoint:            'Client apps calling this endpoint would receive 404 after removal.',
  auth_jwt_missing:             'An incorrect or premature JWT secret rotation locks all end-users out immediately.',
  auth_users_table_missing:     'Auto-creating the users table without owner confirmation may interfere with existing auth flows.',
}
