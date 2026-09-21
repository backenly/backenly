/**
 * THE AUTHORITY DECISION
 * ======================
 *
 * `docs/intent-and-authority-rfc.md` §10. Every proposed autonomous mutation
 * passes through one four-valued decision, recorded whether it permits or
 * refuses.
 *
 *     AUTO_EXECUTE    act now, within the stated bounds
 *     PROPOSE_ONLY    prepare it, surface it, do not act
 *     FREEZE          no mutation and no executable repair proposal; say why
 *     DENY            policy forbids this here, permanently
 *
 * ── Deterministic, not clever ───────────────────────────────────────────────
 *
 * This is policy evaluation over recorded facts. No LLM decides anything here;
 * an LLM may propose the action that gets evaluated, and may read the receipt
 * afterwards to explain it. The RFC's non-goal #1 is that this is not "the AI
 * decides", and the implementation has to make that structurally true.
 *
 * ── An intersection, not a priority race ────────────────────────────────────
 *
 * The existing gates keep their meanings and stop deciding alone: the dial, the
 * tier ceiling, the deployment flags, sensor confidence, verification
 * capability, recovery capability, and recent conflicting change are all INPUTS.
 * Every one of them can only narrow the answer, never widen it, and each records
 * that it did so in `narrowedBy`.
 *
 * ── Shadow ──────────────────────────────────────────────────────────────────
 *
 * Phase 2 evaluates this beside the live loop and changes nothing. The point is
 * to find out whether it reproduces the known-good answers and fixes the known
 * bad ones BEFORE it is allowed to gate a mutation.
 */

import { maxAutoTier, type AutonomyLevel } from '@/lib/autonomy/autonomy-level'
import { resolveExecutionMode } from '@/lib/autonomy/execution-mode'
import { canRollback } from '@/lib/autonomy/maintenance/rollback-capability'
import type { ProbeOutcome, ProbeStatus } from '@/lib/autonomy/sensor-health'
import type { CorrelatedChange } from '@/lib/autonomy/change-correlation'
import type { Principal, PrincipalSet } from '@/lib/principal'

import { actionClass, type ActionClass, type SensorRequirement } from './action-classes'

export type Decision = 'AUTO_EXECUTE' | 'PROPOSE_ONLY' | 'FREEZE' | 'DENY'

/** One sensor's contribution, as it stood when the decision was made. */
export interface SensorEvidence {
  probeId: string
  status: ProbeStatus | 'missing'
  /** Seconds since the probe last ran, or null when never/unknown. */
  ageSeconds: number | null
  withinLiveness: boolean
  supportsAutonomy: boolean
  note: string
}

export interface AuthorityInputs {
  projectId: string
  /** The action being proposed, by action-class id. */
  actionClassId: string
  /** What it would touch, in real identifiers. */
  resource: string
  environment: 'development' | 'staging' | 'production'
  principals: PrincipalSet
  /** The project's autonomy dial. */
  level: AutonomyLevel
  /** Sensor health, as produced by lib/autonomy/sensor-health. */
  probes: ProbeOutcome[]
  /**
   * Could the resource be observed at all when this was decided?
   *
   * Separate from sensor health, and it has to be, because the Phase 2 run
   * showed sensor health CANNOT report this. `detectMissingRls` asks
   * `pg_tables WHERE schemaname = $1`; against a schema that no longer exists
   * that returns zero rows and no error, so the probe is classified
   * `unverified` — ran quietly, never fired — exactly as it would be on a
   * healthy backend with nothing wrong.
   *
   * That is `#83` restated one layer up: an unreadable resource and a clean one
   * produce the same value. Establishing observability separately is what makes
   * a probe's silence mean something, and it is the only input that can turn
   * observation blindness into FREEZE.
   *
   * `'unknown'` is not optimism: it is treated as unobservable.
   */
  resourceObservable: boolean | 'unknown'

  /** Recent changes by anyone, for conflict detection. */
  recentChanges?: CorrelatedChange[]
  /**
   * Does a durable declaration say what the correct end state is?
   *
   * Phase 2 always passes false: no ownership intent exists yet. Phase 3 supplies
   * it, and the same action can then legitimately reach a different answer
   * WITHOUT any rule here being relaxed.
   */
  hasDeclaredIntent?: boolean
}

export interface AuthorityDecision {
  decision: Decision
  actionClassId: string
  resource: string
  environment: string

  principals: {
    requestedBy: Principal
    authorizedBy: Principal | null
    executedBy: Principal
    authorizationSource: string
  }

  evidence: SensorEvidence[]

  capability: {
    verification: 'available' | 'unavailable'
    recovery: string
    recoveryStatus: 'implemented' | 'not_implemented'
  }

  conflict: CorrelatedChange[]

