/**
 * DESIRED-STATE SPEC — the formal contract the autonomous loop reconciles toward
 * ============================================================================
 *
 * Every funded autonomous platform (K8s operators, AWS DevOps Guru, Aurora,
 * SRE automation) drives toward a *declared correct state* and continuously
 * diffs reality against it. Backenly's checks were previously scattered across
 * four scan agents and an intent-time invariant validator — there was no single
 * declarative answer to "what does correct look like for this project?".
 *
 * This module IS that answer. It is the K (Knowledge) of the MAPE-K loop.
 *
 * HARD CONTRACT — this module acts on NOTHING:
 *   • It only reads. Every probe delegates to an existing canonical detector;
 *     no detection logic is reimplemented here (reuse, never rewrite).
 *   • The `fix` closures on RawFindings are stripped from the output, so the
 *     report is pure, JSON-serialisable data that cannot accidentally mutate.
 *   • Tiering derives from the existing `fix-classifier` (the single source of
 *     truth for risk) — this module only adds the silent-vs-announced split
 *     (Tier 0 vs Tier 1) that the classifier genuinely lacks.
 *
 * The control loop (later phase) reads this report, the circuit breaker bounds
 * how much it may act on per window, and the existing deterministic kernel
 * (auto-fix-engine → executeAction) closes the gaps. This file never executes.
 */

import {
  detectFkColumnsMissingConstraints,
  detectTablesWithNoApiDefinition,
  detectShadowMutations,
  detectMissingFkIndexes,
  checkAuthIntegrity,
  detectApiCoverageGaps,
  detectOverPermissiveRls,
} from '@/lib/core/drift-detector'
import {
  detectMissingRls,
  detectRlsDeniesEverything,
  detectOrphanTables,
} from '@/lib/services/workspace-observer'
import { verifyWorkflows } from '@/lib/core/workflow-verifier'
import { classifyFix } from '@/lib/core/fix-classifier'
import { checksFromDesiredState, type CheckState } from './fix-acceptance'
import { normalizeFindingType } from '@/lib/core/types'
import type { FindingType, FindingSeverity, RawFinding } from '@/lib/core/types'
import {
  detectMissingHotPathIndexes,
  detectStaleDataOverflow,
  detectExpiredTokenBuildup,
  detectTableBloat,
} from './invariant-probes'
import { detectRuntimeEngineMismatch } from './engine-conformance'
import { detectUnregisteredSchema } from './schema-registration'
import { detectPendingSchemaDrift } from './drift-watch'
import { detectDataPlaneNotAnswering } from './data-plane-liveness'
import { detectServiceRoleKeyExposure } from '@/lib/security/service-role-exposure'

// ── Bounded-autonomy tiers (graded by blast radius) ───────────────────────────
//
//  0 — auto, silent     : purely additive, invisible to data/behaviour
//  1 — auto, announced   : additive but user-visible; needs notify + one-click undo
//  2 — approval required : auth / external / destructive; human approves
//  3 — escalate, never   : irreversible (billing, data loss); alert only
export type AutonomyTier = 0 | 1 | 2 | 3

/**
 * Finding types whose auto-fix is genuinely invisible — no behaviour change a
 * user could perceive (an index, a regenerated/missing API surface). These are
 * Tier 0. Everything else the classifier marks `auto` is Tier 1 (announced):
 * additive but user-visible (turning on RLS, adding a FK constraint).
 *
 * This is the ONLY risk distinction this module owns. auto→approval→notify
 * always comes from fix-classifier so there is one source of truth.
 */
const TIER0_SILENT: ReadonlySet<FindingType> = new Set<FindingType>([
  'missing_fk_index',
  'api_drift',
  'missing_api_definition',
  'missing_api_crud',
])

/**
 * Map any finding to its blast-radius tier. Decision authority stays with the
 * existing fix-classifier; we only split its `auto` bucket into 0 vs 1.
 */
export function deriveTier(findingType: string, details?: Record<string, unknown>): AutonomyTier {
  const { decision } = classifyFix(findingType, details ?? null)
  if (decision === 'notify_only') return 3
  if (decision === 'approval') return 2
  return TIER0_SILENT.has(findingType as FindingType) ? 0 : 1
}

