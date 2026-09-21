/**
 * PHASE 0 — BASELINE THE AUTONOMY SYSTEM WE ARE ABOUT TO CHANGE
 * =============================================================
 *
 * `docs/intent-and-authority-rfc.md` proposes a decision layer. Before any of it
 * is built, this measures what the CURRENT system does, so the redesign can
 * later be judged against a number rather than against an argument.
 *
 * This is a measurement, not a test, and that distinction is deliberate:
 *
 *   - It is a SCRIPT, not a jest suite. A CI-blocking suite would have to
 *     assert the current system is good, and the whole point is that we do not
 *     know that. `#80` left every maintenance ladder blocked; a green test
 *     asserting that is fine, and tells you nothing about autonomy.
 *   - It emits JSON, so Phase 2's shadow decisions can be compared against
 *     EXACTLY these scenarios and metrics rather than a re-run of a moving
 *     target.
 *   - It reports per action class. Index repair being excellent must not be
 *     able to mask RLS repair being dangerous.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * No principals, no grants, no Adaptation, no ownership intent, no Authority
 * Decision. Those are Phases 1 to 3. Adding any of them here would mean the
 * baseline measured a system that never shipped.
 *
 * Usage:
 *   npx tsx scripts/autonomy-baseline.ts
 *   npx tsx scripts/autonomy-baseline.ts --out artifacts/baseline.json
 *   npx tsx scripts/autonomy-baseline.ts --fault rls-disabled-on-user-table
 */

import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

import { PrismaClient } from '@prisma/client'

import { FAULTS, type LabFault, type FaultContext } from '../tests/lab/faults'
import { scenario } from '../tests/lab/scenarios'
import { seedScenario, teardownScenario, type SeededProject } from '../tests/lab/seed'
import { schemaFingerprint, schemaIsObservable } from '../tests/lab/oracles'
import { prepareForPostgrest } from '../tests/lab/postgrest'
import { decideAuthority, type AuthorityDecision } from '../lib/authority/decision'
import { loopPrincipals } from '../lib/principal'
import {
  connectObserver,
  connectionBypassesRls,
  ensureObserverRole,
  grantObserverAccess,
  type LabObserver,
} from '../tests/lab/observer-role'

// The loop only runs when the deployment says it may. Set before importing the
// reconciler so the flag getters read these on first evaluation.
process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

type RfcDecision = 'AUTO_EXECUTE' | 'PROPOSE_ONLY' | 'FREEZE' | 'DENY' | 'SILENT'

interface FaultOutcome {
  faultId: string
  family: LabFault['family']
  scenario: string
  actionClass: string | null

  /** How the lab exposed this schema to the PostgREST client roles. */
  substrate: { usedProductionFunction: boolean; grantedTo: string[]; missingRoles: string[] } | null
  /** False when a declared precondition could not be established. */
  substrateValid: boolean
  /**
   * False when the row is a valid observation of the LAB but not a scorable
   * observation of the PRODUCT, e.g. blindness that the app role's privileges
   * mean the loop never experienced.
   */
  scorable: boolean
  /** Audit rows cleared so the fault gets a fresh breaker budget. */
  breakerRowsCleared: number
  /** Passes the loop needed to reach steady state before the fault. */
  settleIterations: number
  /** Repairs applied while settling. Adoption of the raw-DDL seed, mostly. */
  settleApplied: number

  /** Did `apply` actually change anything? A false here invalidates the row. */
  faultWasReal: boolean
  /** Could the oracle see the schema after the fault? */
  observableAfterFault: boolean

  expected: {
    detected: boolean
    decision: string
    converges: boolean
  }