  /** Every input that reduced the answer, in the order it applied. */
  narrowedBy: string[]
  /** Ordered, machine-readable, human-legible. */
  reasons: string[]
  /** For FREEZE: the prerequisite to restore. Never null on a FREEZE. */
  blocker: string | null
  decidedAt: string
}

/** Seconds since an ISO timestamp, or null when absent. */
function ageOf(iso?: string): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 1000))
}

/**
 * Judge one sensor requirement.
 *
 * `clean` supports autonomy; `unverified` does not, because a probe that has
 * never fired is indistinguishable from a broken one and its silence proves
 * nothing. `fired` means it is working AND found something, which is exactly the
 * case an action is responding to.
 */
function judgeSensor(req: SensorRequirement, probes: ProbeOutcome[]): SensorEvidence {
  const probe = probes.find(p => p.id === req.probeId)
  if (!probe) {
    return {
      probeId: req.probeId,
      status: 'missing',
      ageSeconds: null,
      withinLiveness: false,
      supportsAutonomy: false,
      note: 'no such probe in the sensor report',
    }
  }

  const age = ageOf(probe.lastFiredAt)
  // Liveness is about the probe having RUN recently. The report is produced by a
  // run, so a probe present in it has just run; `lastFiredAt` refines that for
  // probes that have demonstrated they can fire.
  const withinLiveness = probe.status === 'errored' || probe.status === 'disabled' ? false : true

  const supports = (probe.status === 'clean' || probe.status === 'fired') && withinLiveness

  const note =
    probe.status === 'errored'
      ? `probe failed: ${probe.error ?? 'unknown error'}`
      : probe.status === 'disabled'
        ? `probe disabled: ${probe.disabledReason ?? 'a server capability is missing'}`
        : probe.status === 'unverified'
          ? 'ran quietly but has never fired, so its silence proves nothing'
          : probe.status === 'fired'
            ? 'ran and found something'
            : 'ran quietly and has fired before, so silence is meaningful'

  return {
    probeId: req.probeId,
    status: probe.status,
    ageSeconds: age,
    withinLiveness,
    supportsAutonomy: supports,
    note,
  }
}

/**
 * Decide. Pure over its inputs, so the same facts always give the same answer.
 */