// ── The invariant catalogue (the declarative spec) ────────────────────────────

export interface Invariant {
  /** Stable key — referenced by the loop, audit log, and trust UI. */
  id: string
  /** Non-technical, one-line statement of what must always be true. */
  title: string
  /** Why this matters — surfaced in the "why?" explainability UI later. */
  rationale: string
  /** Read-only probe. Returns the gaps (canonical RawFindings) if violated. */
  probe: (projectId: string) => Promise<RawFinding[]>
}

/**
 * The complete declarative set of guarantees every project must satisfy.
 * Each invariant delegates its reality probe to a canonical detector — adding
 * an invariant here never duplicates detection logic.
 */
export const INVARIANTS: readonly Invariant[] = [
  {
    id: 'user_data_is_rls_protected',
    title: 'Every table holding user data is protected by row-level security',
    rationale:
      'Without RLS, any signed-in end-user can read or modify every other user’s rows. This is the single highest-impact data-safety guarantee.',
    probe: detectMissingRls,
  },
  {
    id: 'rls_policies_are_not_wide_open',
    title: 'No table has row-level security that is silently a no-op',
    rationale:
      'A table can have RLS enabled but a policy of USING (true) — it looks protected in every dashboard while exposing every row to everyone. This is the misconfiguration a missing-RLS check structurally cannot catch.',
    probe: detectOverPermissiveRls,
  },
  {
    id: 'service_role_keys_stay_server_side',
    title: 'The key that bypasses row-level security is never called from a browser',
    rationale:
      'A service-role key short-circuits every policy in the project by design, which is correct on a server and a total breach in a browser — every row of every table, readable by anyone who opens developer tools. It is also the failure that gives no warning: the key works everywhere, so the mistake of importing a server module into a client component produces no error, no failed request, and nothing in any log that looks wrong. The runtime refuses these requests outright (lib/security/service-role-exposure.ts), so this invariant reports a contained incident rather than an open one — but the key is still in a shipped bundle until the owner rotates it, and that is the part only they can do.',
    probe: detectServiceRoleKeyExposure,
  },
  {
    id: 'relationships_have_fk_constraints',
    title: 'Every relationship column is enforced by a real foreign key',
    rationale:
      'A *_id column with no FK constraint lets orphaned and inconsistent rows accumulate silently — corruption that is expensive to unwind later.',
    probe: detectFkColumnsMissingConstraints,
  },
  {
    id: 'relationships_are_indexed',
    title: 'Every relationship column is indexed for fast lookups',
    rationale:
      'An unindexed foreign key turns every join and filter into a full table scan. This is the classic silent-until-you-have-users performance cliff.',
    probe: detectMissingFkIndexes,
  },
  {
    id: 'data_plane_is_registered',
    title: 'The REST data plane is actually serving this project',
    rationale:
      "PostgREST only serves schemas on its exposed list. A schema missing from that list answers PGRST106 for EVERY table — the whole /db/* plane is dead for this one project — while /auth/* and /fn/* keep working on the Express runtime, so nothing else looks wrong. That combination is why it went unnoticed: five of nine projects on production were in this state, every one of them created after the PostgREST cutover, and it was a customer who found it. The inverse fault (a registered schema that no longer exists) already had a probe because it 503s every tenant at once. This is the quiet half.",
    probe: detectUnregisteredSchema,
  },
  {
    id: 'every_table_has_an_api',
    title: 'Every table is reachable through the REST API',
    rationale:
      'Under PostgREST this holds by construction: a table is served because it exists in the catalog and the role holds a grant on it, so reachability is not a state that can drift. The probe is retained as a satisfied invariant rather than deleted, because "every table is reachable" is still a guarantee worth stating to the user — it is simply now guaranteed by the engine instead of by a registry someone had to remember to write. Exposure decisions live in lib/postgrest/exposure.ts.',
    probe: detectTablesWithNoApiDefinition,
  },
  {
    id: 'api_coverage_is_complete',
    title: 'Every table has full CRUD and no dead endpoints',
    rationale:
      'Partial CRUD or endpoints pointing at dropped tables cause runtime failures in the deployed app.',
    probe: detectApiCoverageGaps,
  },
  // ── Registered 2026-07-30 so their auto-applied fixes can be verified ───────
  //
  // These three probes already existed and were already read-only; they were
  // simply absent from this catalogue. The consequence was specific: their
  // finding types are classified `auto`, so the loop applied their fixes without
  // asking, and `recheckGap` had no probe to re-run afterwards — every one was
  // recorded as fixed on the executor's word alone.
  {
    id: 'rls_is_not_deny_all',
    title: 'No table is protected by a policy that denies everyone, including its owner',
    rationale:
      'RLS enabled with no permissive policy is not protection, it is an outage: every query matches zero rows and the API answers 200 with an empty array. It looks identical to "the user has no data" from every surface except the one that matters.',
    probe: detectRlsDeniesEverything,
  },
  {
    id: 'live_tables_are_adopted',
    title: 'Every table in the database is known to the platform',
    rationale:
      'A READ_WRITE connection string is a product feature, so tables created from psql or a migration tool are expected, not anomalous. Until one is adopted it has no RLS, no API contract and no backup entry in the platform metadata — it is real data the platform cannot see. This is the most likely finding on any project that uses the direct-connection escape hatch.',
    probe: detectOrphanTables,
  },
  {
    id: 'declared_workflows_still_work',
    title: 'Every declared workflow still has all of its components',
    rationale:
      'A workflow (signup → verify → login, checkout → webhook → fulfil) breaks when any one component is removed, and the individual pieces all still look healthy on their own. This is the check that sees the seam rather than the parts.',
    probe: verifyWorkflows,
  },
  {
    id: 'live_schema_matches_intent',
    title: 'The live database schema matches what the AI built',
    rationale:
      'Columns added outside the AI (shadow mutations) drift the real backend away from its intended design and break reproducibility.',
    probe: detectShadowMutations,
  },
  {
    id: 'auth_subsystem_is_intact',
    title: 'Authentication is correctly wired whenever the app has users',
    rationale:
      'A missing JWT secret or users table means every end-user sign-in silently fails — a total outage of the app’s auth.',
    probe: checkAuthIntegrity,
  },
  // ── Wow-moment invariants — the ones a user actually feels ───────────────────
  {
    id: 'hot_path_columns_are_indexed',
    title: 'Common filter columns (created_at, status, slug, email) are indexed',
    rationale:
      'The columns list and lookup queries hit constantly. Unindexed they look fast on day one and turn every request into a full table scan once the table has real data — the silent performance cliff.',
    probe: detectMissingHotPathIndexes,
  },
  // 'public_endpoints_have_rate_limits' was removed on 2026-07-21 along with its
  // probe. It asserted a property that is not expressible in this architecture:
  // there is no per-endpoint rate limit to configure. Limits are per API key
  // (`ApiKey.rateLimit`, Int @default(1000) — never unset) and are enforced on
  // every serving surface. The probe therefore reported a violation for every
  // table, forever, and its "fix" wrote a field no request path reads. See the
  // note in lib/autonomy/invariant-probes.ts.
  {
    id: 'growing_tables_have_archival_plan',
    title: 'Session / log / event tables have an archival or cleanup cron',
    rationale:
      'Tables that grow without bound slow every query against them and inflate storage cost month over month — and the bigger the table, the riskier the eventual cleanup.',
    probe: detectStaleDataOverflow,
  },
  {
    id: 'tables_are_not_bloated',
    title: 'No table is carrying more dead rows than autovacuum can clear',
    rationale:
      'A table whose dead rows outnumber its live ones makes every read scan space that holds nothing, and skews the planner into choosing worse plans. The repair is a plain VACUUM ANALYZE, which changes no data and takes no exclusive lock, so it is safe to apply automatically. It is registered here rather than left to the daily infra scan for one specific reason: the repair is auto-applied, and an auto-applied fix with no probe to re-run afterwards gets recorded as a success on the executor\'s word alone. With this probe the loop can tell a VACUUM that reclaimed space from one that did nothing.',
    probe: detectTableBloat,
  },
  {
    id: 'expired_tokens_get_cleaned_up',
    title: 'Tables with expiry columns have an expired-row cleanup cron',
    rationale:
      'Expired auth tokens pile up forever without a cleanup cron — bloating the table and broadening the attack window of stolen credentials still in the database.',
    probe: detectExpiredTokenBuildup,
  },
  // ── Open loop — direct database access (reconciliation, not lockout) ─────────
  {
    id: 'external_schema_changes_are_adopted',
    title: 'Schema changes made over a direct connection are adopted into the contract',
    rationale:
      'A READ_WRITE connection string lets developers run DDL from psql or a migration tool. Until adopted, the stored contract (APIs, snapshot baseline, access grants) disagrees with the live schema — the exact drift a schema-mirror platform structurally cannot have, and the one this loop exists to close.',
    probe: detectPendingSchemaDrift,
  },
  // ── The one that was missing, and the one that happens most ─────────────────
  {
    id: 'data_plane_is_answering',
    title: 'The backend is actually answering its API',
    rationale:
      "Measured over two months of production, contract_surface_broken is ~80% of every real fault ever recorded here — 298 findings against 29 for the next most common. It means a customer cannot reach their backend, and it was the one thing this catalogue did not check. Every other invariant asks whether the backend is SHAPED correctly; this asks whether it RESPONDS. Without it computeDesiredStateDiff could return satisfied and the dashboard could print \"Backend is healthy — all guarantees hold\" while the project's REST API returned 502s. Reads the 15-minute contract sweep's recorded result rather than probing, because the reconciler runs this set every minute and live HTTP probing does not belong in that loop.",
    probe: detectDataPlaneNotAnswering,
  },
  // ── Phase 3 — data-plane engine matches the identity its policies read ───────
  {
    id: 'runtime_engine_matches_rls_contract',
    title: 'Every RLS policy reads an identity the data plane actually sets',
    rationale:
      'PostgREST sets request.jwt.claims and never sets the legacy app.* GUCs. A policy still written against those evaluates against an identity that was never set, matches no rows, and the API answers 200 with an empty array. Nothing errors and no log line appears — monitoring sees healthy traffic while the customer sees their data gone. It is the only failure here that is invisible to every other instrument, because it is not a failure from the database\'s point of view.',
    probe: detectRuntimeEngineMismatch,
  },
] as const

