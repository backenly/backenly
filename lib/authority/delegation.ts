/**
 * DELEGATION — MAY BACKENLY CHANGE IT
 * ===================================
 *
 * Kept deliberately separate from ownership intent, because they answer
 * different questions and collapsing them would be the next unsafe shortcut:
 *
 *     intent      what SHOULD be true of this table
 *     delegation  whether Backenly may CHANGE it without asking
 *
 * A declared ownership intent tells Backenly what the correct policy predicate
 * is. It says nothing about whether the owner wants Backenly rewriting
 * authorization rules unattended, and treating it as if it did would turn a
 * factual declaration into a grant of power the owner never made.
 *
 * ── Why this is not the dial ────────────────────────────────────────────────
 *
 * The dial's tier ceiling is 1 even at AGGRESSIVE — "Tier-2+ is never auto,
 * ever" (`autonomy-level.ts`). That default is correct and this does not change
 * it. Raising the global ceiling to let one action through would widen every
 * tier-2 action at once, which is precisely the kind of blanket loosening the
 * ceiling exists to prevent.
 *
 * A delegation is narrow instead: one principal, one action class, one
 * environment, with a time bound. It permits a specific thing rather than
 * raising a general limit.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * Phase 3 needs exactly one delegation to exist and be checkable. This is not
 * the grant engine from the RFC — no resource scoping, no budgets, no
 * revocation workflow, no UI. Those arrive with the grant model; naming them
 * here would be inventing an API nobody has evidence for yet.
 */

import type { Principal } from '@/lib/principal'

/**
 * Permission for a Backenly loop to perform one class of action unattended.
 *
 * Created by a human. An agent may never create one naming itself, which is the
 * self-authorization rule from the RFC's threat model: an agent requesting an
 * action and an agent authorizing it are the same principal, and the whole
 * point of the distinction is that they must not be.
 */
export interface TierDelegation {
  id: string
  projectId: string
  /** The action class this permits. One class, never a tier band. */
  actionClassId: string
  /** Where it applies. */
  environment: 'development' | 'staging' | 'production'
  /** Who created it. Must be a human principal. */
  grantedBy: Principal
  /** When it stops applying. A delegation without an end is a policy change. */
  expiresAt: Date | null
  revokedAt: Date | null
  /** Bumped on any change to what the grant permits; the decision records it. */
  version?: number
  /** '*' or a specific resource. */
  resourceScope?: string
  maxTier?: number
}

export type DelegationRefusal =
  | 'no_delegation_for_action'
  | 'delegation_wrong_environment'
  | 'delegation_expired'
  | 'delegation_revoked'
  | 'delegation_not_granted_by_human'

export interface DelegationEvaluation {
  delegation: TierDelegation | null
  refusal: DelegationRefusal | null
  note: string
}

/**
 * Does a live delegation permit this action class here?
 *
 * Pure over its inputs, and every failure is a distinct named refusal so the
 * receipt can say which condition was missing rather than "not permitted".
 */
export function evaluateDelegation(
  delegations: TierDelegation[],
  actionClassId: string,
  environment: string,
  now: Date = new Date(),
): DelegationEvaluation {
  const forAction = delegations.filter(d => d.actionClassId === actionClassId)
  if (forAction.length === 0) {
    return {
      delegation: null,
      refusal: 'no_delegation_for_action',
      note: `No delegation permits ${actionClassId} to run unattended.`,
    }
  }

  const here = forAction.filter(d => d.environment === environment)
  if (here.length === 0) {
    return {
      delegation: null,
      refusal: 'delegation_wrong_environment',
      note:
        `A delegation for ${actionClassId} exists, but not for ${environment}. ` +
        'Authority granted in one environment does not carry to another.',
    }
  }

  const live = here.find(d => {
    if (d.revokedAt) return false
    if (d.expiresAt && d.expiresAt.getTime() <= now.getTime()) return false
    return true
  })

  if (!live) {
    const revoked = here.some(d => d.revokedAt)
    return {
      delegation: null,
      refusal: revoked ? 'delegation_revoked' : 'delegation_expired',
      note: revoked
        ? `The delegation for ${actionClassId} was revoked, so it permits nothing.`
        : `The delegation for ${actionClassId} has expired.`,
    }
  }

  // An agent cannot grant itself authority. Checked here rather than only at
  // creation because a row that got in by any route must still fail to
  // authorize anything.
  if (live.grantedBy.kind !== 'user') {
    return {
      delegation: null,
      refusal: 'delegation_not_granted_by_human',
      note:
        `The delegation for ${actionClassId} was not created by a person ` +
        `(${live.grantedBy.kind}). Only a human may delegate unattended authority.`,
    }
  }

  return {
    delegation: live,
    refusal: null,
    note: `${actionClassId} is delegated for unattended use in ${environment}.`,
  }
}
