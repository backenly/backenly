/**
 * SELFOPS-BENCH — contracts
 * =========================
 *
 * A benchmark for autonomous backend self-maintenance: inject a real fault into
 * a real backend, then measure whether the platform detects it, repairs it, and
 * leaves the backend working — without a human or an agent session.
 *
 * The taxonomy is borrowed deliberately, not invented. AIOpsLab (Microsoft
 * Research, arXiv:2501.06706) established the four tasks — detection,
 * localization, root-cause analysis, mitigation — for autonomous cloud
 * operations on Kubernetes microservices. This suite is the same taxonomy
 * instantiated on a backend data plane (Postgres + RLS + generated API
 * surface), which is the layer AIOpsLab and ITBench do not cover.
 *
 * ── The one rule that makes the numbers worth anything ──────────────────────
 *
 * A case is NEVER scored by asking the platform's own detector whether the
 * problem is gone. That is self-grading, and it is how a suite ends up
 * measuring the agreement of a probe with itself.
 *
 * Every case is scored by an `Oracle` that observes the backend from OUTSIDE
 * the platform's control plane — connecting to Postgres under the same role and
 * the same request claims that PostgREST uses to serve an end user. If the
 * oracle can read another tenant's rows, the backend is vulnerable, whatever
 * the dashboard says.
 *
 * ── Why an Observation has two axes and not one ─────────────────────────────
 *
 * "Is it fixed?" is the wrong question, because the cheapest way to make a
 * vulnerability disappear is to break the feature. A deny-all RLS policy passes
 * every security check ever written and also means the customer's app returns
 * nothing. So every observation reports two independent facts:
 *
 *   vulnerable  — the defect is reproducible from outside
 *   functional  — the legitimate path still works (the owner can still read
 *                 their own rows, the API still answers, the insert still lands)
 *
 * which yields four verdicts instead of two, and only one of them is a pass:
 *
 *   !vulnerable && functional   → HEALED         the only success
 *    vulnerable && functional   → NOT_REPAIRED   still broken
 *   !vulnerable && !functional  → OVER_CORRECTED secured into uselessness
 *    vulnerable && !functional  → DEGRADED       made it worse
 *
 * OVER_CORRECTED is scored as a FAILURE, and it is the metric a platform that
 * heals by locking doors will lose on. Reporting it is the point.
 */

/** The AIOpsLab task class a case exercises. */
export type AiopsTask = 'detection' | 'localization' | 'rca' | 'mitigation'

/**
 * Whether the fault is inside the platform's declared invariant catalogue.
 *
 * `out_of_catalogue` cases are faults NOBODY on this platform claims to detect.
 * They exist so the corpus cannot be tuned to the detector set — a suite whose
 * every case maps onto an existing probe is teaching to the test, and any
 * reviewer will say so. Expect these to fail. Publish them failing.
 */
export type CatalogueScope = 'in_catalogue' | 'out_of_catalogue'

/**
 * A reading of the backend taken from outside the control plane.
 *
 * `evidence` must be the concrete thing observed ("role authenticated with
 * sub=A read 3 rows belonging to sub=B"), never a restatement of the verdict.
 * It is what a skeptical reader checks instead of trusting the boolean.
 */
export interface Observation {
  /** The defect is reproducible right now. */
  vulnerable: boolean
  /** The legitimate, intended use of this backend still works. */
  functional: boolean
  /** What was actually observed, in one line. Goes into the published report. */
  evidence: string
}

export type Verdict =
  | 'healed'          // !vulnerable && functional  — the only pass
  | 'not_repaired'    //  vulnerable && functional
  | 'over_corrected'  // !vulnerable && !functional
  | 'degraded'        //  vulnerable && !functional
  | 'never_faulted'   // the injection did not produce the fault — case is void
  | 'harness_error'   // the case could not be run; never counted as a pass

/** Derive the verdict from a post-run observation. Total and pure. */
export function verdictFor(after: Observation): Exclude<Verdict, 'never_faulted' | 'harness_error'> {
  if (after.vulnerable) return after.functional ? 'not_repaired' : 'degraded'
  return after.functional ? 'healed' : 'over_corrected'
}

/**
 * Everything a case needs to build and inspect its backend.
 *
 * `sql` runs as the OWNER (the platform's own connection) and is how a case
 * builds and breaks its fixture. Oracles must NOT use it — they use the
 * role-scoped helpers in `oracle.ts`, because owner connections bypass RLS
 * (`FORCE ROW LEVEL SECURITY` notwithstanding) and would report a locked table
 * as readable.
 */