// ── The diff (real vs desired) ────────────────────────────────────────────────

/** One detected gap, tier-tagged, with the lazy fix closure stripped. */
export interface DesiredStateGap {
  invariantId: string
  type: FindingType
  severity: FindingSeverity
  tier: AutonomyTier
  details: Record<string, unknown>
}

export interface InvariantStatus {
  id: string
  title: string
  satisfied: boolean
  gaps: DesiredStateGap[]
}

export interface DesiredStateReport {
  projectId: string
  evaluatedAt: string
  /** True only when every invariant holds. */
  satisfied: boolean
  invariants: InvariantStatus[]
  /** Flat list of all gaps — feeds the existing auto-fix kernel unchanged. */
  violations: DesiredStateGap[]
  /** Gap count by blast-radius tier — drives the loop's bounded execution. */
  tierCounts: Record<AutonomyTier, number>
  /** Probe errors (isolated; one failed probe never fails the report). */
  errors: string[]
}

/**
 * Compute the gap between a project's real state and its desired state.
 *
 * Pure and read-only: runs every invariant probe concurrently, projects the
 * results onto the catalogue, tier-tags each gap, and returns a serialisable
 * report. Executes nothing. One probe failing isolates to `errors`.
 */
export async function computeDesiredStateDiff(projectId: string): Promise<DesiredStateReport> {
  const errors: string[] = []

  const probed = await Promise.allSettled(
    INVARIANTS.map(async (inv) => ({
      inv,
      findings: await inv.probe(projectId),
    })),
  )

  const invariants: InvariantStatus[] = []
  const violations: DesiredStateGap[] = []
  const tierCounts: Record<AutonomyTier, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }

  probed.forEach((outcome, i) => {
    const inv = INVARIANTS[i]

    if (outcome.status === 'rejected') {
      errors.push(`[${inv.id}] ${String(outcome.reason?.message ?? outcome.reason)}`)
      // Unknown state ≠ satisfied. Report as unsatisfied with no actionable
      // gaps so the loop never "closes" an invariant it could not evaluate.
      invariants.push({ id: inv.id, title: inv.title, satisfied: false, gaps: [] })
      return
    }

    const gaps: DesiredStateGap[] = outcome.value.findings.map((f: RawFinding) => {
      const details = (f.details ?? {}) as Record<string, unknown>
      const tier = deriveTier(f.type, details)
      tierCounts[tier]++
      return {
        invariantId: inv.id,
        type: f.type,
        severity: f.severity,
        tier,
        details, // `fix` closure deliberately dropped — report stays pure data
      }
    })

    violations.push(...gaps)
    invariants.push({
      id: inv.id,
      title: inv.title,
      satisfied: gaps.length === 0,
      gaps,
    })
  })

  return {
    projectId,
    evaluatedAt: new Date().toISOString(),
    satisfied: violations.length === 0 && errors.length === 0,
    invariants,
    violations,
    tierCounts,
    errors,
  }
}

