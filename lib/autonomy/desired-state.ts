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
import { detectMissingRls } from '@/lib/services/workspace-observer'
import { classifyFix } from '@/lib/core/fix-classifier'
import type { FindingType, FindingSeverity, RawFinding } from '@/lib/core/types'
import {
  detectMissingHotPathIndexes,
  detectStaleDataOverflow,
  detectExpiredTokenBuildup,
} from './invariant-probes'
import { detectRuntimeEngineMismatch } from './engine-conformance'
import { detectUnregisteredSchema } from './schema-registration'
import { detectPendingSchemaDrift } from './drift-watch'

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
    (table && column ? `${table}.${column}` : table)
  return `${type}::${loc}`
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
  const key = gapIdentity(gapType, gapDetails)
  const report = await computeDesiredStateDiff(projectId)
  const stillPresent = report.violations.some(
    (v) => gapIdentity(v.type, v.details as Record<string, unknown>) === key,
  )
  if (stillPresent) return 'unresolved'
  return report.errors.length > 0 ? 'unknown' : 'resolved'
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