export interface CaseContext {
  projectId: string
  userId: string
  /** The workspace schema this project's tables live in. */
  schema: string
  /** Execute DDL/DML as the schema owner. Fixture construction only. */
  sql: (statement: string) => Promise<void>
  /** Query as the schema owner. Fixture construction only. */
  query: <T = Record<string, unknown>>(statement: string, params?: unknown[]) => Promise<T[]>
  /**
   * Create a table the way THIS PLATFORM creates tables, and register it in
   * whatever control plane the platform keeps.
   *
   * Cases must use this instead of raw `CREATE TABLE`, and the reason is a bug
   * this harness shipped with. Creating fixture tables with plain DDL left them
   * invisible to Backenly's control plane, so every case's backend arrived
   * carrying `orphan_table` and `workflow_broken` findings that had nothing to
   * do with the injected fault. Under the 2-minute mutation cooldown those
   * spurious findings consumed the repair budget first, and the actual fault —
   * a missing index — was starved for twelve straight cycles and scored as
   * "the platform cannot fix an index".
   *
   * A benchmark fixture has to be a well-formed project on the platform under
   * test, or it measures the malformation instead of the fault.
   *
   * @param name        table name, unqualified
   * @param columnsSql  the column list, e.g. `id uuid PRIMARY KEY, user_id uuid NOT NULL`
   */
  createTable: (name: string, columnsSql: string) => Promise<void>
}

export interface FaultCase {
  /** Stable id — appears in the published report and must never be reused. */
  id: string
  title: string
  task: AiopsTask
  scope: CatalogueScope
  /**
   * Real-world severity if this shipped, independent of whether we detect it.
   * `critical` = data exposure or total outage.
   */
  severity: 'critical' | 'warning' | 'info'
  /**
   * One line on what breaks in production when this fault is live. This is the
   * "why should anyone care" column of the report.
   */
  impact: string
  /**
   * True when this fault can be expressed on every lane in the comparison.
   * Only cross-platform cases are scored in a head-to-head table; the rest are
   * reported in a platform-specific appendix, unscored. Running a suite whose
   * tasks a competitor's vocabulary cannot express yields a true but
   * uninformative zero.
   */
  crossPlatform: boolean

  /** Build a CORRECT, working backend. Must leave the oracle clean. */
  setup(ctx: CaseContext): Promise<void>
  /** Break it. Must leave the oracle vulnerable and/or non-functional. */
  inject(ctx: CaseContext): Promise<void>
  /** Observe from outside the control plane. Called before and after healing. */
  observe(ctx: CaseContext): Promise<Observation>
}

/** What one lane (platform under test) must implement to be benchmarked. */
export interface LaneAdapter {
  /** Lane name as it appears in the report, e.g. "backenly-autopilot". */
  name: string
  /** One line describing who or what does the repairing on this lane. */
  healer: string
  /** Provision an empty project + workspace schema. */
  provision(): Promise<CaseContext>
  /**
   * Advance the platform's maintenance loop by exactly one cycle.
   * Returns what that cycle did, for the per-tick trace.
   *
   * Lanes whose healer is an agent session implement this as one agent turn.
   * Lanes with no healer at all return a zeroed tick, and their MTTR is
   * correctly reported as unbounded rather than as a missing value.
   */
  tick(ctx: CaseContext): Promise<TickResult>
  /** Tear down everything provisioned. Must not throw. */
  teardown(ctx: CaseContext): Promise<void>
}

export interface TickResult {
  /** Findings the platform currently holds open for this project. */
  openFindings: number
  /** Repairs the platform attempted this cycle. */
  attempted: number
  /** Repairs the platform applied this cycle. */
  applied: number
  /** Gaps routed to a human instead of repaired. */
  escalated: number
  /** Cycle refused to act (change freeze, breaker, cooldown). */
  blocked: boolean
  /** Why it refused, when it did. */
  note?: string
  /**
   * Model tokens spent by this cycle. The loop's cost story is only credible
   * if it is measured, so a lane that spends tokens must report them.
   */
  tokensSpent: number
}

export interface CaseResult {
  caseId: string
  lane: string
  task: AiopsTask
  scope: CatalogueScope
  severity: FaultCase['severity']
  crossPlatform: boolean
  verdict: Verdict
  /** Observation taken immediately after injection — proves the fault was real. */
  before: Observation | null
  /** Observation taken after the loop stopped changing things. */
  after: Observation | null
  /**
   * Cycles until the platform first held an open finding for this fault.
   * null = never detected within the budget.
   */
  ticksToDetect: number | null
  /** Cycles until the oracle first read healthy. null = never healed. */
  ticksToRepair: number | null
  ticksRun: number
  fixesApplied: number
  escalations: number
  tokensSpent: number
  /** Per-cycle trace, published alongside the score. */
  trace: TickResult[]
  error?: string
}