/**
 * Canonical identity of a gap: `type::location`, most-specific locator first.
 *
 * `location` / `tableName.columnName` MUST win over bare `tableName`: the
 * index probes emit one gap per COLUMN, and keying by table collapsed
 * "email is unindexed" and "created_at is unindexed" on the same table into
 * one identity. The fix for one column then re-checked against the OTHER
 * column's still-open gap and a fix that genuinely worked was escalated as
 * "did not hold" (prod, 2026-07-20: idx__email_verifications_email existed,
 * finding escalated anyway). Every consumer — recheckGap, the reconciler's
 * dedupe, the reaper — must derive identity through here so the definition
 * cannot fork again.
 *
 * The TYPE half is normalized to its canonical base, and that is load-bearing.
 * Findings reach this function under three vocabularies: canonical
 * (`missing_api_crud`), bare category (`missing_api`, from the scan agents),
 * and `${category}_${location}` (`missing_api_email_verifications`). The probes
 * only ever emit canonical. Comparing raw against raw meant an aliased finding's
 * identity could not match the probe that re-detects it, so `recheckGap` scored
 * every aliased fix 'resolved' without ever looking — which is how a fix that
 * changed nothing got certified `auto_fixed`, counted toward the trust
 * scoreboard, and re-appeared on the next cadence tick. Normalize both sides or
 * the post-fix verification is decorative.
 */
