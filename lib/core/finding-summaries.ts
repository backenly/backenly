/**
 * FINDING SUMMARIES — the single human-language rendering of a HealthFinding.
 *
 * Both the dashboard AdvisorBlock (client) and /api/projects/:id/health
 * (server) render finding rows for the user. They used to each carry their own
 * partial switch over finding types; anything either copy didn't know fell
 * through to the raw type string ("verification failed") — a HIGH-severity row
 * with zero explanation. This module is the one place a finding becomes a
 * sentence, covering the full FindingType vocabulary.
 *
 * Layered so it can never silently degrade to a bare type again:
 *   1. Curated one-liners per canonical type (via normalizeFindingType, so
 *      suffixed multi-agent types like `missing_rls_users` also land here).
 *   2. The detector's own `details.reason` — every lib/core + lib/autonomy
 *      detector writes one — or `details.message` / `details.detail`.
 *   3. The humanized type, last resort only.
 *
 * Pure module: no prisma, no server-only imports — safe in client components.
 */

import { normalizeFindingType } from './types'

type Details = Record<string, unknown> | null | undefined

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined
}

/**
 * Free-form detector text destined for the one-line summary. Some older
 * findings persisted a raw response body inside their sentence
 * (`… returned 404: {"success":false,"error":…}`) — serialized JSON belongs in
 * the Details expander, never the row, so cut the sentence at the first JSON
 * literal and drop the dangling separator.
 */
