/**
 * POLICY — what the engine may do on its own, and what needs a person
 * ===================================================================
 *
 * Architecture evolution must never mean "Backenly can rewrite production
 * whenever it wants". The boundary is written down here, in one place, so a new
 * primitive inherits it instead of re-deciding it:
 *
 *   may happen unattended        detection, evidence, rehearsal (a transaction
 *                                that is always rolled back), verification,
 *                                observation — none of them changes the
 *                                customer's schema or data
 *   needs a person, every time   any rung that changes the live schema; consent
 *                                binds to one exact plan version
 *   never run by software        anything irreversible or destructive (dropping
 *                                the old structure) and any SEMANTIC redesign
 *                                (cardinality, business meaning, transaction
 *                                boundaries, API contracts)
 *   gated by the deployment      mutations (ENABLE_EVOLUTION_MUTATIONS) and
 *                                unattended resumption (ENABLE_EVOLUTION_SCHEDULER),
 *                                both off by default
 *
 * ── Structural is not semantic ──────────────────────────────────────────────
 *
 * Seeing that `refund_amount`, `refund_reason` and `refunded_at` move together
 * is evidence about STRUCTURE. It is not evidence that a refund is a 1:1
 * attachment of an order — the business may need partial refunds, refund
 * attempts, disputes. A structural change keeps today's meaning exactly
 * (same rows, same cardinality, same access); the moment a change would alter
 * meaning it is semantic, and semantic changes are never executable here.
 * They can be recommended, explained and left to a person.
 *
 * ── Undo on regression is opt-in ────────────────────────────────────────────
 *
 * When observation sees a regression the engine STOPS progression (the change
 * goes to `blocked`) and tells the owner. Undoing it automatically is a policy
 * choice, off by default, and even when on it only happens through the same
 * rollback that refuses whenever undoing could lose a write.
 *
 * Pure.
 */

export type ChangeClass = 'structural' | 'semantic'
export type RiskLevel = 'low' | 'medium' | 'high'

export interface EvolutionPolicy {
  /** How long a cut-over change is watched before it may be called stable. */
  observationHours: number
  /** Observation passes required inside that window. One look is an anecdote. */
  minObservationPasses: number
  /** Undo automatically when observation sees a regression and undo is lossless. */
  autoRollbackOnRegression: boolean
}

export const DEFAULT_POLICY: EvolutionPolicy = {
  observationHours: 24,
  minObservationPasses: 3,
  autoRollbackOnRegression: false,
}

export interface RungTraits {
  tier: 0 | 1 | 2 | 3
  /** Software never runs it (destructive, irreversible, or a person's call). */
  humanOnly: boolean
  /** Changes the live schema or data. */
  mutates: boolean
}

export interface PlanTraits {
  changeClass: ChangeClass
  rungs: RungTraits[]
  /** Every rung software runs has an undo the executor can perform. */
  reversible: boolean
  /** The rehearsal covered who may read and write, not only what is stored. */
  authorizationRehearsed: boolean
}

export interface ApprovalRequirement {
  /** True for anything that changes the live schema. */
  required: boolean
  /** Software may never run it, approved or not. */
  humanOnly: boolean
  reason: string
}

export function approvalRequirement(p: PlanTraits): ApprovalRequirement {
  if (p.changeClass === 'semantic') {
    return {
      required: true,
      humanOnly: true,
      reason: 'it changes what the data means, which is a decision for a person and never run automatically',
    }
  }
  if (!p.reversible) {
    return { required: true, humanOnly: true, reason: 'part of it cannot be undone, so a person has to carry it out' }
  }
  const mutates = p.rungs.some(r => r.mutates && !r.humanOnly)
  return mutates
    ? { required: true, humanOnly: false, reason: 'it changes the live schema; Backenly asks before every change of this kind' }
    : { required: false, humanOnly: false, reason: 'it only reads' }
}

export function riskOf(p: PlanTraits): RiskLevel {
  if (p.changeClass === 'semantic' || !p.reversible) return 'high'
  const top = Math.max(0, ...p.rungs.filter(r => !r.humanOnly).map(r => r.tier))
  if (top <= 1) return 'low'
  // Behaviour-changing but reversible. Access that was not rehearsed is the
  // one gap that lifts it: a security regression is worse than a schema one.
  return p.authorizationRehearsed ? 'medium' : 'high'
}

/**
 * May the scheduler move this change forward without anybody pressing a button?
 *
 * Only what a person already consented to, only in a deployment that allows
 * both writing and unattended scheduling, and never on a project whose
 * autonomy is OFF.
 */
export function mayResumeUnattended(input: {
  consented: boolean
  mutationsEnabled: boolean
  schedulerEnabled: boolean
  autonomyOff: boolean
}): boolean {
  return input.consented && input.mutationsEnabled && input.schedulerEnabled && !input.autonomyOff
}

/** Undo automatically after a regression? Only when policy says so AND undo is lossless. */
export function shouldAutoRollback(policy: EvolutionPolicy, rollbackLossless: boolean): boolean {
  return policy.autoRollbackOnRegression && rollbackLossless
}