export function gapIdentity(
  type: string,
  details: Record<string, unknown> | null | undefined,
): string {
  const d = details ?? {}
  const table = (d.tableName ?? d.table ?? '') as string
  const column = (d.columnName ?? d.column ?? '') as string
  const loc =
    (d.location as string | undefined) ??
    // Workflow findings are located by WORKFLOW, not by table — their details
    // carry no tableName at all. Without this every workflow_broken row shared
    // the identity `workflow_broken::`, so one still-broken workflow kept that
    // identity "detected" and masked a second workflow that had genuinely
    // healed, pinning its finding open. Discriminating here lets the reaper
    // withdraw each workflow independently.
    (d.workflow as string | undefined) ??
    // Runtime-contract findings are located by SURFACE (auth / db / storage /
    // functions / healthz / runtime), and carry no table either. Same collapse,
    // already live: `reapObserverFindings` keys contract_surface_broken rows
    // through this function, so with two surfaces down they shared the identity
    // `contract_surface_broken::` and one recovering could withdraw the other's
    // finding. The contract sweep's own auto-resolve is per-surface and was
    // unaffected, which is why this stayed hidden.
    (d.surface as string | undefined) ??
    (table && column ? `${table}.${column}` : table)
  const base = normalizeFindingType(type, d)?.base ?? type
  return `${base}::${loc}`
}

/**
 * Which canonical types each invariant's probe can actually emit.
 *
 * This exists so `recheckGap` can tell "I re-probed and the gap is gone" apart
 * from "nothing in this catalogue probes that type at all". It used to collapse
 * both into 'resolved', which meant every fix for an unprobed type
 * (contract_surface_broken, broken_webhook, deploy_failure, integration_*) was
 * certified as verified without a single check running.
 *
 * Keyed by invariant id and asserted complete by
 * tests/core/autonomy-verification-coverage.test.ts, so adding or retiring a
 * probe cannot silently leave a false claim of coverage behind.
 */
