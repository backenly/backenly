/**
 * PHASE 4 — hypothesis-driven healing.
 *
 * The existing loop is rule-driven: a probe matches a known pattern and a mapped
 * fix runs. That works when symptom and cause are one-to-one, and it is exactly
 * wrong when they are not — which is most of the interesting failures.
 *
 * Three from this codebase, all real:
 *
 *   • Every tenant returned 503. Cause: ONE unrelated project's schema was
 *     dropped while still registered. No rule connects those.
 *   • A table reads empty. Cause could be an engine/policy mismatch, an RLS
 *     predicate that is too strict, missing grants, or genuinely no rows. The
 *     symptom is identical in all four cases, and the fixes are different and
 *     partly opposite.
 *   • An endpoint 404s. Stale schema cache, missing ApiDefinition, dropped
 *     table, disabled route — again one symptom, four causes.
 *
 * A rule-matcher must pick one cause per symptom, so it is forced to guess. It
 * guesses silently, the fix does not help, and the loop reports success because
 * the command it ran succeeded.
 *
 * What an engineer does instead is not "try harder to guess". It is:
 *   1. list the explanations that would produce this symptom
 *   2. find an observation that the explanations DISAGREE about
 *   3. make that observation
 *   4. repeat until one explanation survives — or until nothing left
 *      distinguishes them, and say so
 *
 * Step 2 is the entire game, and it is what this module makes explicit. A test
 * that every hypothesis predicts identically carries no information no matter
 * how expensive or thorough it looks. Running those is how a system produces
 * pages of diagnostics and still concludes nothing.
 */

/** How confident we are, 0..1. Priors come from the catalog, not from nowhere. */
export type Confidence = number

export interface Hypothesis {
  id: string
  /** Stated as a claim that could be false, not as a category. */
  statement: string
  /**
   * Prior belief before any evidence. Encodes real base rates — a stale schema
   * cache is far more common than a dropped table, and treating them as equally
   * likely wastes the first test.
   */
  prior: Confidence
  /**
   * What this hypothesis PREDICTS each test will show. Absent means "this
   * hypothesis makes no prediction about that test" — which is honest and
   * important: a hypothesis that predicts everything explains nothing.
   */
  predicts: Record<string, string | undefined>
  /**
   * False when no evidence this platform can gather could ever settle it.
   *
   * `split_brain_writers` is the case: confirming it needs analysis of function
   * source, and there is no AST tooling here. Such a hypothesis may be RAISED —
   * it is a real possibility and hiding it would be dishonest — but it must
   * never be concluded on, and `structural.ts` has always enforced that for the
   * leader.
   *
   * It must also never be the reason a DIFFERENT, properly confirmed hypothesis
   * goes unacted on. No test can separate the two, so as a blocking runner-up
   * it does not express uncertainty that further evidence could resolve; it
   * expresses a permanent veto. Left that way, raising it can only ever
   * suppress a conclusion and never inform one — and because its deciding
   * observation is true of any table with more than two write shapes, the veto
   * applies to nearly every live project.
   *
   * So it is carried into the verdict as a standing caveat instead. The repair
   * it warns about is the one the maintenance ladder is built to catch:
   * dual-write and reconciliation compare the two representations
   * independently, and a second writer that keeps changing one of them shows up
   * as `inconsistent` rather than as silent drift.
   *
   * Defaults to confirmable when absent, so an ordinary hypothesis is
   * unaffected.
   */
  confirmable?: boolean
  /** The repair implied if this hypothesis wins. */
  remedy: {
    summary: string
    /** Whether the loop may apply it without a human. */
    autoApplicable: boolean
    /** Present when auto-applicable — the action the fix engine understands. */
    action?: string
    params?: Record<string, unknown>
  }
}

export interface DiagnosticTest {
  id: string
  description: string
  /**
   * Rough cost. Used only to break ties between tests with equal
   * discriminating power — never to skip a test that would actually decide
   * the question, because a cheap indecisive test is worse than an expensive
   * decisive one.
   */
  cost: 'trivial' | 'cheap' | 'expensive'
}

export interface Observation {
  testId: string
  outcome: string
  /** Raw detail for the audit trail; never used for matching. */
  detail?: string
}

export type InvestigationVerdict =
  /** One hypothesis survived with enough margin to act on. */
  | { kind: 'conclusive'; hypothesis: Hypothesis; confidence: Confidence }
  /**
   * Several remain and no available test separates them. Candidates carry their
   * confidence so a human inheriting the decision sees how close the field was,
   * not just which explanations survived.
   */
  | { kind: 'ambiguous'; candidates: Array<Hypothesis & { confidence: Confidence }>; reason: string }
  /** Evidence contradicted every hypothesis — the catalog is incomplete. */
  | { kind: 'unexplained'; reason: string; observations: Observation[] }
  /** Nothing to explain. */
  | { kind: 'no_symptom' }

export interface InvestigationState {
  symptomId: string
  hypotheses: Array<Hypothesis & { confidence: Confidence }>
  observations: Observation[]
  /** Tests already run, so the loop cannot repeat itself. */
  spentTests: string[]
}

/**
 * Confidence required before a hypothesis may be acted on automatically.
 *
 * Set high deliberately. The cost of acting on a wrong diagnosis is not a
 * failed command — it is a fix that changes production in a direction nobody
 * intended, on a system whose whole promise is that it can be trusted to touch
 * a backend unattended.
 */
export const ACT_THRESHOLD = 0.85

/**
 * Margin the leader must hold over the runner-up.
 *
 * Absolute confidence alone is not enough: two hypotheses at 0.86 and 0.85 mean
 * the evidence barely distinguished them, even though the leader clears the bar.
 */
export const LEAD_MARGIN = 0.25