function sentence(v: unknown): string | undefined {
  const s = str(v)
  if (!s) return undefined
  const cut = s.search(/[{[]\s*"/)
  const clean = (cut === -1 ? s : s.slice(0, cut)).replace(/[\s:—-]+$/, '').trim()
  return clean.length > 0 ? clean : undefined
}

/** Render a finding's type + details as one user-facing sentence. */
export function summariseFinding(type: string, details: Details): string {
  const d = (details ?? {}) as Record<string, unknown>
  const norm = normalizeFindingType(type, d)
  const table =
    norm?.tableName ?? str(d.tableName) ?? str(d.table) ?? str(d.name)

  // ── Aliased families first ────────────────────────────────────────────────
  // The normalizer maps these onto a canonical base so the FIX engine knows
  // what to do (arch_migration → shadow_mutation, n_plus_one_risk →
  // missing_fk_index, unbounded_pagination → missing_rate_limit) — but the
  // base's sentence would misdescribe what the detector actually saw. Say the
  // real thing.
  if (type.startsWith('arch_migration')) {
    const title = str(d.title) ?? str(d.description)
    return title
      ? `Proposed migration: ${title}`
      : 'A proposed architecture migration is waiting'
  }
  if (type.startsWith('n_plus_one_risk')) {
    return norm?.tableName
      ? `N+1 query pattern around \`${norm.tableName}\``
      : 'An access pattern risks N+1 queries'
  }
  if (type.startsWith('unbounded_pagination')) {
    const loc = str(d.location) ?? str(d.tableName) ?? str(d.table)
    return loc
      ? `List endpoint \`${loc}\` returns unbounded results — no pagination cap`
      : 'A list endpoint returns unbounded results — no pagination cap'
  }

  switch (norm?.base) {
    // ── Schema ────────────────────────────────────────────────────────────
    case 'missing_fk':
      return table
        ? `\`${table}\` has a relation with no foreign key constraint`
        : 'A relation is missing its foreign key constraint'
    case 'missing_fk_index':
      return table
        ? `Sequential scan on \`${table}\`${str(d.column) ? `.${d.column}` : ''} (no index)`
        : 'A foreign key column is missing its index'
    case 'shadow_mutation':
      return table
        ? `\`${table}\` was changed outside the governed pipeline`
        : 'A table was changed outside the governed pipeline'
    case 'external_schema_change': {
      const n = typeof d.eventCount === 'number' ? d.eventCount : undefined
      return n
        ? `${n} schema change${n === 1 ? '' : 's'} arrived over your direct database connection — adopt to update APIs and the contract`
        : 'Schema changes arrived over your direct database connection — adopt to update APIs and the contract'
    }
    case 'orphan_table':
      return table
        ? `\`${table}\` is orphaned (no API, no relations)`
        : 'An orphaned table has no API or relations'

    // ── Auth ──────────────────────────────────────────────────────────────
    case 'auth_spike':
      return `Unusual auth error rate${d.errorCount ? ` — ${d.errorCount} failures` : ''}`
    case 'auth_jwt_missing':
      return 'The project JWT secret is missing'
    case 'auth_users_table_missing':
      return 'Auth is enabled but the workspace `users` table does not exist'
    case 'broken_auth':
      return sentence(d.reason) ?? 'The auth subsystem failed a structural check'
    case 'oauth_redirect_uri_missing':
      return `An OAuth provider${str(d.provider) ? ` (${d.provider})` : ''} has no redirect URI configured`
    case 'oauth_config_invalid':
      return sentence(d.reason) ?? `An OAuth provider${str(d.provider) ? ` (${d.provider})` : ''} is misconfigured`

    // ── RLS ───────────────────────────────────────────────────────────────
    case 'missing_rls':
      return table ? `RLS missing on \`${table}\`` : 'A table exposing user data has no row-level security'
    case 'unprotected_user_data':
      return table
        ? `\`${table}\` stores user data but has no RLS policy`
        : 'A table storing user data has no RLS policy'
    case 'rls_expression_invalid':
      return table
        ? `RLS policy on \`${table}\` is ineffective${str(d.policyName) ? ` (\`${d.policyName}\`)` : ''}`
        : 'An RLS policy expression is ineffective'

    // ── API coverage ──────────────────────────────────────────────────────
    case 'api_drift':
      return table ? `API contract drifted from \`${table}\`` : 'An API contract drifted from its table'
    case 'missing_api_definition':
    case 'missing_api_crud':
      return table ? `\`${table}\` has no generated API` : 'A table has no generated API'
    case 'dead_api_endpoint':
      return 'An endpoint points at a table that no longer exists'
    case 'missing_rate_limit':
      return str(d.location)
        ? `Public endpoint \`${d.location}\` has no rate limit`
        : 'A public endpoint has no rate limit'
    case 'realtime_gap':
      return table
        ? `\`${table}\` changes are not broadcast to realtime subscribers`
        : 'A live-data table is missing its realtime notify trigger'

    // ── Integrations ──────────────────────────────────────────────────────
    case 'broken_webhook':
      return 'A webhook is failing to deliver'
    case 'integration_key_invalid':
      return `${str(d.provider) ?? str(d.integration) ?? 'An integration'} API key is invalid or revoked`
    case 'integration_webhook_failing':
      return `${str(d.provider) ?? str(d.integration) ?? 'Integration'} webhooks are failing${d.failureCount ? ` — ${d.failureCount} dead-lettered` : ''}`
    case 'integration_smtp_unreachable':
      return str(d.host)
        ? `SMTP host \`${d.host}${d.port ? `:${d.port}` : ''}\` is unreachable — outbound email will fail`
        : 'The SMTP host is unreachable — outbound email will fail'
    case 'integration_connected_unused':
      return `${str(d.provider) ?? str(d.integration) ?? 'An integration'} is connected but nothing uses it yet`

    // ── Workflow / verification ───────────────────────────────────────────
    case 'workflow_broken': {
      const wf = str(d.displayName) ?? str(d.workflow)
      const missing = Array.isArray(d.missingComponents) && d.missingComponents.length > 0
        ? ` — missing ${(d.missingComponents as unknown[]).join(', ')}`
        : ''
      return wf ? `Workflow "${wf}" is incomplete${missing}` : `A workflow is incomplete${missing}`
    }
    case 'verification_failed': {
      const scenario = str(d.scenarioName) ?? str(d.scenarioId)
      const why =
        (Array.isArray(d.failedChecks) && sentence(d.failedChecks[0])) || sentence(d.reason)
      if (scenario && why) return `"${scenario}" failed verification: ${why}`
      if (scenario) return `"${scenario}" failed its live verification check`
      return why ?? 'A live structural verification check failed'
    }

    // ── Hygiene ───────────────────────────────────────────────────────────
    case 'missing_archival_job':
      return table
        ? `\`${table}\` grows without bound${d.rowCount ? ` (~${Number(d.rowCount).toLocaleString()} rows)` : ''} — no archival job`
        : 'A large table has no archival job'
    case 'missing_token_cleanup_cron':
      return table
        ? `Expired tokens accumulate in \`${table}\` — no cleanup cron`
        : 'Expired tokens are accumulating with no cleanup cron'

    // ── Ops ───────────────────────────────────────────────────────────────
    case 'deploy_failure':
      return 'The last deploy failed'
    case 'ai_action_pending': {
      const action = str(d.executorAction)
      return action
        ? `A gated change (${action.toLowerCase().replace(/_/g, ' ')}) is waiting for your approval`
        : 'A gated change is waiting for your approval'
    }
  }

  // contract_surface_broken has no `case` in the switch above because its
  // sentence is built from `details.surface` rather than from the type alone.
  if (norm?.base === 'contract_surface_broken') {
    const surface = str(d.surface)
    const detail = sentence(d.detail)
    return surface
      ? `The live ${surface} API surface is failing${detail ? `: ${detail}` : ''}`
      : detail ?? 'A live API surface probe failed'
  }

  // Same convention as contract_surface_broken: canonical, but carries no fix
  // mapping, so it is answered here rather than through the normalizer.
  //
  // Leads with the observable symptom rather than the mechanism. Anyone reading
  // this is most likely already staring at tables that look empty, and the
  // useful thing is to connect that to a cause — not to name a configuration
  // discrepancy they would then have to translate into "that is why my data
  // looks gone".
  if (type === 'runtime_engine_mismatch') {
    return 'Tables return no rows: some row-security policies still read the old identity setting, which the data plane never sets'
  }

  // Unknown type — prefer the detector's own sentence over the raw type.
  return (
    sentence(d.reason) ??
    sentence(d.message) ??
    sentence(d.detail) ??
    type.replace(/_/g, ' ')
  )
}