const INVARIANT_EMITS: Readonly<Record<string, readonly FindingType[]>> = {
  user_data_is_rls_protected: ['missing_rls'],
  rls_policies_are_not_wide_open: ['rls_expression_invalid'],
  // Genuinely re-detectable, which is why it is listed despite having no
  // auto-fix: the probe reads a rolling 24h window of recorded refusals AND
  // re-reads the key's current state, so revoking or downgrading the key clears
  // the finding on the next tick rather than waiting the window out.
  service_role_keys_stay_server_side: ['service_role_key_exposed'],
  relationships_have_fk_constraints: ['missing_fk'],
  relationships_are_indexed: ['missing_fk_index'],
  data_plane_is_registered: ['schema_not_registered'],
  // Both satisfied by construction under PostgREST — these probes are no-ops,
  // so they verify nothing and must not claim to. Listing a type here that no
  // probe can actually re-detect is the exact failure this map exists to stop:
  // recheckGap would read the type as covered, find it absent (because nothing
  // looks for it), and certify every fix as verified.
  every_table_has_an_api: [],
  api_coverage_is_complete: [],
  rls_is_not_deny_all: ['rls_denies_everything'],
  live_tables_are_adopted: ['orphan_table'],
  declared_workflows_still_work: ['workflow_broken'],
  live_schema_matches_intent: ['shadow_mutation'],
  auth_subsystem_is_intact: [
    'auth_jwt_missing',
    'auth_users_table_missing',
    'oauth_redirect_uri_missing',
    'rls_expression_invalid',
    'unprotected_user_data',
  ],
  hot_path_columns_are_indexed: ['missing_fk_index'],
  growing_tables_have_archival_plan: ['missing_archival_job'],
  expired_tokens_get_cleaned_up: ['missing_token_cleanup_cron'],
  tables_are_not_bloated: ['infra_table_bloat'],
  external_schema_changes_are_adopted: ['external_schema_change'],
  runtime_engine_matches_rls_contract: ['runtime_engine_mismatch'],
  // Re-detectable: the probe reads the sweep's recorded result, so a repaired
  // data plane genuinely disappears from the report on the next sweep. Listing
  // it makes `recheckGap` treat a HEAL_DATA_PLANE fix as verifiable instead of
  // recording it 'unknown'.
  data_plane_is_answering: ['contract_surface_broken'],
}

let _probedTypeCache: ReadonlySet<string> | null = null

/** Canonical base types this module can positively re-verify after a fix. */
export function probeCoveredTypes(): ReadonlySet<string> {
  if (!_probedTypeCache) {
    _probedTypeCache = new Set<string>(
      INVARIANTS.flatMap((inv) => INVARIANT_EMITS[inv.id] ?? []),
    )
  }
  return _probedTypeCache
}

/**
 * POST-FIX VERIFICATION — re-probe and report whether the SPECIFIC gap
 * (type + location) is now gone. Identity-based, never count-based: applying
 * one fix can legitimately reveal a different gap, so we only ever ask "did
 * THIS gap close?", never "did the total drop?".
 *
 *   'resolved'   — the gap is gone (and probes ran cleanly)
 *   'unresolved' — the gap is still present (the fix no-op'd or did not work)
 *   'unknown'    — a probe errored this pass, so closure can't be confirmed
 *
 * The auto-fix kernel escalates on 'unresolved' — a fix is never recorded as
 * applied while its gap is still positively present. 'unknown' is trusted (the
 * cross-tick recurrence check catches anything that silently didn't hold),
 * which avoids chronically escalating good fixes when an unrelated probe blips.
 */