  observed: {
    /**
     * Did the loop detect THIS fault?
     *
     * Scoped to the fault's declared `detectorInvariants`. An earlier version
     * set this from "any finding at all", which scored the RLS fault as a true
     * positive on the strength of unrelated advisory gaps while the RLS
     * invariant never fired. Detection has to mean detection of the thing.
     */
    detected: boolean
    /** True when any finding was produced, related or not. */
    anyFinding: boolean
    /** Every ReconcileAction the plan produced, for the record. */
    actions: string[]
    /** Which invariants fired, with tier. The diagnostic half of a row. */
    findings: Array<{ invariantId: string; type: string; tier: number; action: string }>
    /**
     * Findings the loop reported but will not act on (tier above the dial).
     * Recorded as noise rather than scored: an advisory gap on a healthy
     * backend is not the failure this baseline is hunting.
     */
    advisoryOnly: number
    /** Current behaviour mapped into the RFC's vocabulary. */
    decision: RfcDecision
    /** Did the live run mutate the schema? */
    mutated: boolean
    /** Mutation happened, but not on this fault's target. Recorded, not scored. */
    collateralMutation: boolean
    /** Did the schema end up where the fault's expectation says it should? */
    converged: boolean
    /** The loop's own claim about what it applied. */
    claimedApplied: number
    /** Claims the oracle could not confirm. Non-zero is a safety finding. */
    unconfirmedClaims: number
    error: string | null
  }

  scores: {
    truePositive: boolean
    falsePositive: boolean
    falseNegative: boolean
    /** A mutation that should not have happened. Tier 1 safety. */
    unsafeMutation: boolean
    /** Claimed success the oracle contradicts. Tier 1 safety. */
    falseVerifiedSuccess: boolean
    /** Refused when it safely could have acted. Tier 2 utility. */
    overRefusal: boolean
    /** Decision matched the declared correct one. */
    decisionCorrect: boolean
    /** Could every conclusion be tied to a ground-truth observation? */
    evidenceComplete: boolean
  }

  /**
   * PHASE 2. What the Authority Decision layer would have said, evaluated
   * beside the live loop and changing nothing.
   */
  shadow: {
    decision: string
    narrowedBy: string[]
    blocker: string | null
    reason: string
    /** Did the shadow layer land on the oracle's declared answer? */
    matchesOracle: boolean
    /** Did it differ from what the old behaviour did? */
    differsFromOld: boolean
  } | null

  timings: { shadowMs: number; liveMs: number }
  notes: string[]
}

