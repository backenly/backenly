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
import { isDataPlaneOutage } from './fix-actions'
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
  'rls_denies_everything',  // Installing a policy on a default-deny table RESTORES service
  'api_drift',              // Re-generating a missing API is additive
  // 'missing_fk' was here until 2026-08-09, described as "safe when data is
  // consistent". Two things were wrong with that.
  //
  // First, a foreign key is not additive. It permanently changes which writes
  // the database accepts: from that moment an INSERT naming a parent that does
  // not exist is rejected. Application code that relied on writing the child
  // first starts failing, and nothing in the schema says why.
  //
  // Second and worse, the repair also chooses a cascade rule, and
  // getCascadeRule's default branch is ON DELETE CASCADE. So the autonomous fix
  // was inferring, from a column name, that deleting one row should silently
  // delete every row referencing it. That is a destructive semantic change made
  // without asking, on the strength of a naming convention.
  //
  // It is still one click, and the approval now names the target table and the
  // exact ON DELETE rule, so the owner approves the behaviour rather than the
  // word "constraint".
  'missing_fk_index',       // Adding an index — performance only, no data change
  // Same repair, sourced from measured latency instead of a missing FK. The
  // column is parsed from pg_stat_statements and then verified to exist and to
  // be unindexed before the finding is ever raised, so by the time it reaches
  // here it is the same additive CREATE INDEX.
  'slow_query_missing_index',
  'infra_hot_table',        // Same shape: CREATE INDEX on a verified column, additive
  // Plain VACUUM (ANALYZE) on one table. Changes no row and no schema, holds no
  // exclusive lock, and is idempotent — the safest mutation in the catalogue.
  // Never VACUUM FULL; see executeVacuumTable for why that distinction is the
  // whole reason this can be automatic.
  'infra_table_bloat',
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
  // Rewrites what writes and deletes the database will accept, with a cascade
  // rule inferred from a column name. See the note in AUTO_SAFE above.
  'missing_fk',
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
  // Dropping an index is the one performance repair where being wrong costs
  // real money. "PostgreSQL never used it in 14 days" is strong evidence and
  // still not proof: only the application's author knows about the job that
  // runs quarterly. The drop is reversible (the pre-fix snapshot carries the
  // full definition) but a rebuild on a large table is slow, and every query
  // that needed the index is degraded for the whole rebuild. So Backenly
  // states the measurement and the owner decides — exactly the line between
  // "add an obviously missing index" and "decide an index is not needed".
  'unused_index',
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

  // ── Runtime contract: decided on evidence, not on the type alone ───────────
  //
  // The same finding type covers a repairable fault and an unrepairable one, so
  // this is the one family the type cannot classify by itself. Only the
  // data-plane shape (PostgREST down or wedged) has an executable repair.
  //
  // AUTO is deliberate for that shape. The data plane being down means every
  // /db/* request for the project is ALREADY failing, and the repair
  // (lib/postgrest/supervisor.ts) re-verifies the outage against an independent
  // platform probe before it touches anything, no-ops when PostgREST answers,
  // and is single-flighted platform-wide. Waiting for a human here is what left
  // a critical sitting in a queue while the customer's backend served 502s.
  if (type === 'contract_surface_broken') {
    if (isDataPlaneOutage(details)) {
      return {
        decision: 'auto',
        reason:
          'The REST data plane is not answering. Backenly re-verifies the outage and restarts ' +
          'the data plane itself — the backend is already down, so the repair can only improve it.',
        suggestedAction: 'HEAL_DATA_PLANE',
      }
    }
    return {
      decision: 'notify_only',
      reason:
        'This surface is served by the platform runtime, not by your project\'s schema — ' +
        'Backenly is monitoring it and will clear the finding automatically when it recovers.',
    }
  }

  // ── Hot table: also decided on evidence, for the same reason ───────────────
  //
  // The repair is CREATE_INDEX, which needs a column. The detector only supplies
  // one when it verified the column exists on the table and is not already the
  // leading column of an index; when it cannot, there is genuinely nothing to
  // apply. Rating that `auto` anyway is what produced the reported bug: the
  // dashboard drew an enabled "Fix now" button under copy promising Backenly
  // "can fix them itself", and every click returned a failure.
  //
  // Guessing a column instead is not an option — an index on the wrong column
  // costs write throughput for as long as it exists.
  // Slow queries: decided on evidence for exactly the reason above. The probe
  // only raises this with a column it verified against the catalog, so in
  // practice the column is always there — but the rating must depend on the
  // EVIDENCE rather than on the type, or a finding that arrived without one
  // (an older row, a hand-written entry) would be rated auto, reach
  // buildFixAction with nothing to build, and become a "Fix now" button that
  // fails on every click. That is a bug this repo has already shipped once.
  if (type === 'slow_query_missing_index' && !details?.columnName) {
    return {
      decision: 'notify_only',
      reason:
        'These queries are scanning instead of using an index, but Backenly could not confirm ' +
        'which column to index safely. Naming the wrong one would slow every write to the table.',
    }
  }

  if (type === 'infra_hot_table' && !details?.columnName) {
    return {
      decision: 'notify_only',
      reason:
        'This table is taking heavy sequential scans, but Backenly could not identify a column ' +
        'it is safe to index on its own. Pick the column your queries filter or sort by.',
    }
  }

  // ── Service-role key reaching a browser ────────────────────────────────────
  //
  // notify_only, and deliberately not approval: an approval queue implies there
  // is a repair waiting behind a yes, and here there is not. Revoking the key
  // would stop a breach the runtime is ALREADY refusing and break whatever
  // server code legitimately uses it — trading a blocked attack for a certain
  // outage. The actual fix is in the owner's frontend bundle, which Backenly
  // does not own and must not pretend it can edit.
  //
  // Critical severity with no auto-fix is the honest shape for this one: the
  // platform has already contained it, and the owner still has to act.
  if (type === 'service_role_key_exposed') {
    return {
      decision: 'notify_only',
      reason:
        'Backenly is already refusing these requests, so no data is being served. The remaining ' +
        'fix is in your own code — move the service-role key to a server route, switch the ' +
        'browser to a client key, then revoke and reissue the exposed one.',
      riskNote:
        'Revoking this key automatically would break any server code legitimately using it, so ' +
        'Backenly will not do it without you.',
    }
  }

  // ── Schema design ─────────────────────────────────────────────────────────
  //
  // notify_only for a reason that is specific rather than cautious: every repair
  // here is a migration against live data. SET NOT NULL takes a lock, a UNIQUE
  // index fails outright the moment a duplicate exists, a CHECK needs the
  // owner's actual value list, and ALTER TYPE on money rounds. None of them is
  // additive, and the platform's own rule is that non-additive schema change
  // belongs to a human. The probe states the exact migration instead.
  if (type === 'schema_design_defect') {
    return {
      decision: 'notify_only',
      reason:
        'Backenly measured this against your live data and can give you the exact migration, ' +
        'but running it changes an existing column, so it is yours to apply.',
      riskNote:
        'Each of these locks or rewrites a column that already holds data. Apply them during ' +
        'a quiet window, not automatically.',
    }
  }

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
  rls_denies_everything:    'SET_PERMISSION (schema-inferred template)',
  api_drift:                'FIX_API',
  missing_fk_index:         'CREATE_INDEX',
  slow_query_missing_index: 'CREATE_INDEX',
  infra_hot_table:          'CREATE_INDEX',
  infra_table_bloat:        'VACUUM_TABLE',
  missing_api_definition:   'GENERATE_API',
  missing_api_crud:         'GENERATE_API',
  missing_rate_limit:       'SET_RATE_LIMIT',
  external_schema_change:   'ADOPT_EXTERNAL_SCHEMA',
  unprotected_user_data:    'SET_PERMISSION (own_rows)',
  rls_expression_invalid:   'SET_PERMISSION (own_rows)',
  realtime_gap:             'FIX_REALTIME',
  // Was 'REGISTER_POSTGREST_SCHEMA' — an action name that never existed in the
  // executor. The rating was right and the label was fiction, so an approval
  // that reached buildFixAction found no mapping and dead-ended.
  schema_not_registered:    'REGISTER_SCHEMA',
  contract_surface_broken:  'HEAL_DATA_PLANE',
}

const APPROVAL_REASON_MAP: Partial<Record<FindingType, string>> = {
  missing_fk:                   'Adding a foreign key changes which writes the database accepts from that moment on, and the delete rule is inferred from the column name — so it is stated for you to approve rather than applied.',
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
  unused_index:                 'Backenly measured that PostgreSQL never used this index, but only you know whether something that runs rarely still needs it.',
}

const RISK_NOTE_MAP: Partial<Record<FindingType, string>> = {
  missing_fk:       'Under ON DELETE CASCADE, deleting a parent row also deletes every row referencing it. Existing rows pointing at a missing parent will make the constraint fail until they are cleaned up.',
  broken_auth:      'An incorrect fix could lock all end-users out of the application.',
  dead_api_endpoint:            'Client apps calling this endpoint would receive 404 after removal.',
  auth_jwt_missing:             'An incorrect or premature JWT secret rotation locks all end-users out immediately.',
  auth_users_table_missing:     'Auto-creating the users table without owner confirmation may interfere with existing auth flows.',
  unused_index:                 'If a rarely-run query does need it, that query gets slow until the index is rebuilt.',
}