export function decideAuthority(input: AuthorityInputs): AuthorityDecision {
  const narrowedBy: string[] = []
  const reasons: string[] = []
  let blocker: string | null = null

  const cls = actionClass(input.actionClassId)

  const base = {
    actionClassId: input.actionClassId,
    resource: input.resource,
    environment: input.environment,
    principals: {
      requestedBy: input.principals.requestedBy,
      authorizedBy: input.principals.authorizedBy,
      executedBy: input.principals.executedBy,
      authorizationSource: input.principals.authorizationSource ?? 'none',
    },
    conflict: input.recentChanges ?? [],
    decidedAt: new Date().toISOString(),
  }

  // ── Unregistered action: unsupported, not unconstrained ───────────────────
  if (!cls) {
    narrowedBy.push('action_class_unregistered')
    reasons.push(
      `No action class is registered for "${input.actionClassId}", so its sensor, ` +
        'verification and recovery dependencies are unknown.',
    )
    blocker = `register an action class for ${input.actionClassId}`
    return {
      ...base,
      decision: 'FREEZE',
      evidence: [],
      capability: { verification: 'unavailable', recovery: 'none', recoveryStatus: 'not_implemented' },
      narrowedBy,
      reasons,
      blocker,
    }
  }

  const frozenEarly = (why: string, blockerText: string): AuthorityDecision => {
    narrowedBy.push(why)
    return {
      ...base,
      decision: 'FREEZE',
      evidence: [],
      capability: { verification: 'unavailable', recovery: cls.recovery, recoveryStatus: 'not_implemented' },
      narrowedBy,
      reasons,
      blocker: blockerText,
    }
  }

  const evidence = cls.requiredSensors.map(r => judgeSensor(r, input.probes))
  const verifierEvidence = judgeSensor(cls.verifier, input.probes)
  const recoveryStatus: 'implemented' | 'not_implemented' =
    cls.recovery === 'none' || canRollback(cls.recovery as any)
      ? 'implemented'
      : 'not_implemented'

  const capability = {
    verification: verifierEvidence.status === 'missing' || verifierEvidence.status === 'errored' || verifierEvidence.status === 'disabled'
      ? ('unavailable' as const)
      : ('available' as const),
    recovery: cls.recovery,
    recoveryStatus,
  }

  const frozen = (why: string, blockerText: string): AuthorityDecision => {
    narrowedBy.push(why)
    blocker = blockerText
    return {
      ...base,
      decision: 'FREEZE',
      evidence,
      capability,
      narrowedBy,
      reasons,
      blocker,
    }
  }

  // ── FREEZE first: can the resource be observed at all? ────────────────────
  //
  // Before any probe's output is worth reading. A probe that reported nothing
  // about a schema it could not see has established nothing, and acting on that
  // silence is the failure this whole audit removed.
  if (input.resourceObservable !== true) {
    reasons.push(
      input.resourceObservable === 'unknown'
        ? `Backenly could not establish whether ${input.resource} is observable, so ` +
          'no probe result about it can be trusted.'
        : `${input.resource} could not be observed, so every probe reporting nothing ` +
          'about it reported an absence of evidence, not evidence of health.',
    )
    return frozenEarly('resource_unobservable', `restore access to ${input.resource}`)
  }

  // ── FREEZE: can the state be established at all? ──────────────────────────
  //
  // A required sensor that is errored or disabled means the claim this action
  // responds to cannot be established. There is no meaningful proposal to make
  // either, because the evidence for needing the action is what is missing —
  // so this is FREEZE and not PROPOSE_ONLY (RFC §7, corrected in review).
  const broken = evidence.filter(e => e.status === 'errored' || e.status === 'disabled' || e.status === 'missing')
  if (broken.length > 0) {
    const b = broken[0]
    reasons.push(
      `${cls.id} requires probe ${b.probeId}, and it ${b.note}. Backenly cannot ` +
        'establish whether this repair is necessary.',
    )
    return frozen('required_sensor_unavailable', `restore probe ${b.probeId}`)
  }

  // Verification is not negotiable, and no delegation can make an unverifiable
  // action verifiable (RFC §9.3). Consent changes what may be attempted, not
  // what can be known.
  if (capability.verification === 'unavailable') {
    reasons.push(
      `${cls.id} has no available verifier (${cls.verifier.probeId}), so success ` +
        'could not be independently established.',
    )
    return frozen('verification_unavailable', `restore verifier ${cls.verifier.probeId}`)
  }

  // ── Deployment capability ─────────────────────────────────────────────────
  const mode = resolveExecutionMode(input.level)
  if (!mode.repairsAreApplied) {
    narrowedBy.push(`deployment_${mode.reason}`)
    reasons.push(mode.explanation)
  }

  // ── Everything below can only narrow ──────────────────────────────────────
  let decision: Decision = 'AUTO_EXECUTE'
  const narrow = (to: Decision, why: string, reason: string) => {
    if (to === 'PROPOSE_ONLY' && decision === 'AUTO_EXECUTE') decision = 'PROPOSE_ONLY'
    narrowedBy.push(why)
    reasons.push(reason)
  }

  if (!mode.repairsAreApplied) {
    decision = 'PROPOSE_ONLY'
  }

  // Sensor confidence: unverified may observe, but cannot support autonomy.
  const weak = evidence.filter(e => !e.supportsAutonomy)
  for (const w of weak) {
    narrow(
      'PROPOSE_ONLY',
      `sensor_${w.status}`,
      `Probe ${w.probeId} ${w.note}, so it cannot support acting without review.`,
    )
  }

  // Tier ceiling: the dial's, which is 1 even at AGGRESSIVE.
  const maxTier = maxAutoTier(input.level)
  if (cls.tier > maxTier) {
    narrow(
      'PROPOSE_ONLY',
      'tier_above_dial_ceiling',
      `${cls.id} is tier ${cls.tier} and this project's autonomy allows up to tier ${maxTier}.`,
    )
  }

  // Recovery: an action that cannot be undone is never automatic.
  if (recoveryStatus === 'not_implemented') {
    narrow(
      'PROPOSE_ONLY',
      'recovery_not_implemented',
      `Rollback strategy "${cls.recovery}" is not implemented in this deployment, ` +
        'so this cannot be applied unattended.',
    )
  }

  // ── Authorization-shaped actions need to be told what is correct ──────────
  //
  // The measured failure from Phase 0. Backenly can see that USING (true) is
  // wrong and cannot know what predicate is right. Evidence establishes that
  // something is broken; only a declaration establishes what "fixed" means.
  if (cls.changesAuthorization && !input.hasDeclaredIntent) {
    narrow(
      'PROPOSE_ONLY',
      'no_declared_intent_for_authorization_change',
      `${cls.id} changes who can read data, and no declared ownership intent says ` +
        'what the correct rule is. Backenly would be guessing the predicate.',
    )
  }

  // Conflict: somebody else is changing this right now.
  const conflicting = (input.recentChanges ?? []).filter(c => c.minutesBefore <= 10)
  if (conflicting.length > 0) {
    narrow(
      'PROPOSE_ONLY',
      'recent_conflicting_change',
      `${conflicting.length} change(s) touched this backend in the last 10 minutes; ` +
        'acting now risks fighting whoever made them.',
    )
  }

  if (decision === 'AUTO_EXECUTE') {
    reasons.push(
      `All required sensors support the claim, ${cls.id} is tier ${cls.tier} within ` +
        `the project ceiling of ${maxTier}, verification and recovery are available.`,
    )
  }

  return { ...base, decision, evidence, capability, narrowedBy, reasons, blocker }
}