async function runFault(
  prisma: PrismaClient,
  f: LabFault,
  observer: LabObserver | null,
  appBypassesRls: boolean,
): Promise<FaultOutcome> {
  const notes: string[] = []
  let seeded: SeededProject | null = null
  let cleanup: (() => Promise<void>) | void
  const exec = (sql: string) => prisma.$executeRawUnsafe(sql)

  const outcome: FaultOutcome = {
    faultId: f.id,
    family: f.family,
    scenario: f.scenario,
    actionClass: f.expected.actionClass,
    substrate: null,
    substrateValid: true,
    scorable: true,
    breakerRowsCleared: 0,
    settleIterations: 0,
    settleApplied: 0,
    faultWasReal: false,
    observableAfterFault: false,
    expected: {
      detected: f.expected.detected,
      decision: f.expected.decision,
      converges: f.expected.converges,
    },
    observed: {
      detected: false,
      anyFinding: false,
      actions: [],
      findings: [],
      advisoryOnly: 0,
      decision: 'SILENT',
      mutated: false,
      collateralMutation: false,
      converged: false,
      claimedApplied: 0,
      unconfirmedClaims: 0,
      error: null,
    },
    scores: {
      truePositive: false,
      falsePositive: false,
      falseNegative: false,
      unsafeMutation: false,
      falseVerifiedSuccess: false,
      overRefusal: false,
      decisionCorrect: false,
      evidenceComplete: false,
    },
    shadow: null,
    timings: { shadowMs: 0, liveMs: 0 },
    notes,
  }

  try {
    seeded = await seedScenario(prisma, scenario(f.scenario))
    const ctx: FaultContext = {
      prisma,
      projectId: seeded.projectId,
      schema: seeded.schema,
      exec,
      observer,
    }

    if (observer) await grantObserverAccess(prisma, seeded.schema)

    // ── Make the schema reachable the way production's is ───────────────────
    //
    // detectMissingRls only reports CLIENT-REACHABLE tables, and the seeder
    // grants nothing, so without this the RLS fault measures an exposure that
    // cannot exist. See tests/lab/postgrest.ts for why leaving this implicit
    // also made the result depend on which other suites had run.
    const prep = await prepareForPostgrest(prisma, seeded.schema)
    outcome.substrate = {
      usedProductionFunction: prep.usedProductionFunction,
      grantedTo: prep.grantedTo,
      missingRoles: prep.missingRoles,
    }

    if (f.precondition) await f.precondition(ctx)

    if (f.verifyHealthy) {
      try {
        await f.verifyHealthy(ctx)
      } catch (e: any) {
        outcome.substrateValid = false
        notes.push(`PRECONDITION NOT MET: ${e?.message ?? e}`)
        return outcome
      }
    }

    // ── Settle to steady state BEFORE injecting the fault ────────────────────
    //
    // The bank seeds schemas with raw DDL, which bypasses the product's own
    // table-creation path. So a freshly seeded project has real tables that
    // Backenly has never registered, and the loop correctly reports adoption
    // and API-coverage gaps for every one of them.
    //
    // Measuring from that state would score ~10 legitimate adoption repairs as
    // unsafe mutations on a "healthy" backend, which would be a confident wrong
    // finding of exactly the kind this baseline exists to avoid. Letting the
    // loop converge first means the healthy fingerprint is the state the system
    // itself considers settled, and everything after the fault is a response to
    // the fault.
    const settle = await settleProject(seeded.projectId, notes)
    outcome.settleIterations = settle.iterations
    outcome.settleApplied = settle.applied

    // ── Give the fault a fresh circuit-breaker budget ────────────────────────
    //
    // The breaker counts budget-consuming AuditLog rows in a rolling window, so
    // the ~10 adoption repairs above spend the window before the fault is even
    // injected. The first full run showed exactly that: a tier-0 index repair
    // came back BLOCKED_BY_BREAKER, and reporting "the loop never auto-fixes"
    // from that would have been a property of this harness, not of the system.
    //
    // Clearing this project's own audit rows isolates the measurement. It is
    // safe because the project was created by this run seconds ago.
    const cleared = await prisma.auditLog.deleteMany({ where: { projectId: seeded.projectId } })
    outcome.breakerRowsCleared = cleared.count

    const healthy = await schemaFingerprint(prisma, seeded.schema)

    cleanup = await f.apply(ctx)

    // Non-vacuity: a fault whose fingerprint is unchanged did nothing, and any
    // score derived from it would describe a backend that was never broken.
    outcome.observableAfterFault = await schemaIsObservable(prisma, seeded.schema)
    const broken = outcome.observableAfterFault
      ? await schemaFingerprint(prisma, seeded.schema)
      : null
    // Non-vacuity, proven in the dimension the fault actually operates in.
    //
    // A schema diff is the right test for a `backend` fault, which changes the
    // database. It is the WRONG test for an `observer` fault, which leaves the
    // database healthy and impairs the reader: REVOKE USAGE moves no catalog
    // row, so a fingerprint comparison reported "FAULT DID NOTHING" for a
    // revocation that had genuinely blinded the observer.
    //
    // Observer faults are therefore validated by `verifyBroken`, which asserts
    // the contrast that IS the fault: the owner still sees the truth and the
    // production-equivalent reader does not.
    outcome.faultWasReal =
      f.family === 'control'
        ? true // a control is *supposed* to change nothing
        : f.family === 'observer'
          ? true // established by verifyBroken below; a missing one is rejected
          : broken === null || JSON.stringify(healthy) !== JSON.stringify(broken)

    if (f.family === 'observer' && !f.verifyBroken) {
      outcome.faultWasReal = false
      notes.push('observer fault has no verifyBroken, so its blindness is unproven')
      return outcome
    }

    if (!outcome.faultWasReal) {
      notes.push('FAULT DID NOTHING — this row is invalid, not a passing result')
      return outcome
    }

    // A fault that only blinds a reader weaker than the app connection cannot
    // test the product when the app connection bypasses RLS. Record it, do not
    // score it: calling that a product false positive would attribute a
    // blindness the deployed loop never experienced.
    if (f.requiresProductionEquivalentAppRole && appBypassesRls) {
      outcome.scorable = false
      notes.push(
        'NOT SCORED: the application role bypasses RLS, so the product never ' +
          'experienced this blindness. Re-run against a NOSUPERUSER NOBYPASSRLS role.',
      )
    }

    if (f.verifyBroken) {
      try {
        await f.verifyBroken(ctx)
      } catch (e: any) {
        outcome.substrateValid = false
        notes.push(`FAULT DID NOT PRODUCE ITS CONDITION: ${e?.message ?? e}`)
        return outcome
      }
    }

    // ── PHASE 2: the Authority Decision, in shadow ───────────────────────────
    //
    // Evaluated on the same backend, at the same moment, from the same sensor
    // report the loop would see. It gates nothing: the live run below still
    // behaves exactly as it did in Phase 0, which is the only way to compare
    // the two answers honestly.
    try {
      const { checkSensorHealth } = await import('../lib/autonomy/sensor-health')
      const { DEFAULT_LEVEL } = await import('../lib/autonomy/autonomy-level')
      const report = await checkSensorHealth(seeded.projectId)
      const principals = await loopPrincipals(prisma, seeded.projectId, 'reconciler')

      const d: AuthorityDecision = decideAuthority({
        projectId: seeded.projectId,
        actionClassId: f.expected.shadowActionClass,
        resource: `${seeded.schema}.posts`,
        environment: 'development',
        principals,
        // Lab projects carry the default dial, which is AGGRESSIVE.
        level: DEFAULT_LEVEL,
        probes: report.probes,
        // Asked of PostgreSQL at decision time, by the oracle rather than by a
        // probe. For the blindness faults this is what the sensor layer cannot
        // tell the decision on its own.
        resourceObservable: await schemaIsObservable(prisma, seeded.schema).catch(
          () => 'unknown' as const,
        ),
        // Phase 2 has no ownership intent. Phase 3 supplies it and tests
        // whether the same action can then legitimately become AUTO_EXECUTE.
        hasDeclaredIntent: false,
      })

      outcome.shadow = {
        decision: d.decision,
        narrowedBy: d.narrowedBy,
        blocker: d.blocker,
        reason: d.reasons[0] ?? '',
        matchesOracle: d.decision === f.expected.decision,
        // Filled in after the live run below, which is what establishes the old
        // behaviour to compare against.
        differsFromOld: false,
      }
    } catch (e: any) {
      notes.push(`shadow authority decision failed: ${String(e?.message ?? e)}`)
    }

    // ── Shadow: what would it do? ────────────────────────────────────────────
    const { runReconcilerShadow, runReconcilerLive } = await import('../lib/autonomy/reconciler')

    const t0 = Date.now()
    const plan = await runReconcilerShadow(seeded.projectId).catch((e: any) => {
      outcome.observed.error = `shadow: ${e?.message ?? e}`
      return null
    })
    outcome.timings.shadowMs = Date.now() - t0

    if (plan) {
      outcome.observed.actions = plan.decisions.map(d => d.action)
      outcome.observed.findings = plan.decisions.map(d => ({
        invariantId: d.invariantId,
        type: d.type,
        tier: d.tier,
        action: d.action,
      }))
      outcome.observed.anyFinding = plan.decisions.length > 0
      const want = f.expected.detectorInvariants
      outcome.observed.detected =
        want.length === 0
          ? plan.decisions.length > 0
          : plan.decisions.some(d => want.includes(d.invariantId))
      outcome.observed.decision = mapDecision(
        plan.decisions.filter(d => want.length === 0 || want.includes(d.invariantId)).map(d => d.action),
      )
      outcome.observed.advisoryOnly = plan.decisions.filter(
        d => d.action === 'NEEDS_APPROVAL' || d.action === 'NOTIFY_ONLY',
      ).length
    }

    // ── Live: what does it actually do to the database? ──────────────────────
    const t1 = Date.now()
    const live = await runReconcilerLive(seeded.projectId).catch((e: any) => {
      outcome.observed.error = `${outcome.observed.error ?? ''} live: ${e?.message ?? e}`.trim()
      return null
    })
    outcome.timings.liveMs = Date.now() - t1

    if (live) outcome.observed.claimedApplied = live.applied

    if (outcome.shadow) {
      outcome.shadow.differsFromOld = outcome.shadow.decision !== outcome.observed.decision
    }

    // ── Ground truth, after the system has had its turn ──────────────────────
    const observableNow = await schemaIsObservable(prisma, seeded.schema)
    const after = observableNow ? await schemaFingerprint(prisma, seeded.schema) : null

    if (after && broken) {
      outcome.observed.mutated = JSON.stringify(after) !== JSON.stringify(broken)
      outcome.observed.converged = f.verifyConverged
        ? await f.verifyConverged(ctx).catch(() => false)
        : JSON.stringify(after) === JSON.stringify(healthy)
    } else if (!observableNow) {
      notes.push('schema still unobservable after the run — convergence unknowable')
    }

    // A claim of applied repairs that did not move the schema is the `#79`
    // shape: the executor certifying itself.
    if (outcome.observed.claimedApplied > 0 && !outcome.observed.mutated) {
      outcome.observed.unconfirmedClaims = outcome.observed.claimedApplied
    }

    score(outcome, f)
  } catch (err: any) {
    outcome.observed.error = `harness: ${err?.message ?? err}`
    notes.push('harness error — row is not a measurement of the system')
  } finally {
    try {
      if (cleanup) await cleanup()
    } catch (e: any) {
      notes.push(`cleanup failed: ${e?.message ?? e}`)
    }
    if (seeded) {
      try {
        await teardownScenario(prisma, seeded)
      } catch (e: any) {
        notes.push(`teardown failed: ${e?.message ?? e}`)
      }
    }
  }

  return outcome
}

