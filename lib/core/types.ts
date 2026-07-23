/**
 * CORE OBSERVATION TYPES
 * ======================
 * Shared types for health findings across all observation subsystems.
 * Centralised here to avoid circular imports between workspace-observer
 * and the lib/core detector modules.
 */

export type FindingType =
  // ── Existing (workspace-observer) ─────────────────────────────────────────
  | 'missing_rls'
  | 'missing_fk'
  | 'api_drift'
  | 'broken_webhook'
  | 'broken_auth'
  | 'orphan_table'
  | 'auth_spike'
  | 'deploy_failure'
  // ── 3.1 Schema Drift ──────────────────────────────────────────────────────
  | 'missing_fk_index'
  | 'missing_api_definition'
  | 'shadow_mutation'
  // ── 3.2 Auth Integrity ────────────────────────────────────────────────────
  | 'auth_jwt_missing'
  | 'auth_users_table_missing'
  | 'oauth_redirect_uri_missing'
  | 'rls_expression_invalid'
  | 'unprotected_user_data'
  // ── 3.3 Integration Health ────────────────────────────────────────────────
  | 'integration_key_invalid'
  | 'integration_webhook_failing'
  | 'integration_smtp_unreachable'
  | 'integration_connected_unused'
  | 'oauth_config_invalid'
  // ── 3.4 Workflow Correctness ──────────────────────────────────────────────
  | 'workflow_broken'
  // ── Phase 13 — live verification scenario executed and structural checks failed
  | 'verification_failed'
  // ── 3.5 API Coverage ──────────────────────────────────────────────────────
  | 'missing_api_crud'
  | 'dead_api_endpoint'
  | 'missing_rate_limit'
  | 'realtime_gap'
  // ── 3.6 Long-running hygiene (notify_only — needs user input on retention) ─
  | 'missing_archival_job'
  | 'missing_token_cleanup_cron'
  // ── Phase 4 — medium/high-risk action queued from AI chat or orchestration
  // before it applies. details.executorAction/executorParams carry the exact
  // AIAction to run once approved — see lib/core/auto-fix-engine.ts's
  // 'ai_action_pending' case in buildFixAction.
  | 'ai_action_pending'
  // ── Runtime contract verification — a live probe of an advertised API
  // surface (auth/db/storage/functions/realtime) failed for this project.
  // details.surface names which one. See lib/services/contract-verifier.ts.
  | 'contract_surface_broken'
  // ── Open-loop drift — DDL arrived over a direct database connection
  // (READ_WRITE bkn_rw_% role). Evidence = SchemaDriftEvent rows recorded by
  // the event trigger. Fix = ADOPT_EXTERNAL_SCHEMA (bookkeeping only, no DDL).
  // See lib/autonomy/drift-watch.ts.
  | 'external_schema_change'
  // ── RLS policies reading an identity the data plane never sets.
  // Uniquely dangerous because nothing errors: PostgREST sets
  // `request.jwt.claims` and never the legacy `app.*` GUCs, so a policy still
  // written against those matches no rows. Every affected table reads EMPTY and
  // the API returns 200. Users read that as data loss.
  //
  // Name kept after the single-engine cutover (2026-07-21) so the
  // health_findings rows already written under this key are not orphaned; the
  // failure it names is unchanged. See lib/autonomy/engine-conformance.ts.
  | 'runtime_engine_mismatch'
  // ── The project's workspace schema is not in PostgREST's exposed list, so
  // every /db/* request returns PGRST106 and the entire REST data plane is dead
  // for that ONE project. Silent from every angle the platform measured:
  // /auth/* and /fn/* run on the Express runtime and keep working, the tables
  // are all present in the catalog, and health stays green.
  //
  // The inverse fault (registered-but-absent) already had a probe, because it
  // takes down every tenant at once and is loud. This one had none, and shipped:
  // register_schema was called by the cutover script and by no application code,
  // so every project created afterwards was born with a dead data plane.
  // See lib/autonomy/schema-registration.ts.
  | 'schema_not_registered'

export type FindingSeverity = 'critical' | 'warning' | 'info'
export type FindingStatus = 'open' | 'auto_fixed' | 'pending_approval' | 'dismissed'

// ─── Dynamic finding-type normalization ───────────────────────────────────────
//
// Multi-agent scanners (lib/ai/background-monitor.ts, architecture-evolution.ts)
// write HealthFinding.type as `${category}_${location}` — e.g. `missing_rls_users`,
// `missing_api_reviews`, `n_plus_one_risk_product_categories`, `auth_gap_auth`,
// `schema_drift`, `arch_migration_add_composite_indexes_…`.
//
// The auto-fix engine matches on the canonical FindingType union, so these
// suffixed/aliased types must be normalized to a base type + resolved table
// before classification and fix-action mapping. Without this, the MAJORITY of
// real findings silently dead-end ("No fix action mapped").
//
// Order matters: longest / most-specific prefixes first.