export async function recheckGap(
  projectId: string,
  gapType: string,
  gapDetails: Record<string, unknown>,
): Promise<'resolved' | 'unresolved' | 'unknown'> {
  const base = normalizeFindingType(gapType, gapDetails)?.base ?? gapType

  // No probe in this catalogue can re-detect this type, so absence from the
  // report is meaningless — it would have been absent before the fix too.
  // Returning 'resolved' here is the difference between a verified fix and an
  // unverified one being recorded identically.
  if (!probeCoveredTypes().has(base)) return 'unknown'

  const key = gapIdentity(gapType, gapDetails)
  const report = await computeDesiredStateDiff(projectId)
  const stillPresent = report.violations.some(
    (v) => gapIdentity(v.type, v.details as Record<string, unknown>) === key,
  )
  if (stillPresent) return 'unresolved'

  // A probe that ERRORED this pass cannot be read as proof the gap closed, and
  // the only probe whose silence matters here is the one that owns this type.
  // Blanket-checking `errors.length` let an unrelated probe failure downgrade a
  // genuinely verified fix, while a failure of the RELEVANT probe was
  // indistinguishable from success once any other probe also failed.
  const owningIds = new Set(
    INVARIANTS.filter((inv) =>
      (INVARIANT_EMITS[inv.id] ?? []).includes(base as FindingType),
    ).map((inv) => inv.id),
  )
  // A probe that threw is recorded as `satisfied: false, gaps: []` (see
  // computeDesiredStateDiff) — the one shape a clean pass can never produce.
  const owningProbeFailed = report.invariants.some(
    (i) => owningIds.has(i.id) && !i.satisfied && i.gaps.length === 0,
  )
  return owningProbeFailed ? 'unknown' : 'resolved'
}

/**
 * Invariant ids that can emit this finding type. Empty when nothing probes it.
 */
export function owningInvariantIds(type: string, details?: Record<string, unknown> | null): string[] {
  const base = normalizeFindingType(type, details ?? null)?.base ?? type
  return INVARIANTS.filter((inv) =>
    (INVARIANT_EMITS[inv.id] ?? []).includes(base as FindingType),
  ).map((inv) => inv.id)
}

/**
 * Invariants a fix cannot be held responsible for breaking.
 *
 * Regression attribution assumes a causal link: this guarantee held before the
 * fix ran and fails after it, therefore the fix broke it. That inference is only
 * sound for properties the fix could plausibly affect.
 *
 * `data_plane_is_answering` reflects whether the platform's Express runtime was
 * answering HTTP on the last contract sweep. A CREATE INDEX cannot cause a PM2
 * restart. Leaving it in scope would mean any autonomous fix that happened to
 * overlap a runtime bounce got recorded as having "broken a previously passing
 * guarantee" and escalated to a human — turning an unrelated platform event into
 * a permanent black mark against a fix that worked, and re-creating the noise the
 * escalation-retry ladder exists to drain.
 *
 * Kept deliberately tiny. Every entry is a promise that this invariant's state is
 * environmental rather than caused by the change under test, and a wrong entry
 * silently disables real collateral-damage detection.
 */
const ENVIRONMENTAL_INVARIANTS: ReadonlySet<string> = new Set(['data_plane_is_answering'])

export interface FixOutcome {
  /** Did the SPECIFIC gap close? Identity-precise. */
  recheck: 'resolved' | 'unresolved' | 'unknown'
  /**
   * Invariants that were passing before the fix and are failing after it,
   * EXCLUDING the invariant the fix targeted.
   */
  regressions: string[]
  /** Safe to record as a verified fix. */
  accepted: boolean
  reason: string
}

/**
 * POST-FIX ACCEPTANCE — the full contract, not just "did the target close".
 *
 * `recheckGap` answers half the question. The other half is collateral damage:
 * a fix that closes its own gap while breaking a previously-passing invariant is
 * not a fix, and nothing in the live loop was checking for that. The gate that
 * does (lib/autonomy/fix-acceptance.ts) was written, unit-tested, and never
 * wired into any production path — `evaluateFixAcceptance` had zero callers
 * outside its own spec file.
 *
 * The two halves use DIFFERENT granularities, and that is deliberate:
 *
 *   • The TARGET is checked by gap identity (type + table.column), because an
 *     invariant covers many locations. Fixing RLS on `orders` while `invoices`
 *     is still unprotected leaves `user_data_is_rls_protected` failing — reading
 *     that as "the fix didn't work" would escalate every correct fix on any
 *     project with more than one gap.
 *   • REGRESSIONS are checked at invariant level, which is the right grain for
 *     "something that used to hold no longer does", and the owning invariant is
 *     excluded for exactly the reason above.
 */