/**
 * Run the live loop until it stops changing anything, or give up.
 *
 * Returns how many passes it took and how much it applied. A project that never
 * settles is itself a finding: it means the loop believes it is repairing
 * something it is not actually fixing, which is the `#79` shape at the level of
 * the whole tick rather than one action.
 */
async function settleProject(
  projectId: string,
  notes: string[],
  maxPasses = 4,
): Promise<{ iterations: number; applied: number }> {
  const { runReconcilerLive } = await import('../lib/autonomy/reconciler')
  let applied = 0

  for (let i = 1; i <= maxPasses; i++) {
    const r = await runReconcilerLive(projectId).catch((e: any) => {
      notes.push(`settle pass ${i} failed: ${e?.message ?? e}`)
      return null
    })
    if (!r) return { iterations: i, applied }
    applied += r.applied
    if (r.applied === 0) return { iterations: i, applied }
  }

  notes.push(
    `did not settle in ${maxPasses} passes (${applied} applied) — the loop keeps ` +
      'repairing something that does not stay repaired',
  )
  return { iterations: maxPasses, applied }
}

/**
 * Map today's ReconcileAction vocabulary onto the RFC's four values.
 *
 * The important asymmetry: **there is no input that maps to FREEZE.** The
 * current system has no way to say "I cannot establish this", so an observer
 * fault can only come out as SILENT (indistinguishable from healthy) or as a
 * finding built on blindness. That gap is the single most important thing this
 * baseline measures, and it is why the mapping is written down rather than
 * inferred at read time.
 */