interface NormalizedFinding {
  /** Canonical base type the engine knows how to classify + fix. */
  base: FindingType
  /** Table the fix targets, resolved from the suffix or details.location. */
  tableName?: string
  /** True when the raw type was an alias/suffixed form (not an exact match). */
  wasAliased: boolean
}

// Canonical types — exact matches pass through untouched.
const CANONICAL: ReadonlySet<string> = new Set<FindingType>([
  'missing_rls', 'missing_fk', 'api_drift', 'broken_webhook', 'broken_auth',
  'orphan_table', 'auth_spike', 'deploy_failure', 'missing_fk_index',
  'missing_api_definition', 'shadow_mutation', 'auth_jwt_missing',
  'auth_users_table_missing', 'oauth_redirect_uri_missing',
  'rls_expression_invalid', 'unprotected_user_data', 'integration_key_invalid',
  'integration_webhook_failing', 'integration_smtp_unreachable',
  'integration_connected_unused',
  'oauth_config_invalid', 'workflow_broken', 'verification_failed',
  'missing_api_crud', 'dead_api_endpoint', 'missing_rate_limit', 'realtime_gap',
  'missing_archival_job', 'missing_token_cleanup_cron', 'ai_action_pending',
  'external_schema_change', 'schema_not_registered',
])

// Category prefix → canonical base. Most-specific first.
const PREFIX_MAP: ReadonlyArray<readonly [string, FindingType]> = [
  ['missing_fk_index', 'missing_fk_index'],
  ['missing_api_definition', 'missing_api_definition'],
  ['missing_api_crud', 'missing_api_crud'],
  ['missing_api', 'missing_api_definition'],
  ['missing_rls', 'missing_rls'],
  ['weak_rls', 'missing_rls'],
  ['unprotected_user_data', 'unprotected_user_data'],
  ['rls_expression_invalid', 'rls_expression_invalid'],
  ['orphaned_fk', 'missing_fk'],
  ['missing_fk', 'missing_fk'],
  ['missing_index', 'missing_fk_index'],
  ['n_plus_one_risk', 'missing_fk_index'],
  ['unbounded_pagination', 'missing_rate_limit'],
  ['missing_rate_limit', 'missing_rate_limit'],
  ['missing_realtime_triggers', 'realtime_gap'],
  ['realtime_gap', 'realtime_gap'],
  ['auth_jwt', 'auth_jwt_missing'],
  ['auth_users_table', 'auth_users_table_missing'],
  ['auth_gap', 'broken_auth'],
  ['auth_spike', 'auth_spike'],
  ['oauth_redirect_uri', 'oauth_redirect_uri_missing'],
  ['oauth_config', 'oauth_config_invalid'],
  ['integration_smtp', 'integration_smtp_unreachable'],
  ['integration_webhook', 'integration_webhook_failing'],
  ['integration_connected_unused', 'integration_connected_unused'],
  ['integration_key', 'integration_key_invalid'],
  ['broken_webhook', 'broken_webhook'],
  ['broken_auth', 'broken_auth'],
  ['schema_drift', 'shadow_mutation'],
  ['shadow_mutation', 'shadow_mutation'],
  ['arch_migration', 'shadow_mutation'],
  ['api_drift', 'api_drift'],
  ['dead_api_endpoint', 'dead_api_endpoint'],
  ['workflow_broken', 'workflow_broken'],
  ['verification_failed', 'verification_failed'],
  ['deploy_failure', 'deploy_failure'],
  ['orphan_table', 'orphan_table'],
]

/**
 * Normalize any raw HealthFinding.type (canonical, aliased, or
 * `${category}_${location}`) into a base FindingType the engine can act on.
 *
 * Returns null only when the raw type matches no known category at all — the
 * caller should treat that as notify_only rather than a hard error.
 */
export function normalizeFindingType(
  rawType: string,
  details?: Record<string, unknown> | null,
): NormalizedFinding | null {
  const raw = (rawType ?? '').trim()
  if (!raw) return null

  const detailTable =
    (details?.tableName as string) ??
    (details?.location as string) ??
    (details?.table as string) ??
    undefined

  // Exact canonical match — pass through.
  if (CANONICAL.has(raw)) {
    return { base: raw as FindingType, tableName: detailTable, wasAliased: false }
  }

  // Prefix match — strip the category to recover the location/table suffix.
  for (const [prefix, base] of PREFIX_MAP) {
    if (raw === prefix || raw.startsWith(prefix + '_')) {
      const suffix = raw === prefix ? '' : raw.slice(prefix.length + 1)
      // Prefer an explicit table from details; fall back to the type suffix
      // when it looks like a real identifier (not a free-text description).
      const suffixLooksLikeTable =
        suffix.length > 0 && suffix.length <= 63 && /^[a-z][a-z0-9_]*$/.test(suffix)
      return {
        base,
        tableName: detailTable ?? (suffixLooksLikeTable ? suffix : undefined),
        wasAliased: true,
      }
    }
  }

  return null
}

export interface RawFinding {
  type: FindingType
  severity: FindingSeverity
  details: Record<string, unknown>
  autoFixable: boolean
  fix?: () => Promise<void>
}