export async function evaluateFixOutcome(
  projectId: string,
  gapType: string,
  gapDetails: Record<string, unknown>,
  before: readonly CheckState[] | null,
): Promise<FixOutcome> {
  const base = normalizeFindingType(gapType, gapDetails)?.base ?? gapType
  const owning = new Set(owningInvariantIds(gapType, gapDetails))

  // One diff serves both halves — the after-state is expensive, so it is
  // computed once here rather than once per check.
  const after = await computeDesiredStateDiff(projectId)

  // ── Target half ────────────────────────────────────────────────────────────
  let recheck: FixOutcome['recheck']
  if (!probeCoveredTypes().has(base)) {
    recheck = 'unknown'
  } else {
    const key = gapIdentity(gapType, gapDetails)
    const stillPresent = after.violations.some(
      (v) => gapIdentity(v.type, v.details as Record<string, unknown>) === key,
    )
    if (stillPresent) {
      recheck = 'unresolved'
    } else {
      const owningProbeFailed = after.invariants.some(
        (i) => owning.has(i.id) && !i.satisfied && i.gaps.length === 0,
      )
      recheck = owningProbeFailed ? 'unknown' : 'resolved'
    }
  }

  // ── Regression half ────────────────────────────────────────────────────────
  const regressions: string[] = []
  if (before) {
    const afterChecks = new Map(
      checksFromDesiredState(after).map((c) => [c.id, c.passing]),
    )
    for (const b of before) {
      if (owning.has(b.id)) continue
      if (ENVIRONMENTAL_INVARIANTS.has(b.id)) continue
      if (b.passing && afterChecks.get(b.id) === false) regressions.push(b.id)
    }
  }

  if (recheck === 'unresolved') {
    return {
      recheck,
      regressions,
      accepted: false,
      reason:
        'Fix ran and reported success but the issue is still present on re-check — ' +
        'escalated for review instead of recorded as fixed.',
    }
  }
  if (regressions.length > 0) {
    return {
      recheck,
      regressions,
      accepted: false,
      reason:
        `Fix closed its own gap but broke ${regressions.length} previously passing ` +
        `guarantee(s): ${regressions.join(', ')}. Escalated instead of recorded as fixed.`,
    }
  }
  return {
    recheck,
    regressions: [],
    accepted: recheck === 'resolved',
    reason:
      recheck === 'resolved'
        ? 'Gap re-probed and confirmed closed, with no regressions.'
        : 'Fix applied. No probe covers this type, so closure could not be confirmed.',
  }
}

/**
 * Snapshot the current invariant pass/fail state, for use as the `before` half
 * of `evaluateFixOutcome`. Cheap to call once per reconcile tick; the caller
 * should reuse one snapshot across a batch rather than recomputing per fix.
 */
export async function captureCheckBaseline(projectId: string): Promise<CheckState[]> {
  const report = await computeDesiredStateDiff(projectId)
  return checksFromDesiredState(report)
}

/**
 * One-line human summary for logs and the (later) trust UI. Non-technical by
 * design — the primary audience is non-engineer founders.
 */
export function summarizeDesiredState(report: DesiredStateReport): string {
  if (report.satisfied) return 'Backend is healthy — all guarantees hold.'
  const { 0: t0, 1: t1, 2: t2, 3: t3 } = report.tierCounts
  const parts: string[] = []
  if (t0 + t1 > 0) parts.push(`${t0 + t1} safe to auto-repair`)
  if (t2 > 0) parts.push(`${t2} need${t2 === 1 ? 's' : ''} your approval`)
  if (t3 > 0) parts.push(`${t3} need${t3 === 1 ? 's' : ''} your attention`)
  if (report.errors.length > 0) parts.push(`${report.errors.length} could not be checked`)
  const total = report.violations.length
  return `${total} ${total === 1 ? 'issue' : 'issues'} found — ${parts.join(', ')}.`
}