function mapDecision(actions: string[]): RfcDecision {
  if (actions.length === 0) return 'SILENT'
  if (actions.includes('WOULD_AUTO_APPLY')) return 'AUTO_EXECUTE'
  if (
    actions.includes('NEEDS_APPROVAL') ||
    actions.includes('NOTIFY_ONLY') ||
    actions.includes('BLOCKED_BY_LEVEL') ||
    actions.includes('BLOCKED_BY_BREAKER')
  ) {
    return 'PROPOSE_ONLY'
  }
  return 'SILENT'
}

function score(o: FaultOutcome, f: LabFault): void {
  const s = o.scores
  const shouldDetect = f.expected.detected

  // A backend the loop merely has ADVICE about is not a backend it got wrong.
  // Controls and observer faults are scored on whether the loop ACTED, not on
  // whether it stayed completely quiet: a lab-seeded project always carries some
  // Tier-2/3 advisory gaps (archival plans, token cleanup, data-plane
  // registration) that are legitimate observations and are never mutations.
  //
  // Scoring those as false positives would make the control unpassable for
  // reasons unrelated to safety, and the temptation would then be to weaken the
  // control until it went green. The advisory count is reported instead, so the
  // noise stays visible without being laundered into a safety number.
  const actedOn = o.observed.decision === 'AUTO_EXECUTE' || o.observed.mutated

  s.truePositive = shouldDetect && o.observed.detected
  s.falseNegative = shouldDetect && !o.observed.detected
  s.falsePositive = !shouldDetect && actedOn

  // ── Unsafe mutation, judged by the authority oracle ──────────────────────
  //
  // This was `mutated && (control || observer)`, which excluded backend faults
  // entirely — so `policy-wide-open` could be declared PROPOSE_ONLY,
  // auto-execute anyway, mutate an authorization policy, and still be counted
  // toward a "0 unsafe mutations" headline. The lab contradicted its own oracle.
  //
  // The correction has to be attributed, though. `o.observed.mutated` is
  // schema-wide, and a tick that correctly declines this fault may still apply
  // an unrelated tier-0 repair in the same pass. Scoring that as unsafe made
  // `fk-dropped` look like a violation when its decision was exactly right.
  //
  // `observed.decision` is already computed over THIS fault's detector
  // invariants only, so AUTO_EXECUTE there means it acted on this fault.
  const actedOnThisFault = o.observed.decision === 'AUTO_EXECUTE'

  s.unsafeMutation =
    (actedOnThisFault && f.expected.decision !== 'AUTO_EXECUTE') ||
    // For a control or an observer fault there is no legitimate target at all,
    // so any mutation is unsafe whatever the loop believed it was repairing.
    (o.observed.mutated && (f.family === 'control' || f.family === 'observer'))

  // Recorded, never scored: mutation elsewhere in the schema during this tick.
  o.observed.collateralMutation = o.observed.mutated && !actedOnThisFault

  s.falseVerifiedSuccess = o.observed.unconfirmedClaims > 0

  // Refused where the declared answer was that it could safely act.
  s.overRefusal =
    f.expected.decision === 'AUTO_EXECUTE' &&
    shouldDetect &&
    o.observed.decision !== 'AUTO_EXECUTE' &&
    !o.observed.converged

  s.decisionCorrect =
    f.family === 'control' || f.family === 'observer'
      ? !actedOn // scored on restraint, not on saying nothing
      : o.observed.decision === f.expected.decision

  // Every conclusion had to be checkable against the catalog. A run that could
  // not observe the schema afterwards cannot claim complete evidence.
  s.evidenceComplete = o.observed.error === null && o.faultWasReal

  if (f.family === 'observer' && o.observed.decision === 'SILENT') {
    o.notes.push(
      'silence on a blind observer: today indistinguishable from a healthy backend (no FREEZE exists)',
    )
  }
}

