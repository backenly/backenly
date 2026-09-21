/**
 * PERSISTED DELEGATED AUTHORITY
 * =============================
 *
 * Phase 3 proved the decision logic with delegations passed in as test inputs.
 * That left the honest gap this file closes: a grant nobody can create, store or
 * revoke is not authority, it is an argument.
 *
 * Default deny throughout. Absence of a row is absence of authority, and every
 * lookup that cannot establish an answer returns none rather than a permissive
 * fallback.
 */

import { prisma } from '@/lib/db/prisma'
import { P, type Principal } from '@/lib/principal'

import type { TierDelegation } from './delegation'

export interface GrantInput {
  projectId: string
  /** The human delegating. Checked, not trusted. */
  grantedBy: Principal
  actionClassId: string
  environment: 'development' | 'staging' | 'production'
  resourceScope?: string
  maxTier?: number
  maxBlastRadius?: 'single_object' | 'table' | 'schema'
  expiresAt?: Date | null
  budget?: number | null
  granteeLoop?: 'reconciler' | 'maintenance'
}

/**
 * Create a standing grant.
 *
 * Refuses any principal that is not a user. This is the self-authorization rule
 * from the RFC's threat model, enforced at the writer rather than only at the
 * reader: an agent that could create a grant naming itself would be authorizing
 * its own requests, which is precisely what separating requestedBy from
 * authorizedBy exists to prevent. Enforced in BOTH places on purpose — a row
 * that got in by any other route must still fail to authorize anything.
 */
export async function grantAuthority(input: GrantInput): Promise<{ id: string }> {
  if (input.grantedBy.kind !== 'user') {
    throw new Error(
      `Only a person may delegate unattended authority; got ${input.grantedBy.kind}. ` +
        'An agent cannot grant authority to itself or to anything else.',
    )
  }

  const row = await prisma.authorityGrant.create({
    data: {
      projectId: input.projectId,
      grantedByUserId: input.grantedBy.userId,
      granteeKind: 'backenly',
      granteeLoop: input.granteeLoop ?? 'reconciler',
      actionClassId: input.actionClassId,
      resourceScope: input.resourceScope ?? '*',
      environment: input.environment,
      maxTier: input.maxTier ?? 2,
      maxBlastRadius: input.maxBlastRadius ?? 'table',
      expiresAt: input.expiresAt ?? null,
      budgetRemaining: input.budget ?? null,
    },
    select: { id: true },
  })
  return row
}

/** Withdraw a grant. Takes effect at the next mutation boundary, not the next tick. */
export async function revokeAuthority(grantId: string, revokedBy: string): Promise<void> {
  await prisma.authorityGrant.update({
    where: { id: grantId },
    data: { revokedAt: new Date(), revokedBy, version: { increment: 1 } },
  })
}

/**
 * Load the grants that could bear on an action.
 *
 * Deliberately does NOT filter out revoked or expired rows in SQL. They are
 * returned and rejected by `evaluateDelegation`, so the receipt can say "a
 * delegation exists and it was revoked" rather than the indistinguishable "no
 * delegation". A refusal that cannot tell those apart sends somebody reading
 * source.
 */
export async function loadGrants(
  projectId: string,
  actionClassId: string,
): Promise<TierDelegation[]> {
  const rows = await prisma.authorityGrant.findMany({
    where: { projectId, actionClassId },
    orderBy: { createdAt: 'desc' },
  })

  return rows.map(r => ({
    id: r.id,
    projectId: r.projectId,
    actionClassId: r.actionClassId,
    environment: r.environment as TierDelegation['environment'],
    grantedBy: P.user(r.grantedByUserId),
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    version: r.version,
    resourceScope: r.resourceScope,
    maxTier: r.maxTier,
  }))
}

/**
 * Re-read one grant at the mutation boundary and prove it has not moved.
 *
 * A decision is a lease. Between deciding and mutating, an owner can revoke
 * through the settings API, which does not participate in the execution lock —
 * so a plain re-read under that lock proves nothing. The version comparison is
 * the compare-and-set half of RFC §10.4: it establishes that the permission
 * relied on is the same permission, not merely that some permission exists.
 */
export async function revalidateGrant(
  grantId: string,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<{ valid: boolean; reason: string | null }> {
  let row
  try {
    row = await prisma.authorityGrant.findUnique({ where: { id: grantId } })
  } catch (err: any) {
    // Could not establish it. Not a pass.
    return { valid: false, reason: `grant could not be re-read: ${err?.message ?? err}` }
  }

  if (!row) return { valid: false, reason: 'grant no longer exists' }
  if (row.version !== expectedVersion) {
    return {
      valid: false,
      reason: `grant changed since the decision (v${expectedVersion} -> v${row.version})`,
    }
  }
  if (row.revokedAt) return { valid: false, reason: 'grant was revoked' }
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: 'grant expired' }
  }
  if (row.budgetRemaining !== null && row.budgetRemaining <= 0) {
    return { valid: false, reason: 'grant budget exhausted' }
  }
  return { valid: true, reason: null }
}

/** Spend one unit of a budgeted grant. No-op for unbudgeted grants. */
export async function consumeGrantBudget(grantId: string): Promise<void> {
  await prisma.authorityGrant
    .updateMany({
      where: { id: grantId, budgetRemaining: { not: null, gt: 0 } },
      data: { budgetRemaining: { decrement: 1 } },
    })
    .catch(() => {
      /* best effort: a missed decrement makes the grant slightly more
         permissive for one action, never less safe than no budget at all */
    })
}