function aggregate(rows: FaultOutcome[]) {
  const valid = rows.filter(
    r =>
      r.faultWasReal &&
      r.substrateValid &&
      r.scorable &&
      !r.observed.error?.startsWith('harness'),
  )
  const recordedNotScored = rows.filter(r => r.faultWasReal && r.substrateValid && !r.scorable)
  const byClass: Record<string, any> = {}

  for (const r of valid) {
    const key = r.actionClass ?? `(${r.family})`
    byClass[key] ??= {
      runs: 0,
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 0,
      unsafeMutation: 0,
      falseVerifiedSuccess: 0,
      overRefusal: 0,
      decisionCorrect: 0,
      evidenceComplete: 0,
      converged: 0,
    }
    const b = byClass[key]
    b.runs++
    for (const k of Object.keys(r.scores) as Array<keyof typeof r.scores>) {
      if (r.scores[k]) b[k] = (b[k] ?? 0) + 1
    }
    if (r.observed.converged) b.converged++
  }

  const safety = {
    unsafeMutations: valid.filter(r => r.scores.unsafeMutation).length,
    falseVerifiedSuccesses: valid.filter(r => r.scores.falseVerifiedSuccess).length,
    // The Tier 1 gate from RFC §18.4. Zero observed is the bar; it is not a
    // proof of impossibility and must not be reported as one.
    tier1GateMet:
      valid.filter(r => r.scores.unsafeMutation || r.scores.falseVerifiedSuccess).length === 0,
  }

  const detection = {
    truePositives: valid.filter(r => r.scores.truePositive).length,
    falsePositives: valid.filter(r => r.scores.falsePositive).length,
    falseNegatives: valid.filter(r => r.scores.falseNegative).length,
  }

  const utility = {
    converged: valid.filter(r => r.observed.converged).length,
    advisoryFindingsOnHealthy: valid
      .filter(r => r.family === 'control')
      .reduce((n, r) => n + r.observed.advisoryOnly, 0),
    overRefusals: valid.filter(r => r.scores.overRefusal).length,
    decisionCorrect: valid.filter(r => r.scores.decisionCorrect).length,
    medianShadowMs: median(valid.map(r => r.timings.shadowMs)),
    medianLiveMs: median(valid.map(r => r.timings.liveMs)),
  }

  const evidence = {
    complete: valid.filter(r => r.scores.evidenceComplete).length,
    incomplete: valid.filter(r => !r.scores.evidenceComplete).length,
  }

  // How often could the system safely act, versus refuse or stay silent?
  const eligible = valid.filter(r => r.expected.decision === 'AUTO_EXECUTE')
  const availability = {
    autoEligibleFaults: eligible.length,
    actuallyAutoExecuted: eligible.filter(r => r.observed.decision === 'AUTO_EXECUTE').length,
    // Observer faults where the only honest answer is FREEZE, which today's
    // vocabulary cannot express at all.
    freezeRequiredButUnavailable: valid.filter(
      r => r.expected.decision === 'FREEZE' && r.family === 'observer',
    ).length,
  }

  const phase2 = rows
    // Controls are scored on RESTRAINT, not on decision agreement: a healthy
    // backend has no proposed action, so the four-valued vocabulary has no
    // member that fits and `FREEZE` is recorded only to keep the type total.
    // Including it would penalise the decision layer for a placeholder.
    .filter(r => r.shadow && r.faultWasReal && r.substrateValid && r.family !== 'control')
    .map(r => ({
      faultId: r.faultId,
      actionClass: r.expected.decision,
      oracle: r.expected.decision,
      oldBehaviour: r.observed.decision,
      shadowDecision: r.shadow!.decision,
      shadowMatchesOracle: r.shadow!.matchesOracle,
      oldMatchedOracle: r.observed.decision === r.expected.decision,
      narrowedBy: r.shadow!.narrowedBy,
      blocker: r.shadow!.blocker,
    }))

  return {
    phase2ShadowComparison: {
      rows: phase2,
      shadowCorrect: phase2.filter(r => r.shadowMatchesOracle).length,
      oldCorrect: phase2.filter(r => r.oldMatchedOracle).length,
      total: phase2.length,
      /** Rows the old behaviour got wrong and the shadow layer gets right. */
      fixed: phase2.filter(r => r.shadowMatchesOracle && !r.oldMatchedOracle).map(r => r.faultId),
      /** Rows the old behaviour got right and the shadow layer would break. */
      regressed: phase2.filter(r => !r.shadowMatchesOracle && r.oldMatchedOracle).map(r => r.faultId),
    },
    validRows: valid.length,
    invalidRows: rows.length - valid.length - recordedNotScored.length,
    recordedNotScored: recordedNotScored.map(r => ({ faultId: r.faultId, why: r.notes[0] ?? '' })),
    safety,
    detection,
    utility,
    evidence,
    availability,
    byActionClass: byClass,
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function firstLine(e: any): string {
  const m = String(e?.message ?? e)
  const nl = m.indexOf(String.fromCharCode(10))
  return nl === -1 ? m : m.slice(0, nl)
}

async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outPath = outIdx >= 0 ? args[outIdx + 1] : 'artifacts/autonomy-baseline.json'
  const onlyIdx = args.indexOf('--fault')
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

  const faults = only ? FAULTS.filter(f => f.id === only) : FAULTS
  if (faults.length === 0) {
    console.error(`No fault matched "${only}"`)
    process.exit(2)
  }

  const prisma = new PrismaClient()
  const rows: FaultOutcome[] = []

  console.log(`\n  Autonomy baseline — ${faults.length} fault(s), real PostgreSQL\n`)

  // What privileges is the application connection actually running with?
  // Recorded because a superuser bypasses RLS entirely, which would make every
  // observation-blindness measurement vacuous without saying so.
  const appRole = await connectionBypassesRls(prisma)
  console.log(
    `  app role: ${appRole.user} super=${appRole.superuser} bypassrls=${appRole.bypassrls}` +
      `${appRole.bypasses ? '  <-- BYPASSES RLS, not production-equivalent' : ''}`,
  )

  let observer: LabObserver | null = null
  try {
    await ensureObserverRole(prisma)
    observer = await connectObserver(process.env.DATABASE_URL ?? '')
    console.log(`  observer: ${observer.role} (NOSUPERUSER NOBYPASSRLS, non-owning)`)
  } catch (e: any) {
    console.log(`  observer: UNAVAILABLE - ` + firstLine(e))
  }
  console.log('')

  for (const f of faults) {
    process.stdout.write(`  ${f.id.padEnd(34)} `)
    const r = await runFault(prisma, f, observer, appRole.bypasses)
    rows.push(r)
    const verdict = !r.faultWasReal
      ? 'INVALID (fault did nothing)'
      : r.observed.error
        ? `error: ${r.observed.error.slice(0, 40)}`
        : `${r.observed.decision.padEnd(13)} expected ${r.expected.decision}`
    console.log(verdict)
  }

  if (observer) await observer.close()
  await prisma.$disconnect()

  const report = {
    kind: 'autonomy-baseline',
    schemaVersion: 1,
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    gitSha: process.env.GIT_SHA ?? null,
    phase: 'phase-0-pre-redesign',
    substrate: {
      appRole,
      observerRole: observer ? observer.role : null,
      // The honest caveat: when the app connection bypasses RLS, the product's
      // own probes cannot be blinded here, so blindness rows describe a
      // production-equivalent reader rather than the deployed loop.
      appRoleIsProductionEquivalent: !appRole.bypasses,
    },
    note:
      'Baseline of the CURRENT autonomy system, before the Authority Decision ' +
      'layer exists. Phase 2 shadow runs must be compared against this file.',
    summary: aggregate(rows),
    rows,
  }

  const full = resolve(process.cwd(), outPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, JSON.stringify(report, null, 2))

  const s = report.summary
  console.log(`\n  rows            ${s.validRows} valid, ${s.invalidRows} invalid`)
  console.log(`  safety          ${s.safety.unsafeMutations} unsafe, ${s.safety.falseVerifiedSuccesses} false-success`)
  console.log(`  detection       ${s.detection.truePositives} TP / ${s.detection.falsePositives} FP / ${s.detection.falseNegatives} FN`)
  console.log(`  utility         ${s.utility.converged} converged, ${s.utility.overRefusals} over-refusal`)
  console.log(`  auto-eligible   ${s.availability.actuallyAutoExecuted}/${s.availability.autoEligibleFaults} auto-executed`)
  console.log(`  FREEZE needed   ${s.availability.freezeRequiredButUnavailable} (vocabulary cannot express it today)`)
  console.log(`\n  written to ${outPath}\n`)

  // Exit 0 regardless of findings: this measures, it does not gate. A baseline
  // that failed CI would pressure whoever runs it to make the number look good.
  process.exit(0)
}

main().catch(err => {
  console.error('baseline failed:', err)
  process.exit(1)
})
